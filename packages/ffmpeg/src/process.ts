import { spawn } from 'node:child_process';
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
): Promise<void> {
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
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (cancelled) return reject(new CancelledError());
      if (code === 0) {
        onProgress?.(1);
        return resolve();
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
