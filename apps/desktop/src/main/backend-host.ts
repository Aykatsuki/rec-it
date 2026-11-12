import {
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess,
  type WebContents,
} from 'electron';
import { join } from 'node:path';
import { IPC } from '../shared/bridge';
import type { BackendConfig, BackendToMain, MainToBackend } from '../shared/backend-messages';
import type { SecretStore } from './secrets';

const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

/**
 * Starts the backend utilityProcess, restarts it if it crashes (with a limit), and hands
 * each renderer its own MessagePort so renderer ⇄ backend traffic bypasses main.
 */
export class BackendHost {
  private child: UtilityProcess | null = null;
  private readonly restarts: number[] = [];
  private stopping = false;
  private readonly clients = new Set<WebContents>();
  /** Media cache folder reported by the backend; used by the recit-media:// handler. */
  cacheRoot: string | null = null;

  constructor(
    private readonly config: BackendConfig,
    private readonly secrets: SecretStore,
  ) {}

  start(): void {
    const child = utilityProcess.fork(join(__dirname, 'backend.js'), [], {
      serviceName: 'Rec-It Backend',
      stdio: 'pipe',
    });
    this.child = child;
    child.stdout?.on('data', (d: Buffer) => process.stdout.write(prefix(d)));
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(prefix(d)));
    child.on('message', (message: BackendToMain) => {
      if (message.type === 'fatal')
        console.error(`[main] backend reported a fatal error: ${message.message}`);
      if (message.type === 'cacheRoot') this.cacheRoot = message.path;
    });
    child.on('exit', (code) => this.onExit(child, code));

    this.send({ type: 'init', config: this.config });
    void this.pushSecrets();
    for (const contents of this.clients) this.connect(contents);
  }

  /** Creates a fresh channel for a renderer (on first load and after every reload). */
  connect(contents: WebContents): void {
    if (contents.isDestroyed()) return;
    if (!this.clients.has(contents)) {
      this.clients.add(contents);
      contents.once('destroyed', () => this.clients.delete(contents));
    }
    if (!this.child) return;
    const { port1, port2 } = new MessageChannelMain();
    this.child.postMessage({ type: 'connect', windowId: contents.id } satisfies MainToBackend, [
      port1,
    ]);
    contents.postMessage(IPC.backendPort, null, [port2]);
  }

  async pushSecrets(): Promise<void> {
    this.send({ type: 'secrets', values: await this.secrets.readAll() });
  }

  /** Asks the backend to stop its jobs and close databases, waiting up to 3 s. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    const exited = new Promise<boolean>((resolve) => child.once('exit', () => resolve(true)));
    // Ask first: on Windows a forced kill would leave the backend's FFmpeg processes running.
    child.postMessage({ type: 'shutdown' } satisfies MainToBackend);
    const clean = await Promise.race([
      exited,
      new Promise<boolean>((r) => setTimeout(() => r(false), 3000)),
    ]);
    if (!clean) child.kill();
  }

  private send(message: MainToBackend): void {
    this.child?.postMessage(message);
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.stopping) return;
    for (const contents of this.clients)
      if (!contents.isDestroyed()) contents.send(IPC.backendDisconnected);
    const now = Date.now();
    while (this.restarts.length && now - this.restarts[0]! > RESTART_WINDOW_MS)
      this.restarts.shift();
    if (this.restarts.length >= MAX_RESTARTS) {
      console.error(
        `[main] backend exited (code ${code}) ${MAX_RESTARTS} times in a minute; not restarting`,
      );
      return;
    }
    this.restarts.push(now);
    console.warn(`[main] backend exited (code ${code}); restarting`);
    setTimeout(() => this.start(), 500);
  }
}

function prefix(data: Buffer): string {
  return data
    .toString('utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `[backend] ${line}\n`)
    .join('');
}
