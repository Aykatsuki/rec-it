// Ducking (ADR-042): music gets quieter while someone speaks, as ordinary volume keyframes, so
// the preview and the export play it identically and it stays editable.
import { secondsToFlicks } from '../time';
import { itemEnd, sourceTimeAt, type Keyframe, type TimelineItem } from './model';

export interface DuckOptions {
  /** Loudness (0–1 of full scale) above which the other clips count as speaking. */
  threshold?: number;
  /** Quiet gaps shorter than this (s) do not bring the music back up. */
  bridge?: number;
  /** Sounds shorter than this (s) are ignored. */
  minLength?: number;
  /** Volume while ducked, as a share of the clip's volume. */
  level?: number;
  /** Seconds to go down and come back up. */
  ramp?: number;
}

const DEFAULTS: Required<DuckOptions> = {
  threshold: 0.08,
  bridge: 0.6,
  minLength: 0.2,
  level: 0.25,
  ramp: 0.25,
};

/**
 * Timeline ranges (seconds) where `loudness` (one value per `step` seconds from 0, 0–1) is above
 * the threshold, with short gaps bridged and short blips ignored.
 */
export function loudRegions(
  loudness: ArrayLike<number>,
  step: number,
  options: DuckOptions = {},
): [number, number][] {
  const o = { ...DEFAULTS, ...options };
  const raw: [number, number][] = [];
  let open = -1;
  for (let i = 0; i <= loudness.length; i++) {
    const loud = i < loudness.length && loudness[i]! >= o.threshold;
    if (loud && open < 0) open = i;
    if (!loud && open >= 0) {
      raw.push([open * step, i * step]);
      open = -1;
    }
  }
  const merged: [number, number][] = [];
  for (const r of raw) {
    const last = merged.at(-1);
    if (last && r[0] - last[1] < o.bridge) last[1] = r[1];
    else merged.push([...r]);
  }
  return merged.filter(([a, b]) => b - a >= o.minLength);
}

/**
 * Volume keyframes (source time) that lower `item` to `level` × its volume during `regions`
 * (timeline seconds), ramping down before each one and back up after it.
 */
export function duckingKeyframes(
  item: TimelineItem,
  regions: readonly [number, number][],
  options: DuckOptions = {},
): Keyframe[] {
  const o = { ...DEFAULTS, ...options };
  const base = item.volume;
  const low = base * o.level;
  const start = item.start / secondsToFlicks(1);
  const end = itemEnd(item) / secondsToFlicks(1);
  const points: [number, number][] = [];
  const push = (t: number, v: number) => {
    const c = Math.min(end, Math.max(start, t));
    const last = points.at(-1);
    if (last && c <= last[0] + 1e-6) {
      // Overlapping ramps: keep the lower value at the same moment.
      last[1] = Math.min(last[1], v);
      return;
    }
    points.push([c, v]);
  };
  for (const [a, b] of regions) {
    if (b <= start || a >= end) continue;
    push(a - o.ramp, base);
    push(a, low);
    push(b, low);
    push(b + o.ramp, base);
  }
  return points.map(([t, v]) => ({
    t: Math.round(sourceTimeAt(item, secondsToFlicks(t))) as Keyframe['t'],
    v: Math.round(v * 1000) / 1000,
    e: 'linear' as const,
  }));
}
