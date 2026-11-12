// Frame accuracy (ROADMAP Phase 2): the GPU preview must show exactly frame n at time n/fps,
// when stepping forwards, backwards and after jumps (which reset the decoder).
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTestFfmpeg } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let dir = '';
let ramp = '';
/** Frame n has luma 16 + STEP·(n mod 40): neighbouring frames differ clearly even after encoding. */
const STEP = 5;

/** Frame number (mod 40) shown in the middle of the preview canvas. */
async function shownFrame(page: Page, at: number): Promise<number> {
  await page.waitForFunction(
    (t) =>
      document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]')?.dataset.time === t,
    at.toFixed(3),
  );
  const grey = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]')!;
    const probe = document.createElement('canvas');
    probe.width = 8;
    probe.height = 8;
    const ctx = probe.getContext('2d')!;
    ctx.drawImage(c, c.width / 2 - 4, c.height / 2 - 4, 8, 8, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i + 1]!;
    return sum / (d.length / 4);
  });
  // Full-range grey back to limited-range luma, then to the frame number.
  const luma = (grey * 219) / 255 + 16;
  return Math.round((luma - 16) / STEP);
}

test.describe('frame accuracy', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recit-frames-'));
    ramp = join(dir, 'ramp.mp4');
    execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x240:r=30:d=4',
      '-vf',
      `geq=lum='16+${STEP}*mod(N\\,40)':cb=128:cr=128`,
      '-c:v',
      'libx264',
      '-crf',
      '10',
      '-pix_fmt',
      'yuv420p',
      ramp,
    ]);
  });
  test.afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('the GPU preview shows the exact frame when stepping and jumping', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Frames');
      await mockOpenDialog(app, [ramp]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await expect(page.getByTestId('sequence-settings')).toContainText('30 fps');
      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');
      await page.getByTestId('timeline-item').click();
      await page.keyboard.press('Escape');

      let frame = 0;
      const check = async () =>
        expect(await shownFrame(page, frame / 30), `frame ${frame}`).toBe(frame % 40);
      const press = async (key: string, delta: number) => {
        await page.keyboard.press(key);
        frame += delta;
        await check();
      };
      await page.keyboard.press('Home');
      await check();
      await press('ArrowRight', 1);
      await press('ArrowRight', 1);
      await press('Shift+ArrowRight', 10);
      await press('Shift+ArrowRight', 10);
      for (let i = 0; i < 5; i++) await press('ArrowRight', 1);
      await press('Shift+ArrowRight', 10); // into the next 40-frame cycle
      await press('Shift+ArrowRight', 10);
      await press('Shift+ArrowRight', 10);
      await press('ArrowLeft', -1); // backwards: the decoder restarts from a keyframe
      await press('ArrowLeft', -1);
      await press('Shift+ArrowLeft', -10);
      await press('Home', -frame);
      await press('Shift+ArrowRight', 10);

      // Scrub latency (informational; the target of 150 ms is measured on the reference PC).
      const t0 = Date.now();
      await press('Shift+ArrowRight', 10);
      console.info(`Seek to a new frame drawn in ${Date.now() - t0} ms`);

      // Playback moves the playhead and keeps drawing frames — also on a slow machine (the CPU is
      // throttled 4×), where a render can take longer than a screen refresh.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.keyboard.press('Space');
      await page.waitForTimeout(1500);
      await page.keyboard.press('Space');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const drawn = Number(await page.getByTestId('program-canvas').getAttribute('data-time'));
      expect(drawn).toBeGreaterThan(frame / 30 + 0.5);

      await page.keyboard.press('Home');
      frame = 0;
      await check();

      // If the graphics context is lost (driver reset, sleep) and comes back, drawing resumes.
      await page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]')!;
        const ext = c.getContext('webgl2')!.getExtension('WEBGL_lose_context')!;
        ext.loseContext();
        setTimeout(() => ext.restoreContext(), 300);
      });
      await page.waitForTimeout(800);
      await press('ArrowRight', 1);
      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');

      // The engine can be switched to the compatible one from the preview's menu.
      await page
        .getByTestId('transform-surface')
        .click({ button: 'right', position: { x: 3, y: 3 } });
      await page.getByRole('menuitem', { name: 'Preview engine' }).hover();
      await page.getByRole('menuitemcheckbox', { name: 'Compatible' }).click();
      await expect(page.getByTestId('program-monitor')).toHaveAttribute(
        'data-engine',
        'compatible',
      );
    } finally {
      await app.close();
    }
  });
});
