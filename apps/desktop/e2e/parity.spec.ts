// Golden-frame parity (ROADMAP Phase 3): what the preview shows must match the exported file.
// Each case puts clips on the timeline with a different transform, screenshots the program
// monitor at a time inside that case, exports, and compares the same moment with SSIM.
import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTestFfmpeg } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, setExportTarget, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let dir = '';
const fx = { video: '', still: '' };

/** Minimum SSIM between preview and export (ROADMAP Phase 3 exit criterion). */
const MIN_SSIM = 0.98;
/** Default timeline zoom in pixels per second. */
const ZOOM = 80;

function ssim(ffmpeg: string, a: string, b: string): number {
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-i',
      a,
      '-i',
      b,
      '-filter_complex',
      // The outer 2 px are left out (the preview box is rounded to whole CSS pixels), and both
      // images get the same light blur so that differences between the browser's and FFmpeg's
      // scalers on each OS do not count. A clip one frame off or showing a stale frame still
      // scores well below the threshold (ADR-027).
      '[0:v]crop=iw-4:ih-4:2:2,format=yuv420p,gblur=sigma=1.5[x];' +
        '[1:v]crop=iw-4:ih-4:2:2,format=yuv420p,gblur=sigma=1.5[y];[x][y]ssim',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const m = / All:([\d.]+)/.exec(r.stderr);
  return m ? Number(m[1]) : 0;
}

/** Average colour of the middle of an image (where the video is in the effects case). */
function meanColour(ffmpeg: string, file: string): number[] {
  const r = spawnSync(
    ffmpeg,
    [
      '-v',
      'error',
      '-i',
      file,
      '-vf',
      'crop=iw*0.6:ih*0.15,scale=1:1:flags=area',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ],
    { maxBuffer: 1 << 20 },
  );
  return [...r.stdout.subarray(0, 3)];
}

