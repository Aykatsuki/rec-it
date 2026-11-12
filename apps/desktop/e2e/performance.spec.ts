// Timeline performance (ROADMAP Phase 2 exit criterion: 1,000 items scroll and zoom at 60 fps
// on the reference PC). CI machines are slower and use software rendering, so this records the
// numbers and fails only on a gross regression; the 60 fps target is checked on the reference PC.
import { expect, test } from '@playwright/test';
import { rmSync } from 'node:fs';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;

test.describe('timeline performance', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('1,000 clips scroll and zoom smoothly', async () => {
    const { app, page } = await launch(tempUserData(), env());
    try {
      await createProject(page, 'Performance');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);

      // 1,000 clips of 0.2 s across two tracks (one undo step).
      await page.evaluate(async () => {
        const call = async <T>(channel: string, input: unknown): Promise<T> => {
          const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
            ok: boolean;
            result?: unknown;
            error?: { message: string };
          };
          if (!r.ok) throw new Error(r.error?.message);
          return r.result as T;
        };
        const S = 705_600_000;
        type Track = { id: string; kind: string };
        const state = await call<{ doc: { sequences: { id: string; tracks: Track[] }[] } }>(
          'doc.get',
          {},
        );
        const seq = state.doc.sequences[0]!;
        const [v2, v1] = seq.tracks.filter((t) => t.kind === 'video');
        const assets = await call<{ id: string }[]>('media.list', {});
        const commands = Array.from({ length: 1000 }, (_, i) => ({
          type: 'item.add',
          sequenceId: seq.id,
          trackId: (i % 2 ? v2 : v1)!.id,
          assetId: assets[0]!.id,
          start: Math.round(Math.floor(i / 2) * 0.2 * S),
          sourceIn: Math.round((i % 10) * 0.2 * S),
          duration: Math.round(0.2 * S),
        }));
        await call('doc.execute', { command: { type: 'batch', commands } });
      });
      await expect(page.getByTestId('program-time')).toContainText('/01:40.000');

      // Frame times while scrolling the timeline and while zooming it.
      const measure = (mode: 'scroll' | 'zoom') =>
        page.evaluate(
          (m) =>
            new Promise<{ p50: number; p95: number }>((resolve) => {
              const el = document.querySelector<HTMLElement>('.tl')!;
              const times: number[] = [];
              let last = performance.now();
              let n = 0;
              const step = () => {
                const now = performance.now();
                times.push(now - last);
                last = now;
                if (m === 'scroll') el.scrollLeft += 60;
                else
                  el.dispatchEvent(
                    new WheelEvent('wheel', {
                      ctrlKey: true,
                      deltaY: n < 60 ? 100 : -100,
                      clientX: el.getBoundingClientRect().left + 400,
                      bubbles: true,
                      cancelable: true,
                    }),
                  );
                if (++n < 120) requestAnimationFrame(step);
                else {
                  const sorted = times.slice(5).sort((a, b) => a - b);
                  resolve({
                    p50: sorted[Math.floor(sorted.length * 0.5)]!,
                    p95: sorted[Math.floor(sorted.length * 0.95)]!,
                  });
                }
              };
              requestAnimationFrame(step);
            }),
          mode,
        );
      const scroll = await measure('scroll');
      const zoom = await measure('zoom');
      console.info(
        `1,000 clips — scroll: p50 ${scroll.p50.toFixed(1)} ms, p95 ${scroll.p95.toFixed(1)} ms; ` +
          `zoom: p50 ${zoom.p50.toFixed(1)} ms, p95 ${zoom.p95.toFixed(1)} ms`,
      );
      // Rendered clips stay bounded however long the timeline is.
      expect(await page.getByTestId('timeline-item').count()).toBeLessThan(200);
      expect(scroll.p95).toBeLessThan(50);
      expect(zoom.p95).toBeLessThan(100);
    } finally {
      await app.close();
    }
  });
});
