import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

// Faceless templates (ADR-046) through the real app: a fake OpenAI-compatible server stands in for
// Ollama/Kimi, and the sidecar's fake voice reads a tone per word at known times.
const bins = findTestFfmpeg();
let fx: Fixtures;
let server: Server;
let aiUrl: string;
const requests: { path: string; body: unknown }[] = [];

const STORY = {
  title: 'AITA for labelling every egg in the fridge',
  story:
    'So my roommate kept eating my eggs. I started writing my name on each one. Now she says I am petty. Am I wrong?',
  username: 'egg_keeper',
};

const FACTS = {
  title: 'Three hearts, blue blood',
  story:
    'Octopuses have three hearts. Two of them pump blood to the gills. Their blood is blue because of copper. Each arm can taste what it touches.',
};
const PLAN = {
  scenes: [
    {
      from: 1,
      to: 2,
      picture: 'an octopus with glowing hearts',
      motion: 'zoomIn',
      palette: ['#001122', '#0055AA', '#66CCFF'],
    },
    {
      from: 3,
      to: 3,
      picture: 'blue blood swirling in water',
      motion: 'panLeft',
      palette: ['#000033', '#3344FF', '#99AAFF'],
    },
    {
      from: 4,
      to: 4,
      picture: 'an octopus arm touching a shell',
      motion: 'zoomOut',
      palette: ['#220011', '#AA3366', '#FFCC99'],
    },
  ],
};

const EPISODE = {
  title: 'Blood of the Shogun',
  style: '2D anime illustration, dark fantasy, black and crimson',
  characters: [
    {
      id: 'hiroshi',
      name: 'Hiroshi Takeda',
      gender: 'male',
      age: 'young',
      look: 'young samurai, dark blue armour',
    },
  ],
  shots: [
    {
      speaker: 'narrator',
      text: 'The year is 1582.',
      picture: 'a burning village at dusk',
      characters: [],
    },
    {
      speaker: 'narrator',
      text: 'Hiroshi returns home.',
      picture: 'Hiroshi on a mountain path',
      characters: ['hiroshi'],
    },
    {
      speaker: 'hiroshi',
      text: 'Whoever did this, I will find you.',
      picture: 'Hiroshi close-up',
      characters: ['hiroshi'],
    },
  ],
};

const LOWPOLY_SCRIPT = {
  title: 'Why Stopping Time Is A Bad Idea',
  script:
    'If you could stop time with the snap of your fingers, you would instantly go blind. Light could not reach your eyes anymore. The air around you would turn solid. Your doctor would call it a miracle. You would reach for a cup and it would not move. So you would be rich, but frozen forever.',
};
const LOWPOLY_BOARD = {
  cast: [
    {
      id: 'doctor',
      name: 'Doctor',
      gender: 'female',
      age: 'adult',
      skin: 'brown',
      hair: 'ponytail',
      hairColor: 'black',
      top: 'labcoat',
      topColor: 'teal',
      bottomColor: 'navy',
      extra: 'glasses',
    },
    {
      id: 'old_man',
      name: 'Old Man',
      gender: 'male',
      age: 'old',
      skin: 'pale',
      hair: 'short',
      top: 'suit',
      topColor: 'grey',
      bottomColor: 'black',
      extra: 'beard',
    },
  ],
  shots: [
    {
      beat: 1,
      set: 'street',
      framing: 'extremeCloseUp',
      subject: 'you',
      action: 'shock',
      camera: 'pushIn',
    },
    {
      beat: 2,
      set: 'bedroom',
      framing: 'closeUp',
      subject: 'you',
      action: 'idle',
      effect: 'beam',
      camera: 'pullOut',
    },
    {
      beat: 3,
      set: 'street',
      framing: 'wide',
      subject: 'you',
      action: 'walk',
      effect: 'frozen',
      camera: 'orbit',
    },
    {
      beat: 4,
      set: 'hospital',
      framing: 'medium',
      subject: 'doctor',
      others: ['old_man'],
      action: 'talk',
      props: ['brain'],
      speaker: 'doctor',
      camera: 'static',
    },
    { beat: 5, set: 'kitchen', framing: 'pov', subject: 'you', props: ['cup'], camera: 'pushIn' },
    {
      beat: 6,
      set: 'bank',
      framing: 'medium',
      subject: 'you',
      action: 'celebrate',
      props: ['money'],
      effect: 'sparkles',
      bigText: 'IM RICH',
      camera: 'shake',
    },
    {
      beat: 7,
      set: 'space',
      framing: 'wide',
      subject: 'you',
      action: 'float',
      effect: 'glow',
      camera: 'orbit',
    },
  ],
};

