import { app, BrowserWindow } from 'electron';
import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { userInfo } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { IMPORT_EXTENSIONS, type ProDownFile, type ProDownLibraryItem } from '@rec-it/ipc-contract';
import { IPC } from '../shared/bridge';

/**
 * Link with ProDown, the user's separate downloader app (ADR-040).
 *
 * - ProDown sends finished downloads over a local named pipe (Unix socket on macOS); Rec-It
 *   queues them and tells the renderer, which offers them through the normal rights dialog.
 *   Nothing is imported without the user's click.
 * - Videos sent while Rec-It was closed wait in ProDown's recit-outbox.json and are picked up here.
 * - The "Import from ProDown" window reads ProDown's library.json (read-only).
 *
 * Only paths to existing files with importable extensions are accepted. No TCP port is opened.
 */

const MAX_FILES = 50;

function safeUser(): string {
  try {
    return userInfo().username.replace(/[^\w.-]/g, '_') || 'user';
  } catch {
    return 'user';
  }
}

/** Must match ProDown's src/main/paths.ts recitPipe(). */
export function prodownPipe(): string {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\recit-prodown-${safeUser()}`
    : join(app.getPath('appData'), 'Rec-It', 'prodown.sock');
}

function prodownDataDir(): string {
  return process.env.RECIT_PRODOWN_DATA ?? join(app.getPath('appData'), 'ProDown');
}

const allowed = new Set<string>(IMPORT_EXTENSIONS.map((e) => `.${e.toLowerCase()}`));

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

/** Keeps only well-formed entries that point at an existing, importable file. */
export function cleanFiles(input: unknown): ProDownFile[] {
  if (!Array.isArray(input)) return [];
  const out: ProDownFile[] = [];
  for (const raw of input.slice(0, MAX_FILES)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const path = str(r.path, 4096);
    if (!path || !isAbsolute(path) || !allowed.has(extname(path).toLowerCase())) continue;
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const url = str(r.url, 2000);
    out.push({
      path,
      title: str(r.title, 500) ?? path.split(/[\\/]/).pop() ?? path,
      url: url && /^https?:\/\//.test(url) ? url : undefined,
      channel: str(r.channel, 200),
      qualityLabel: str(r.qualityLabel, 40),
    });
  }
  return out;
}

export class ProDownLink {
  private queue: ProDownFile[] = [];
  private server: Server | null = null;

  constructor(private getWindow: () => BrowserWindow | undefined) {}

  start(): void {
    this.collectOutbox();
    const path = prodownPipe();
    if (process.platform !== 'win32' && existsSync(path)) rmSync(path, { force: true });
    const server = createServer((socket) => this.handle(socket));
    server.on('error', (e) => console.warn('[prodown] link unavailable:', e.message));
    server.listen(path);
    this.server = server;
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  /** Files waiting to be imported. `peek` leaves them queued. */
  take(peek: boolean): ProDownFile[] {
    this.collectOutbox();
    const files = [...this.queue];
    if (!peek) this.queue = [];
    return files;
  }

  /** ProDown's library, newest first, for the "Import from ProDown" window. */
  library(): { installed: boolean; items: ProDownLibraryItem[] } {
    const file = join(prodownDataDir(), 'library.json');
    if (!existsSync(file)) return { installed: existsSync(prodownDataDir()), items: [] };
    let data: { items?: unknown[] } = {};
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as { items?: unknown[] };
    } catch {
      return { installed: true, items: [] };
    }
    const raw = Array.isArray(data.items) ? data.items.slice(0, 500) : [];
    const items: ProDownLibraryItem[] = [];
    for (const entry of raw) {
      const [clean] = cleanFiles([
        { ...(entry as object), path: (entry as { filePath?: unknown }).filePath },
      ]);
      if (!clean) continue;
      const e = entry as Record<string, unknown>;
      items.push({
        ...clean,
        sizeBytes: typeof e.sizeBytes === 'number' ? e.sizeBytes : 0,
        durationSec: typeof e.durationSec === 'number' ? e.durationSec : 0,
        createdAt: str(e.createdAt, 40) ?? '',
      });
    }
    return { installed: true, items };
  }

  private add(files: ProDownFile[]): void {
    for (const f of files) {
      if (!this.queue.some((q) => q.path === f.path)) this.queue.push(f);
    }
    const win = this.getWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.prodownIncoming);
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  }

  /** Moves recit-outbox.json aside before reading, so ProDown can never write into a file being read. */
  private collectOutbox(): void {
    const outbox = join(prodownDataDir(), 'recit-outbox.json');
    if (!existsSync(outbox)) return;
    const taking = `${outbox}.taking-${process.pid}`;
    try {
      renameSync(outbox, taking);
      const data = JSON.parse(readFileSync(taking, 'utf8')) as { files?: unknown };
      for (const f of cleanFiles(data.files)) {
        if (!this.queue.some((q) => q.path === f.path)) this.queue.push(f);
      }
    } catch (e) {
      console.warn('[prodown] could not read the outbox:', e);
    } finally {
      rmSync(taking, { force: true });
    }
  }

  private handle(socket: Socket): void {
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('error', () => socket.destroy());
    socket.on('data', (chunk: string) => {
      buf += chunk;
      if (buf.length > 1_000_000) {
        socket.destroy();
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const reply = (body: object) => socket.end(`${JSON.stringify(body)}\n`);
      try {
        const msg = JSON.parse(buf.slice(0, nl)) as { type?: unknown; files?: unknown };
        if (msg.type === 'ping')
          return reply({ ok: true, app: 'rec-it', version: app.getVersion() });
        if (msg.type === 'import') {
          const files = cleanFiles(msg.files);
          if (!files.length)
            return reply({ ok: false, error: 'None of the files exist or can be imported.' });
          this.add(files);
          return reply({ ok: true, accepted: files.length });
        }
        reply({ ok: false, error: 'Unknown message' });
      } catch {
        reply({ ok: false, error: 'Bad message' });
      }
    });
  }
}
