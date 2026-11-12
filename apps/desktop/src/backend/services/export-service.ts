import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Sequence } from '@rec-it/core';
import { CancelledError, runFfmpeg, type FfmpegBinaries } from '@rec-it/ffmpeg';
import type { ExportSettings, ExportState, FfmpegStatus } from '@rec-it/ipc-contract';
import {
  ENCODERS,
  encoderLabel,
  hasAudibleContent,
  isSoftwareEncoder,
  parseLoudnorm,
  pickExportEncoder,
  planExport,
  planFrame,
  planLoudnessAnalysis,
  type ExportAsset,
  type ExportEncoder,
  type ExportPlan,
  type LoudnessMeasurement,
} from '@rec-it/render-plan';

export interface ExportToolchain {
  bins: FfmpegBinaries;
  ffmpeg: Pick<FfmpegStatus, 'encoders' | 'nvencUsable'>;
  tonemap: boolean;
}

type Assets = (id: string) => ExportAsset | undefined;

/** Share of the progress bar given to the loudness analysis pass (it only decodes audio). */
const ANALYSIS_SHARE = 0.12;

function checkMedia(seq: Sequence, assets: Assets): void {
  const missing = new Set<string>();
  for (const track of seq.tracks) {
    for (const item of track.items) {
      const asset = assets(item.assetId);
      if (!asset || !existsSync(asset.path))
        missing.add(asset ? basename(asset.path) : item.assetId);
    }
  }
  if (missing.size)
    throw new Error(`Some media is missing: ${[...missing].join(', ')}. Locate it in Media first.`);
}

