import { existsSync } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, parse } from 'node:path';
import { createId } from '@rec-it/core';
import type { AssetRow, ProjectDatabase } from '@rec-it/db';
import {
  PeakBuilder,
  posterArgs,
  probeFile,
  proxyArgs,
  runFfmpeg,
  spriteArgs,
  spriteLayout,
  type FfmpegBinaries,
  type H264Encoder,
  type ProbeInfo,
  type SpriteLayout,
  waveformPcmArgs,
} from '@rec-it/ffmpeg';
import {
  IMPORT_EXTENSIONS,
  probeInfoSchema,
  rightsRecordSchema,
  type JobKind,
  type JobState,
  type JobSummary,
  type MediaAsset,
  type RightsInput,
  type RightsRecord,
} from '@rec-it/ipc-contract';
import { contentHash, displayName } from './files';
import { JobQueue, type JobContext, type JobUpdate } from './jobs';

export interface Toolchain {
  bins: FfmpegBinaries;
  encoder: H264Encoder;
}

export interface MediaServiceOptions {
  project: ProjectDatabase;
  projectId: string;
  /** Folder for this project's proxies, thumbnails and waveforms. */
  cacheDir: string;
  /** Resolves once FFmpeg has been detected; rejects if it is unavailable. */
  toolchain: () => Promise<Toolchain>;
  onAssetsChanged: (assets: MediaAsset[]) => void;
  onJobsChanged: (jobs: JobSummary[]) => void;
}

type Jobs = Record<JobKind, JobState>;
interface Derived {
  sprite?: SpriteLayout;
  /** Bumped whenever derived files are rewritten, so URLs change and caches refresh. */
  version?: number;
}

const ALL_JOBS: JobKind[] = ['probe', 'proxy', 'thumbnails', 'waveform'];
const FILES = {
  proxy: 'proxy.mp4',
  poster: 'poster.jpg',
  sprite: 'sprite.jpg',
  waveform: 'waveform.bin',
} as const;
const EXTENSIONS = new Set<string>(IMPORT_EXTENSIONS);
const BROADCAST_INTERVAL_MS = 250;

/** Which jobs apply to which kind of media. */
function jobsFor(probe: ProbeInfo): Record<Exclude<JobKind, 'probe'>, boolean> {
  return {
    proxy: probe.kind === 'video',
    thumbnails: probe.kind === 'video' || probe.kind === 'image',
    waveform: probe.kind !== 'image' && !!probe.audio,
  };
}

export function attributionFor(name: string, rights: RightsInput): string | undefined {
  if (rights.source !== 'creative-commons') return undefined;
  const title = parse(name).name;
  const by = rights.author ? ` by ${rights.author}` : '';
  const url = rights.originUrl ? ` (${rights.originUrl})` : '';
  return `"${title}"${by}${url}, licensed under ${rights.licence ?? 'a Creative Commons licence'}.`;
}

function rightsRecord(name: string, input: RightsInput): RightsRecord {
  const attribution = attributionFor(name, input);
  return {
    ...input,
    ...(attribution ? { attributionText: attribution } : {}),
    ...(input.userAttested ? { attestedAt: new Date().toISOString() } : {}),
  };
}

/**
 * Imports media into the open project and runs its processing jobs: probe, proxy,
 * thumbnails and waveform (ARCHITECTURE §8). All state is written to the project file
 * as it changes, so a crash loses nothing that finished.
 */