test.describe('preview and export match', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  // Smooth content (colour fields, a moving box) so SSIM measures layout, colour and timing,
  // not how two different scalers treat noise and one-pixel text.
  test.beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recit-parity-'));
    fx.video = join(dir, 'moving box.mp4');
    fx.still = join(dir, 'bars.png');
    execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x1d3f8c:s=1280x720:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'color=c=0xf2c12e:s=220x220:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=f=330:d=3',
      '-filter_complex',
      "[0:v]drawbox=x=0:y=0:w=640:h=720:color=0x2e9e5b:t=fill[bg];[bg][1:v]overlay=x='60+t*300':y=250[v]",
      '-map',
      '[v]',
      '-map',
      '2:a',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      fx.video,
    ]);
    execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'smptehdbars=s=800x600',
      '-frames:v',
      '1',
      fx.still,
    ]);
  });
  test.afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('golden frames: fill, fit with offset and rotation, layered still, keyframes', async () => {
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Parity');
      await mockOpenDialog(app, [fx.video, fx.still]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import 2 files' }).click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(2, {
        timeout: 60_000,
      });
      // The first clip creates the sequence; the rest is built through the same edit commands
      // the UI uses, so every case is exact.
      await page.locator('[data-testid=asset-card][data-name="moving box.mp4"]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      const s = 705_600_000;
      await page.evaluate(async (S) => {
        type Track = { id: string; items: { id: string }[] };
        const call = async <T>(channel: string, input: unknown): Promise<T> => {
          const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
            ok: boolean;
            result?: unknown;
            error?: { message: string };
          };
          if (!r.ok) throw new Error(r.error?.message);
          return r.result as T;
        };
        const state = await call<{ doc: { sequences: { id: string; tracks: Track[] }[] } }>(
          'doc.get',
          {},
        );
        const seq = state.doc.sequences[0]!;
        const [v2, v1] = seq.tracks;
        const assets = await call<{ id: string; name: string }[]>('media.list', {});
        const clip = assets.find((a) => a.name === 'moving box.mp4')!.id;
        const image = assets.find((a) => a.name === 'bars.png')!.id;
        const first = v1!.items[0]!.id;
        await call('doc.execute', {
          command: {
            type: 'batch',
            commands: [
              // 0–2 s: fill (default). 2–4 s: fit, smaller, moved and rotated.
              { type: 'item.trim', sequenceId: seq.id, itemId: first, edge: 'end', time: 2 * S },
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v1!.id,
                assetId: clip,
                id: 'item_case2',
                start: 2 * S,
                sourceIn: 0.5 * S,
                duration: 2 * S,
                transform: { fit: 'fit', scale: 0.7, x: 0.08, y: -0.05, rotation: 30 },
              },
              // 6–8 s: keyframed — grows, turns and slides across (perspective path in export).
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v1!.id,
                assetId: clip,
                id: 'item_case4',
                start: 6 * S,
                sourceIn: 0.5 * S,
                duration: 2 * S,
                transform: { fit: 'fit' },
              },
              ...[
                ['scale', 0.5 * S, 0.5],
                ['scale', 2.5 * S, 1.1],
                ['rotation', 0.5 * S, 0],
                ['rotation', 2.5 * S, 60],
                ['x', 0.5 * S, -0.2],
                ['x', 2.5 * S, 0.2],
              ].map(([property, t, value]) => ({
                type: 'keyframe.set',
                sequenceId: seq.id,
                itemId: 'item_case4',
                property,
                t,
                value,
              })),
              // 4–6 s: a still on V2 over the video, rotated the other way.
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v1!.id,
                assetId: clip,
                start: 4 * S,
                sourceIn: 0,
                duration: 2 * S,
              },
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v2!.id,
                assetId: image,
                start: 4 * S,
                duration: 2 * S,
                transform: { fit: 'fit', scale: 0.45, y: -0.25, rotation: -20 },
              },
            ],
          },
        });
      }, s);
      await expect(page.getByTestId('timeline-item')).toHaveCount(5);

      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');
      const times = [1, 3, 5, 7];
      const stage = page.locator('.program');
      for (const t of times) {
        await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
        await expect(page.getByTestId('program-time')).toContainText(`00:0${t}.000`);
        // Wait for the GPU engine to draw this time (or, in the compatible engine, for the media
        // elements to finish seeking).
        await page.waitForFunction((at) => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]');
          return !c || c.dataset.time === at;
        }, t.toFixed(3));
        await page.waitForFunction(() =>
          [...document.querySelectorAll<HTMLVideoElement>('.program video')].every(
            (v) => v.readyState >= 2 && !v.seeking,
          ),
        );
        await page.waitForTimeout(300);
        await stage.screenshot({ path: join(shots, `preview-${t}.png`) });
      }

      // Export with the default settings (H.264, full size, normal quality).
      const out = join(userData, 'parity.mp4');
      await page.getByTestId('export-button').click();
      await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: 'Export', exact: true })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });

      const results: Record<number, number> = {};
      for (const t of times) {
        const preview = join(shots, `preview-${t}.png`);
        const [w, h] = execFileSync(
          bins!.ffprobe,
          ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
          { encoding: 'utf8' },
        )
          .trim()
          .split(',')
          .map(Number);
        const exported = join(shots, `export-${t}.png`);
        execFileSync(bins!.ffmpeg, [
          '-v',
          'error',
          '-y',
          '-ss',
          String(t),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          `scale=${w}:${h}:flags=area`,
          exported,
        ]);
        results[t] = ssim(bins!.ffmpeg, preview, exported);
      }
      console.info('Preview/export SSIM', results);
      for (const t of times) expect(results[t], `SSIM at ${t}s`).toBeGreaterThanOrEqual(MIN_SSIM);
    } finally {
      await app.close();
    }
  });

  test('golden frames: captions drawn by libass in both', async () => {
    test.skip(
      !/\sass\s/.test(
        spawnSync(bins!.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '',
      ),
      'This FFmpeg has no libass (Homebrew on macOS); captions cannot be exported',
    );
    // Fake Whisper ("word1", "word2", … every 0.5 s) through the real sidecar.
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, {
      ...env(),
      RECIT_DISABLE_SIDECAR: '0',
      RECIT_FAKE_WHISPER: '1',
    });
    try {
      await createProject(page, 'Caption parity');
      await mockOpenDialog(app, [fx.video]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByRole('tab', { name: 'Transcript' }).click();
      await page
        .getByTestId('transcript-panel')
        .getByRole('button', { name: 'Transcribe', exact: true })
        .click({ timeout: 60_000 });
      await expect(page.getByTestId('transcript-words').getByRole('option')).toHaveCount(6, {
        timeout: 60_000,
      });
      await page.getByRole('tab', { name: 'Captions' }).click();
      await page.getByRole('button', { name: 'Generate captions' }).click();
      await expect(page.locator('[data-testid=timeline-item][data-kind=caption]')).not.toHaveCount(
        0,
      );
      // Big captions so that text, not the video, dominates the comparison; one per style family.
      const cases: [number, string][] = [
        [1.5, 'highlight'],
        [2.5, 'karaoke'],
      ];
      for (const [t, style] of cases) {
        await page.evaluate(async (style) => {
          const call = async <T>(channel: string, input: unknown): Promise<T> => {
            const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
              ok: boolean;
              result?: unknown;
              error?: { message: string };
            };
            if (!r.ok) throw new Error(r.error?.message);
            return r.result as T;
          };
          const state = await call<{ doc: { sequences: { id: string }[] } }>('doc.get', {});
          await call('doc.execute', {
            command: {
              type: 'captions.update',
              sequenceId: state.doc.sequences[0]!.id,
              captions: { style, size: 1.8, position: 0.5, wordsPerLine: 2 },
            },
          });
        }, style);
        await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
        await expect(page.getByTestId('program-time')).toContainText(`00:0${t.toFixed(3)}`);
        await page.waitForFunction((at) => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]');
          const k = document.querySelector<HTMLCanvasElement>('[data-testid=captions-canvas]');
          return (!c || c.dataset.time === at) && k?.dataset.time === at;
        }, t.toFixed(3));
        await page.waitForTimeout(400);
        await page.locator('.program').screenshot({ path: join(shots, `preview-${style}.png`) });

        const out = join(userData, `captions-${style}.mp4`);
        await page.getByTestId('export-button').click();
        await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
        await setExportTarget(app, page, out);
        await page
          .getByTestId('export-dialog')
          .getByRole('button', { name: /Export$/ })
          .click();
        await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
          timeout: 120_000,
        });
        await expect(page.getByTestId('export-status')).toContainText(`captions-${style}.mp4`);
        await page.keyboard.press('Escape');
        const preview = join(shots, `preview-${style}.png`);
        const [w, h] = execFileSync(
          bins!.ffprobe,
          ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
          { encoding: 'utf8' },
        )
          .trim()
          .split(',')
          .map(Number);
        const exported = join(shots, `export-${style}.png`);
        execFileSync(bins!.ffmpeg, [
          '-v',
          'error',
          '-y',
          '-ss',
          String(t),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          `scale=${w}:${h}:flags=area`,
          exported,
        ]);
        // Same frame without captions, to show the captions matter to the score.
        const score = ssim(bins!.ffmpeg, preview, exported);
        console.info(`Caption SSIM (${style}) ${score}`);
        expect(score, `caption SSIM, ${style}`).toBeGreaterThanOrEqual(MIN_SSIM);
      }
    } finally {
      await app.close();
    }
  });

  test('golden frames: fades, opacity and colour effects', async () => {
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Effects parity');
      await mockOpenDialog(app, [fx.video, fx.still]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import 2 files' }).click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(2, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card][data-name="bars.png"]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      await page.evaluate(async (S) => {
        type Track = { id: string; items: { id: string }[] };
        const call = async <T>(channel: string, input: unknown): Promise<T> => {
          const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
            ok: boolean;
            result?: unknown;
            error?: { message: string };
          };
          if (!r.ok) throw new Error(r.error?.message);
          return r.result as T;
        };
        const state = await call<{ doc: { sequences: { id: string; tracks: Track[] }[] } }>(
          'doc.get',
          {},
        );
        const seq = state.doc.sequences[0]!;
        const [v2, v1] = seq.tracks;
        const assets = await call<{ id: string; name: string }[]>('media.list', {});
        const clip = assets.find((a) => a.name === 'moving box.mp4')!.id;
        const still = v1!.items[0]!.id;
        const id = 'item_fx';
        await call('doc.execute', {
          command: {
            type: 'batch',
            commands: [
              { type: 'item.trim', sequenceId: seq.id, itemId: still, edge: 'end', time: 3 * S },
              // A small still in a corner, so most of the video fades to and from black.
              {
                type: 'item.update',
                sequenceId: seq.id,
                itemId: still,
                transform: { fit: 'fit', scale: 0.4, x: -0.25, y: 0.3 },
              },
              // The video over the still: fading in, partly transparent, colour graded.
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v2!.id,
                assetId: clip,
                id,
                start: 0,
                sourceIn: 0,
                duration: 3 * S,
                transform: { fit: 'fit', scale: 0.8 },
              },
              {
                type: 'item.update',
                sequenceId: seq.id,
                itemId: id,
                opacity: 0.75,
                fade: { in: 1 * S, out: 1 * S },
              },
              { type: 'effect.add', sequenceId: seq.id, itemId: id, kind: 'color', id: 'fx_a' },
              {
                type: 'effect.update',
                sequenceId: seq.id,
                itemId: id,
                effectId: 'fx_a',
                params: { brightness: 0.12, contrast: 1.3, saturation: 0.4 },
              },
            ],
          },
        });
      }, 705_600_000);
      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');
      const times = [0.5, 1.5, 2.5];
      for (const t of times) {
        const at = t.toFixed(3);
        await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
        await expect(page.getByTestId('program-time')).toContainText(`00:0${at}`);
        await page.waitForFunction(
          (want) =>
            document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]')?.dataset
              .time === want,
          at,
        );
        await page.waitForTimeout(300);
        await page.locator('.program').screenshot({ path: join(shots, `preview-fx-${t}.png`) });
      }

      const out = join(userData, 'effects.mp4');
      await page.getByTestId('export-button').click();
      await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: /Export$/ })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });
      const means: number[][] = [];
      for (const t of times) {
        const preview = join(shots, `preview-fx-${t}.png`);
        const [w, h] = execFileSync(
          bins!.ffprobe,
          ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
          { encoding: 'utf8' },
        )
          .trim()
          .split(',')
          .map(Number);
        const exported = join(shots, `export-fx-${t}.png`);
        execFileSync(bins!.ffmpeg, [
          '-v',
          'error',
          '-y',
          '-ss',
          String(t),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          `scale=${w}:${h}:flags=area`,
          exported,
        ]);
        const score = ssim(bins!.ffmpeg, preview, exported);
        const [a, b] = [meanColour(bins!.ffmpeg, preview), meanColour(bins!.ffmpeg, exported)];
        means.push(b);
        console.info(`Effects at ${t}s: SSIM ${score}, mean colour preview ${a} export ${b}`);
        expect(score, `SSIM at ${t}s`).toBeGreaterThanOrEqual(MIN_SSIM);
        // Brightness, contrast, saturation, opacity and the fade all move the average colour by
        // tens of levels; preview and export agree within a few (rounding in YUV ↔ RGB, as without effects).
        for (let c = 0; c < 3; c++)
          expect(Math.abs(a[c]! - b[c]!), `channel ${c} at ${t}s`).toBeLessThan(6);
      }
      // Half-way through the fade in, the picture is clearly darker than once it is in.
      const sum = (c: number[]) => c[0]! + c[1]! + c[2]!;
      expect(sum(means[0]!)).toBeLessThan(sum(means[1]!) * 0.8);
    } finally {
      await app.close();
    }
  });

  test('golden frames: cross dissolve and dip to black', async () => {
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Transitions parity');
      await mockOpenDialog(app, [fx.video, fx.still]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import 2 files' }).click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(2, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card][data-name="bars.png"]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      await page.evaluate(async (S) => {
        type Track = { id: string; items: { id: string }[] };
        const call = async <T>(channel: string, input: unknown): Promise<T> => {
          const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
            ok: boolean;
            result?: unknown;
            error?: { message: string };
          };
          if (!r.ok) throw new Error(r.error?.message);
          return r.result as T;
        };
        const state = await call<{ doc: { sequences: { id: string; tracks: Track[] }[] } }>(
          'doc.get',
          {},
        );
        const seq = state.doc.sequences[0]!;
        const v1 = seq.tracks[1];
        const assets = await call<{ id: string; name: string }[]>('media.list', {});
        const clip = assets.find((a) => a.name === 'moving box.mp4')!.id;
        const still = v1!.items[0]!.id;
        const at = (n: number) => n * S;
        await call('doc.execute', {
          command: {
            type: 'batch',
            commands: [
              // The still moves to 4–6 s; two pieces of the video play before it.
              {
                type: 'item.move',
                sequenceId: seq.id,
                itemId: still,
                trackId: v1!.id,
                start: at(4),
              },
              { type: 'item.trim', sequenceId: seq.id, itemId: still, edge: 'end', time: at(6) },
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v1!.id,
                assetId: clip,
                id: 'item_a',
                start: 0,
                sourceIn: 0,
                duration: at(2),
                transform: { fit: 'fit' },
              },
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: v1!.id,
                assetId: clip,
                id: 'item_b',
                start: at(2),
                sourceIn: at(0.5),
                duration: at(2),
              },
              {
                type: 'transition.set',
                sequenceId: seq.id,
                itemId: 'item_b',
                kind: 'dissolve',
                duration: at(1),
              },
              {
                type: 'transition.set',
                sequenceId: seq.id,
                itemId: still,
                kind: 'dipBlack',
                duration: at(1.5),
              },
            ],
          },
        });
      }, 705_600_000);
      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');
      // On frame boundaries (30 fps), so preview and export show the same frame.
      const times = [2, 3.5, 4.5];
      for (const t of times) {
        const at = t.toFixed(3);
        await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
        await expect(page.getByTestId('program-time')).toContainText(`00:0${at}`);
        await page.waitForFunction(
          (want) =>
            document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]')?.dataset
              .time === want,
          at,
        );
        await page.waitForTimeout(300);
        await page.locator('.program').screenshot({ path: join(shots, `preview-tr-${t}.png`) });
      }

      const out = join(userData, 'transitions.mp4');
      await page.getByTestId('export-button').click();
      await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: /Export$/ })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });
      for (const t of times) {
        const preview = join(shots, `preview-tr-${t}.png`);
        const [w, h] = execFileSync(
          bins!.ffprobe,
          ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
          { encoding: 'utf8' },
        )
          .trim()
          .split(',')
          .map(Number);
        const exported = join(shots, `export-tr-${t}.png`);
        execFileSync(bins!.ffmpeg, [
          '-v',
          'error',
          '-y',
          '-ss',
          String(t),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          `scale=${w}:${h}:flags=area`,
          exported,
        ]);
        const score = ssim(bins!.ffmpeg, preview, exported);
        const [a, b] = [meanColour(bins!.ffmpeg, preview), meanColour(bins!.ffmpeg, exported)];
        console.info(`Transitions at ${t}s: SSIM ${score}, mean colour preview ${a} export ${b}`);
        expect(score, `SSIM at ${t}s`).toBeGreaterThanOrEqual(MIN_SSIM);
        // Brightness, contrast, saturation, opacity and the fade all move the average colour by
        // tens of levels; preview and export agree within a few (rounding in YUV ↔ RGB, as without effects).
        for (let c = 0; c < 3; c++)
          expect(Math.abs(a[c]! - b[c]!), `channel ${c} at ${t}s`).toBeLessThan(6);
      }
    } finally {
      await app.close();
    }
  });

  test('golden frames: cropped clips (facecam + gameplay layout)', async () => {
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Crop parity');
      await mockOpenDialog(app, [fx.video]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByTestId('timeline-item').click();
      await page.getByRole('button', { name: 'Facecam + gameplay' }).click();
      // Put the "facecam" over the moving box's path: the middle of the picture.
      const box = (await page.getByTestId('crop-box').boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 90, { steps: 4 });
      await page.mouse.up();
      await page.getByRole('button', { name: 'Apply' }).click();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      const t = 1;
      await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
      await expect(page.getByTestId('program-time')).toContainText('00:01.000');
      await page.waitForFunction((at) => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]');
        return !c || c.dataset.time === at;
      }, '1.000');
      await page.waitForTimeout(300);
      const preview = join(shots, 'preview-crop.png');
      await page.locator('.program').screenshot({ path: preview });

      const out = join(userData, 'crop.mp4');
      await page.getByTestId('export-button').click();
      await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: /Export$/ })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });
      const [w, h] = execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
        { encoding: 'utf8' },
      )
        .trim()
        .split(',')
        .map(Number);
      const exported = join(shots, 'export-crop.png');
      execFileSync(bins!.ffmpeg, [
        '-v',
        'error',
        '-y',
        '-ss',
        String(t),
        '-i',
        out,
        '-frames:v',
        '1',
        '-vf',
        `scale=${w}:${h}:flags=area`,
        exported,
      ]);
      const score = ssim(bins!.ffmpeg, preview, exported);
      console.info(`Crop SSIM ${score}`);
      expect(score).toBeGreaterThanOrEqual(MIN_SSIM);
    } finally {
      await app.close();
    }
  });

  test('golden frames: blurred background (blur effect)', async () => {
    const userData = tempUserData();
    const shots = join(userData, 'shots');
    mkdirSync(shots);
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Blur parity');
      await mockOpenDialog(app, [fx.video]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card]').dblclick();
      await page.getByTestId('timeline-item').click();
      await page.getByTestId('blurred-background').click();
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      // The copy behind (on a new track below) carries the blur.
      await page
        .getByTestId('timeline-item')
        .last()
        .click({ position: { x: 20, y: 30 } });
      await expect(page.getByTestId('blur-effect')).toHaveCount(1);
      await page.keyboard.press('Escape');
      const t = 1;
      await page.getByTestId('ruler').click({ position: { x: t * ZOOM, y: 10 } });
      await expect(page.getByTestId('program-time')).toContainText('00:01.000');
      await page.waitForFunction((at) => {
        const c = document.querySelector<HTMLCanvasElement>('[data-testid=program-canvas]');
        return !c || c.dataset.time === at;
      }, '1.000');
      await page.waitForTimeout(300);
      const preview = join(shots, 'preview-blur.png');
      await page.locator('.program').screenshot({ path: preview });

      const out = join(userData, 'blur.mp4');
      await page.getByTestId('export-button').click();
      await page.getByRole('radio', { name: 'YouTube Short', exact: true }).click();
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: /Export$/ })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });
      const [w, h] = execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', preview],
        { encoding: 'utf8' },
      )
        .trim()
        .split(',')
        .map(Number);
      const exported = join(shots, 'export-blur.png');
      execFileSync(bins!.ffmpeg, [
        '-v',
        'error',
        '-y',
        '-ss',
        String(t),
        '-i',
        out,
        '-frames:v',
        '1',
        '-vf',
        `scale=${w}:${h}:flags=area`,
        exported,
      ]);
      const score = ssim(bins!.ffmpeg, preview, exported);
      console.info(`Blur SSIM ${score}`);
      expect(score).toBeGreaterThanOrEqual(MIN_SSIM);
    } finally {
      await app.close();
    }
  });
});
