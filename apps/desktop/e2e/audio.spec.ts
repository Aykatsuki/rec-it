// Audio parity (ADR-030): the preview's Web Audio mix, rendered offline, must match the
// exported file's sound in timing (within 20 ms) and level (within 1 dB), including volume
// keyframes, a clip's own sound and a separate audio clip.
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, setExportTarget, tempUserData } from './helpers';

const bins = findTestFfmpeg();
let fx: Fixtures;
const S = 705_600_000;

/** RMS per 10 ms of a mono float32 signal at 48 kHz. */
function envelope(samples: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 480 <= samples.length; i += 480) {
    let sum = 0;
    for (let j = i; j < i + 480; j++) sum += samples[j]! ** 2;
    out.push(Math.sqrt(sum / 480));
  }
  return out;
}

function correlation(a: number[], b: number[], lag: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const j = i + lag;
    if (j >= 0 && j < b.length) {
      xs.push(a[i]!);
      ys.push(b[j]!);
    }
  }
  const mean = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

test.describe('preview audio', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
  const env = (): Record<string, string> =>
    bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg };

  test('Web Audio mix matches the exported sound, and playback runs on its clock', async () => {
    const userData = tempUserData();
    const { app, page } = await launch(userData, env());
    try {
      await createProject(page, 'Audio');
      await mockOpenDialog(app, [fx.h264, fx.audio]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import 2 files' }).click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(2, {
        timeout: 60_000,
      });
      await page.locator('[data-testid=asset-card][data-name="clip h264.mp4"]').dblclick();
      await expect(page.getByTestId('timeline-item')).toHaveCount(1);
      await expect(page.getByTestId('program-monitor')).toHaveAttribute('data-engine', 'gpu');

      // The video's own 440 Hz tone at half volume, plus a 220 Hz clip from 0.5 s that fades in
      // over its first second (volume keyframes).
      await page.evaluate(async (S) => {
        const call = async <T>(channel: string, input: unknown): Promise<T> => {
          const r = (await window.recit.backend.invoke(channel as never, input as never)) as {
            ok: boolean;
            result?: unknown;
            error?: { message: string };
          };
          if (!r.ok) throw new Error(r.error?.message);
          return r.result as T;
        };
        type Track = { id: string; kind: string; items: { id: string }[] };
        const state = await call<{ doc: { sequences: { id: string; tracks: Track[] }[] } }>(
          'doc.get',
          {},
        );
        const seq = state.doc.sequences[0]!;
        const video = seq.tracks.find((t) => t.kind === 'video' && t.items.length)!.items[0]!.id;
        const a1 = seq.tracks.find((t) => t.kind === 'audio')!.id;
        const assets = await call<{ id: string; name: string }[]>('media.list', {});
        const tone = assets.find((a) => a.name === 'audio.wav')!.id;
        await call('doc.execute', {
          command: {
            type: 'batch',
            commands: [
              { type: 'item.update', sequenceId: seq.id, itemId: video, volume: 0.5 },
              {
                type: 'item.add',
                sequenceId: seq.id,
                trackId: a1,
                assetId: tone,
                id: 'item_tone',
                start: 0.5 * S,
              },
              {
                type: 'keyframe.set',
                sequenceId: seq.id,
                itemId: 'item_tone',
                property: 'volume',
                t: 0,
                value: 0,
              },
              {
                type: 'keyframe.set',
                sequenceId: seq.id,
                itemId: 'item_tone',
                property: 'volume',
                t: S,
                value: 1,
              },
            ],
          },
        });
      }, S);
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      const preview = await page.evaluate(() =>
        (
          window as unknown as {
            recitDebug: { renderAudio(from: number, duration: number): Promise<number[]> };
          }
        ).recitDebug.renderAudio(0, 3),
      );

      // Export without loudness normalisation so levels are comparable.
      const out = join(userData, 'audio.mp4');
      await page.getByTestId('export-button').click();
      await page.getByLabel('Loudness').selectOption('off');
      await setExportTarget(app, page, out);
      await page
        .getByTestId('export-dialog')
        .getByRole('button', { name: 'Export', exact: true })
        .click();
      await expect(page.getByTestId('export-status')).toHaveAttribute('data-state', 'done', {
        timeout: 120_000,
      });
      await page.keyboard.press('Escape');
      // Stereo PCM, averaged to mono exactly like the preview side ((L + R) / 2).
      const pcm = execFileSync(
        bins!.ffmpeg,
        ['-v', 'error', '-i', out, '-t', '3', '-ar', '48000', '-ac', '2', '-f', 'f32le', '-'],
        { maxBuffer: 64 * 1024 * 1024 },
      );
      const stereo = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
      const mono = new Float32Array(stereo.length / 2);
      for (let i = 0; i < mono.length; i++) mono[i] = (stereo[2 * i]! + stereo[2 * i + 1]!) / 2;
      const exported = envelope(mono);

      const n = Math.min(preview.length, exported.length);
      const a = preview.slice(0, n);
      const b = exported.slice(0, n);
      let best = { lag: 0, r: -1 };
      for (let lag = -10; lag <= 10; lag++) {
        const r = correlation(a, b, lag);
        if (r > best.r) best = { lag, r };
      }
      const level = 20 * Math.log10(a.reduce((s, x) => s + x, 0) / b.reduce((s, x) => s + x, 0));
      console.info(
        `Audio parity: r=${best.r.toFixed(4)} lag=${best.lag * 10} ms level=${level.toFixed(2)} dB`,
      );
      expect(best.r).toBeGreaterThan(0.98);
      expect(Math.abs(best.lag)).toBeLessThanOrEqual(2);
      expect(Math.abs(level)).toBeLessThan(1);

      // Playback advances on the audio clock (or the wall clock when there is no audio device).
      await page.getByTestId('ruler').click({ position: { x: 1, y: 10 } });
      await page.getByTestId('program-play').click();
      await page.waitForTimeout(1500);
      await page.getByTestId('program-play').click();
      const shown = await page.getByTestId('program-time').innerText();
      const seconds = Number(/00:0(\d\.\d+)/.exec(shown)?.[1] ?? 0);
      expect(seconds).toBeGreaterThan(1);
      expect(seconds).toBeLessThan(2.2);
    } finally {
      await app.close();
    }
  });
});
