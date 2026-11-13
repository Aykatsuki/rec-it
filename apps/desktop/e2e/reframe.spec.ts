import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;

type Item = {
  id: string;
  muted: boolean;
  linkId?: string;
  transform: { fit: string; y: number; crop?: Record<string, number> };
};

test.describe('reframing', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('facecam + gameplay layout, crop window, safe zones', async () => {
    const { app, page } = await launch(
      tempUserData(),
      bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg },
    );
    const videoItems = () =>
      page.evaluate(async () => {
        const r = (await window.recit.backend.invoke('doc.get' as never, {} as never)) as {
          result: { doc: { sequences: { tracks: { kind: string; items: unknown[] }[] }[] } };
        };
        return r.result.doc.sequences[0]!.tracks.filter((t) => t.kind === 'video').map(
          (t) => t.items,
        );
      }) as Promise<Item[][]>;
    try {
      await createProject(page, 'Reframe');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByTestId('timeline-item').click();

      // One click: gameplay below, a muted linked copy as the facecam on top; the crop window opens.
      await page.getByRole('button', { name: 'Facecam + gameplay' }).click();
      await expect(page.getByTestId('crop-dialog')).toBeVisible();
      const [v2, v1] = await videoItems();
      const cam = v2![0]!;
      const game = v1![0]!;
      expect(cam.muted).toBe(true);
      expect(cam.linkId).toBeDefined();
      expect(cam.linkId).toBe(game.linkId);
      expect(cam.transform.fit).toBe('fit');
      expect(cam.transform.y).toBeLessThan(0);
      expect(game.transform.y).toBeGreaterThan(0);
      expect(cam.transform.crop).toMatchObject({ left: 0, top: 0 });

      // Move the box to the bottom-right corner; the shape is kept.
      const size = await page.getByTestId('crop-size').textContent();
      const box = (await page.getByTestId('crop-box').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 2000, box.y + 2000, { steps: 5 });
      await page.mouse.up();
      await expect(page.getByTestId('crop-size')).toHaveText(size!);
      await page.getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByTestId('crop-dialog')).toBeHidden();
      const [after] = await videoItems();
      const crop = after![0]!.transform.crop!;
      expect(crop.right).toBeCloseTo(0, 3);
      expect(crop.bottom).toBeCloseTo(0, 3);
      expect(crop.left).toBeGreaterThan(0.3);

      // Undo removes the crop change; undo again removes the whole layout.
      await page.keyboard.press('Control+Z');
      await page.keyboard.press('Control+Z');
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);

      // Safe zones from the preview's menu.
      await page
        .getByTestId('transform-surface')
        .click({ button: 'right', position: { x: 3, y: 3 } });
      await page.getByRole('menuitemcheckbox', { name: 'Shorts safe zones' }).click();
      await expect(page.getByTestId('safe-zones')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('auto reframe follows a face with x keyframes (fake detector)', async () => {
    const { app, page } = await launch(tempUserData(), {
      ...(bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg }),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_FACES: '1',
    });
    const xKeys = () =>
      page.evaluate(async () => {
        const r = (await window.recit.backend.invoke('doc.get' as never, {} as never)) as {
          result: {
            doc: {
              sequences: {
                tracks: { kind: string; items: { keyframes?: { x?: { v: number }[] } }[] }[];
              }[];
            };
          };
        };
        const item = r.result.doc.sequences[0]!.tracks.find(
          (t) => t.kind === 'video' && t.items.length,
        )!.items[0]!;
        return item.keyframes?.x?.map((k) => k.v) ?? [];
      });
    try {
      await createProject(page, 'Auto reframe');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByTestId('timeline-item').click();
      await page.getByTestId('auto-reframe').click({ timeout: 60_000 });
      // Analysed, then applied: the picture slides from showing the left towards the right.
      await expect.poll(async () => (await xKeys()).length, { timeout: 60_000 }).toBeGreaterThan(1);
      const xs = await xKeys();
      expect(xs[0]!).toBeGreaterThan(xs.at(-1)!);
      expect(xs).toEqual([...xs].sort((a, b) => b - a));
      await expect(page.getByTestId('timeline-keyframe').first()).toBeVisible();
      // One undo removes the reframing.
      await page.keyboard.press('Control+Z');
      await expect.poll(async () => (await xKeys()).length).toBe(0);
      // Reframing again uses the stored analysis straight away.
      await page.getByTestId('timeline-item').click();
      await page.getByTestId('auto-reframe').click();
      await expect.poll(async () => (await xKeys()).length).toBeGreaterThan(1);
    } finally {
      await app.close();
    }
  });
});
