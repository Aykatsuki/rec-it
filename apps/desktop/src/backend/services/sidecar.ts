import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { SidecarStatus } from '@rec-it/ipc-contract';

export interface SidecarCommand {
  command: string;
  args: string[];
  cwd: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SidecarError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'SidecarError';
  }
}

/**
 * JSON-RPC 2.0 client for the Python media-ai sidecar over stdio (ADR-014).
 * One long-lived process; requests are matched to replies by id.
 */
export class SidecarClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private spawnError: Error | null = null;

  constructor(
    private readonly cmd: SidecarCommand,
    private readonly log: (line: string) => void = (l) => console.info(l),
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  start(): void {
    if (this.child) return;
    this.spawnError = null;
    const child = spawn(this.cmd.command, this.cmd.args, {
      cwd: this.cmd.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    });
    this.child = child;
    child.on('error', (error) => {
      this.spawnError = error;
      this.failAll(new SidecarError(`Could not start the media-ai sidecar: ${error.message}`));
      this.child = null;
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.failAll(new SidecarError(`media-ai sidecar exited (${signal ?? `code ${code}`})`));
    });
    createInterface({ input: child.stderr }).on('line', (line) => this.log(line));
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
  }

  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.child) {
      return Promise.reject(this.spawnError ?? new SidecarError('media-ai sidecar is not running'));
    }
    const id = this.nextId++;
    const child = this.child;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new SidecarError(`media-ai "${method}" timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      setTimeout(() => {
        if (child.exitCode === null) child.kill();
      }, 2000).unref();
    }
    this.failAll(new SidecarError('media-ai sidecar stopped'));
  }

  private onLine(line: string): void {
    let message: { id?: unknown; result?: unknown; error?: { code?: number; message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.log(`[sidecar] ignored non-JSON output: ${line.slice(0, 200)}`);
      return;
    }
    if (typeof message.id !== 'number') return; // notifications are handled from Phase 4
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error)
      entry.reject(new SidecarError(message.error.message ?? 'Unknown error', message.error.code));
    else entry.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

/** Starts the sidecar if needed and asks for its version and hardware info. */
export async function checkSidecar(client: SidecarClient | null): Promise<SidecarStatus> {
  if (!client) return { state: 'missing', gpus: [], message: 'The media-ai sidecar is disabled.' };
  try {
    client.start();
    // The first `uv run` creates the Python environment, which can take a while.
    const version = await client.request<{ version: string; python: string }>(
      'version',
      {},
      180_000,
    );
    const info = await client.request<{ gpus: SidecarStatus['gpus']; cuda: SidecarStatus['cuda'] }>(
      'system.info',
      {},
      30_000,
    );
    return {
      state: 'ok',
      version: version.version,
      python: version.python,
      gpus: info.gpus,
      cuda: info.cuda,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /ENOENT/.test(message);
    return {
      state: missing ? 'missing' : 'error',
      gpus: [],
      message: missing
        ? 'Python sidecar could not start: "uv" was not found. Install uv (see CONTRIBUTING.md) or set RECIT_UV_PATH.'
        : message,
    };
  }
}
