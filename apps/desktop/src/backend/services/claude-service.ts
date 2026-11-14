// The Claude connector's backend side (ARCHITECTURE §13, ADR-044): a local endpoint the MCP
// bridge connects to, Claude's edits grouped into change cards, confirmations for heavy tools
// and the activity feed. Claude never reaches anything but the tools in packages/tools.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createId } from '@rec-it/core';
import { findTool } from '@rec-it/tools';
import {
  ENDPOINT_FILE,
  LineReader,
  PROTOCOL_VERSION,
  type BridgeRequest,
  type BridgeResponse,
  type EndpointInfo,
  type ToolResult,
} from '@rec-it/tools/protocol';
import type {
  ClaudeActivity,
  ClaudeChange,
  ClaudeConfirmation,
  ClaudeState,
} from '@rec-it/ipc-contract';
import { runTool, type ToolContext } from './claude-tools';

/** Claude's edits within this long of each other share one change card / undo step. */
export const GROUP_WINDOW_MS = 60_000;
/** Unanswered confirmations count as "no". */
export const CONFIRM_TIMEOUT_MS = 5 * 60_000;
const MAX_ACTIVITY = 200;
const MAX_CHANGES = 30;

export interface ClaudeDeps {
  userDataDir: string;
  appVersion: string;
  enabled(): boolean;
  /** The tools' view of the open project; `execute` gets the change group to use. */
  tools(execute: ToolContext['execute']): Omit<ToolContext, 'execute' | 'confirm'>;
  /** Applies a command in an undo group; `changed` is false for a no-op. */
  execute: (
    command: Parameters<ToolContext['execute']>[0],
    group: string,
  ) => { version: number; changed: boolean };
  topGroup(): string | undefined;
  undoGroup(group: string): void;
  setup: ClaudeState['setup'];
  onChange(state: ClaudeState): void;
  now?: () => number;
}

interface Client {
  id: string;
  name: string;
  since: number;
  socket: Socket;
}

export class ClaudeService {
  private server: Server | null = null;
  private endpoint: EndpointInfo | null = null;
  private error: string | undefined;
  private readonly clients = new Map<string, Client>();
  private activity: ClaudeActivity[] = [];
  private changes: ClaudeChange[] = [];
  private readonly pending = new Map<
    string,
    { confirmation: ClaudeConfirmation; resolve: (allow: boolean) => void; timer: NodeJS.Timeout }
  >();
  /** The change card Claude's next edit joins, while it is recent and on top of the undo stack. */
  private current: { group: string; at: number } | null = null;

  constructor(private readonly d: ClaudeDeps) {}

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  // ---- Endpoint ------------------------------------------------------------------------------

