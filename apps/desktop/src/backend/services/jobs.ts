import type { JobKind } from '@rec-it/ipc-contract';
import { CancelledError } from '@rec-it/ffmpeg';

export type JobRunState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobContext {
  signal: AbortSignal;
  progress(fraction: number): void;
}

export interface JobSpec {
  /** Unique per asset and kind, e.g. "asset_x:proxy". */
  id: string;
  kind: JobKind;
  assetId: string;
  run(ctx: JobContext): Promise<void>;
}

export interface JobUpdate {
  spec: JobSpec;
  state: JobRunState;
  progress: number;
  error?: string;
}

interface Entry {
  spec: JobSpec;
  state: JobRunState;
  progress: number;
  controller: AbortController;
  done: Promise<void>;
  resolve: () => void;
}

/**
 * Runs media jobs with a concurrency limit per kind (ARCHITECTURE §10.4). Jobs can be
 * cancelled while queued or running; cancellation aborts the job's FFmpeg process.
 */
export class JobQueue {
  private readonly entries = new Map<string, Entry>();
  private readonly running = new Map<JobKind, number>();
  private disposed = false;

  constructor(
    private readonly limits: Record<JobKind, number>,
    private readonly onUpdate: (update: JobUpdate) => void,
  ) {}

  /** Adds a job unless one with the same id is already queued or running. Returns its completion. */
  enqueue(spec: JobSpec): Promise<void> {
    const existing = this.entries.get(spec.id);
    if (existing && (existing.state === 'pending' || existing.state === 'running'))
      return existing.done;
    let resolve!: () => void;
    const done = new Promise<void>((r) => (resolve = r));
    const entry: Entry = {
      spec,
      state: 'pending',
      progress: 0,
      controller: new AbortController(),
      done,
      resolve,
    };
    this.entries.set(spec.id, entry);
    this.onUpdate({ spec, state: 'pending', progress: 0 });
    this.pump();
    return done;
  }

  /** Cancels matching queued and running jobs. */
  cancel(predicate: (spec: JobSpec) => boolean): void {
    for (const entry of this.entries.values()) {
      if (!predicate(entry.spec)) continue;
      if (entry.state === 'pending') {
        this.finish(entry, 'cancelled');
      } else if (entry.state === 'running') {
        entry.controller.abort();
      }
    }
  }

  /** Cancels everything and waits for running jobs to stop. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const pending = [...this.entries.values()].map((e) => e.done);
    this.cancel(() => true);
    await Promise.all(pending);
  }

  active(): { spec: JobSpec; state: JobRunState; progress: number }[] {
    return [...this.entries.values()]
      .filter((e) => e.state === 'pending' || e.state === 'running')
      .map((e) => ({ spec: e.spec, state: e.state, progress: e.progress }));
  }

  private pump(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'pending') continue;
      const kind = entry.spec.kind;
      const busy = this.running.get(kind) ?? 0;
      if (busy >= this.limits[kind]) continue;
      this.running.set(kind, busy + 1);
      void this.start(entry);
    }
  }

  private async start(entry: Entry): Promise<void> {
    entry.state = 'running';
    this.onUpdate({ spec: entry.spec, state: 'running', progress: 0 });
    try {
      await entry.spec.run({
        signal: entry.controller.signal,
        progress: (fraction) => {
          if (entry.state !== 'running') return;
          entry.progress = fraction;
          this.onUpdate({ spec: entry.spec, state: 'running', progress: fraction });
        },
      });
      if (entry.controller.signal.aborted) throw new CancelledError();
      this.finish(entry, 'done');
    } catch (error) {
      if (error instanceof CancelledError || entry.controller.signal.aborted)
        this.finish(entry, 'cancelled');
      else this.finish(entry, 'failed', error instanceof Error ? error.message : String(error));
    } finally {
      this.running.set(entry.spec.kind, (this.running.get(entry.spec.kind) ?? 1) - 1);
      this.pump();
    }
  }

  private finish(entry: Entry, state: 'done' | 'failed' | 'cancelled', error?: string): void {
    entry.state = state;
    if (state === 'done') entry.progress = 1;
    this.entries.delete(entry.spec.id);
    this.onUpdate({
      spec: entry.spec,
      state,
      progress: entry.progress,
      ...(error ? { error } : {}),
    });
    entry.resolve();
  }
}
