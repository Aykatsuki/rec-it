// The preview's compressor (renderer engine/compressor.ts) must match FFmpeg's acompressor
// sample for sample (ADR-042). Lives here because renderer code has no Node types for tests.
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { findTestFfmpeg } from '../../../../packages/ffmpeg/src/testing';
import { Compressor } from '../renderer/src/engine/compressor';

const bins = findTestFfmpeg();

describe('compressor port', () => {
  it.skipIf(!bins)('matches FFmpeg acompressor', () => {
    const rate = 48000;
    const n = rate; // 1 s, stereo: quiet, then loud, then quiet (attack and release)
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const amp = i > 0.25 * n && i < 0.6 * n ? 0.9 : 0.05;
      left[i] = amp * Math.sin((2 * Math.PI * 220 * i) / rate);
      right[i] = 0.5 * amp * Math.sin((2 * Math.PI * 330 * i) / rate);
    }
    const settings = { threshold: -20, ratio: 4, attack: 10, release: 150, makeup: 6 };
    const interleaved = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      interleaved[2 * i] = left[i]!;
      interleaved[2 * i + 1] = right[i]!;
    }
    const lin = (db: number) => Math.pow(10, db / 20);
    const out = execFileSync(
      bins!.ffmpeg,
      [
        '-v',
        'error',
        '-f',
        'f32le',
        '-ar',
        String(rate),
        '-ac',
        '2',
        '-i',
        '-',
        '-af',
        `acompressor=threshold=${lin(settings.threshold)}:ratio=4:attack=10:release=150:makeup=${lin(settings.makeup)}:knee=2.82843:link=average:detection=rms`,
        '-f',
        'f32le',
        '-',
      ],
      { input: Buffer.from(interleaved.buffer), maxBuffer: 64 * 1024 * 1024 },
    );
    const ref = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
    const mine = [Float32Array.from(left), Float32Array.from(right)];
    new Compressor(settings, rate).process(mine, n);
    let worst = 0;
    for (let i = 0; i < n; i++) {
      worst = Math.max(
        worst,
        Math.abs(mine[0]![i]! - ref[2 * i]!),
        Math.abs(mine[1]![i]! - ref[2 * i + 1]!),
      );
    }
    // Loud part is compressed (gain well under make-up) and the port agrees to float precision.
    expect(Math.max(...ref.slice(0.4 * n * 2, 0.5 * n * 2))).toBeLessThan(0.9);
    expect(worst).toBeLessThan(1e-4);
  });
});
