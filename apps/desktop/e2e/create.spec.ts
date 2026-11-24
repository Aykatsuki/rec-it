import { expect, test } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { rmSync } from 'node:fs';
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
        const content = ask.includes('Rec-It is connected')
          ? 'Rec-It is connected.'
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
      await dialog.getByTestId('story-write').click();
      await expect(dialog.getByTestId('story-title')).toHaveValue(STORY.title, { timeout: 15_000 });
      await expect(dialog.getByTestId('story-text')).toHaveValue(STORY.story);
      const write = requests.find((r) => JSON.stringify(r.body ?? '').includes('r/AmItheAsshole'));
      expect(write?.body).toMatchObject({
        model: 'fake-model',
        response_format: { type: 'json_object' },
      });
      await dialog.getByTestId('story-voice').selectOption('bf_emma');
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
});
