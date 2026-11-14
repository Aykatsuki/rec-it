import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import type { Command } from './commands';
import { History } from './history';
import { emptyDocument, sourceSpan, sourceTimeAt, timelineTimeAt } from './model';

const lookup = (id: string) =>
  id === 'clip'
    ? { kind: 'video' as const, duration: S(10), hasAudio: true, width: 1920, height: 1080 }
    : undefined;

function setup() {
  const h = new History(emptyDocument());
  const run = (c: Command) => h.execute(c, lookup);
  run({
    type: 'sequence.create',
    id: 's',
    name: 'S',
    width: 1080,
    height: 1920,
    fps: FRAME_RATES.fps30,
  });
  const v1 = h.doc.sequences[0]!.tracks[1]!.id;
  // A plays source 2–6 s at 0–4 s; B follows at 4–6 s.
  run({
    type: 'item.add',
    sequenceId: 's',
    trackId: v1,
    assetId: 'clip',
    id: 'a',
    start: 0,
    sourceIn: S(2),
    duration: S(4),
  });
  run({
    type: 'item.add',
    sequenceId: 's',
    trackId: v1,
    assetId: 'clip',
    id: 'b',
    start: S(4),
    sourceIn: 0,
    duration: S(2),
  });
  const items = () => h.doc.sequences[0]!.tracks[1]!.items;
  return { h, run, items };
}

describe('speed, reverse and freeze frames', () => {
  it('double speed halves the length, keeps the source and closes up later clips', () => {
    const { run, items } = setup();
    run({ type: 'item.speed', sequenceId: 's', itemId: 'a', speed: 2 });
    const [a, b] = items();
    expect(a!.duration).toBe(S(2));
    expect(sourceSpan(a!)).toBe(S(4));
    expect(sourceTimeAt(a!, S(1))).toBe(S(4));
    expect(timelineTimeAt(a!, S(4))).toBe(S(1));
    expect(b!.start).toBe(S(2));
    // Half speed makes room again.
    run({ type: 'item.speed', sequenceId: 's', itemId: 'a', speed: 0.5 });
    expect(items()[0]!.duration).toBe(S(8));
    expect(items()[1]!.start).toBe(S(8));
    expect(() => run({ type: 'item.speed', sequenceId: 's', itemId: 'a', speed: NaN })).toThrow();
  });

  it('reverse plays the source backwards and splits keep the right parts', () => {
    const { run, items } = setup();
    run({ type: 'item.speed', sequenceId: 's', itemId: 'a', reverse: true });
    const a = items()[0]!;
    expect(sourceTimeAt(a, 0)).toBeGreaterThan(S(5.99));
    expect(sourceTimeAt(a, S(3))).toBe(S(3) - 705_600); // 1 ms before: the previous frame
    run({ type: 'item.split', sequenceId: 's', time: S(1) });
    const [left, right] = items();
    // The first second of a reversed clip is the last second of its source.
    expect(left!.sourceIn).toBe(S(5));
    expect(right!.sourceIn).toBe(S(2));
    expect(sourceSpan(right!)).toBe(S(3));
  });

  it('trims a fast clip within its media', () => {
    const { h, run, items } = setup();
    run({ type: 'item.speed', sequenceId: 's', itemId: 'a', speed: 2 });
    const v1 = h.doc.sequences[0]!.tracks[1]!.id;
    run({ type: 'item.move', sequenceId: 's', itemId: 'b', trackId: v1, start: S(8) });
    run({ type: 'item.move', sequenceId: 's', itemId: 'a', trackId: v1, start: S(3) });
    // 2 s of media before the in point = 1 s of timeline at double speed.
    run({ type: 'item.trim', sequenceId: 's', itemId: 'a', edge: 'start', time: 0 });
    expect(items()[0]!.start).toBe(S(2));
    expect(items()[0]!.sourceIn).toBe(0);
    // 6 s of media after the out point (6–10 s... from source 6) = 2 s at double speed.
    run({ type: 'item.trim', sequenceId: 's', itemId: 'a', edge: 'end', time: S(7.5) });
    expect(items()[0]!.duration).toBe(S(5));
  });

  it('freeze frame inserts a still of the frame and moves what follows', () => {
    const { run, items } = setup();
    run({
      type: 'item.freeze',
      sequenceId: 's',
      itemId: 'a',
      time: S(1),
      sourceTime: S(3),
      duration: S(2),
      id: 'f',
    });
    const list = items();
    expect(list.map((i) => [i.start / S(1), i.duration / S(1)])).toEqual([
      [0, 1],
      [1, 2],
      [3, 3],
      [6, 2],
    ]);
    const f = list[1]!;
    expect(f).toMatchObject({ id: 'f', freeze: true, muted: true, sourceIn: S(3) });
    expect(sourceTimeAt(f, S(2.5))).toBe(S(3) + 705_600);
    expect(list[2]!.sourceIn).toBe(S(3));
  });
});
