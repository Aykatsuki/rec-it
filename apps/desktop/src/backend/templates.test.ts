import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLICKS_PER_SECOND } from '@rec-it/core';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '@rec-it/ffmpeg/testing';
import { totalFrames, type RenderSpec } from '@rec-it/lowpoly';
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
    process.env.RECIT_FAKE_LIPSYNC = '1';
    process.env.RECIT_FAKE_VOICEHQ = '1';
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
    delete process.env.RECIT_FAKE_LIPSYNC;
    delete process.env.RECIT_FAKE_VOICEHQ;
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

  it('makes a talking-character test shot', async () => {
    await waitFor(() => app.animation.status().available !== null, 60_000);
    await waitFor(() => app.images.status().available !== null, 60_000);
    const jobId = app.templates.talkTest({
      character: 'a cheerful orange fox in a green scarf',
      line: 'Hello there, I am a fox.',
      voice: 'af_heart',
    });
    const job = await waitFor(() => {
      const j = app.templates.list().find((x) => x.id === jobId);
      return j && j.state !== 'running' && j;
    }, 120_000);
    expect(job.error).toBeUndefined();
    expect(job.kind).toBe('talk-test');
    expect(job.stage).toMatch(/^Done in .+; the mouth shapes took .+ \(\d of 7 drawn\)\.$/);
    const { doc } = app.projects.document().state();
    const seq = doc.sequences.find((s) => s.id === job.sequenceId)!;
    const track = (name: string) => seq.tracks.find((t) => t.name === name)!.items;
    const clip = app.projects.media().get(track('V1')[0]!.assetId);
    expect(clip.kind).toBe('video');
    expect(clip.originalPath).toMatch(/talking .+\.mp4$/);
    expect(clip.probe?.audioStreamCount).toBe(0);
    expect(app.projects.media().get(track('A1')[0]!.assetId).kind).toBe('audio');
    // The clip lasts exactly as long as the line, and the mouth shapes were drawn next to the
    // character picture.
    expect(sec(track('V1')[0]!.duration)).toBeCloseTo(sec(track('A1')[0]!.duration), 1);
    const shapesDir = join(
      dirname(clip.originalPath),
      readdirSync(dirname(clip.originalPath)).find((n) => n.startsWith('character '))!,
      'shapes',
    );
    expect(readdirSync(shapesDir).filter((n) => n.endsWith('.png')).length).toBeGreaterThanOrEqual(
      4,
    );
  }, 180_000);

  it('speaks with the human-like voice, built in or cloned from a sample', async () => {
    await waitFor(() => app.voice.human.status().available !== null, 60_000);
    expect(app.voice.human.status()).toMatchObject({ available: true, engine: 'fake' });
    // A sample: any recording of 5 s or more (shorter ones are refused).
    const recording = join(dir, 'me.wav');
    execFileSync(bins!.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=6', recording]);
    await expect(app.voice.addSample(fx.h264, 'Too short')).rejects.toThrow(/at least 5 seconds/);
    const sample = await app.voice.addSample(recording, 'Test voice');
    expect(sample.seconds).toBeGreaterThanOrEqual(4);
    expect((await app.voice.samples()).map((v) => v.name)).toContain('Test voice');
    for (const voice of ['hq:builtin', `hq:${sample.id}`, 'hq:k-bm_lewis']) {
      const jobId = app.templates.talkTest({
        character: 'a tired samurai',
        line: 'The rain never stopped that day.',
        voice,
      });
      const job = await waitFor(() => {
        const j = app.templates.list().find((x) => x.id === jobId);
        return j && j.state !== 'running' && j;
      }, 120_000);
      expect(job.error).toBeUndefined();
      expect(job.state).toBe('done');
    }
    // The Lewis reference was read once by Kokoro and kept for next time.
    expect(existsSync(join(dir, 'ud', 'voices', 'reference-bm_lewis.wav'))).toBe(true);
    await app.voice.removeSample(sample.id);
    expect(await app.voice.samples()).toEqual([]);
  }, 240_000);

  it('makes an episode from a brief: cast, shots, voices, talking close-ups', async () => {
    app.ai.planEpisode = async () => ({
      title: 'The Last Samurai: Episode 1',
      style: '2D anime illustration, dark fantasy',
      characters: [
        { id: 'hiroshi', name: 'Hiroshi', gender: 'male', age: 'young', look: 'young samurai' },
        {
          id: 'warrior',
          name: 'Black Warrior',
          gender: 'male',
          age: 'adult',
          look: 'black armour',
        },
      ],
      shots: [
        {
          speaker: 'narrator',
          text: 'The year is 1582.',
          picture: 'a village',
          characters: [],
          motion: 'panLeft',
        },
        {
          speaker: 'narrator',
          text: 'His village is burning.',
          picture: 'Hiroshi runs',
          characters: ['hiroshi'],
        },
        {
          speaker: 'hiroshi',
          text: 'Whoever did this, I will find you.',
          picture: 'Hiroshi close-up',
          characters: [],
        },
        {
          speaker: 'warrior',
          text: 'Your father warned us you would return.',
          picture: 'the warrior',
          characters: ['warrior'],
        },
        {
          speaker: 'ghost',
          text: 'He draws his sword.',
          picture: 'a blade',
          characters: ['nobody'],
        },
      ],
    });
    const jobId = app.templates.episode({
      brief: 'Episode 1 of a dark samurai anime. A young samurai returns to his burning village.',
      seconds: 45,
      narrator: 'am_onyx',
    });
    const job = await waitFor(() => {
      const j = app.templates.list().find((x) => x.id === jobId);
      return j && j.state !== 'running' && j;
    }, 240_000);
    expect(job.error).toBeUndefined();
    expect(job.stage).toMatch(/5 shots, 2 spoken by characters/);
    expect(job.title).toBe('The Last Samurai: Episode 1');
    const { doc } = app.projects.document().state();
    const seq = doc.sequences.find((s) => s.id === job.sequenceId)!;
    const track = (name: string) => seq.tracks.find((t) => t.name === name)!.items;
    // One clip per shot, edge to edge; the two dialogue shots are talking videos.
    const v1 = track('V1');
    expect(v1).toHaveLength(5);
    for (let i = 1; i < v1.length; i++)
      expect(v1[i]!.start).toBe(v1[i - 1]!.start + v1[i - 1]!.duration);
    const kinds = v1.map((i) => app.projects.media().get(i.assetId).kind);
    expect(kinds).toEqual(['image', 'image', 'video', 'video', 'image']);
    // One voice track with every line, captioned.
    expect(track('A1')).toHaveLength(1);
    const captions = seq.tracks.find((t) => t.kind === 'caption')!.items;
    expect(captions.flatMap((c) => c.caption!.words.map((w) => w.text)).join(' ')).toContain(
      'Your father warned us',
    );
  }, 300_000);

  it('remembers the cast and speaks a written script exactly as written', async () => {
    // The first episode designed Hiroshi and the warrior: both are remembered.
    expect((await app.templates.cast()).map((c) => c.id)).toEqual(['hiroshi', 'warrior']);
    let seen: { script?: string; cast?: readonly { id: string }[] } = {};
    app.ai.planEpisode = async (_brief, _seconds, extra = {}) => {
      seen = extra;
      return {
        title: 'Episode 2',
        style: '2D anime illustration',
        // The AI re-describes Hiroshi differently and under another id: the remembered one wins.
        characters: [
          { id: 'takeda', name: 'Hiroshi', gender: 'male', age: 'adult', look: 'blue eyes' },
          { id: 'kenji', name: 'Kenji', gender: 'male', age: 'old', look: 'grey beard' },
        ],
        shots: [
          { line: 1, speaker: 'narrator', text: 'x', picture: 'rain on a temple', characters: [] },
          { line: 2, speaker: 'takeda', text: 'x', picture: 'close-up', characters: ['takeda'] },
          { line: 3, speaker: 'kenji', text: 'x', picture: 'close-up', characters: ['kenji'] },
        ],
      };
    };
    const prompts: string[] = [];
    const generate = app.images.generate.bind(app.images);
    app.images.generate = (p, o) => {
      prompts.push(...p);
      return generate(p, o);
    };
    const jobId = app.templates.episode({
      script:
        'NARRATOR: Rain fell on the temple.\nHIROSHI: I remember you.\nKenji: Then you remember why.',
      narrator: 'am_onyx',
    });
    const job = await waitFor(() => {
      const j = app.templates.list().find((x) => x.id === jobId);
      return j && j.state !== 'running' && j;
    }, 240_000);
    app.images.generate = generate;
    expect(job.error).toBeUndefined();
    expect(seen.script).toContain('2. Hiroshi: I remember you.');
    expect(seen.cast?.map((c) => c.id)).toEqual(['hiroshi', 'warrior']);
    // Only Kenji is new: one design sheet, and no picture of Hiroshi drawn from scratch.
    expect(prompts.filter((p) => p.startsWith('Character design sheet'))).toHaveLength(1);
    expect(prompts.join(' ')).not.toContain('blue eyes');
    expect((await app.templates.cast()).map((c) => c.id)).toEqual(['hiroshi', 'kenji', 'warrior']);
    const { doc } = app.projects.document().state();
    const seq = doc.sequences.find((s) => s.id === job.sequenceId)!;
    const captions = seq.tracks.find((t) => t.kind === 'caption')!.items;
    expect(captions.flatMap((c) => c.caption!.words.map((w) => w.text)).join(' ')).toMatch(
      /Rain fell on the temple\. I remember you\. Then you remember why\./,
    );
    await app.templates.forget('kenji');
    expect((await app.templates.cast()).map((c) => c.id)).toEqual(['hiroshi', 'warrior']);
  }, 300_000);

  it('makes a low-poly 3D Short: script, beats, storyboard, filmed frames, captions', async () => {
    app.ai.lowPolyScript = async () => ({
      title: 'Why Stopping Time Is A Bad Idea',
      script:
        'If you could stop time with the snap of your fingers, you would instantly go blind. The air would turn solid. So you instant-',
    });
    let beatsSeen: string[] = [];
    app.ai.lowPolyBoard = async (_title, beats) => {
      beatsSeen = beats;
      return {
        cast: [{ id: 'doc', name: 'Doc', top: 'labcoat', topColor: 'white' }],
        shots: [
          { beat: 1, set: 'street', framing: 'extremeCloseUp', subject: 'you', action: 'shock' },
          {
            beat: 2,
            set: 'lab',
            framing: 'medium',
            subject: 'doc',
            action: 'talk',
            speaker: 'doc',
          },
          { beat: 3, set: 'void', framing: 'wide', subject: 'you', effect: 'frozen' },
        ],
      };
    };
    // A stand-in renderer: the same small JPEG for every frame.
    const jpeg = join(dir, 'frame.jpg');
    execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x336699:s=108x192',
      '-frames:v',
      '1',
      jpeg,
    ]);
    const frame = new Uint8Array(readFileSync(jpeg));
    let spec: RenderSpec | null = null;
    (app.lowPoly as unknown as { d: { emit: (r: string, s: RenderSpec) => void } }).d.emit = (
      request,
      s,
    ) => {
      spec = s;
      void (async () => {
        const total = totalFrames(s);
        for (let i = 0; i < total; i += 16)
          await app.lowPoly.frames(
            request,
            Array.from({ length: Math.min(16, total - i) }, () => frame),
          );
        app.lowPoly.finished(request);
      })();
    };
    const jobId = app.templates.lowPolyShort({
      topic: 'stopping time',
      narrator: 'am_michael',
      brand: 'Test',
    });
    const job = await waitFor(() => {
      const j = app.templates.list().find((x) => x.id === jobId);
      return j && j.state !== 'running' && j;
    }, 240_000);
    expect(job.error).toBeUndefined();
    expect(job.title).toBe('Why Stopping Time Is A Bad Idea');
    expect(beatsSeen).toEqual([
      'If you could stop time with the snap of your fingers,',
      'you would instantly go blind.',
      'The air would turn solid.',
      'So you instant-',
    ]);
    const s = spec as unknown as RenderSpec;
    expect(s.brand).toBe('Test');
    expect(s.shots.map((x) => [x.subject, x.framing])).toEqual([
      ['you', 'extremeCloseUp'],
      ['doc', 'medium'],
      ['you', 'wide'],
      // A beat the AI skipped repeats the previous shot from closer.
      ['you', 'closeUp'],
    ]);
    // Shots run edge to edge from 0, and the speaker's mouth moves.
    expect(s.shots[0]!.start).toBe(0);
    for (let i = 1; i < s.shots.length; i++) expect(s.shots[i]!.start).toBe(s.shots[i - 1]!.end);
    expect(s.shots[1]!.mouth.length).toBeGreaterThan(0);
    expect(s.cast.map((c) => c.id).sort()).toEqual(['doc', 'you']);
    // The filmed video is the background, under the voice and retro captions.
    const { doc } = app.projects.document().state();
    const seq = doc.sequences.find((x) => x.id === job.sequenceId)!;
    const v1 = seq.tracks.find((t) => t.name === 'V1')!.items;
    expect(app.projects.media().get(v1[0]!.assetId).kind).toBe('video');
    expect(seq.captions?.style).toBe('retro');
    const captions = seq.tracks.find((t) => t.kind === 'caption')!.items;
    expect(captions.flatMap((c) => c.caption!.words.map((w) => w.text)).join(' ')).toContain(
      'snap',
    );
  }, 300_000);

  it('previews a voice as WAV', async () => {
    const wav = Buffer.from(await app.voice.preview('af_heart', 1, 'Hello there'), 'base64');
    expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  });
});
