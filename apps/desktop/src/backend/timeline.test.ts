import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as s } from '@rec-it/core';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { BackendApp } from './app';

const bins = findTestFfmpeg();

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!bins)('timeline and export (backend, real FFmpeg)', () => {
  let fx: Fixtures;
  let dir: string;
  let app: BackendApp;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'recit-tl-'));
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 4 });
    app = new BackendApp({
      userDataDir: join(dir, 'ud'),
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
    await app.projects.create('Timeline test');
    const media = app.projects.media();
    await media.import([fx.h264, fx.audio, fx.image, ...(fx.hevcRotated ? [fx.hevcRotated] : [])], {
      source: 'own-recording',
      userAttested: true,
    });
    const assets = await waitFor(() => {
      const list = media.list();
      return list.every((a) => a.status === 'ready') && list;
    }, 120_000);
    for (const a of assets) ids[a.name] = a.id;
  }, 180_000);

  afterAll(async () => {
    await app?.dispose();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(fx.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('makes playable preview copies for audio files and stills for images', () => {
    const list = app.projects.media().list();
    expect(list.find((a) => a.name === 'audio.wav')!.urls.proxy).toMatch(/proxy\.m4a/);
    expect(list.find((a) => a.name === 'image.png')!.urls.still).toMatch(/still\.jpg/);
  });

  it('edits, persists across reopening, and protects media in use', async () => {
    const doc = app.projects.document();
    doc.execute({
      type: 'sequence.create',
      id: 'seq',
      name: 'My Short',
      width: 1080,
      height: 1920,
      fps: FRAME_RATES.fps30,
    });
    const tracks = doc.state().doc.sequences[0]!.tracks;
    const [v2, v1, a1] = tracks;
    doc.execute({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: v1!.id,
      assetId: ids['clip h264.mp4']!,
      start: 0,
    });
    doc.execute({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: v2!.id,
      assetId: ids['image.png']!,
      start: s(1),
      duration: s(1),
    });
    doc.execute({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: a1!.id,
      assetId: ids['audio.wav']!,
      start: s(0.5),
    });
    if (ids['phone hevc.mov']) {
      doc.execute({
        type: 'item.add',
        sequenceId: 'seq',
        trackId: v1!.id,
        assetId: ids['phone hevc.mov']!,
        start: s(3),
      });
    }
    doc.execute({ type: 'item.split', sequenceId: 'seq', time: s(2) });
    expect(doc.state().canUndo).toBe(true);
    const saved = doc.state().doc;

    await expect(app.handlers['media.remove']({ assetIds: [ids['image.png']!] })).rejects.toThrow(
      /used in My Short/,
    );

    const path = app.projects.info()!.path;
    await app.projects.close();
    await app.projects.open(path);
    expect(app.projects.document().state().doc).toEqual(saved);
  });

  it('exports an MP4 at the sequence size, frame rate and length', async () => {
    const out = join(dir, 'My Short.mp4');
    app.handlers['export.start']({ sequenceId: 'seq', path: out, quality: 'draft' });
    const final = await waitFor(() => {
      const st = app.exports.status();
      return st.state !== 'running' && st;
    }, 120_000);
    expect(final).toMatchObject({ state: 'done', progress: 1, path: out });
    expect(existsSync(`${out}.part`)).toBe(false);
    const probe = JSON.parse(
      execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out],
        {
          encoding: 'utf8',
        },
      ),
    ) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }[];
      format: { duration: string };
    };
    const v = probe.streams.find((x) => x.codec_type === 'video')!;
    expect([v.codec_name, v.width, v.height, v.r_frame_rate]).toEqual(['h264', 1080, 1920, '30/1']);
    expect(probe.streams.find((x) => x.codec_type === 'audio')?.codec_name).toBe('aac');
    const expected = ids['phone hevc.mov'] ? 6 : 3;
    expect(Math.abs(Number(probe.format.duration) - expected)).toBeLessThan(0.1);
  }, 180_000);

  it('cancels an export and leaves no partial file', async () => {
    const out = join(dir, 'cancelled.mp4');
    app.handlers['export.start']({ sequenceId: 'seq', path: out, quality: 'high' });
    app.handlers['export.cancel']({});
    const final = await waitFor(() => {
      const st = app.exports.status();
      return st.state !== 'running' && st;
    }, 30_000);
    expect(final.state).toBe('cancelled');
    expect(existsSync(out) || existsSync(`${out}.part`)).toBe(false);
  }, 60_000);
});
