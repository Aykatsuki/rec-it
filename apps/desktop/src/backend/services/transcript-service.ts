// Local transcription (Phase 4, ADR-031): FFmpeg extracts 16 kHz mono audio, the Python sidecar
// runs faster-whisper on it, and the word-timed transcript is stored in the project file.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFfmpeg } from '@rec-it/ffmpeg';
import {
  transcriptSchema,
  type Transcript,
  type TranscriptionJob,
  type TranscriptionStatus,
} from '@rec-it/ipc-contract';
import type { ProjectService } from './project-service';
import { installExtra } from './extras';
import type { SidecarClient, SidecarCommand } from './sidecar';

/** Share of the progress bar for extracting the audio. */
const EXTRACT_SHARE = 0.08;

export interface TranscriptDeps {
  projects: ProjectService;
  sidecar: SidecarClient | null;
  sidecarCommand: SidecarCommand | null;
  ffmpeg: () => Promise<string>;
  device: () => 'auto' | 'cuda' | 'cpu';
  modelsDir: string;
  onChange: (status: TranscriptionStatus) => void;
  /** Another job uses the helper (installing would restart it). */
  busyElsewhere?: () => boolean;
  /** Called after an install, so other services can check their engines again. */
  onEngineChanged?: () => void;
}

export class TranscriptService {
  private available: boolean | null = null;
  private blocked: string | undefined;
  private engine: string | undefined;
  private install: TranscriptionStatus['install'] = { state: 'idle' };
  private jobs: TranscriptionJob[] = [];
  private controllers = new Map<string, AbortController>();
  private running = false;

  constructor(private readonly d: TranscriptDeps) {}

  status(): TranscriptionStatus {
    let transcribed: string[];
    try {
      transcribed = this.d.projects.info() ? this.d.projects.database().transcribedAssets() : [];
    } catch {
      transcribed = [];
    }
    return {
      available: this.available,
      ...(this.engine ? { engine: this.engine } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
      install: this.install,
      jobs: this.jobs,
      transcribed,
    };
  }

  private emit(): void {
    this.d.onChange(this.status());
  }

  /** Asks the sidecar whether faster-whisper is installed. */
  async refresh(): Promise<void> {
    if (!this.d.sidecar) {
      this.available = false;
      this.blocked = 'The media-ai helper is turned off, so transcription is unavailable.';
      this.emit();
      return;
    }
    try {
      this.d.sidecar.start();
      const info = await this.d.sidecar.request<{
        transcription?: { available: boolean; engine?: string };
      }>('system.info', {}, 60_000);
      this.available = !!info.transcription?.available;
      this.engine = info.transcription?.engine;
      this.blocked = undefined;
    } catch (error) {
      this.available = false;
      this.blocked = `The media-ai helper is not running (${
        error instanceof Error ? error.message : String(error)
      }). Install uv (see the README) and restart Rec-It.`;
    }
    this.emit();
  }

  /** Installs the transcription extra with uv (one-time; downloads about 1.5 GB on Windows). */
  installEngine(): void {
    const cmd = this.d.sidecarCommand;
    if (!cmd) throw new Error('The media-ai sidecar is turned off.');
    if (this.install.state === 'running') return;
    if (this.jobs.some((j) => ['extracting', 'transcribing'].includes(j.state)))
      throw new Error('Wait for the running transcription to finish.');
    if (this.d.busyElsewhere?.()) throw new Error('Wait for the running analysis to finish.');
    // The helper is restarted afterwards so it picks up the new packages cleanly.
    this.d.sidecar?.stop();
    installExtra(cmd, 'transcribe', (state, finished) => {
      this.install = state.state === 'failed' && !state.message ? this.install : state;
      this.emit();
      if (finished) {
        this.d.onEngineChanged?.();
        void this.refresh();
      }
    });
  }

  /** True while a transcription is running (the helper must not be restarted). */
  busy(): boolean {
    return this.jobs.some((j) => ['extracting', 'transcribing'].includes(j.state));
  }

  get(assetId: string): Transcript | null {
    const row = this.d.projects.database().loadTranscript(assetId);
    if (!row) return null;
    const parsed = transcriptSchema.safeParse({ assetId, ...JSON.parse(row.json) });
    return parsed.success ? parsed.data : null;
  }

  /** Queues a media file for transcription. */
  start(assetId: string, language: string | null): void {
    const media = this.d.projects.media();
    const asset = media.exportAsset(assetId);
    if (!asset) throw new Error('That media is not ready yet.');
    if (!asset.hasAudio) throw new Error('This media has no sound to transcribe.');
    if (!this.d.sidecar) throw new Error('Transcription needs the media-ai sidecar, which is off.');
    if (
      this.jobs.some(
        (j) => j.assetId === assetId && ['queued', 'extracting', 'transcribing'].includes(j.state),
      )
    )
      return;
    this.jobs = [
      ...this.jobs.filter((j) => j.assetId !== assetId),
      { assetId, state: 'queued', progress: 0 },
    ];
    this.languages.set(assetId, language);
    this.emit();
    void this.pump();
  }

  cancel(assetId: string): void {
    this.controllers.get(assetId)?.abort();
    this.update(assetId, (j) => (j.state === 'queued' ? { ...j, state: 'cancelled' } : j));
  }

  private readonly languages = new Map<string, string | null>();

  private update(assetId: string, f: (j: TranscriptionJob) => TranscriptionJob): void {
    this.jobs = this.jobs.map((j) => (j.assetId === assetId ? f(j) : j));
    this.emit();
  }

  /** Runs queued jobs one at a time (Whisper uses the whole GPU). */
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
    const work = await mkdtemp(join(tmpdir(), 'recit-transcribe-'));
    try {
      const asset = this.d.projects.media().exportAsset(assetId);
      if (!asset) throw new Error('That media is no longer in the project.');
      this.update(assetId, (j) => ({ ...j, state: 'extracting', progress: 0 }));
      const audio = join(work, 'audio.wav');
      await runFfmpeg(
        await this.d.ffmpeg(),
        [
          '-i',
          asset.path,
          '-map',
          '0:a:0',
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          '-f',
          'wav',
          audio,
        ],
        {
          signal: controller.signal,
          onProgress: (p) => this.update(assetId, (j) => ({ ...j, progress: p * EXTRACT_SHARE })),
        },
      );
      this.update(assetId, (j) => ({ ...j, state: 'transcribing', progress: EXTRACT_SHARE }));
      const out = join(work, 'transcript.json');
      const language = this.languages.get(assetId) ?? null;
      this.d.sidecar!.start();
      await this.d.sidecar!.job(
        'transcribe',
        {
          audio,
          out,
          device: this.d.device(),
          modelsDir: this.d.modelsDir,
          ...(language ? { language } : {}),
        },
        {
          signal: controller.signal,
          onProgress: (p, message) =>
            this.update(assetId, (j) => ({
              ...j,
              progress: EXTRACT_SHARE + p * (1 - EXTRACT_SHARE),
              ...(message ? { message } : {}),
            })),
        },
      );
      const raw = JSON.parse(await readFile(out, 'utf8')) as Record<string, unknown>;
      const parsed = transcriptSchema.parse({ assetId, ...raw });
      const { assetId: _id, ...stored } = parsed;
      this.d.projects
        .database()
        .saveTranscript(assetId, parsed.language, parsed.model, JSON.stringify(stored));
      this.update(assetId, ({ message: _m, ...j }) => ({ ...j, state: 'done', progress: 1 }));
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

  /** Forgets jobs when the project closes. */
  reset(): void {
    for (const c of this.controllers.values()) c.abort();
    this.jobs = [];
    this.emit();
  }
}