  /** Starts listening and writes the discovery file. Failure leaves Claude unavailable only. */
  async listen(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const name = `recit-mcp-${randomBytes(6).toString('hex')}`;
    const path =
      process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
    const server = createServer((socket) => this.accept(socket, token));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.off('error', reject);
          resolve();
        });
      });
      if (process.platform !== 'win32') chmodSync(path, 0o600);
      this.endpoint = {
        protocol: PROTOCOL_VERSION,
        path,
        token,
        pid: process.pid,
        appVersion: this.d.appVersion,
      };
      writeFileSync(this.endpointFile(), JSON.stringify(this.endpoint), { mode: 0o600 });
      this.server = server;
      this.error = undefined;
    } catch (error) {
      server.close();
      this.error = `The Claude connector could not start: ${error instanceof Error ? error.message : String(error)}`;
      console.error(this.error);
    }
    this.changed();
  }

  private endpointFile() {
    return join(this.d.userDataDir, ENDPOINT_FILE);
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
    for (const c of this.clients.values()) c.socket.destroy();
    this.clients.clear();
    // Only remove the discovery file if it is still ours (another Rec-It may have started).
    try {
      const file = this.endpointFile();
      if (
        this.endpoint &&
        existsSync(file) &&
        (JSON.parse(readFileSync(file, 'utf8')) as EndpointInfo).token === this.endpoint.token
      )
        rmSync(file, { force: true });
    } catch {
      // best effort
    }
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private accept(socket: Socket, token: string): void {
    socket.setEncoding('utf8');
    const reader = new LineReader();
    let client: Client | null = null;
    const send = (m: BridgeResponse) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    };
    // Unauthenticated connections get a few seconds to say hello.
    const helloTimer = setTimeout(() => {
      if (!client) socket.destroy();
    }, 5000);
    socket.on('data', (chunk: string) => {
      let messages: unknown[];
      try {
        messages = reader.push(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const raw of messages) {
        const m = raw as BridgeRequest;
        if (typeof m !== 'object' || m === null || typeof m.id !== 'number') {
          socket.destroy();
          return;
        }
        if (!client) {
          if (m.method !== 'hello' || !sameToken(m.params?.token, token)) {
            send({ id: m.id, error: { message: 'Not authorised.' } });
            socket.end();
            socket.destroy();
            return;
          }
          clearTimeout(helloTimer);
          client = {
            id: createId('client'),
            name: String(m.params.client?.name ?? 'Claude').slice(0, 60),
            since: this.now(),
            socket,
          };
          this.clients.set(client.id, client);
          send({ id: m.id, result: { protocol: PROTOCOL_VERSION, appVersion: this.d.appVersion } });
          this.changed();
          continue;
        }
        if (m.method !== 'call') {
          send({ id: m.id, error: { message: 'Unknown method.' } });
          continue;
        }
        void this.call(String(m.params?.name), m.params?.arguments).then(
          (result) => send({ id: m.id, result }),
          (error: unknown) =>
            send({
              id: m.id,
              error: { message: error instanceof Error ? error.message : 'Failed.' },
            }),
        );
      }
    });
    const gone = () => {
      clearTimeout(helloTimer);
      if (client && this.clients.delete(client.id)) this.changed();
    };
    socket.on('close', gone);
    socket.on('error', gone);
  }

  // ---- Tools ---------------------------------------------------------------------------------

  /** Runs a tool for Claude, recording it in the activity feed. */
  async call(name: string, args: unknown): Promise<ToolResult> {
    const def = findTool(name);
    const title = def?.title ?? name;
    if (!this.d.enabled()) {
      this.log(name, title, 'Refused: Claude is turned off in Settings.', 'denied');
      return {
        content: [
          {
            type: 'text',
            text: 'Claude is turned off in Rec-It (Settings → Claude). Ask the user to turn it on.',
          },
        ],
        isError: true,
      };
    }
    let lastSummary = '';
    let group: string | undefined;
    const execute: ToolContext['execute'] = (command, summary) => {
      const g = this.groupForEdit();
      const { version, changed } = this.d.execute(command, g);
      if (changed) {
        group = g;
        this.recordEdit(g, summary);
        lastSummary = summary;
      }
      return version;
    };
    const ctx: ToolContext = {
      ...this.d.tools(execute),
      execute,
      confirm: (tool, t, detail) => this.confirm(tool, t, detail),
    };
    try {
      const result = await runTool(name, args, ctx);
      const first = result.content.find((c) => c.type === 'text');
      const detail = result.isError
        ? first?.type === 'text'
          ? first.text.split('\n')[0]!
          : 'Failed'
        : lastSummary || readSummary(name, args);
      this.log(name, title, detail.slice(0, 200), result.isError ? 'error' : 'ok', group);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(name, title, message.slice(0, 200), 'error', group);
      return { content: [{ type: 'text', text: message }], isError: true };
    }
  }

  /** The group for Claude's next edit: the current card if recent and still on top, else a new one. */
  private groupForEdit(): string {
    const now = this.now();
    const card = this.current && this.changes.find((c) => c.group === this.current!.group);
    if (
      this.current &&
      card?.state === 'open' &&
      now - this.current.at <= GROUP_WINDOW_MS &&
      this.d.topGroup() === this.current.group
    ) {
      this.current.at = now;
      return this.current.group;
    }
    this.current = { group: createId('change'), at: now };
    return this.current.group;
  }

  private recordEdit(group: string, summary: string): void {
    const now = this.now();
    let card = this.changes.find((c) => c.group === group);
    if (!card) {
      card = { group, startedAt: now, updatedAt: now, edits: [], state: 'open', canUndo: true };
      this.changes.unshift(card);
      this.changes = this.changes.slice(0, MAX_CHANGES);
    }
    card.edits.push(summary);
    card.updatedAt = now;
    this.refreshUndo();
  }

  private log(
    tool: string,
    title: string,
    detail: string,
    status: ClaudeActivity['status'],
    group?: string,
  ): void {
    this.activity.unshift({
      id: createId('act'),
      at: this.now(),
      tool,
      title,
      detail,
      status,
      ...(group ? { group } : {}),
    });
    this.activity = this.activity.slice(0, MAX_ACTIVITY);
    this.changed();
  }

  private confirm(tool: string, title: string, detail: string): Promise<boolean> {
    const id = createId('confirm');
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.respond(id, false), CONFIRM_TIMEOUT_MS);
      this.pending.set(id, { confirmation: { id, tool, title, detail }, resolve, timer });
      this.changed();
    });
  }

  // ---- Renderer actions ----------------------------------------------------------------------

  respond(id: string, allow: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(allow);
    if (!allow) this.log(p.confirmation.tool, p.confirmation.title, 'Declined by you.', 'denied');
    this.changed();
  }

  undoChange(group: string): void {
    const card = this.changes.find((c) => c.group === group);
    if (!card || card.state !== 'open') throw new Error('Those changes are no longer open.');
    this.d.undoGroup(group);
    card.state = 'undone';
    if (this.current?.group === group) this.current = null;
    this.refreshUndo();
    this.changed();
  }

  keepChange(group: string): void {
    const card = this.changes.find((c) => c.group === group);
    if (!card) return;
    if (card.state === 'open') card.state = 'kept';
    if (this.current?.group === group) this.current = null;
    this.refreshUndo();
    this.changed();
  }

  clearActivity(): void {
    this.activity = [];
    this.changes = this.changes.filter((c) => c.state === 'open');
    this.changed();
  }

  /** Called on every document change (also the user's own edits and undo). */
  documentChanged(): void {
    if (this.refreshUndo()) this.changed();
  }

  /** A different project: earlier cards no longer apply. */
  projectChanged(): void {
    this.changes = [];
    this.current = null;
    this.changed();
  }

  private refreshUndo(): boolean {
    const top = this.d.topGroup();
    let dirty = false;
    for (const c of this.changes) {
      const canUndo = c.state === 'open' && c.group === top;
      if (c.canUndo !== canUndo) {
        c.canUndo = canUndo;
        dirty = true;
      }
    }
    return dirty;
  }

  state(): ClaudeState {
    return {
      enabled: this.d.enabled(),
      listening: this.server !== null,
      clients: [...this.clients.values()].map(({ id, name, since }) => ({ id, name, since })),
      setup: this.d.setup,
      ...(this.error ? { error: this.error } : {}),
      activity: this.activity,
      changes: this.changes,
      confirmations: [...this.pending.values()].map((p) => p.confirmation),
    };
  }

  changed(): void {
    this.d.onChange(this.state());
  }
}

function sameToken(given: unknown, token: string): boolean {
  if (typeof given !== 'string' || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
}

/** A line for the activity feed for read tools. */
function readSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const range =
    a.start !== undefined || a.end !== undefined
      ? ` ${String(a.start ?? 0)}–${a.end === undefined ? 'end' : String(a.end)} s`
      : '';
  switch (name) {
    case 'get_project_summary':
      return 'Read the project outline';
    case 'get_sequence':
      return `Read the timeline${range}`;
    case 'get_transcript':
      return `Read the transcript${range}`;
    case 'search_transcript':
      return `Searched the transcript for "${String(a.query).slice(0, 40)}"`;
    case 'get_frame':
      return `Looked at the frame at ${String(a.time)} s`;
    case 'list_caption_styles':
      return 'Read the caption styles';
    case 'get_job_status':
      return 'Checked job progress';
    case 'transcribe_asset':
      return 'Started a transcription';
    case 'export_sequence':
      return 'Started an export';
    default:
      return name;
  }
}