/** Runs a plan with its filter graph passed as a file (long graphs exceed Windows' command line). */
async function runPlan(
  ffmpeg: string,
  plan: ExportPlan,
  work: string,
  output: string[],
  options: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
): Promise<string> {
  const graphFile = join(work, `graph-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(graphFile, plan.filterGraph);
  const { stderrTail } = await runFfmpeg(
    ffmpeg,
    [...plan.inputArgs, '-/filter_complex', graphFile, ...plan.outputArgs, ...output],
    { signal: options.signal, durationSec: plan.durationSec, onProgress: options.onProgress },
  );
  return stderrTail;
}

/** Runs one export at a time (ARCHITECTURE §10.4) and reports progress. */
export class ExportService {
  private current: ExportState = { state: 'idle', progress: 0 };
  private controller: AbortController | null = null;
  private lastEmit = 0;

  constructor(private readonly onChange: (state: ExportState) => void) {}

  status(): ExportState {
    return this.current;
  }

  start(
    seq: Sequence,
    path: string,
    settings: ExportSettings,
    toolchain: () => Promise<ExportToolchain>,
    assets: Assets,
  ): ExportState {
    if (this.current.state === 'running') throw new Error('An export is already running.');
    checkMedia(seq, assets);
    this.controller = new AbortController();
    this.set(
      { state: 'running', progress: 0, path, sequenceName: seq.name, startedAt: Date.now() },
      true,
    );
    void this.run(seq, path, settings, toolchain, assets, this.controller.signal);
    return this.current;
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Renders one frame through the export graph and saves it as PNG or JPEG. */
  async frame(
    seq: Sequence,
    time: number,
    path: string,
    toolchain: () => Promise<ExportToolchain>,
    assets: Assets,
  ): Promise<void> {
    checkMedia(seq, assets);
    const { bins, tonemap } = await toolchain();
    const work = await mkdtemp(join(tmpdir(), 'recit-frame-'));
    const jpeg = /\.jpe?g$/i.test(path);
    const part = join(work, jpeg ? 'frame.jpg' : 'frame.png');
    try {
      const plan = planFrame(seq, assets, time, { tonemap });
      await runPlan(bins.ffmpeg, plan, work, [...(jpeg ? ['-q:v', '2'] : []), part]);
      await rm(path, { force: true });
      await rename(part, path).catch(async () => {
        // rename fails across drives on Windows; fall back to copy + delete.
        const { copyFile } = await import('node:fs/promises');
        await copyFile(part, path);
      });
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async run(
    seq: Sequence,
    path: string,
    settings: ExportSettings,
    toolchain: () => Promise<ExportToolchain>,
    assets: Assets,
    signal: AbortSignal,
  ): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'recit-export-'));
    const part = `${path}.part`;
    try {
      const { bins, ffmpeg, tonemap } = await toolchain();
      let encoder = pickExportEncoder(settings.codec, settings.encoder, ffmpeg);
      if (!encoder)
        throw new Error(
          settings.codec === 'hevc'
            ? 'No H.265 (HEVC) encoder is available in this FFmpeg build. Choose H.264 instead.'
            : 'No H.264 encoder is available. Run "pnpm fetch-ffmpeg" and restart Rec-It.',
        );

      // Pass 1: measure loudness of the final mix, so pass 2 can apply one exact, linear gain.
      let measured: LoudnessMeasurement | null = null;
      const analyse = settings.loudness !== null && hasAudibleContent(seq, assets);
      if (analyse) {
        this.set({ ...this.current, phase: 'analysing' }, true);
        const analysis = planLoudnessAnalysis(seq, assets, settings.loudness!);
        const stderr = await runPlan(bins.ffmpeg, analysis, work, ['-f', 'null', '-'], {
          signal,
          onProgress: (p) => this.set({ ...this.current, progress: p * ANALYSIS_SHARE }),
        });
        measured = parseLoudnorm(stderr);
      }
      const base = analyse ? ANALYSIS_SHARE : 0;

      const encode = async (enc: ExportEncoder) => {
        const plan = planExport(seq, assets, {
          encoder: enc,
          quality: settings.quality,
          tonemap,
          scale: settings.scale,
          audioBitrateK: settings.audioBitrate,
          title: seq.name,
          // Silence measures as nothing to normalise; leave it alone.
          loudness:
            settings.loudness === null || !measured
              ? null
              : { target: settings.loudness, measured },
        });
        this.set(
          {
            ...this.current,
            phase: 'encoding',
            encoder: encoderLabel(enc),
            width: plan.width,
            height: plan.height,
          },
          true,
        );
        await runPlan(bins.ffmpeg, plan, work, ['-f', 'mp4', part], {
          signal,
          onProgress: (p) => this.set({ ...this.current, progress: base + p * (1 - base) }),
        });
      };

      try {
        await encode(encoder);
      } catch (error) {
        // A graphics-card encoder that fails straight away (driver, session limit, missing
        // hardware) is retried once in software rather than failing the export.
        if (signal.aborted || error instanceof CancelledError || isSoftwareEncoder(encoder))
          throw error;
        if (this.current.progress > base + 0.05 * (1 - base)) throw error;
        const fallback = ENCODERS[settings.codec].cpu;
        if (!ffmpeg.encoders[fallback]) throw error;
        this.set(
          {
            ...this.current,
            note: `${encoderLabel(encoder)} could not encode this video, so the software encoder was used.`,
          },
          true,
        );
        encoder = fallback;
        await rm(part, { force: true });
        await encode(encoder);
      }

      await rm(path, { force: true });
      await rename(part, path);
      const size = (await stat(path)).size;
      this.set(
        {
          ...this.current,
          state: 'done',
          progress: 1,
          phase: undefined,
          sizeBytes: size,
          finishedAt: Date.now(),
        },
        true,
      );
    } catch (error) {
      await rm(part, { force: true }).catch(() => {});
      if (error instanceof CancelledError || signal.aborted) {
        this.set({ ...this.current, state: 'cancelled', finishedAt: Date.now() }, true);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.set(
          { ...this.current, state: 'failed', error: message, finishedAt: Date.now() },
          true,
        );
      }
    } finally {
      this.controller = null;
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  private set(state: ExportState, force = false): void {
    this.current = state;
    const now = Date.now();
    if (force || now - this.lastEmit > 200) {
      this.lastEmit = now;
      this.onChange(state);
    }
  }
}
