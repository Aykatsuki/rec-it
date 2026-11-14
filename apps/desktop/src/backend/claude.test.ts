import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { ENDPOINT_FILE, type EndpointInfo, type ToolResult } from '@rec-it/tools/protocol';
// The real bridge connection (apps/mcp), so both ends of the local link are tested together.
import { RecItConnection } from '../../../mcp/src/connection';
import { BackendApp } from './app';

const bins = findTestFfmpeg();

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
const versionOf = (r: ToolResult) => Number(/version=(\d+)/.exec(textOf(r))?.[1]);

describe.skipIf(!bins)('Claude connector (backend endpoint + bridge, real FFmpeg)', () => {
  let fx: Fixtures;
  let dir: string;
  let ud: string;
  let app: BackendApp;
  let claude: RecItConnection;
  let videoId: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'recit-claude-'));
    ud = join(dir, 'ud');
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 4 });
    app = new BackendApp({
      userDataDir: ud,
      projectsDir: join(dir, 'projects'),
      appVersion: 'test',
      electronVersion: 'test',
      ffmpeg: {
        envPath: bins!.source === 'path' ? undefined : bins!.ffmpeg,
        bundledDir: join(dir, 'none'),
      },
      sidecar: null,
    });
    await app.start();
    claude = new RecItConnection({ clientName: () => 'Test Claude', dataDir: ud });
  }, 180_000);

  afterAll(async () => {
    claude?.close();
    await app?.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(fx.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('publishes its endpoint in a private discovery file', () => {
    const file = join(ud, ENDPOINT_FILE);
    const info = JSON.parse(readFileSync(file, 'utf8')) as EndpointInfo;
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o077).toBe(0);
      expect(statSync(info.path).mode & 0o077).toBe(0);
    }
    expect(app.claude.state().listening).toBe(true);
  });

  it('refuses a connection with the wrong token', async () => {
    const info = JSON.parse(readFileSync(join(ud, ENDPOINT_FILE), 'utf8')) as EndpointInfo;
    const reply = await new Promise<string>((resolve) => {
      const s = connect(info.path);
      let data = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => (data += d));
      s.on('close', () => resolve(data));
      s.on('error', () => {});
      s.write(
        `${JSON.stringify({ id: 1, method: 'hello', params: { token: 'x'.repeat(64), protocol: 1, client: { name: 'evil', version: '1' } } })}\n${JSON.stringify({ id: 2, method: 'call', params: { name: 'get_project_summary', arguments: {} } })}\n`,
      );
    });
    expect(reply).toContain('Not authorised');
    expect(reply).not.toContain('"id":2');
    expect(app.claude.state().clients).toEqual([]);
  });

  it('says when no project is open, and shows the connection', async () => {
    const r = await claude.call('get_project_summary', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No project is open');
    expect(app.claude.state().clients.map((c) => c.name)).toEqual(['Test Claude']);
  });

  it('reads the project and edits it as one undoable change', async () => {
    await app.projects.create('Claude test');
    const media = app.projects.media();
    await media.import([fx.h264], { source: 'own-recording', userAttested: true });
    const [asset] = await waitFor(() => {
      const list = media.list();
      return list.length > 0 && list.every((a) => a.status === 'ready') && list;
    }, 120_000);
    videoId = asset!.id;

    const summary = JSON.parse(textOf(await claude.call('get_project_summary', {}))) as {
      project: string;
      version: number;
      media: { id: string }[];
      activeSequence: unknown;
    };
    expect(summary.project).toBe('Claude test');
    expect(summary.media.map((m) => m.id)).toEqual([videoId]);
    expect(summary.activeSequence).toBeNull();

    const added = await claude.call('add_clip', { assetId: videoId, version: summary.version });
    expect(added.isError).toBeUndefined();
    const cut = await claude.call('remove_ranges', {
      ranges: [{ start: 1, end: 1.5 }],
      version: versionOf(added),
    });
    expect(textOf(cut)).toContain('0.5 s in total');
    const seq = app.projects.document().state().doc.sequences[0]!;
    expect(seq.width).toBe(1080);
    expect(seq.tracks.flatMap((t) => t.items)).toHaveLength(2);

    // Both edits (and the sequence that was created) form one change card / undo step.
    const state = app.claude.state();
    expect(state.changes).toHaveLength(1);
    expect(state.changes[0]!.edits).toEqual([
      'Created sequence "Short 1"',
      'Added clip h264.mp4',
      'Cut 1 range',
    ]);
    expect(state.changes[0]!.canUndo).toBe(true);
    expect(state.activity.map((a) => a.tool)).toEqual([
      'remove_ranges',
      'add_clip',
      'get_project_summary',
      'get_project_summary',
    ]);

    app.claude.undoChange(state.changes[0]!.group);
    expect(app.projects.document().state().doc.sequences).toEqual([]);
    expect(app.claude.state().changes[0]!.state).toBe('undone');
  });

  it('refuses an edit planned against an old version', async () => {
    const a = await claude.call('add_clip', { assetId: videoId });
    const user = app.projects.document();
    const seq = user.state().doc.sequences[0]!;
    user.execute({ type: 'item.split', sequenceId: seq.id, time: 705_600_000 }); // the user edits
    const r = await claude.call('remove_ranges', {
      ranges: [{ start: 0, end: 0.5 }],
      version: versionOf(a),
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('The timeline changed');
    expect(textOf(r)).toContain('"project":"Claude test"');
    // The user's edit sits on top, so the earlier card can no longer be undone as a whole.
    expect(app.claude.state().changes[0]!.canUndo).toBe(false);
  });

  it('returns a finished frame as an image', async () => {
    const r = await claude.call('get_frame', { time: 0.5 });
    const image = r.content.find((c) => c.type === 'image');
    expect(image?.type === 'image' && image.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(image?.type === 'image' ? image.data : '', 'base64');
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    // 768 px on the long side (1080x1920 sequence).
    const sof = bytes.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    expect(bytes.readUInt16BE(sof + 5)).toBe(768);
  }, 60_000);

  it('asks the user before exporting', async () => {
    const pending = claude.call('export_sequence', { fileName: 'claude' });
    const confirmation = await waitFor(() => app.claude.state().confirmations[0]);
    expect(confirmation.tool).toBe('export_sequence');
    expect(confirmation.detail).toContain('claude.mp4');
    app.claude.respond(confirmation.id, false);
    const r = await pending;
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('declined');
    expect(app.exports.status().state).toBe('idle');
  });

  it('validates input and stops when Claude is turned off', async () => {
    const bad = await claude.call('remove_ranges', { ranges: [] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Invalid input');
    app.handlers['settings.update']({ aiEnabled: false });
    const off = await claude.call('get_project_summary', {});
    expect(textOf(off)).toContain('turned off');
    app.handlers['settings.update']({ aiEnabled: true });
  });
});
