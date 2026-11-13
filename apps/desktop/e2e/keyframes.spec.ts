import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;
const ZOOM = 80;

const sliderValue = (page: Page, label: string) =>
  page
    .locator('.slider', { has: page.getByLabel(label, { exact: true }) })
    .locator('.slider__value');

test.describe('keyframes and linked clips', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('animate scale with keyframes, then detach, link and unlink audio', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Keyframes');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      const item = page.getByTestId('timeline-item').first();
      await expect(item).toBeVisible();

      // Keyframe at 0.5 s with scale 100%.
      await page.getByTestId('ruler').click({ position: { x: 0.5 * ZOOM, y: 10 } });
      await item.click({ position: { x: 0.5 * ZOOM, y: 30 } });
      await page.getByTestId('keyframe-scale').click();
      await expect(page.getByTestId('timeline-keyframe')).toHaveCount(1);

      // At 2.5 s, changing the slider adds a second keyframe automatically.
      await page.getByTestId('ruler').click({ position: { x: 2.5 * ZOOM, y: 10 } });
      await item.click({ position: { x: 2.5 * ZOOM, y: 30 } });
      const scale = page.getByLabel('Scale', { exact: true });
      await scale.focus();
      for (let i = 0; i < 50; i++) await scale.press('ArrowRight');
      await expect(sliderValue(page, 'Scale')).toHaveText('150%');
      await expect(page.getByTestId('timeline-keyframe')).toHaveCount(2);

      // Half-way between, the value is interpolated.
      await page.getByTestId('ruler').click({ position: { x: 1.5 * ZOOM, y: 10 } });
      await item.click({ position: { x: 1.5 * ZOOM, y: 30 } });
      await expect(sliderValue(page, 'Scale')).toHaveText('125%');

      // Easing for the keyframe at 0.5 s.
      await page.getByTestId('keyframes').getByRole('button', { name: 'Previous' }).click();
      await expect(page.getByTestId('program-time')).toContainText('00:00.500');
      await page.getByLabel('Keyframe easing').selectOption('ease');
      await page.getByTestId('ruler').click({ position: { x: 1 * ZOOM, y: 10 } });
      await item.click({ position: { x: 1 * ZOOM, y: 30 } });
      // Eased: 0.25 of the way in time is 0.156 of the way in value → 108%.
      await expect(sliderValue(page, 'Scale')).toHaveText('108%');

      // Undo removes the easing change; the diamond removes a keyframe.
      await page.keyboard.press('Control+z');
      await expect(sliderValue(page, 'Scale')).toHaveText('113%');

      // Drag the second keyframe (2.5 s) half a second earlier: at 1.5 s the value is then
      // 100% + 50% × (1 / 1.5) = 133%.
      const marker = page.getByTestId('timeline-keyframe').nth(1);
      await expect(marker).toHaveAttribute('title', /2\.50 s/);
      // hover() waits until nothing covers the marker (and names what does, if something does).
      await marker.hover();
      const kf = (await marker.boundingBox())!;
      await page.mouse.down();
      await page.mouse.move(kf.x + kf.width / 2 - 20, kf.y + kf.height / 2, { steps: 4 });
      await page.mouse.move(kf.x + kf.width / 2 - 0.5 * ZOOM, kf.y + kf.height / 2, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByTestId('program-time')).toContainText('00:02.000');
      await page.getByTestId('ruler').click({ position: { x: 1.5 * ZOOM, y: 10 } });
      await item.click({ position: { x: 1.5 * ZOOM, y: 30 } });
      await expect(sliderValue(page, 'Scale')).toHaveText('133%');

      // Detach audio: a linked sound clip appears and moves with the picture.
      await item.click({ button: 'right', position: { x: 10, y: 30 } });
      await page.getByRole('menuitem', { name: 'Detach audio' }).click();
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);
      await expect(page.getByLabel('Linked')).toHaveCount(2);
      const audio = page.getByTestId('timeline-item').nth(1);
      const before = (await audio.boundingBox())!.x;
      const box = (await item.boundingBox())!;
      await page.mouse.move(box.x + 30, box.y + 20);
      await page.mouse.down();
      await page.mouse.move(box.x + 70, box.y + 20, { steps: 5 });
      await page.mouse.move(box.x + 110, box.y + 20, { steps: 5 });
      await page.mouse.up();
      await expect.poll(async () => Math.round((await audio.boundingBox())!.x - before)).toBe(80);

      // Unlink: the link badges go away.
      await item.click({ button: 'right', position: { x: 10, y: 30 } });
      await page.getByRole('menuitem', { name: 'Unlink' }).click();
      await expect(page.getByLabel('Linked')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
