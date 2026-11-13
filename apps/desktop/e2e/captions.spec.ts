import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

// Real sidecar with the fake Whisper engine: "word1", "word2", … every 0.5 s.
const bins = findTestFfmpeg();
let fx: Fixtures;

/** How many pixels of the preview differ clearly from `baseline` (a screenshot without captions). */
async function changedPixels(page: Page, baseline: Buffer): Promise<number> {
  const now = await page.getByTestId('program-monitor').screenshot();
  return page.evaluate(
    async ([a, b]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = new OffscreenCanvas(img.width, img.height);
        const ctx = c.getContext('2d')!;
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, img.width, img.height).data;
      };
      const [x, y] = [await load(a!), await load(b!)];
      let n = 0;
      for (let i = 0; i < x.length; i += 4)
        if (
          Math.abs(x[i]! - y[i]!) +
            Math.abs(x[i + 1]! - y[i + 1]!) +
            Math.abs(x[i + 2]! - y[i + 2]!) >
          90
        )
          n++;
      return n;
    },
    [baseline.toString('base64'), now.toString('base64')],
  );
}

test.describe('captions', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('correct a word, turn on captions, and see them in the preview', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_WHISPER: '1',
    });
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    try {
      await createProject(page, 'Captions');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByRole('tab', { name: 'Transcript' }).click();
      const panel = page.getByTestId('transcript-panel');
      await panel
        .getByRole('button', { name: 'Transcribe', exact: true })
        .click({ timeout: 60_000 });
      await expect(panel.getByText('Transcribed', { exact: true })).toBeVisible({
        timeout: 60_000,
      });
      const words = page.getByTestId('transcript-words').getByRole('option');
      await expect(words).toHaveCount(6);

      // Correct "word2" into two words; hide "word3" from captions.
      await words.nth(1).dblclick();
      await page.getByTestId('word-input').fill('Hello there');
      await page.getByTestId('word-input').press('Enter');
      await expect(words.nth(1)).toHaveText('Hello');
      await expect(words.nth(2)).toHaveText('there');
      await expect(words.nth(1)).toHaveClass(/is-edited/);
      await words.nth(3).dblclick();
      await page.getByTestId('word-input').fill('');
      await page.getByTestId('word-input').press('Enter');
      await expect(words.nth(3)).toHaveClass(/is-hidden/);

      // Captions off: nothing drawn.
      // Captions off: no caption layer over the picture at all.
      const canvas = page.getByTestId('captions-canvas');
      await words.nth(1).click(); // playhead into "Hello"
      await expect(canvas).toHaveCount(0);
      await page.mouse.move(0, 0);
      const baseline = await page.getByTestId('program-monitor').screenshot();

      await page.getByRole('tab', { name: 'Captions' }).click();
      await page.getByLabel('Show captions').click();
      await expect(page.getByLabel('Show captions')).toBeChecked();
      await expect(canvas).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
      await expect
        .poll(() => changedPixels(page, baseline), { timeout: 10_000 })
        .toBeGreaterThan(400);
      const highlight = await page.getByTestId('program-monitor').screenshot();

      // Another style draws something else; undo brings back the first.
      await page.getByRole('button', { name: /Clean box/ }).click();
      await expect
        .poll(() => changedPixels(page, highlight), { timeout: 10_000 })
        .toBeGreaterThan(400);
      await page.keyboard.press('Control+Z');
      await expect.poll(() => changedPixels(page, highlight), { timeout: 10_000 }).toBeLessThan(50);

      // Turning captions off removes the layer.
      await page.getByLabel('Show captions').click();
      await expect(page.getByLabel('Show captions')).not.toBeChecked();
      await expect(canvas).toHaveCount(0);
      await expect.poll(() => changedPixels(page, baseline), { timeout: 10_000 }).toBeLessThan(50);
      expect(errors.filter((e) => /caption/i.test(e))).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
