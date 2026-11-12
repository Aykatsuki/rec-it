import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;

test.describe('timeline editing and export', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> => (bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg });

  test('drag clips onto the timeline, edit, undo, change settings and export', async () => {
    const userData = tempUserData();
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Edit test');
      await mockOpenDialog(app, [fx.h264, fx.audio, fx.image]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import 3 files' }).click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(3, { timeout: 60_000 });

      // Dragging the first clip onto the empty timeline creates a 9:16 sequence.
      await page.locator('[data-testid=asset-card][data-name="clip h264.mp4"]').dragTo(page.getByTestId('timeline-drop'));
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      await expect(page.getByTestId('sequence-settings')).toContainText('1080×1920 · 30 fps');

      // Double-click adds at the end; audio goes to an audio track.
      await page.locator('[data-testid=asset-card][data-name="clip h264.mp4"]').dblclick();
      await page.locator('[data-testid=asset-card][data-name="audio.wav"]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(3);
      await expect(page.getByTestId('program-time')).toContainText('/00:06.000');

      // Split at the playhead with S, then undo and redo.
      await page.getByTestId('ruler').click({ position: { x: 120, y: 10 } });
      await page.keyboard.press('s');
      await expect(page.getByTestId('timeline-item')).toHaveCount(5);
      await page.keyboard.press('Control+z');
      await expect(page.getByTestId('timeline-item')).toHaveCount(3);
      await page.keyboard.press('Control+Shift+z');
      await expect(page.getByTestId('timeline-item')).toHaveCount(5);

      // Select a clip and delete it with ripple: the timeline gets shorter.
      await page.getByTestId('timeline-item').nth(0).click();
      await expect(page.getByTestId('clip-inspector')).toBeVisible();
      await page.keyboard.press('Shift+Delete');
      await expect(page.getByTestId('timeline-item')).toHaveCount(4);

      // Change resolution and frame rate.
      await page.getByTestId('sequence-settings').click();
      await page.getByLabel('Format').selectOption('square');
      await page.getByLabel('Frame rate').selectOption('25/1');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByTestId('sequence-settings')).toContainText('1080×1080 · 25 fps');

      // Export.
      const out = join(userData, 'export test.mp4');
      await app.evaluate(({ dialog }, path) => {
        dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as typeof dialog.showSaveDialog;
      }, out);
      await page.getByTestId('export-button').click();
      await page.getByLabel(/Draft/).check();
      await page.getByRole('button', { name: 'Export…' }).click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', { timeout: 120_000 });
      expect(existsSync(out)).toBe(true);
      const probe = execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'csv=p=0', out],
        { encoding: 'utf8' },
      ).trim();
      expect(probe).toBe('1080,1080,25/1');
    } finally {
      await app.close();
    }
  });

  test('the timeline is saved with the project', async () => {
    const userData = tempUserData();
    let { app, page } = await launch(userData, env());
    await createProject(page, 'Persist test');
    await mockOpenDialog(app, [fx.h264]);
    await page.getByRole('button', { name: 'Import footage' }).click();
    await page.getByLabel(/I have the right/).check();
    await page.getByRole('button', { name: 'Import' }).last().click();
    await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, { timeout: 60_000 });
    await page.locator('[data-testid=asset-card]').dblclick();
    await page.locator('[data-testid=asset-card]').dblclick();
    await expect(page.getByTestId('timeline-item')).toHaveCount(2);
    await app.close();

    ({ app, page } = await launch(userData, env()));
    try {
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);
      // Media used on the timeline cannot be removed from the project.
      await page.locator('[data-testid=asset-card]').click();
      await page.keyboard.press('Delete');
      await expect(page.locator('.toast')).toContainText('used in');
      await expect(page.getByTestId('asset-card')).toHaveCount(1);
    } finally {
      await app.close();
    }
  });
});
