import { describe, expect, it } from 'vitest';
import { secondsToFlicks as S } from '../time';
import { DEFAULT_TRANSFORM, valueAt } from './model';
import { autoReframe, type FaceTrack } from './reframe';

const SRC = { width: 1920, height: 1080 };
const FRAME = { width: 1080, height: 1920 };
const clip = (seconds: number) => ({
  sourceIn: 0,
  duration: S(seconds),
  transform: DEFAULT_TRANSFORM,
});
/** One face per sample at centre `x(t)` (fraction of the picture), 5 samples a second. */
const track = (seconds: number, x: (t: number) => number | null): FaceTrack => ({
  fps: 5,
  frames: Array.from({ length: seconds * 5 + 1 }, (_, i) => {
    const cx = x(i / 5);
    return cx === null ? [] : [[cx - 0.05, 0.3, 0.1, 0.2, 0.9]];
  }),
});
// A 16:9 picture filling a 9:16 frame is 3413 px wide; 1080 px of it shows.
const LIMIT = (3413 - 1080) / 2 / 1080;
const xFor = (u: number) => Math.max(-LIMIT, Math.min(LIMIT, (3413 * (0.5 - u)) / 1080));

describe('automatic reframing', () => {
  it('follows a face walking across the picture with a few keyframes', () => {
    const r = autoReframe(
      clip(10),
      SRC,
      FRAME,
      track(10, (t) => 0.2 + 0.06 * t),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keyframes.length).toBeGreaterThan(2);
    expect(r.keyframes.length).toBeLessThan(20);
    const at = (t: number) => valueAt(r.keyframes, S(t));
    // Starts on the face, ends near it (the camera trails inside its dead zone).
    expect(Math.abs(at(0) - xFor(0.2))).toBeLessThan(0.06);
    expect(Math.abs(at(10) - xFor(0.8))).toBeLessThan(0.12);
    // Always moving the same way.
    const xs = r.keyframes.map((k) => k.v);
    expect(xs).toEqual([...xs].sort((a, b) => b - a));
  });

  it('holds still for small movements and single-frame mistakes', () => {
    const r = autoReframe(
      clip(6),
      SRC,
      FRAME,
      track(6, (t) => (Math.abs(t - 3) < 0.01 ? 0.9 : 0.5 + 0.01 * Math.sin(t * 5))),
    );
    expect(r.ok && r.keyframes.every((k) => Math.abs(k.v - r.keyframes[0]!.v) < 0.005)).toBe(true);
  });

  it('cuts instead of panning when the face jumps across and stays', () => {
    const r = autoReframe(
      clip(6),
      SRC,
      FRAME,
      track(6, (t) => (t < 3 ? 0.25 : 0.75)),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hold = r.keyframes.findIndex((k) => k.e === 'hold');
    expect(hold).toBeGreaterThanOrEqual(0);
    const before = valueAt(r.keyframes, S(2.9));
    const after = valueAt(r.keyframes, S(4));
    expect(before).toBeCloseTo(xFor(0.25), 2);
    expect(after).toBeCloseTo(xFor(0.75), 2);
  });

  it('keeps the last position through gaps, and reports clips it cannot reframe', () => {
    const gap = autoReframe(
      clip(4),
      SRC,
      FRAME,
      track(4, (t) => (t > 1 && t < 3 ? null : 0.3)),
    );
    expect(gap.ok && gap.facesSeen).toBeGreaterThan(5);
    expect(
      autoReframe(
        clip(4),
        SRC,
        FRAME,
        track(4, () => null),
      ),
    ).toEqual({
      ok: false,
      reason: 'no-faces',
    });
    // Fitted to the frame there is nothing to slide.
    expect(
      autoReframe(
        { ...clip(4), transform: { ...DEFAULT_TRANSFORM, fit: 'fit' } },
        SRC,
        FRAME,
        track(4, () => 0.3),
      ),
    ).toEqual({ ok: false, reason: 'no-room' });
  });

  it('works in the cropped picture and only inside the clip', () => {
    // Keep the right half; a face at 0.75 of the full picture is the middle of the crop.
    const item = {
      sourceIn: S(2),
      duration: S(2),
      transform: { ...DEFAULT_TRANSFORM, crop: { left: 0.5, top: 0, right: 0, bottom: 0 } },
    };
    const r = autoReframe(
      item,
      SRC,
      FRAME,
      track(6, () => 0.75),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.keyframes[0]!.t).toBe(S(2));
    expect(r.keyframes.at(-1)!.t).toBe(S(4));
    expect(Math.abs(r.keyframes[0]!.v)).toBeLessThan(0.01);
  });
});
