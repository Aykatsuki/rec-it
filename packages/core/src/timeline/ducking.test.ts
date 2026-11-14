import { describe, expect, it } from 'vitest';
import { secondsToFlicks as S } from '../time';
import { duckingKeyframes, loudRegions } from './ducking';
import { DEFAULT_TRANSFORM, type TimelineItem } from './model';

describe('ducking', () => {
  it('finds speech, bridging short pauses and ignoring blips', () => {
    // 10 ms steps: speech 1.0–2.0 s, a 0.3 s pause, speech 2.3–3.0 s, a 0.1 s click at 5 s.
    const l = new Array(600).fill(0);
    for (let i = 100; i < 200; i++) l[i] = 0.5;
    for (let i = 230; i < 300; i++) l[i] = 0.5;
    for (let i = 500; i < 510; i++) l[i] = 0.9;
    const r = loudRegions(l, 0.01);
    expect(r).toHaveLength(1);
    expect(r[0]![0]).toBeCloseTo(1, 6);
    expect(r[0]![1]).toBeCloseTo(3, 6);
  });

  it('turns regions into volume keyframes in source time', () => {
    const music: TimelineItem = {
      id: 'm',
      assetId: 'song',
      start: S(0.5),
      duration: S(10),
      sourceIn: S(30),
      volume: 0.8,
      muted: false,
      transform: DEFAULT_TRANSFORM,
    };
    const keys = duckingKeyframes(music, [[2, 4]]);
    expect(keys.map((k) => [k.t / S(1), k.v])).toEqual([
      [31.25, 0.8],
      [31.5, 0.2],
      [33.5, 0.2],
      [33.75, 0.8],
    ]);
    // Regions running past the clip are clipped to it.
    const edge = duckingKeyframes(music, [[0, 1]]);
    expect(edge[0]!.t).toBe(S(30));
  });
});
