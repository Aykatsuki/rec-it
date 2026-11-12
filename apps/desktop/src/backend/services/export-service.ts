import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Sequence } from '@rec-it/core';
import { CancelledError, runFfmpeg } from '@rec-it/ffmpeg';
import type { ExportState } from '@rec-it/ipc-contract';
import {
  planExport,
  type ExportAsset,
  type ExportEncoder,
  type ExportQuality,
} from '@rec-it/render-plan';
import type { Toolchain } from './media-service';

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
    quality: ExportQuality,
    toolchain: () => Promise<Toolchain>,
    assets: (id: string) => ExportAsset | undefined,
  ): ExportState {
    if (this.current.state === 'running') throw new Error('An export is already running.');
    const missing = new Set<string>();
    for (const track of seq.tracks) {
      for (const item of track.items) {
        const asset = assets(item.assetId);
        if (!asset || !existsSync(asset.path))
          missing.add(asset ? basename(asset.path) : item.assetId);
      }
    }
    if (missing.size)
      throw new Error(
        `Some media is missing: ${[...missing].join(', ')}. Locate it in Media first.`,
      );

    this.controller = new AbortController();
    this.set(
      { state: 'running', progress: 0, path, sequenceName: seq.name, startedAt: Date.now() },
      true,
    );
    void this.run(seq, path, quality, toolchain, assets, this.controller.signal);
    return this.current;
  }

  cancel(): void {
    this.controller?.abort();
  }

  private async run(
    seq: Sequence,
    path: string,
    quality: ExportQuality,
    toolchain: () => Promise<Toolchain>,
    assets: (id: string) => ExportAsset | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const work = await mkdtemp(join(tmpdir(), 'recit-export-'));
    const part = `${path}.part`;
    try {
      const { bins, encoder, tonemap } = await toolchain();
      const plan = planExport(seq, assets, { encoder: encoder as ExportEncoder, quality, tonemap });
      this.set({ ...this.current, encoder }, true);
      // The graph goes in a file: long timelines would exceed Windows' command-line limit.
      const graphFile = join(work, 'graph.txt');
      await writeFile(graphFile, plan.filterGraph);
      await runFfmpeg(
        bins.ffmpeg,
        [...plan.inputArgs, '-/filter_complex', graphFile, ...plan.outputArgs, '-f', 'mp4', part],
        {
          signal,
          durationSec: plan.durationSec,
          onProgress: (p) => this.set({ ...this.current, progress: p }),
        },
      );
      await rm(path, { force: true });
      await rename(part, path);
      this.set({ ...this.current, state: 'done', progress: 1, finishedAt: Date.now() }, true);
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