export class MediaService {
  private readonly queue: JobQueue;
  private readonly missing = new Set<string>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly o: MediaServiceOptions) {
    this.queue = new JobQueue({ probe: 4, proxy: 2, thumbnails: 2, waveform: 2 }, (u) =>
      this.onJobUpdate(u),
    );
  }

  /** Called after opening a project: detects missing originals and resumes unfinished work. */
  async resume(): Promise<void> {
    for (const row of this.o.project.listAssets()) {
      if (!existsSync(row.originalPath)) {
        this.missing.add(row.id);
        continue;
      }
      const jobs = row.jobs as Jobs;
      const needsProbe = jobs.probe.state !== 'done' && jobs.probe.state !== 'failed';
      if (needsProbe) {
        this.schedule(row.id, 'probe');
        continue;
      }
      if (jobs.probe.state !== 'done') continue;
      for (const kind of ['proxy', 'thumbnails', 'waveform'] as const) {
        const state = jobs[kind].state;
        const interrupted = state === 'pending' || state === 'running' || state === 'cancelled';
        const lost = state === 'done' && !this.derivedFilesExist(row.id, kind);
        if (interrupted || lost) this.schedule(row.id, kind);
      }
    }
    this.broadcast(true);
  }

  list(): MediaAsset[] {
    return this.o.project.listAssets().map((row) => this.toDto(row));
  }

  get(assetId: string): MediaAsset {
    return this.toDto(this.row(assetId));
  }

  jobs(): JobSummary[] {
    const names = new Map(this.o.project.listAssets().map((r) => [r.id, r.name]));
    return this.queue.active().map((j) => ({
      assetId: j.spec.assetId,
      assetName: names.get(j.spec.assetId) ?? '',
      kind: j.spec.kind,
      state: j.state,
      progress: j.progress,
    }));
  }

  async import(
    paths: string[],
    rights: RightsInput,
  ): Promise<{ imported: string[]; skipped: { path: string; reason: string }[] }> {
    const imported: string[] = [];
    const skipped: { path: string; reason: string }[] = [];
    for (const path of paths) {
      try {
        const ext = extname(path).slice(1).toLowerCase();
        if (!EXTENSIONS.has(ext)) throw new Error(`".${ext}" files are not supported`);
        const info = await stat(path);
        if (!info.isFile()) throw new Error('Not a file');
        const { hash, size, mtimeMs } = await contentHash(path);
        const existing = this.o.project.findByHash(hash);
        if (existing) throw new Error(`Already in the project as "${existing.name}"`);
        const name = displayName(path);
        const id = createId('asset');
        const jobs: Jobs = {
          probe: { state: 'pending', progress: 0 },
          proxy: { state: 'pending', progress: 0 },
          thumbnails: { state: 'pending', progress: 0 },
          waveform: { state: 'pending', progress: 0 },
        };
        this.o.project.insertAsset({
          id,
          name,
          kind: null,
          originalPath: path,
          contentHash: hash,
          sizeBytes: size,
          mtimeMs,
          probe: null,
          rights: rightsRecord(name, rights),
          jobs,
          derived: {},
          importedAt: new Date().toISOString(),
        });
        imported.push(id);
        this.schedule(id, 'probe');
      } catch (error) {
        skipped.push({ path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    this.broadcast(true);
    return { imported, skipped };
  }

  async remove(assetIds: string[]): Promise<void> {
    const ids = new Set(assetIds);
    this.queue.cancel((spec) => ids.has(spec.assetId));
    this.o.project.deleteAssets(assetIds);
    for (const id of assetIds) {
      this.missing.delete(id);
      await rm(this.assetDir(id), { recursive: true, force: true }).catch(() => {});
    }
    this.broadcast(true);
  }

  /** Re-points a missing asset at a moved file, after checking it is the same content. */
  async relink(assetId: string, path: string): Promise<MediaAsset> {
    const row = this.row(assetId);
    const { hash, mtimeMs } = await contentHash(path);
    if (hash !== row.contentHash) {
      throw new Error(
        'That file has different content from the original, so it cannot replace it.',
      );
    }
    this.o.project.updateAsset(assetId, { originalPath: path, mtimeMs, name: row.name });
    this.missing.delete(assetId);
    await this.resumeAsset(assetId);
    this.broadcast(true);
    return this.get(assetId);
  }

  retry(assetId: string, job?: JobKind): void {
    const row = this.row(assetId);
    const jobs = row.jobs as Jobs;
    const kinds = job
      ? [job]
      : ALL_JOBS.filter((k) => jobs[k].state === 'failed' || jobs[k].state === 'cancelled');
    for (const kind of kinds) {
      if (kind !== 'probe' && jobs.probe.state !== 'done') this.schedule(assetId, 'probe');
      else this.schedule(assetId, kind);
    }
    this.broadcast(true);
  }

  cancel(assetIds: string[]): void {
    const ids = new Set(assetIds);
    this.queue.cancel((spec) => ids.has(spec.assetId));
  }

  updateRights(assetId: string, rights: RightsInput): MediaAsset {
    const row = this.row(assetId);
    this.o.project.updateAsset(assetId, { rights: rightsRecord(row.name, rights) });
    this.broadcast(true);
    return this.get(assetId);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
    await this.queue.dispose();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private row(assetId: string): AssetRow {
    const row = this.o.project.getAsset(assetId);
    if (!row) throw new Error('That media item is no longer in the project.');
    return row;
  }

  private async resumeAsset(assetId: string): Promise<void> {
    const jobs = this.row(assetId).jobs as Jobs;
    if (jobs.probe.state !== 'done') return this.schedule(assetId, 'probe');
    for (const kind of ['proxy', 'thumbnails', 'waveform'] as const) {
      if (jobs[kind].state !== 'done' && jobs[kind].state !== 'skipped')
        this.schedule(assetId, kind);
    }
  }

  private assetDir(assetId: string): string {
    return join(this.o.cacheDir, assetId);
  }

  private derivedFilesExist(assetId: string, kind: Exclude<JobKind, 'probe'>): boolean {
    const dir = this.assetDir(assetId);
    if (kind === 'proxy') return existsSync(join(dir, FILES.proxy));
    if (kind === 'waveform') return existsSync(join(dir, FILES.waveform));
    return existsSync(join(dir, FILES.poster));
  }

  private setJob(assetId: string, kind: JobKind, state: JobState): void {
    if (this.closed) return;
    const row = this.o.project.getAsset(assetId);
    if (!row) return;
    const jobs = { ...(row.jobs as Jobs), [kind]: state };
    this.o.project.updateAsset(assetId, { jobs });
  }

  private schedule(assetId: string, kind: JobKind): void {
    void this.queue.enqueue({
      id: `${assetId}:${kind}`,
      kind,
      assetId,
      run: (ctx) => this.runJob(assetId, kind, ctx),
    });
  }

  private onJobUpdate(update: JobUpdate): void {
    const { spec, state, progress, error } = update;
    // Progress ticks are frequent: keep them in memory and only persist state changes.
    if (state !== 'running' || progress === 0) {
      this.setJob(spec.assetId, spec.kind, { state, progress, ...(error ? { error } : {}) });
    }
    if (
      state === 'failed' &&
      !existsSync(this.o.project.getAsset(spec.assetId)?.originalPath ?? '')
    ) {
      this.missing.add(spec.assetId);
    }
    this.broadcast(state !== 'running');
  }

  private async runJob(assetId: string, kind: JobKind, ctx: JobContext): Promise<void> {
    const row = this.row(assetId);
    if (!existsSync(row.originalPath))
      throw new Error('The original file is missing. Use "Locate" to find it.');
    const { bins, encoder } = await this.o.toolchain();
    const dir = this.assetDir(assetId);
    await mkdir(dir, { recursive: true });

    if (kind === 'probe') {
      const probe = await probeFile(bins.ffprobe, row.originalPath);
      this.o.project.updateAsset(assetId, { kind: probe.kind, probe });
      const applicable = jobsFor(probe);
      for (const k of ['proxy', 'thumbnails', 'waveform'] as const) {
        if (applicable[k]) this.schedule(assetId, k);
        else this.setJob(assetId, k, { state: 'skipped', progress: 1 });
      }
      return;
    }

    const probe = probeInfoSchema.parse(row.probe) as ProbeInfo;
    const changes: Derived = {};
    const write = async (file: string, produce: (tmp: string) => Promise<void>) => {
      const target = join(dir, file);
      const tmp = `${target}.part`;
      try {
        await produce(tmp);
        await rename(tmp, target);
      } finally {
        // On failure or cancellation no partial file is left behind.
        await rm(tmp, { force: true });
      }
    };

    if (kind === 'proxy') {
      await write(FILES.proxy, (tmp) =>
        runFfmpeg(bins.ffmpeg, proxyArgs(row.originalPath, tmp, probe, encoder), {
          signal: ctx.signal,
          durationSec: probe.durationSec,
          onProgress: ctx.progress,
        }),
      );
    } else if (kind === 'thumbnails') {
      await write(FILES.poster, (tmp) =>
        runFfmpeg(bins.ffmpeg, posterArgs(row.originalPath, tmp, probe), { signal: ctx.signal }),
      );
      ctx.progress(0.3);
      if (probe.kind === 'video') {
        const layout = spriteLayout(probe.durationSec);
        await write(FILES.sprite, (tmp) =>
          runFfmpeg(bins.ffmpeg, spriteArgs(row.originalPath, tmp, layout), {
            signal: ctx.signal,
            durationSec: probe.durationSec,
            onProgress: (p) => ctx.progress(0.3 + p * 0.7),
          }),
        );
        changes.sprite = layout;
      }
    } else if (kind === 'waveform') {
      const peaks = new PeakBuilder();
      await runFfmpeg(bins.ffmpeg, waveformPcmArgs(row.originalPath), {
        signal: ctx.signal,
        durationSec: probe.durationSec,
        onProgress: ctx.progress,
        onStdout: (chunk) => peaks.push(chunk),
      });
      await write(FILES.waveform, (tmp) => writeFile(tmp, peaks.finish()));
    }
    // Jobs for one asset run in parallel: merge into the latest stored value, not the one read at start.
    const latest = (this.row(assetId).derived ?? {}) as Derived;
    this.o.project.updateAsset(assetId, {
      derived: { ...latest, ...changes, version: (latest.version ?? 0) + 1 },
    });
  }

  private status(row: AssetRow, jobs: Jobs): MediaAsset['status'] {
    if (this.missing.has(row.id)) return 'missing';
    const states = ALL_JOBS.map((k) => jobs[k].state);
    if (states.includes('failed')) return 'failed';
    if (states.some((s) => s === 'pending' || s === 'running' || s === 'cancelled'))
      return 'processing';
    return 'ready';
  }

  private toDto(row: AssetRow): MediaAsset {
    const stored = row.jobs as Jobs;
    // Overlay live progress for running jobs (not persisted on every tick).
    const live = new Map(
      this.queue
        .active()
        .filter((j) => j.spec.assetId === row.id)
        .map((j) => [j.spec.kind, j]),
    );
    const jobs = Object.fromEntries(
      ALL_JOBS.map((k) => {
        const l = live.get(k);
        return [k, l ? { state: l.state, progress: l.progress } : stored[k]];
      }),
    ) as Jobs;
    const derived = (row.derived ?? {}) as Derived;
    const v = derived.version ?? 0;
    const url = (file: string) =>
      `recit-media://asset/${this.o.projectId}/${row.id}/${file}?v=${v}`;
    const probe = row.probe ? (probeInfoSchema.safeParse(row.probe).data ?? null) : null;
    return {
      id: row.id,
      name: row.name,
      kind: (row.kind as MediaAsset['kind']) ?? null,
      originalPath: row.originalPath,
      sizeBytes: row.sizeBytes,
      importedAt: row.importedAt,
      status: this.status(row, jobs),
      missing: this.missing.has(row.id),
      probe,
      rights: rightsRecordSchema.parse(row.rights),
      jobs,
      urls: {
        ...(jobs.proxy.state === 'done' ? { proxy: url(FILES.proxy) } : {}),
        ...(jobs.thumbnails.state === 'done' ? { poster: url(FILES.poster) } : {}),
        ...(jobs.waveform.state === 'done' ? { waveform: url(FILES.waveform) } : {}),
        ...(jobs.thumbnails.state === 'done' && derived.sprite
          ? { sprite: { url: url(FILES.sprite), ...derived.sprite } }
          : {}),
      },
    };
  }

  /** Sends asset and job lists to the UI, at most four times a second for progress ticks. */
  private broadcast(immediate = false): void {
    if (this.closed) return;
    const send = () => {
      this.broadcastTimer = null;
      if (this.closed) return;
      this.o.onAssetsChanged(this.list());
      this.o.onJobsChanged(this.jobs());
    };
    if (immediate) {
      if (this.broadcastTimer) clearTimeout(this.broadcastTimer);
      send();
    } else if (!this.broadcastTimer) {
      this.broadcastTimer = setTimeout(send, BROADCAST_INTERVAL_MS);
    }
  }
}
