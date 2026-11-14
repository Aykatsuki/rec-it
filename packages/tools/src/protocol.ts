// The local connection between the MCP bridge (run by the Claude app) and Rec-It's backend
// (ADR-044). Newline-delimited JSON over a named pipe (Windows) or a Unix socket that only this
// user can reach, authenticated with a random token from a discovery file in Rec-It's user-data
// folder. Pure: path helpers take the platform and environment as arguments.

/** Written by Rec-It while it runs, removed when it quits. */
export const ENDPOINT_FILE = 'mcp-endpoint.json';
export const PROTOCOL_VERSION = 1;

export interface EndpointInfo {
  protocol: number;
  /** Named pipe or socket path. */
  path: string;
  /** Random secret; the bridge must send it first. */
  token: string;
  pid: number;
  appVersion: string;
}

export type ToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
}

export type BridgeRequest =
  | {
      id: number;
      method: 'hello';
      params: { token: string; protocol: number; client: { name: string; version: string } };
    }
  | { id: number; method: 'call'; params: { name: string; arguments: unknown } };

export type BridgeResponse =
  { id: number; result: unknown } | { id: number; error: { message: string } };

export const APP_FOLDER = 'Rec-It';

/**
 * Rec-It's user-data folder, as Electron chooses it (appData/productName), unless
 * RECIT_USER_DATA overrides it (tests, portable setups).
 */
export function userDataDir(
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
  join: (...parts: string[]) => string,
): string {
  if (env.RECIT_USER_DATA) return env.RECIT_USER_DATA;
  if (platform === 'win32')
    return join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), APP_FOLDER);
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', APP_FOLDER);
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), APP_FOLDER);
}

/** Reads one JSON object per line from a stream of chunks. */
export class LineReader {
  private buffer = '';
  /** Lines longer than this are refused (a frame image is well under it). */
  constructor(private readonly maxLine = 64 * 1024 * 1024) {}

  push(chunk: string): unknown[] {
    this.buffer += chunk;
    const out: unknown[] = [];
    let nl = this.buffer.indexOf('\n');
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) out.push(JSON.parse(line));
      nl = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > this.maxLine) throw new Error('Message too large.');
    return out;
  }
}
