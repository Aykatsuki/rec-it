// Fades, opacity and colour effects from the inspector and the timeline (ADR-036).
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

interface Item {
  id: string;
  opacity?: number;
  fade?: { in: number; out: number };
  effects?: { saturation: number; enabled: boolean }[];
}
const firstItem = (page: Page) =>
  page.evaluate(async () => {
    const r = (await window.recit.backend.invoke('doc.get' as never, {} as never)) as {
      result: { doc: { sequences: { tracks: { items: Item[] }[] }[] } };
    };
    return r.result.doc.sequences[0]!.tracks.flatMap((t) => t.items)[0]!;
  });

test.describe('effects', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('colour effect, opacity and fades from the inspector and the clip handles', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Effects');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      const item = page.getByTestId('timeline-item').first();
      await item.click({ position: { x: 1.5 * ZOOM, y: 30 } });

      // Colour: add an effect, take the saturation down to nothing, switch it off and on.
      await page.getByTestId('add-colour').click();
      await expect(page.getByTestId('colour-effect')).toHaveCount(1);
      const saturation = page.getByLabel('Saturation', { exact: true });
      await saturation.focus();
      await saturation.press('Home');
      await expect(sliderValue(page, 'Saturation')).toHaveText('0%');
      await expect.poll(async () => (await firstItem(page)).effects?.[0]?.saturation).toBe(0);
      await page.getByRole('button', { name: 'Turn effect off' }).click();
      await expect.poll(async () => (await firstItem(page)).effects?.[0]?.enabled).toBe(false);
      await page.getByRole('button', { name: 'Turn effect on' }).click();

      // Opacity from the slider.
      const opacity = page.getByLabel('Opacity', { exact: true });
      await opacity.focus();
      for (let i = 0; i < 20; i++) await opacity.press('ArrowLeft');
      await expect(sliderValue(page, 'Opacity')).toHaveText('80%');
      await expect.poll(async () => (await firstItem(page)).opacity).toBeCloseTo(0.8);

      // Fade in by dragging the handle at the clip's top-left corner half a second right.
      await item.hover();
      const handle = (await page.getByTestId('fade-in-handle').boundingBox())!;
      await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await page.mouse.down();
      await page.mouse.move(handle.x + handle.width / 2 + 0.5 * ZOOM, handle.y + 4, { steps: 5 });
      await page.mouse.up();
      await expect(sliderValue(page, 'Fade in')).toHaveText('0.5 s');
      // Fade out from the slider.
      const fadeOut = page.getByLabel('Fade out', { exact: true });
      await fadeOut.focus();
      for (let i = 0; i < 10; i++) await fadeOut.press('ArrowRight');
      await expect(sliderValue(page, 'Fade out')).toHaveText('1.0 s');
      await expect(item.locator('.tl__fade')).toHaveCount(2);
      const fade = (await firstItem(page)).fade!;
      expect(fade.in / 705_600_000).toBeCloseTo(0.5);
      expect(fade.out / 705_600_000).toBeCloseTo(1);

      // Undo takes the last fade away again.
      await page.keyboard.press('Control+z');
      await expect(sliderValue(page, 'Fade out')).toHaveText('0.9 s');
    } finally {
      await app.close();
    }
  });
});
