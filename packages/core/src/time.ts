/**
 * Timeline time is stored as integer *flicks*: 1/705,600,000 of a second (ADR-005).
 * A flick divides exactly into every common frame rate (including 29.97 and 59.94)
 * and every common audio sample rate, so edits never accumulate rounding drift.
 */

declare const flicksBrand: unique symbol;
export type Flicks = number & { readonly [flicksBrand]: true };

export const FLICKS_PER_SECOND = 705_600_000;

/** A frame rate or other ratio, e.g. { num: 30000, den: 1001 } for 29.97 fps. */
export interface Rational {
  readonly num: number;
  readonly den: number;
}

export const FRAME_RATES = {
  fps23_976: { num: 24000, den: 1001 },
  fps24: { num: 24, den: 1 },
  fps25: { num: 25, den: 1 },
  fps29_97: { num: 30000, den: 1001 },
  fps30: { num: 30, den: 1 },
  fps50: { num: 50, den: 1 },
  fps59_94: { num: 60000, den: 1001 },
  fps60: { num: 60, den: 1 },
  fps120: { num: 120, den: 1 },
} as const satisfies Record<string, Rational>;

export function isFlicks(value: number): value is Flicks {
  return Number.isSafeInteger(value);
}

/** Asserts that a number is a safe integer and brands it as flicks. */
export function flicks(value: number): Flicks {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Flicks must be a safe integer, got ${value}`);
  }
  return value as Flicks;
}

/** Converts seconds to flicks, rounding to the nearest flick. */
export function secondsToFlicks(seconds: number): Flicks {
  if (!Number.isFinite(seconds)) throw new RangeError(`Invalid seconds: ${seconds}`);
  return flicks(Math.round(seconds * FLICKS_PER_SECOND));
}

export function flicksToSeconds(value: Flicks): number {
  return value / FLICKS_PER_SECOND;
}

/** Duration of one frame. Exact (an integer) for every rate in FRAME_RATES. */
export function frameDuration(rate: Rational): Flicks {
  assertValidRate(rate);
  const exact = (FLICKS_PER_SECOND * rate.den) / rate.num;
  if (!Number.isInteger(exact)) {
    throw new RangeError(
      `Frame rate ${rate.num}/${rate.den} is not exactly representable in flicks`,
    );
  }
  return exact as Flicks;
}

/** Index of the frame that contains `time` (floor). */
export function flicksToFrame(time: Flicks, rate: Rational): number {
  return Math.floor(time / frameDuration(rate));
}

export function frameToFlicks(frame: number, rate: Rational): Flicks {
  if (!Number.isInteger(frame))
    throw new RangeError(`Frame index must be an integer, got ${frame}`);
  return flicks(frame * frameDuration(rate));
}

/** Snaps a time to the nearest frame boundary. */
export function snapToFrame(time: Flicks, rate: Rational): Flicks {
  const d = frameDuration(rate);
  return flicks(Math.round(time / d) * d);
}

/** Number of audio samples in `time` at `sampleRate` (exact for 44.1 kHz and 48 kHz). */
export function flicksToSamples(time: Flicks, sampleRate: number): number {
  return (time * sampleRate) / FLICKS_PER_SECOND;
}

export function rationalToNumber(rate: Rational): number {
  assertValidRate(rate);
  return rate.num / rate.den;
}

/** Formats flicks as H:MM:SS.mmm (hours omitted when zero). */
export function formatTimecode(time: Flicks): string {
  const sign = time < 0 ? '-' : '';
  const totalMs = Math.round(Math.abs(time) / (FLICKS_PER_SECOND / 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  return `${sign}${h > 0 ? `${h}:` : ''}${mmss}`;
}

function assertValidRate(rate: Rational): void {
  if (
    !Number.isInteger(rate.num) ||
    !Number.isInteger(rate.den) ||
    rate.num <= 0 ||
    rate.den <= 0
  ) {
    throw new RangeError(`Invalid rational ${rate.num}/${rate.den}`);
  }
}
