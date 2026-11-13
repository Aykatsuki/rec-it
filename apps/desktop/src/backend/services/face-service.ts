// Face analysis for automatic reframing (Phase 5b, ADR-035): the Python sidecar decodes the
// media's preview copy at 5 frames a second and finds faces with OpenCV's YuNet; the detections
// are stored in the project file. The framing path itself is computed in packages/core.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  faceTrackSchema,
  type FaceJob,
  type FaceStatus,
  type FaceTrackData,
} from '@rec-it/ipc-contract';
import { installExtra, type InstallState } from './extras';
import type { ProjectService } from './project-service';
import type { SidecarClient, SidecarCommand } from './sidecar';

/** Samples per second of video. Enough to follow people; fast to analyse. */
const FPS = 5;

export interface FaceDeps {
  projects: ProjectService;
  sidecar: SidecarClient | null;
  sidecarCommand: SidecarCommand | null;
  ffmpeg: () => Promise<string>;
  onChange: (status: FaceStatus) => void;
  busyElsewhere?: () => boolean;
  onEngineChanged?: () => void;
}

export class FaceService {
  private available: boolean | null = null;
  private engine: string | undefined;
  private blocked: string | undefined;
  private install: InstallState = { state: 'idle' };
  private jobs: FaceJob[] = [];
  private controllers = new Map<string, AbortController>();
  private running = false;

  constructor(private readonly d: FaceDeps) {}

  status(): FaceStatus {
    let analysed: string[];
    try {
      analysed = this.d.projects.info() ? this.d.projects.database().faceTrackedAssets() : [];
    } catch {
      analysed = [];
    }
    return {
      available: this.available,
      ...(this.engine ? { engine: this.engine } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
      install: this.install,
      jobs: this.jobs,
      analysed,
    };
  }

  private emit(): void {
    this.d.onChange(this.status());
  }

  /** Asks the sidecar whether face detection is installed. */
  async refresh(): Promise<void> {
    if (!this.d.sidecar) {
      this.available = false;
      this.blocked = 'The media-ai helper is turned off, so automatic reframing is unavailable.';
      this.emit();
      return;
    }
    try {
      this.d.sidecar.start();
      const info = await this.d.sidecar.request<{
        faces?: { available: boolean; engine?: string };
      }>('system.info', {}, 60_000);
      this.available = !!info.faces?.available;
      this.engine = info.faces?.engine;
      this.blocked = undefined;
    } catch (error) {
      this.available = false;
      this.blocked = `The media-ai helper is not running (${
        error instanceof Error ? error.message : String(error)
      }). Install uv (see the README) and restart Rec-It.`;
    }
    this.emit();
  }

  busy(): boolean {
    return this.jobs.some((j) => j.state === 'running');
  }

  /** Installs face detection (OpenCV, about 60 MB) once. */
  installEngine(): void {
    const cmd = this.d.sidecarCommand;
    if (!cmd) throw new Error('The media-ai sidecar is turned off.');
    if (this.install.state === 'running') return;
    if (this.busy() || this.d.busyElsewhere?.())
      throw new Error('Wait for the running analysis to finish.');
    this.d.sidecar?.stop();
    installExtra(cmd, 'reframe', (state, finished) => {
      this.install = state;
      this.emit();
      if (finished) {
        this.d.onEngineChanged?.();
        void this.refresh();
      }
    });
  }

  get(assetId: string): FaceTrackData | null {
    const json = this.d.projects.database().loadFaceTrack(assetId);
    if (!json) return null;
    const parsed = faceTrackSchema.safeParse({ assetId, ...JSON.parse(json) });
    return parsed.success ? parsed.data : null;
  }

  /** Queues a media file for face analysis. */
  start(assetId: string): void {
    const asset = this.d.projects.media().exportAsset(assetId);
    if (!asset) throw new Error('That media is not ready yet.');
    if (asset.kind !== 'video') throw new Error('Automatic reframing works on video clips.');
    if (!this.d.sidecar)
      throw new Error('Automatic reframing needs the media-ai sidecar, which is off.');
    if (this.jobs.some((j) => j.assetId === assetId && ['queued', 'running'].includes(j.state)))
      return;
    this.jobs = [
      ...this.jobs.filter((j) => j.assetId !== assetId),
      { assetId, state: 'queued', progress: 0 },
    ];
    this.emit();
    void this.pump();
  }

  cancel(assetId: string): void {
    this.controllers.get(assetId)?.abort();
    this.update(assetId, (j) => (j.state === 'queued' ? { ...j, state: 'cancelled' } : j));
  }

  private update(assetId: string, f: (j: FaceJob) => FaceJob): void {
    this.jobs = this.jobs.map((j) => (j.assetId === assetId ? f(j) : j));
    this.emit();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find((j) => j.state === 'queued');
        if (!job) break;
        await this.run(job.assetId);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(assetId: string): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(assetId, controller);
    const work = await mkdtemp(join(tmpdir(), 'recit-faces-'));
    try {
      const media = this.d.projects.media();
      const asset = media.list().find((a) => a.id === assetId);
      const v = asset?.probe?.video;
      // The preview copy is small and always H.264, so it decodes quickly; detections are in
      // fractions of the picture, so they apply to the original too.
      const video = media.proxyPath(assetId) ?? media.exportAsset(assetId)?.path;
      if (!asset || !v || !video) throw new Error('That media is no longer in the project.');
      this.update(assetId, (j) => ({ ...j, state: 'running', progress: 0 }));
      const out = join(work, 'faces.json');
      this.d.sidecar!.start();
      await this.d.sidecar!.job(
        'faces',
        {
          video,
          out,
          ffmpeg: await this.d.ffmpeg(),
          width: v.displayWidth,
          height: v.displayHeight,
          duration: asset.probe?.durationSec ?? 0,
          fps: FPS,
        },
        {
          signal: controller.signal,
          onProgress: (p) => this.update(assetId, (j) => ({ ...j, progress: p })),
        },
      );
      const raw = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
      const parsed = faceTrackSchema.parse({ assetId, ...raw });
      const { assetId: _id, ...stored } = parsed;
      this.d.projects.database().saveFaceTrack(assetId, parsed.engine, JSON.stringify(stored));
      this.update(assetId, (j) => ({ ...j, state: 'done', progress: 1 }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.update(assetId, (j) =>
        controller.signal.aborted || /cancel/i.test(message)
          ? { ...j, state: 'cancelled' }
          : { ...j, state: 'failed', error: message },
      );
    } finally {
      this.controllers.delete(assetId);
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  reset(): void {
    for (const c of this.controllers.values()) c.abort();
    this.jobs = [];
    this.emit();
  }
}
