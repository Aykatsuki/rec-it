import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { BackendApp } from './app';

const bins = findTestFfmpeg();
const rights = { source: 'own-recording' as const, userAttested: true };

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
}

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!bins)('media pipeline (backend, real FFmpeg)', () => {
  let fx: Fixtures;
  let dir: string;
  const apps: BackendApp[] = [];

  const start = async () => {
    const app = new BackendApp({
      userDataDir: join(dir, 'userdata'),
      projectsDir: join(dir, 'projects'),
      appVersion: 'test',
      electronVersion: 'test',
      ffmpeg: {
        envPath: bins!.source === 'path' ? undefined : bins!.ffmpeg,
        bundledDir: join(dir, 'none'),
      },
      sidecar: null,
    });
    apps.push(app);
    await app.start();
    return app;
  };
  const settled = (app: BackendApp) =>
    waitFor(() => {
      const list = app.projects.media().list();
      return list.every((a) => a.status !== 'processing') && list;
    }, 120_000);

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recit-media-'));
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 60 });
  }, 180_000);
  afterAll(async () => {
    for (const app of apps) await app.dispose().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    rmSync(fx.dir, { recursive: true, force: true });
  });

  it('imports every kind of media and produces proxies, thumbnails and waveforms', async () => {
    const app = await start();
    const project = await app.projects.create('Pipeline test');
    expect(project.path).toMatch(/Pipeline test\.recit$/);

    const files = [
      fx.h264,
      fx.vfr,
      fx.prores,
      fx.audio,
      fx.image,
      fx.corrupt,
      fx.hevcRotated,
      fx.hdr,
    ].filter((f): f is string => !!f);
    const result = await app.projects.media().import([...files, join(fx.dir, 'notes.txt')], rights);
    expect(result.imported).toHaveLength(files.length);
    expect(result.skipped).toEqual([
      { path: join(fx.dir, 'notes.txt'), reason: '".txt" files are not supported' },
    ]);

    const assets = await settled(app);
    const byName = (n: string) => assets.find((a) => a.name === n)!;

    const video = byName('clip h264.mp4');
    expect(video).toMatchObject({ status: 'ready', kind: 'video' });
    expect(video.urls.proxy).toMatch(
      /^recit-media:\/\/asset\/project_\w+\/asset_\w+\/proxy-v2\.mp4\?v=\d+$/,
    );
    expect(video.urls.sprite).toMatchObject({ columns: 3, rows: 1 });
    expect(video.urls.waveform).toBeDefined();

    expect(byName('vfr.mp4')).toMatchObject({ status: 'ready', probe: { video: { isVfr: true } } });
    expect(byName('prores.mov').status).toBe('ready');
    expect(byName('audio.wav')).toMatchObject({
      status: 'ready',
      kind: 'audio',
      jobs: { proxy: { state: 'done' } },
    });
    expect(byName('image.png')).toMatchObject({
      status: 'ready',
      kind: 'image',
      jobs: { waveform: { state: 'skipped' } },
    });
    expect(byName('image.png').urls.poster).toBeDefined();
    const corrupt = byName('corrupt.mp4');
    expect(corrupt.status).toBe('failed');
    expect(corrupt.jobs.probe.error).toMatch(/could not be read as media/);
    if (fx.hevcRotated) {
      expect(byName('phone hevc.mov')).toMatchObject({
        status: 'ready',
        probe: { video: { rotation: 90, displayWidth: 720, displayHeight: 1280 } },
      });
    }

    const files_ = walk(project.cacheDir);
    expect(files_.filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(files_.filter((f) => f.endsWith('proxy-v2.mp4'))).toHaveLength(fx.hevcRotated ? 5 : 3);
  }, 180_000);

  it('refuses duplicates', async () => {
    const app = apps[0]!;
    const again = await app.projects.media().import([fx.h264], rights);
    expect(again.imported).toEqual([]);
    expect(again.skipped[0]!.reason).toMatch(/Already in the project/);
  });

  it('cancels a running proxy within a second and leaves no partial files', async () => {
    const app = apps[0]!;
    const media = app.projects.media();
    const { imported } = await media.import([fx.long], rights);
    const id = imported[0]!;
    await waitFor(
      () => media.get(id).jobs.proxy.state === 'running' && media.get(id).jobs.proxy.progress > 0,
    );
    const t0 = Date.now();
    media.cancel([id]);
    await waitFor(() => media.get(id).jobs.proxy.state === 'cancelled', 5000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(media.get(id).status).toBe('processing');
    await new Promise((r) => setTimeout(r, 200));
    expect(
      walk(app.projects.info()!.cacheDir).filter((f) => f.includes(id) && f.endsWith('.part')),
    ).toEqual([]);

    media.retry(id);
    await waitFor(() => media.get(id).status === 'ready', 120_000);
  }, 180_000);

  it('recovers after a crash: the project reopens with everything that was written', async () => {
    const first = apps[0]!;
    const before = first.projects
      .media()
      .list()
      .map((a: MediaAsset) => [a.name, a.status]);
    // Simulate a crash: the next process opens the same files without a clean shutdown.
    apps.length = 0;
    const second = await start();
    expect(second.projects.info()?.name).toBe('Pipeline test');
    const after = await settled(second);
    expect(after.map((a) => [a.name, a.status])).toEqual(before);
    await first.dispose().catch(() => {});
  }, 120_000);

  it('detects moved originals and relinks them by content', async () => {
    const app = apps[0]!;
    const media = app.projects.media();
    const moved = join(fx.dir, 'moved prores.mov');
    const original = media.list().find((a) => a.name === 'prores.mov')!;
    renameSync(fx.prores, moved);
    await app.projects.close();
    await app.projects.open(join(app.projects.defaultDirectory, 'Pipeline test.recit'));
    const reopened = app.projects.media().get(original.id);
    expect(reopened.status).toBe('missing');

    await expect(app.projects.media().relink(original.id, fx.vfr)).rejects.toThrow(
      /different content/,
    );
    const relinked = await app.projects.media().relink(original.id, moved);
    expect(relinked).toMatchObject({ missing: false, originalPath: moved, status: 'ready' });
  }, 60_000);

  it('removes media and its cached files, and saves a copy with Save As', async () => {
    const app = apps[0]!;
    const media = app.projects.media();
    const image = media.list().find((a) => a.name === 'image.png')!;
    const cacheDir = app.projects.info()!.cacheDir;
    await media.remove([image.id]);
    expect(existsSync(join(cacheDir, image.id))).toBe(false);
    expect(media.list().some((a) => a.id === image.id)).toBe(false);

    const copyPath = join(dir, 'elsewhere', 'Copy');
    const copy = await app.projects.saveAs(copyPath);
    expect(copy.path).toBe(`${copyPath}.recit`);
    expect(app.projects.media().list().length).toBeGreaterThan(0);
  }, 60_000);
});
