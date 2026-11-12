import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;

const sliderValue = (page: Page, label: string) =>
  page
    .locator('.slider', { has: page.getByLabel(label, { exact: true }) })
    .locator('.slider__value');

async function dragBy(page: Page, x: number, y: number, dx: number, dy: number) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

async function centre(page: Page, testId: string) {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

test.describe('direct manipulation and context menus', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('move, resize and rotate a clip in the preview, and use right-click menus', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Transform test');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      const card = page.locator('[data-testid=asset-card][data-status=ready]');
      await expect(card).toHaveCount(1, { timeout: 60_000 });

      // Right-click in the media bin adds the clip.
      await card.click({ button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await page.getByRole('menuitem', { name: 'Add to end of timeline' }).click();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      await expect(page.getByTestId('filmstrip')).toBeVisible();
      await page.getByTestId('ruler').click({ position: { x: 40, y: 10 } });

      // Click the picture to select it; the transform box and inspector appear.
      const mid = await centre(page, 'program-monitor');
      await page.mouse.click(mid.x, mid.y);
      await expect(page.getByTestId('transform-box')).toBeVisible();
      await expect(page.getByTestId('clip-inspector')).toBeVisible();
      await page.getByRole('radio', { name: 'Fit whole picture' }).click();
      await expect(sliderValue(page, 'Scale')).toHaveText('100%');

      // Resize from a corner.
      const se = await centre(page, 'transform-se');
      await dragBy(page, se.x, se.y, 40, 25);
      await expect(sliderValue(page, 'Scale')).not.toHaveText('100%');

      // Move by dragging the picture (Alt turns snapping off so the offset is exact).
      const body = await centre(page, 'transform-box');
      await page.keyboard.down('Alt');
      await dragBy(page, body.x, body.y, 30, 0);
      await page.keyboard.up('Alt');
      await expect(sliderValue(page, 'Left / right')).not.toHaveText('0%');
      await expect(sliderValue(page, 'Up / down')).toHaveText('0%');

      // Rotate with the round handle, holding Shift for 15° steps.
      const rot = await centre(page, 'transform-rotate');
      const c = await centre(page, 'transform-box');
      await page.keyboard.down('Shift');
      await dragBy(page, rot.x, rot.y, c.y - rot.y, 0);
      await page.keyboard.up('Shift');
      await expect(sliderValue(page, 'Rotation')).toHaveText('45°');

      // Each gesture is one undo step.
      await page.keyboard.press('Control+z');
      await expect(sliderValue(page, 'Rotation')).toHaveText('0°');

      // Right-click the clip on the timeline: rotate via the Framing submenu, then duplicate.
      const item = page.getByTestId('timeline-item').first();
      await item.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Framing' }).hover();
      await page.getByRole('menuitem', { name: 'Rotate 90° clockwise' }).click();
      await expect(sliderValue(page, 'Rotation')).toHaveText('90°');
      await item.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Duplicate' }).click();
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      // Copy and paste with the keyboard.
      await page.keyboard.press('Control+c');
      await page.keyboard.press('End');
      await page.keyboard.press('Control+v');
      await expect(page.getByTestId('timeline-item')).toHaveCount(3);

      // Box-select on the empty lane picks up clips, and they move together.
      const lane = page.locator('.tl__lane', { has: item });
      const laneBox = (await lane.boundingBox())!;
      const tlBox = (await page.locator('.tl').boundingBox())!;
      const right = tlBox.x + tlBox.width - 30;
      await dragBy(page, right, laneBox.y + 3, laneBox.x + 5 - right, 20);
      await expect(page.locator('[data-testid=timeline-item][data-selected=true]')).toHaveCount(3);

      // Right-click empty lane space: Select all, then delete everything.
      await lane.click({ button: 'right', position: { x: right - laneBox.x, y: 10 } });
      await page.getByRole('menuitem', { name: 'Select all', exact: true }).click();
      await page.keyboard.press('Delete');
      await expect(page.getByTestId('timeline-item')).toHaveCount(0);

      // Track header menu adds a track.
      const tracks = await page.locator('.tl__row').count();
      await page.locator('.tl__header').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Add video track' }).click();
      await expect(page.locator('.tl__row')).toHaveCount(tracks + 1);

      // Escape closes a menu.
      await page.locator('.tl__header').first().click({ button: 'right' });
      await expect(page.getByTestId('context-menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('context-menu')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});