test.describe('create a Short', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(async () => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 4 });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString('utf8')));
      req.on('end', () => {
        requests.push({ path: req.url ?? '', body: body ? JSON.parse(body) : undefined });
        res.setHeader('content-type', 'application/json');
        if (req.url?.endsWith('/models')) {
          res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
          return;
        }
        const ask = JSON.stringify(JSON.parse(body).messages);
        const content = ask.includes('low-poly 3D story channels')
          ? JSON.stringify(LOWPOLY_SCRIPT)
          : ask.includes('storyboard a vertical low-poly')
            ? JSON.stringify(LOWPOLY_BOARD)
            : ask.includes('Rec-It is connected')
              ? 'Rec-It is connected.'
              : ask.includes('director and storyboard artist')
                ? JSON.stringify(EPISODE)
                : ask.includes('storyboard')
                  ? JSON.stringify(PLAN)
                  : ask.includes('faceless YouTube Shorts')
                    ? JSON.stringify(FACTS)
                    : JSON.stringify(STORY);
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    aiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  test.afterAll(() => {
    server?.close();
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('write a story with the AI, voice it and build the Short', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_TTS: '1',
      RECIT_FAKE_IMAGES: '1',
    });
    try {
      await createProject(page, 'Stories');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });

      // Point the AI at the fake server and check it.
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'AI' }).click();
      const ai = page.getByTestId('ai-settings');
      await ai.getByLabel('AI provider').selectOption('custom');
      await ai.getByLabel('Server address').fill(aiUrl);
      await ai.getByLabel('Server address').blur();
      await expect(ai.getByText('Installed (fake)')).toBeVisible({ timeout: 60_000 });
      await ai.getByTestId('ai-test').click();
      await expect(ai.getByTestId('ai-check')).toContainText('fake-model answered', {
        timeout: 15_000,
      });
      await page.keyboard.press('Escape');

      // Create → Story video → Write it → Create Short.
      await page.getByTestId('create-button').click();
      const dialog = page.getByTestId('create-dialog');
      await dialog.getByRole('button', { name: /Story or topic video/ }).click();
      await dialog.getByTestId('story-write').click();
      await expect(dialog.getByTestId('story-title')).toHaveValue(STORY.title, { timeout: 15_000 });
      await expect(dialog.getByTestId('story-text')).toHaveValue(STORY.story);
      const write = requests.find((r) => JSON.stringify(r.body ?? '').includes('r/AmItheAsshole'));
      expect(write?.body).toMatchObject({
        model: 'fake-model',
        response_format: { type: 'json_object' },
      });
      await dialog.getByTestId('story-voice').selectOption('bf_emma');
      await dialog.getByTestId('visuals-footage').click();
      await dialog.getByTestId('story-create').click();
      await expect(dialog).toBeHidden({ timeout: 90_000 });

      // The Short: background, title card, voiceover and story captions on the timeline.
      await expect(page.getByText('Your Short is ready on the timeline.')).toBeVisible();
      const items = page.getByTestId('timeline-item');
      await expect(items.first()).toBeVisible();
      expect(await items.count()).toBeGreaterThanOrEqual(5);
      await expect(page.locator('[data-testid=asset-card]')).toHaveCount(3);
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath('story-short.png') });

      // One undo removes the whole Short.
      await items.first().click();
      await page.keyboard.press('Control+Z');
      await expect(items).toHaveCount(0);
    } finally {
      await app.close();
    }
  });

  test('make a Short about a topic with AI pictures from the storyboard', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_TTS: '1',
      RECIT_FAKE_IMAGES: '1',
    });
    try {
      await createProject(page, 'Facts');
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'AI' }).click();
      const ai = page.getByTestId('ai-settings');
      await ai.getByLabel('AI provider').selectOption('custom');
      await ai.getByLabel('Server address').fill(aiUrl);
      await ai.getByLabel('Server address').blur();
      await expect(ai.getByText('Installed (fake)')).toBeVisible({ timeout: 60_000 });
      await page.keyboard.press('Escape');

      await page.getByTestId('create-button').click();
      const dialog = page.getByTestId('create-dialog');
      await dialog.getByRole('button', { name: /Story or topic video/ }).click();
      await dialog.getByRole('combobox').first().selectOption('facts');
      await dialog.getByRole('textbox', { name: 'Topic' }).fill('octopus facts');
      await dialog.getByTestId('story-write').click();
      await expect(dialog.getByTestId('story-title')).toHaveValue(FACTS.title, { timeout: 15_000 });
      // AI pictures is the default; the fake engine counts as installed.
      await expect(dialog.getByTestId('picture-engine')).toHaveCount(0);
      await dialog.getByTestId('picture-style').selectOption('anime');
      await dialog.getByTestId('story-create').click();
      await expect(dialog).toBeHidden({ timeout: 90_000 });

      // Voice + one picture per planned scene, animated, with captions over them.
      await expect(page.locator('[data-testid=asset-card]')).toHaveCount(4);
      const storyboard = requests.find((r) => JSON.stringify(r.body ?? '').includes('storyboard'));
      expect(JSON.stringify(storyboard?.body)).toContain('1. Octopuses have three hearts.');
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath('pictures-short.png') });
    } finally {
      await app.close();
    }
  });
  test('test a talking character: draw, voice and animate one shot', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_TTS: '1',
      RECIT_FAKE_IMAGES: '1',
      RECIT_FAKE_LIPSYNC: '1',
      RECIT_FAKE_VOICEHQ: '1',
    });
    try {
      await createProject(page, 'Characters');
      await page.getByTestId('create-button').click();
      const dialog = page.getByTestId('create-dialog');
      await dialog.getByRole('button', { name: /Talking characters/ }).click();
      // The fake engines count as installed.
      await expect(dialog.getByTestId('talk-create')).toBeEnabled({ timeout: 60_000 });
      await expect(dialog.getByTestId('animation-engine')).toHaveCount(0);
      await dialog.getByTestId('talk-character').fill('a sleepy blue owl');
      await dialog.getByTestId('talk-line').fill('Who stayed up this late?');
      // The human-like voice is the default once installed (the fake one counts).
      await expect(dialog.getByTestId('talk-voice')).toHaveValue('hq:builtin');
      await page.screenshot({ path: test.info().outputPath('talking-form.png') });
      await dialog.getByTestId('talk-create').click();
      await expect(dialog).toBeHidden({ timeout: 90_000 });
      // The clip, the line and the character picture, on a new sequence.
      await expect(page.locator('[data-testid=asset-card]')).toHaveCount(3);
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath('talking-shot.png') });
    } finally {
      await app.close();
    }
  });
  test('make an episode from a brief', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_TTS: '1',
      RECIT_FAKE_IMAGES: '1',
      RECIT_FAKE_LIPSYNC: '1',
      RECIT_FAKE_VOICEHQ: '1',
    });
    try {
      await createProject(page, 'Episode');
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'AI' }).click();
      const ai = page.getByTestId('ai-settings');
      await ai.getByLabel('AI provider').selectOption('custom');
      await ai.getByLabel('Server address').fill(aiUrl);
      await ai.getByLabel('Server address').blur();
      await page.keyboard.press('Escape');

      await page.getByTestId('create-button').click();
      const dialog = page.getByTestId('create-dialog');
      // Episode from a brief is the first template; the narrator defaults to a deep human-like voice.
      await expect(dialog.getByTestId('episode-narrator')).toHaveValue('hq:k-am_onyx', {
        timeout: 60_000,
      });
      await dialog
        .getByTestId('episode-brief')
        .fill(
          'Episode 1 of a dark 2D anime samurai thriller. Hiroshi returns to his burning village.',
        );
      await page.screenshot({ path: test.info().outputPath('episode-form.png') });
      await dialog.getByTestId('episode-create').click();
      await expect(dialog).toBeHidden({ timeout: 120_000 });
      // The voice track and one visual per shot (the dialogue shot is a talking clip).
      await expect(page.locator('[data-testid=asset-card]')).toHaveCount(4);
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath('episode.png') });
    } finally {
      await app.close();
    }
  });
  test('make a low-poly 3D Short from a topic', async () => {
    // Software WebGL (SwiftShader) in CI films slowly; a graphics card takes seconds.
    test.setTimeout(900_000);
    const projects = mkdtempSync(join(tmpdir(), 'recit-lowpoly-'));
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_TTS: '1',
      RECIT_PROJECTS_DIR: projects,
    });
    try {
      await createProject(page, 'Low Poly');
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('tab', { name: 'AI' }).click();
      const ai = page.getByTestId('ai-settings');
      await ai.getByLabel('AI provider').selectOption('custom');
      await ai.getByLabel('Server address').fill(aiUrl);
      await ai.getByLabel('Server address').blur();
      await page.keyboard.press('Escape');

      await page.getByTestId('create-button').click();
      const dialog = page.getByTestId('create-dialog');
      await dialog.getByRole('button', { name: /Low-poly 3D story/ }).click();
      await dialog.getByTestId('lowpoly-topic').fill('Why stopping time is a bad idea');
      await dialog.getByTestId('lowpoly-narrator').selectOption('am_michael');
      await dialog.getByTestId('lowpoly-brand').fill('Rec It Shorts');
      await page.screenshot({ path: test.info().outputPath('lowpoly-form.png') });
      await dialog.getByTestId('lowpoly-create').click();
      await expect(dialog).toBeHidden({ timeout: 840_000 });
      // The narration and the filmed 3D video.
      await expect(page.locator('[data-testid=asset-card]')).toHaveCount(2);
      await page.waitForTimeout(500);
      await page.screenshot({ path: test.info().outputPath('lowpoly.png') });
      const media = join(projects, 'Low Poly media');
      const video = readdirSync(media).find((f) => /^3d .*\.mp4$/.test(f));
      expect(video).toBeTruthy();
      // A contact sheet of the filmed frames, for looking at the style.
      execFileSync(bins!.ffmpeg, [
        '-v',
        'error',
        '-y',
        '-i',
        join(media, video!),
        '-vf',
        'fps=2,scale=270:-1,tile=6x3',
        '-frames:v',
        '1',
        test.info().outputPath('lowpoly-sheet.jpg'),
      ]);
    } finally {
      await app.close();
      rmSync(projects, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    }
  });
});
