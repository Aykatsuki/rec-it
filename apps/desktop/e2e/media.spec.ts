import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;

test.describe('media pipeline', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');

  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 90 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('imports through the UI, processes, and plays the proxy', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Import test');
      await mockOpenDialog(app, [fx.h264, fx.audio, fx.image, fx.corrupt]);
      await page.getByRole('button', { name: 'Import footage' }).click();

      // Rights are recorded at import (ADR-012); the button stays disabled until confirmed.
      const importButton = page.getByRole('button', { name: 'Import 4 files' });
      await expect(importButton).toBeDisabled();
      await page.getByLabel(/I have the right/).check();
      await importButton.click();

      const cards = page.getByTestId('asset-card');
      await expect(cards).toHaveCount(4);
      await expect(page.locator('[data-testid=asset-card][data-status=processing]')).toHaveCount(
        0,
        { timeout: 60_000 },
      );
      await expect(
        page.locator('[data-testid=asset-card][data-name="corrupt.mp4"]'),
      ).toHaveAttribute('data-status', 'failed');
      await expect(
        page.locator('[data-testid=asset-card][data-name="clip h264.mp4"]'),
      ).toHaveAttribute('data-status', 'ready');

      await page.locator('[data-testid=asset-card][data-name="clip h264.mp4"]').click();
      await expect(page.getByTestId('asset-details')).toContainText('1280 × 720');
      const video = page.getByTestId('source-video');
      // The proxy is served by recit-media:// with range requests; seeking proves both work.
      await video.evaluate(
        (v: HTMLVideoElement) =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('video did not load')), 15000);
            const seek = () => {
              v.currentTime = 2;
            };
            v.addEventListener('seeked', () => (clearTimeout(timer), resolve()), { once: true });
            if (v.readyState >= 1) seek();
            else v.addEventListener('loadedmetadata', seek, { once: true });
          }),
      );
      const info = await video.evaluate((v: HTMLVideoElement) => ({
        w: v.videoWidth,
        h: v.videoHeight,
        t: v.currentTime,
      }));
      expect(info).toEqual({ w: 1280, h: 720, t: 2 });
    } finally {
      await app.close();
    }
  });

  test('serves only allowed cache files over recit-media://', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Protocol test');
      const results = await page.evaluate(async () => {
        const codes: number[] = [];
        for (const url of [
          'recit-media://asset/project_x/asset_y/../../../app.db',
          'recit-media://asset/project_x/asset_y/secrets.json',
          'recit-media://asset/project_x/asset_y/proxy.mp4',
        ]) {
          codes.push(
            await fetch(url).then(
              (r) => r.status,
              () => -1,
            ),
          );
        }
        return codes;
      });
      expect(results).toEqual([404, 404, 404]);
    } finally {
      await app.close();
    }
  });

  test('recovers after the app is killed mid-processing', async () => {
    const userData = tempUserData();
    let { app, page } = await launch(userData, env());
    await createProject(page, 'Crash test');
    await mockOpenDialog(app, [fx.long, fx.h264]);
    await page.getByRole('button', { name: 'Import footage' }).click();
    await page.getByLabel(/I have the right/).check();
    await page.getByRole('button', { name: 'Import 2 files' }).click();
    await expect(page.locator('[data-testid=asset-card][data-name="long.mp4"]')).toHaveAttribute(
      'data-status',
      'processing',
    );

    // Hard kill: no clean shutdown at all.
    app.process().kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));

    ({ app, page } = await launch(userData, env()));
    try {
      // The last project reopens by itself, with both imports, and unfinished work resumes.
      await expect(page.locator('.topbar__project')).toContainText('Crash test');
      await expect(page.getByTestId('asset-card')).toHaveCount(2);
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(2, {
        timeout: 120_000,
      });
      const walk = (d: string): string[] =>
        existsSync(d)
          ? readdirSync(d, { withFileTypes: true }).flatMap((e) =>
              e.isDirectory() ? walk(join(d, e.name)) : [e.name],
            )
          : [];
      const parts = walk(join(userData, 'cache')).filter((n) => n.endsWith('.part'));
      expect(parts).toEqual([]);
    } finally {
      await app.close();
    }
  });
});
