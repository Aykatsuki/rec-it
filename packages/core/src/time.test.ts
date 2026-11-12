import { describe, expect, it } from 'vitest';
import {
  FLICKS_PER_SECOND,
  FRAME_RATES,
  flicks,
  flicksToFrame,
  flicksToSamples,
  formatTimecode,
  frameDuration,
  frameToFlicks,
  secondsToFlicks,
  snapToFrame,
} from './time';

describe('flicks', () => {
  it('represents every supported frame rate exactly', () => {
    for (const [name, rate] of Object.entries(FRAME_RATES)) {
      const d = frameDuration(rate);
      expect(Number.isInteger(d), name).toBe(true);
      // One second of frames adds up exactly (for integer rates) with no drift.
      expect(frameToFlicks(rate.num, rate) / rate.den).toBe(FLICKS_PER_SECOND);
    }
  });

  it('represents 44.1 kHz and 48 kHz sample counts exactly', () => {
    const oneSecond = secondsToFlicks(1);
    expect(flicksToSamples(oneSecond, 44_100)).toBe(44_100);
    expect(flicksToSamples(oneSecond, 48_000)).toBe(48_000);
    expect(Number.isInteger(FLICKS_PER_SECOND / 44_100)).toBe(true);
  });

  it('round-trips frames through flicks at 29.97 fps over an hour without drift', () => {
    const rate = FRAME_RATES.fps29_97;
    const frames = 107_892; // one hour of 29.97 fps
    expect(flicksToFrame(frameToFlicks(frames, rate), rate)).toBe(frames);
  });

  it('snaps to the nearest frame', () => {
    const rate = FRAME_RATES.fps30;
    const d = frameDuration(rate);
    expect(snapToFrame(flicks(d * 10 + d / 2 - 1), rate)).toBe(d * 10);
    expect(snapToFrame(flicks(d * 10 + d / 2 + 1), rate)).toBe(d * 11);
  });

  it('rejects non-integer flicks and invalid rates', () => {
    expect(() => flicks(1.5)).toThrow(RangeError);
    expect(() => frameDuration({ num: 0, den: 1 })).toThrow(RangeError);
    expect(() => frameDuration({ num: 13, den: 1 })).toThrow(RangeError);
  });

  it('formats timecodes', () => {
    expect(formatTimecode(secondsToFlicks(0))).toBe('00:00.000');
    expect(formatTimecode(secondsToFlicks(61.25))).toBe('01:01.250');
    expect(formatTimecode(secondsToFlicks(3723.5))).toBe('1:02:03.500');
    expect(formatTimecode(secondsToFlicks(-2))).toBe('-00:02.000');
  });
});
