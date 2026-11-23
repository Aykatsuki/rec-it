// Ducking (ADR-042): music gets quieter while someone speaks, as ordinary volume keyframes, so
// the preview and the export play it identically and it stays editable.
import { FLICKS_PER_SECOND, secondsToFlicks } from '../time';
import type { Command } from './commands';
import {
  itemEnd,
  sourceTimeAt,
  volumeAt,
  type Keyframe,
  type Sequence,
  type TimelineItem,
} from './model';

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

/** Clips linked to any of `ids` (not including them). */
export function linkedPartners(seq: Sequence | null | undefined, ids: readonly string[]): string[] {
  const all = (seq?.tracks ?? []).flatMap((t) => t.items);
  const links = new Set(all.filter((i) => ids.includes(i.id) && i.linkId).map((i) => i.linkId));
  return all.filter((i) => i.linkId && links.has(i.linkId) && !ids.includes(i.id)).map((i) => i.id);
}

/** The audible clips `item` could duck under: not itself or its partners, not muted, not captions. */
export function duckSources(seq: Sequence, item: TimelineItem): TimelineItem[] {
  const self = new Set([item.id, ...linkedPartners(seq, [item.id])]);
  return seq.tracks
    .filter((t) => !t.muted && t.kind !== 'caption')
    .flatMap((t) => t.items)
    .filter((i) => !self.has(i.id) && !i.muted && !i.freeze && !i.caption);
}

/** A clip and its media's loudness: one byte (0–255) per 10 ms of source (the waveform file). */
export interface DuckSource {
  item: TimelineItem;
  peaks: ArrayLike<number>;
}

/**
 * Timeline ranges (seconds) where the other clips are loud — speech — while `item` plays.
 * Loudness is the loudest of `sources` every 10 ms, after their volume and fades.
 */
export function speechRegions(
  item: TimelineItem,
  sources: readonly DuckSource[],
  options: DuckOptions = {},
): [number, number][] {
  const step = 0.01;
  const from = item.start / FLICKS_PER_SECOND;
  const n = Math.max(1, Math.round(item.duration / FLICKS_PER_SECOND / step));
  const loud = new Float32Array(n);
  for (const o of sources) {
    for (let i = 0; i < n; i++) {
      const t = secondsToFlicks(from + i * step);
      if (t < o.item.start || t >= o.item.start + o.item.duration) continue;
      const src = sourceTimeAt(o.item, t) / FLICKS_PER_SECOND;
      const v = ((o.peaks[Math.floor(src * 100)] ?? 0) / 255) * volumeAt(o.item, t);
      if (v > loud[i]!) loud[i] = v;
    }
  }
  return loudRegions(loud, step, options).map(([a, b]) => [a + from, b + from]);
}

/** Commands replacing `item`'s volume animation with ducking keyframes (one undo step). */
export function duckingCommands(
  seq: Sequence,
  item: TimelineItem,
  regions: readonly [number, number][],
  options: DuckOptions = {},
): Command {
  const keys = duckingKeyframes(item, regions, options);
  return {
    type: 'batch',
    commands: [
      ...(item.keyframes?.volume?.length
        ? [
            {
              type: 'keyframe.clear' as const,
              sequenceId: seq.id,
              itemId: item.id,
              property: 'volume' as const,
              t: item.sourceIn,
            },
          ]
        : []),
      ...keys.map((k) => ({
        type: 'keyframe.set' as const,
        sequenceId: seq.id,
        itemId: item.id,
        property: 'volume' as const,
        t: k.t,
        value: k.v,
        easing: 'linear' as const,
      })),
    ],
  };
}
