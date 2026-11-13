import { spawn, type ChildProcess } from 'node:child_process';

/** Every FFmpeg process currently running, so they can all be stopped if the app dies. */
const running = new Set<ChildProcess>();

let tracker: ((pids: number[]) => void) | null = null;

/**
 * Called with the current FFmpeg process ids whenever one starts or ends. The backend writes
 * them to disk so a later start can end FFmpeg processes orphaned by a crash (ADR-024).
 */
export function setFfmpegTracker(fn: ((pids: number[]) => void) | null): void {
  tracker = fn;
}

function track(): void {
  tracker?.([...running].map((c) => c.pid).filter((p): p is number => typeof p === 'number'));
}

/** Kills all running FFmpeg processes immediately. Safe to call from an 'exit' handler. */
export function killAllFfmpeg(): void {
  for (const child of running) child.kill('SIGKILL');
  running.clear();
  track();
}
import { createInterface } from 'node:readline';

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

export class CancelledError extends Error {
  override name = 'CancelledError';
  constructor() {
    super('Cancelled');
  }
}

export interface RunFfmpegOptions {
  /** Aborting kills FFmpeg and rejects with CancelledError. */
  signal?: AbortSignal;
  /** Expected output duration, used to turn `-progress` output into 0..1. */
  durationSec?: number;
  onProgress?: (fraction: number) => void;
  /** Receives raw stdout chunks when FFmpeg writes data to pipe:1 (progress then goes to pipe:2). */
  onStdout?: (chunk: Buffer) => void;
  /** Working folder (relative file names in filter graphs resolve against it). */
  cwd?: string;
}

/**
 * Parses one line of `-progress` output. Returns seconds processed, or null.
 * FFmpeg writes `out_time_us=…` (older builds: `out_time_ms=…`, which is also microseconds).
 */
export function parseProgressLine(line: string): number | null {
  const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
  return m ? Number(m[1]) / 1_000_000 : null;
}

/**
 * Runs FFmpeg with an argument array (never a shell). Progress is read from `-progress`,
 * which this function adds. stderr is kept (last 4 KB) for error messages.
 */
export function runFfmpeg(
  ffmpeg: string,
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<{ stderrTail: string }> {
  const { signal, durationSec, onProgress, onStdout } = options;
  if (signal?.aborted) return Promise.reject(new CancelledError());
  const progressTarget = onStdout ? 'pipe:2' : 'pipe:1';
  const fullArgs = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-progress',
    progressTarget,
    '-nostats',
    ...args,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, fullArgs, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running.add(child);
    track();
    let stderrTail = '';
    let cancelled = false;

    // Kill immediately: a polite SIGTERM makes FFmpeg flush its encoder, which can take seconds.
    // Partial output is deleted by the caller, so nothing is lost.
    const onAbort = () => {
      cancelled = true;
      child.kill('SIGKILL');
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleProgress = (line: string) => {
      const seconds = parseProgressLine(line);
      if (seconds !== null && durationSec && durationSec > 0 && onProgress) {
        onProgress(Math.min(1, Math.max(0, seconds / durationSec)));
      }
    };

    if (onStdout) {
      child.stdout.on('data', onStdout);
    } else {
      createInterface({ input: child.stdout }).on('line', handleProgress);
    }
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-4096);
      if (onStdout) for (const line of text.split(/\r?\n/)) handleProgress(line);
    });

    child.on('error', (error) => {
      running.delete(child);
      track();
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      running.delete(child);
      track();
      signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code === 0) {
        onProgress?.(1);
        return resolve({ stderrTail });
      }
      const lastLines = stderrTail
        .split(/\r?\n/)
        .filter((l) => l.trim() && !/^\w+=/.test(l))
        .slice(-3)
        .join(' ');
      reject(
        new FfmpegError(
          `FFmpeg failed (exit ${code}): ${lastLines || 'no details'}`,
          code,
          stderrTail,
        ),
      );
    });
  });
}
