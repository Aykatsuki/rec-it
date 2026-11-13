import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

// Uses the real media-ai sidecar with its fake Whisper engine ("word1", "word2", … every 0.5 s),
// so no model is downloaded.
const bins = findTestFfmpeg();
let fx: Fixtures;

test.describe('transcript', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('transcribe a clip, jump to a word, and cut words from the timeline', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_WHISPER: '1',
      RECIT_FAKE_WHISPER_DELAY: '0.15',
    });
    try {
      await createProject(page, 'Transcript');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);

      await page.getByRole('tab', { name: 'Transcript' }).click();
      const panel = page.getByTestId('transcript-panel');
      await panel.getByRole('button', { name: 'Transcribe', exact: true }).click({
        timeout: 60_000,
      });
      await expect(panel.getByText('Transcribed')).toBeVisible({ timeout: 60_000 });

      const words = page.getByTestId('transcript-words').getByRole('option');
      await expect(words).toHaveText(['word1', 'word2', 'word3', 'word4', 'word5', 'word6']);

      // Clicking a word moves the playhead there and highlights it.
      await words.nth(4).click();
      await expect(words.nth(4)).toHaveClass(/is-current/);

      // Select word2–word3 and delete: the clip is cut and the gap closed.
      await words.nth(1).click();
      await words.nth(2).click({ modifiers: ['Shift'] });
      await expect(page.getByTestId('cut-words')).toHaveText('Cut 2 words');
      await page.keyboard.press('Delete');
      await expect(words).toHaveText(['word1', 'word4', 'word5', 'word6']);
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      // One undo brings the words back.
      await page.getByTestId('timeline-item').first().click();
      await page.keyboard.press('Control+Z');
      await expect(words).toHaveCount(6);
    } finally {
      await app.close();
    }
  });
});
