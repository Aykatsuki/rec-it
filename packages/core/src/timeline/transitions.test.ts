import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import type { Command } from './commands';
import { History } from './history';
import { emptyDocument, fadeAt, gainAt, pictureAt } from './model';
import { presentSequence, transitionSpans } from './transitions';

const lookup = (id: string) =>
  id === 'clip'
    ? { kind: 'video' as const, duration: S(10), hasAudio: true, width: 1920, height: 1080 }
    : undefined;
const length = (id: string) => (id === 'clip' ? S(10) : undefined);

/** Two clips back to back on V1: A plays source 2–5 s at 0–3 s, B plays source 4–8 s at 3–7 s. */
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
  const add = (id: string, start: number, sourceIn: number, duration: number) =>
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: v1,
      assetId: 'clip',
      id,
      start: S(start),
      sourceIn: S(sourceIn),
      duration: S(duration),
    });
  add('a', 0, 2, 3);
  add('b', 3, 4, 4);
  const seq = () => h.doc.sequences[0]!;
  const shown = () => presentSequence(seq(), length).tracks[1]!.items;
  return { h, run, seq, shown, add };
}

describe('transitions', () => {
  it('cross dissolve overlaps the clips around the cut, B fading in over A', () => {
    const { run, seq, shown } = setup();
    run({ type: 'transition.set', sequenceId: 's', itemId: 'b', kind: 'dissolve', duration: S(1) });
    expect(seq().tracks[1]!.items[1]!.transitionIn).toEqual({ kind: 'dissolve', duration: S(1) });
    const [a, b] = shown();
    expect(a!.duration).toBe(S(3.5));
    expect(b!.start).toBe(S(2.5));
    expect(b!.sourceIn).toBe(S(3.5));
    expect(b!.duration).toBe(S(4.5));
    // B's picture and sound fade in over the second; A's sound fades out, its picture stays.
    expect(pictureAt(b!, S(3)).alpha).toBeCloseTo(0.5, 6);
    expect(pictureAt(a!, S(3.4)).alpha).toBe(1);
    expect(gainAt(a!, S(3)) + gainAt(b!, S(3))).toBeCloseTo(1, 6);
    // The timeline itself is unchanged.
    expect(seq().tracks[1]!.items[0]!.duration).toBe(S(3));
  });

  it('uses media from one side only when the other has none', () => {
    const { run, seq } = setup();
    run({ type: 'transition.set', sequenceId: 's', itemId: 'b', kind: 'dissolve', duration: S(1) });
    const track = seq().tracks[1]!;
    // B starting at the very start of its media: the whole dissolve comes after the cut.
    const atStart = { ...track, items: [track.items[0]!, { ...track.items[1]!, sourceIn: S(0) }] };
    expect(transitionSpans(atStart, length)[0]).toMatchObject({ start: S(3), end: S(4) });
    // Neither side has any: nothing is shown.
    const none = { ...atStart, items: [{ ...track.items[0]!, sourceIn: S(7) }, atStart.items[1]!] };
    expect(transitionSpans(none, length)).toEqual([]);
  });

  it('dips to a colour and back without moving the clips', () => {
    const { run, shown } = setup();
    run({ type: 'transition.set', sequenceId: 's', itemId: 'b', kind: 'dipWhite', duration: S(1) });
    const [a, b] = shown();
    expect(a!.duration).toBe(S(3));
    expect(b!.start).toBe(S(3));
    expect(pictureAt(a!, S(2.75))).toMatchObject({ tint: 0.5, tintColor: 'white', alpha: 1 });
    expect(pictureAt(b!, S(3.25)).tint).toBeCloseTo(0.5, 6);
    expect(gainAt(a!, S(2.75))).toBeCloseTo(0.5, 6);
    expect(fadeAt(b!, S(3))).toBe(1);
  });

  it('is ignored when the clips no longer touch, and split and limits behave', () => {
    const { run, seq, shown } = setup();
    expect(() =>
      run({
        type: 'transition.set',
        sequenceId: 's',
        itemId: 'a',
        kind: 'dissolve',
        duration: S(1),
      }),
    ).toThrow(/another clip/);
    run({
      type: 'transition.set',
      sequenceId: 's',
      itemId: 'b',
      kind: 'dissolve',
      duration: S(30),
    });
    // Limited to 5 s and the shorter clip (A, 3 s).
    expect(seq().tracks[1]!.items[1]!.transitionIn!.duration).toBe(S(3));
    run({
      type: 'item.move',
      sequenceId: 's',
      itemId: 'b',
      trackId: seq().tracks[1]!.id,
      start: S(4),
    });
    expect(shown()[1]!.start).toBe(S(4));
    run({
      type: 'item.move',
      sequenceId: 's',
      itemId: 'b',
      trackId: seq().tracks[1]!.id,
      start: S(3),
    });
    run({ type: 'item.split', sequenceId: 's', time: S(5) });
    const items = seq().tracks[1]!.items;
    expect(items[1]!.transitionIn).toBeDefined();
    expect(items[2]!.transitionIn).toBeUndefined();
    run({ type: 'transition.remove', sequenceId: 's', itemId: 'b' });
    expect(seq().tracks[1]!.items[1]!.transitionIn).toBeUndefined();
  });
});
