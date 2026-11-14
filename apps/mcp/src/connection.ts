// The bridge's side of the local link to Rec-It (ADR-044): finds the running app through the
// discovery file in its user-data folder, connects to its pipe/socket and authenticates with the
// token. One connection, reused; reconnects when Rec-It restarts.
import { readFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ENDPOINT_FILE,
  LineReader,
  PROTOCOL_VERSION,
  userDataDir,
  type BridgeRequest,
  type BridgeResponse,
  type EndpointInfo,
  type ToolResult,
} from '@rec-it/tools/protocol';

export const VERSION = '0.1.0';
/** Long enough for the user to answer a confirmation in Rec-It (it gives up after 5 minutes). */
const CALL_TIMEOUT_MS = 6 * 60_000;
const RETRY_MS = 3000;

export const NOT_RUNNING =
  'Rec-It is not open. Ask the user to start Rec-It and open their project, then try again.';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RecItConnection {
  private socket: Socket | null = null;
  private connecting: Promise<Socket> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private retry: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly options: {
      clientName: () => string;
      dataDir?: string;
    },
  ) {}

  private endpoint(): EndpointInfo | null {
    const dir = this.options.dataDir ?? userDataDir(process.platform, process.env, homedir(), join);
    try {
      const info = JSON.parse(readFileSync(join(dir, ENDPOINT_FILE), 'utf8')) as EndpointInfo;
      return info.protocol === PROTOCOL_VERSION && info.path && info.token ? info : null;
    } catch {
      return null;
    }
  }

  /** Stays connected in the background (so Rec-It shows Claude as connected). */
  keepAlive(): void {
    if (this.closed || this.retry) return;
    const tick = () => {
      this.retry = null;
      if (this.closed) return;
      if (this.socket) return;
      this.open().then(
        () => {},
        () => {
          this.retry = setTimeout(tick, RETRY_MS);
          this.retry.unref();
        },
      );
    };
    tick();
  }

  private open(): Promise<Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    this.connecting ??= new Promise<Socket>((resolve, reject) => {
      const info = this.endpoint();
      if (!info) {
        reject(new Error(NOT_RUNNING));
        return;
      }
      const socket = connect(info.path);
      socket.setEncoding('utf8');
      const reader = new LineReader();
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };
      socket.once('error', () => fail(new Error(NOT_RUNNING)));
      socket.on('data', (chunk: string) => {
        let messages: unknown[];
        try {
          messages = reader.push(chunk);
        } catch {
          socket.destroy();
          return;
        }
        for (const m of messages) this.receive(m as BridgeResponse);
      });
      socket.on('close', () => {
        const wasOpen = this.socket === socket;
        if (wasOpen) this.socket = null;
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('Rec-It closed the connection (it may have quit).'));
          this.pending.delete(id);
        }
        if (wasOpen && !this.closed) this.keepAlive();
      });
      socket.once('connect', () => {
        this.request(socket, {
          id: this.nextId++,
          method: 'hello',
          params: {
            token: info.token,
            protocol: PROTOCOL_VERSION,
            client: { name: this.options.clientName(), version: VERSION },
          },
        }).then(() => {
          socket.removeAllListeners('error');
          socket.on('error', () => socket.destroy());
          this.socket = socket;
          resolve(socket);
        }, fail);
      });
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private request(socket: Socket, message: BridgeRequest, timeout = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error('Rec-It did not answer in time.'));
      }, timeout);
      this.pending.set(message.id, { resolve, reject, timer });
      socket.write(`${JSON.stringify(message)}\n`);
    });
  }

  private receive(m: BridgeResponse): void {
    const p = this.pending.get(m.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(m.id);
    if ('error' in m) p.reject(new Error(m.error.message));
    else p.resolve(m.result);
  }

  /** Runs a tool in Rec-It. */
  async call(name: string, args: unknown): Promise<ToolResult> {
    const socket = await this.open();
    return (await this.request(
      socket,
      { id: this.nextId++, method: 'call', params: { name, arguments: args } },
      CALL_TIMEOUT_MS,
    )) as ToolResult;
  }

  close(): void {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
  }
}
