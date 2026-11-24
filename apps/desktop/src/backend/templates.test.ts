import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND } from '@rec-it/core';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { BackendApp } from './app';

// The story template end to end with the real sidecar and the fake voice (a tone per word at
// known times, so no model download), real FFmpeg imports and the real document.
const bins = findTestFfmpeg();
const mediaAi = resolve(__dirname, '../../../../services/media-ai');
const fontsDir = resolve(__dirname, '../../../../resources/fonts');
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

const sec = (f: number) => f / FLICKS_PER_SECOND;

describe.skipIf(!bins || !hasUv)('story template (backend, real sidecar, fake voice)', () => {
  let fx: Fixtures;
  let dir: string;
  let app: BackendApp;
  let backgroundId: string;

  beforeAll(async () => {
    process.env.RECIT_FAKE_TTS = '1';
    process.env.RECIT_FAKE_IMAGES = '1';
    dir = mkdtempSync(join(tmpdir(), 'recit-tpl-'));
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
      fontsDir,
    });
    await app.start();
    await app.projects.create('Story test');
    const media = app.projects.media();
    await media.import([fx.h264], { source: 'own-recording', userAttested: true });
    const [asset] = await waitFor(() => {
      const list = media.list();
      return list.length > 0 && list.every((a) => a.status === 'ready') && list;
    }, 120_000);
    backgroundId = asset!.id;
    await waitFor(() => app.voice.status().available !== null, 60_000);
  }, 180_000);

  afterAll(async () => {
    await app?.dispose();
    delete process.env.RECIT_FAKE_TTS;
    delete process.env.RECIT_FAKE_IMAGES;
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    rmSync(fx.dir, { recursive: true, force: true, maxRetries: 3 });
  });

  it('reports the fake voice as available', () => {
    expect(app.voice.status()).toMatchObject({ available: true, engine: 'fake' });
  });

  it('turns a story into a finished, undoable Short', async () => {
    const jobId = app.templates.story({
      title: 'My neighbour **stole** my parcel 📦',
      story:
        'So this happened yesterday.\nEdit: thanks for the replies!\nI got it back in the end.',
      community: 'r/stories',
      username: 'tester',
      voice: 'am_adam',
      speed: 1,
      backgroundAssetId: backgroundId,
      backgroundStart: 0,
    });
    const job = await waitFor(() => {
      const j = app.templates.list().find((x) => x.id === jobId);
      return j && j.state !== 'running' && j;
    }, 120_000);
    expect(job.error).toBeUndefined();
    expect(job.state).toBe('done');

    // The voice and the card are ordinary media, marked as made by Rec-It, next to the project.
    const made = app.projects
      .media()
      .list()
      .filter((a) => a.rights.source === 'made-in-rec-it');
    expect(made.map((a) => a.kind).sort()).toEqual(['audio', 'image']);
    expect(made.every((a) => existsSync(a.originalPath))).toBe(true);
    expect(made[0]!.originalPath).toContain('Story test media');

    // The voiceover's transcript: title words (markdown and emoji removed), then the story
    // without the "Edit:" line.
    const voice = made.find((a) => a.kind === 'audio')!;
    const words = app.transcripts.get(voice.id)!.words.map((w) => w.text);
    expect(words).toEqual(
      'My neighbour stole my parcel So this happened yesterday. I got it back in the end.'.split(
        ' ',
      ),
    );
    expect(app.transcripts.status().transcribed).toContain(voice.id);

    const { doc } = app.projects.document().state();
    const seq = doc.sequences.find((s) => s.id === job.sequenceId)!;
    expect(doc.activeSequenceId).toBe(seq.id);
    expect([seq.width, seq.height]).toEqual([1080, 1920]);
    const track = (name: string) => seq.tracks.find((t) => t.name === name)!.items;
    // 5 title words + 0.35 s gap + 11 story words at 0.4 s each (fake voice), then the tail.
    const voiceLength = sec(track('A1')[0]!.duration);
    expect(voiceLength).toBeCloseTo(5 * 0.4 + 0.35 + 11 * 0.4 + 0.35, 1);
    // The 4 s background repeats to cover the whole Short.
    expect(track('V1').length).toBeGreaterThanOrEqual(2);
    expect(track('V1').every((i) => i.muted && i.assetId === backgroundId)).toBe(true);
    expect(track('V2')[0]!.assetId).toBe(made.find((a) => a.kind === 'image')!.id);
    const captions = seq.tracks.find((t) => t.kind === 'caption')!.items;
    expect(captions[0]!.caption!.words[0]!.text).toBe('So');

    // One undo removes the whole Short.
    app.projects.document().undo();
    expect(
      app.projects
        .document()
        .state()
        .doc.sequences.find((s) => s.id === seq.id),
    ).toBe(undefined);
  }, 180_000);

  it('refuses a background that is not a video', () => {
    expect(() =>
      app.templates.story({
        title: 't',
        story: 's',
        voice: 'am_adam',
        backgroundAssetId: app.projects
          .media()
          .list()
          .find((a) => a.kind === 'audio')!.id,
      }),
    ).toThrow(/background/);
  });

  for (const visuals of ['pictures', 'graphics'] as const) {
    it(`generates the visuals from the script (${visuals})`, async () => {
      await waitFor(() => app.images.status().available !== null, 60_000);
      expect(app.images.status().available).toBe(true);
      const script =
        'Octopuses have three hearts. Two pump blood to the gills. One pumps it to the body. Their blood is blue. They can taste with their arms. Each arm has its own mini brain.';
      const jobId = app.templates.story({
        title: 'Octopus facts',
        story: script,
        voice: 'af_heart',
        speed: 1,
        visuals,
        pictureStyle: 'anime',
        card: false,
      });
      const job = await waitFor(() => {
        const j = app.templates.list().find((x) => x.id === jobId);
        return j && j.state !== 'running' && j;
      }, 120_000);
      expect(job.error).toBeUndefined();
      const { doc } = app.projects.document().state();
      const seq = doc.sequences.find((s) => s.id === job.sequenceId)!;
      const v1 = seq.tracks.find((t) => t.name === 'V1')!.items;
      // No AI is set up here, so the script is grouped into 3 scenes (the minimum) by sentences.
      expect(v1).toHaveLength(3);
      const stills = app.projects
        .media()
        .list()
        .filter((a) => v1.some((i) => i.assetId === a.id));
      expect(stills.every((a) => a.kind === 'image' && a.rights.source === 'made-in-rec-it')).toBe(
        true,
      );
      expect(v1.every((i) => i.keyframes && Object.keys(i.keyframes).length)).toBe(true);
      expect(v1[1]!.transitionIn?.kind).toBe('dissolve');
      // Each scene starts when its sentences start being spoken.
      const words = app.transcripts.get(
        seq.tracks.find((t) => t.name === 'A1')!.items[0]!.assetId,
      )!.words;
      const at = (w: string) => words.find((x) => x.text === w)!.start;
      // 6 sentences in 3 scenes: the second starts at "One pumps…", the third at "They can…".
      expect(sec(v1[1]!.start)).toBeCloseTo(at('One'), 0);
      expect(sec(v1[2]!.start)).toBeCloseTo(at('They'), 0);
      expect(sec(v1[1]!.start)).toBeLessThan(at('One') + 0.01);
      // The title is spoken and captioned (no card).
      const caps = seq.tracks.find((t) => t.kind === 'caption')!.items;
      expect(caps[0]!.caption!.words[0]!.text).toBe('Octopus');
    }, 180_000);
  }

  it('previews a voice as WAV', async () => {
    const wav = Buffer.from(await app.voice.preview('af_heart', 1, 'Hello there'), 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  });
});
