import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { BackendApp } from './app';

// Runs the real sidecar (uv + Python) with the deterministic fake Whisper engine, so this needs no
// model download: one word every 0.5 s, "word1", "word2", ...
const bins = findTestFfmpeg();
const mediaAi = resolve(__dirname, '../../../../services/media-ai');
const hasUv = (() => {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!bins || !hasUv)('transcription (backend, real sidecar, fake engine)', () => {
  let fx: Fixtures;
  let dir: string;
  let app: BackendApp;
  let assetId: string;

  beforeAll(async () => {
    process.env.RECIT_FAKE_WHISPER = '1';
    process.env.RECIT_FAKE_WHISPER_DELAY = '0.2';
    dir = mkdtempSync(join(tmpdir(), 'recit-tr-'));
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
      sidecar: {
        command: 'uv',
        args: ['run', '--project', mediaAi, '--quiet', 'python', '-m', 'recit_media_ai'],
        cwd: mediaAi,
      },
    });
    await app.start();
    await app.projects.create('Transcript test');
    const media = app.projects.media();
    await media.import([fx.h264], { source: 'own-recording', userAttested: true });
    const [asset] = await waitFor(() => {
      const list = media.list();
      return list.length > 0 && list.every((a) => a.status === 'ready') && list;
    }, 120_000);
    assetId = asset!.id;
    await waitFor(() => app.transcripts.status().available !== null, 60_000);
  }, 180_000);

  afterAll(async () => {
    await app?.dispose();
    delete process.env.RECIT_FAKE_WHISPER;
    delete process.env.RECIT_FAKE_WHISPER_DELAY;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(fx.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reports the engine as available', () => {
    expect(app.transcripts.status().available).toBe(true);
  });

  it('can be cancelled while transcribing', async () => {
    app.transcripts.start(assetId, null);
    await waitFor(
      () => app.transcripts.status().jobs.find((j) => j.state === 'transcribing'),
      30_000,
    );
    app.transcripts.cancel(assetId);
    const job = await waitFor(
      () =>
        app.transcripts
          .status()
          .jobs.find(
            (j) => j.assetId === assetId && ['cancelled', 'done', 'failed'].includes(j.state),
          ),
      30_000,
    );
    expect(job.state).toBe('cancelled');
    expect(app.transcripts.get(assetId)).toBeNull();
  }, 60_000);

  it('transcribes, reports progress and saves word timings in the project', async () => {
    const seen: number[] = [];
    app.transcripts.start(assetId, 'en');
    const job = await waitFor(() => {
      const j = app.transcripts.status().jobs.find((x) => x.assetId === assetId);
      if (j) seen.push(j.progress);
      return j && ['done', 'failed', 'cancelled'].includes(j.state) && j;
    }, 60_000);
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('done');
    expect(new Set(seen).size).toBeGreaterThan(2);
    const transcript = app.transcripts.get(assetId)!;
    expect(transcript.model).toBe('fake');
    expect(transcript.words.length).toBeGreaterThanOrEqual(6);
    expect(transcript.words[0]).toMatchObject({ text: 'word1', start: 0.1, end: 0.5 });
    expect(app.transcripts.status().transcribed).toEqual([assetId]);
  }, 90_000);
});
