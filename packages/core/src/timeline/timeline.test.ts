import { describe, expect, it } from 'vitest';
import { FRAME_RATES, frameDuration, secondsToFlicks, type Flicks } from '../time';
import { CommandError, checkInvariants, type Command } from './commands';
import { History } from './history';
import { computeLayout, emptyDocument, sequenceDuration, type AssetInfo, type ProjectDocument } from './model';

const s = (seconds: number) => secondsToFlicks(seconds);
const ASSETS: Record<string, AssetInfo> = {
  clip10: { kind: 'video', duration: s(10), hasAudio: true, width: 1920, height: 1080 },
  silent: { kind: 'video', duration: s(4), hasAudio: false, width: 1080, height: 1920 },
  song: { kind: 'audio', duration: s(30), hasAudio: true },
  photo: { kind: 'image', duration: null, hasAudio: false, width: 800, height: 600 },
};
const lookup = (id: string) => ASSETS[id];

function setup() {
  const h = new History(emptyDocument());
  h.execute({ type: 'sequence.create', id: 'seq', name: 'Short', width: 1080, height: 1920, fps: FRAME_RATES.fps30 }, lookup);
  const seq = () => h.doc.sequences[0]!;
  const track = (name: string) => seq().tracks.find((t) => t.name === name)!;
  type WithoutSequence<T> = T extends unknown ? Omit<T, 'sequenceId'> : never;
  const run = (c: WithoutSequence<Command>) =>
    h.execute({ ...c, sequenceId: 'seq' } as Command, lookup);
  return { h, seq, track, run };
}

describe('timeline commands', () => {
  it('creates a 9:16 sequence with two video and two audio tracks', () => {
    const { seq } = setup();
    expect(seq()).toMatchObject({ width: 1080, height: 1920 });
    expect(seq().tracks.map((t) => `${t.kind}:${t.name}`)).toEqual(['video:V2', 'video:V1', 'audio:A1', 'audio:A2']);
  });

  it('adds clips at their full length, stills at 5 s, snapped to frames', () => {
    const { run, track } = setup();
    run({ type: 'item.add', trackId: track('V1').id, assetId: 'clip10', start: s(1.01) });
    run({ type: 'item.add', trackId: track('V2').id, assetId: 'photo', start: 0 });
    const v1 = track('V1').items[0]!;
    expect(v1.start % frameDuration(FRAME_RATES.fps30)).toBe(0);
    expect(v1.duration).toBe(s(10));
    expect(track('V2').items[0]!.duration).toBe(s(5));
  });

  it('refuses wrong track kinds and locked tracks', () => {
    const { run, track, h } = setup();
    expect(() => run({ type: 'item.add', trackId: track('V1').id, assetId: 'song', start: 0 })).toThrow(CommandError);
    expect(() => run({ type: 'item.add', trackId: track('A1').id, assetId: 'silent', start: 0 })).toThrow(/no sound/);
    run({ type: 'track.update', trackId: track('V1').id, locked: true });
    expect(() => run({ type: 'item.add', trackId: track('V1').id, assetId: 'clip10', start: 0 })).toThrow(/locked/);
    checkInvariants(h.doc);
  });

  it('overwrites what is underneath when adding or moving', () => {
    const { run, track } = setup();
    const v1 = track('V1').id;
    run({ type: 'item.add', trackId: v1, assetId: 'clip10', start: 0, id: 'a' });
    run({ type: 'item.add', trackId: v1, assetId: 'silent', start: s(3), id: 'b' });
    // 'a' is split around 'b': 0–3 and 7–10.
    expect(track('V1').items.map((i) => [i.start, i.duration])).toEqual([
      [0, s(3)],
      [s(3), s(4)],
      [s(7), s(3)],
    ]);
    expect(track('V1').items[2]!.sourceIn).toBe(s(7));
    run({ type: 'item.move', itemId: 'b', trackId: track('V2').id, start: s(1) });
    expect(track('V2').items[0]!.start).toBe(s(1));
    expect(track('V1').items).toHaveLength(2);
  });

  it('trims within the source and the neighbouring clips', () => {
    const { run, track } = setup();
    const v1 = track('V1').id;
    run({ type: 'item.add', trackId: v1, assetId: 'silent', start: 0, id: 'a' });
    run({ type: 'item.add', trackId: v1, assetId: 'silent', start: s(6), id: 'b' });
    run({ type: 'item.trim', itemId: 'a', edge: 'end', time: s(20) });
    expect(track('V1').items[0]!.duration).toBe(s(4)); // source is only 4 s long
    run({ type: 'item.trim', itemId: 'b', edge: 'start', time: s(2) });
    expect(track('V1').items[1]).toMatchObject({ start: s(6), sourceIn: 0 }); // cannot go before the source start
    run({ type: 'item.trim', itemId: 'b', edge: 'start', time: s(7) });
    expect(track('V1').items[1]).toMatchObject({ start: s(7), sourceIn: s(1), duration: s(3) });
    run({ type: 'item.trim', itemId: 'b', edge: 'start', time: s(1) });
    expect(track('V1').items[1]!.start).toBe(s(6)); // limited by the source start again
  });

  it('splits at the playhead and removes with or without ripple', () => {
    const { run, track, seq } = setup();
    const v1 = track('V1').id;
    run({ type: 'item.add', trackId: v1, assetId: 'clip10', start: 0, id: 'a' });
    run({ type: 'item.split', time: s(4) });
    const [left, right] = track('V1').items;
    expect([left!.duration, right!.start, right!.sourceIn]).toEqual([s(4), s(4), s(4)]);
    run({ type: 'item.remove', itemIds: [left!.id], ripple: true });
    expect(track('V1').items[0]).toMatchObject({ start: 0, sourceIn: s(4), duration: s(6) });
    expect(sequenceDuration(seq())).toBe(s(6));
    expect(() => run({ type: 'item.split', time: s(20) })).toThrow(/no clip/);
  });

  it('re-aligns edits when the frame rate changes', () => {
    const { run, track, seq } = setup();
    run({ type: 'item.add', trackId: track('V1').id, assetId: 'clip10', start: s(1) });
    run({ type: 'sequence.update', fps: FRAME_RATES.fps25, width: 1080, height: 1080 });
    const d = frameDuration(FRAME_RATES.fps25);
    const item = track('V1').items[0]!;
    expect(item.start % d).toBe(0);
    expect(seq()).toMatchObject({ width: 1080, height: 1080, fps: FRAME_RATES.fps25 });
    expect(() => run({ type: 'sequence.update', width: 1081 })).toThrow(/even/);
  });

  it('undoes and redoes exactly', () => {
    const { h, run, track } = setup();
    const before = h.doc;
    run({ type: 'item.add', trackId: track('V1').id, assetId: 'clip10', start: 0 });
    run({ type: 'item.split', time: s(5) });
    const after = h.doc;
    h.undo();
    h.undo();
    expect(h.doc).toEqual(before);
    h.redo();
    h.redo();
    expect(h.doc).toEqual(after);
    expect(h.canRedo).toBe(false);
  });

  it('keeps invariants under 3,000 random commands, and undo returns to the start', () => {
    const { h, seq } = setup();
    const start = h.doc;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    let applied = 0;
    for (let i = 0; i < 3000; i++) {
      const tracks = seq().tracks;
      const items = tracks.flatMap((t) => t.items);
      const t = (rnd() * 40 * 705_600_000) as Flicks;
      const commands: Command[] = [
        { type: 'item.add', sequenceId: 'seq', trackId: pick(tracks).id, assetId: pick(Object.keys(ASSETS)), start: t },
        ...(items.length
          ? ([
              { type: 'item.move', sequenceId: 'seq', itemId: pick(items).id, trackId: pick(tracks).id, start: t },
              { type: 'item.trim', sequenceId: 'seq', itemId: pick(items).id, edge: pick(['start', 'end'] as const), time: t },
              { type: 'item.split', sequenceId: 'seq', time: t },
              { type: 'item.remove', sequenceId: 'seq', itemIds: [pick(items).id], ripple: rnd() > 0.5 },
            ] as Command[])
          : []),
      ];
      try {
        h.execute(pick(commands), lookup);
        applied++;
      } catch (e) {
        if (!(e instanceof CommandError)) throw e;
      }
      checkInvariants(h.doc);
    }
    expect(applied).toBeGreaterThan(1000);
    while (h.canUndo) h.undo();
    // Undo stops at the history limit; replay a fresh history to check exact reversal.
    const h2 = new History(start, 10_000);
    const docs: ProjectDocument[] = [h2.doc];
    for (let i = 0; i < 50; i++) {
      try {
        h2.execute({ type: 'item.add', sequenceId: 'seq', trackId: pick(seq().tracks).id, assetId: 'clip10', start: (rnd() * 20 * 705_600_000) as Flicks }, lookup);
        docs.push(h2.doc);
      } catch {
        // wrong track kind
      }
    }
    while (h2.canUndo) h2.undo();
    expect(h2.doc).toEqual(start);
  });
});

describe('computeLayout', () => {
  it('fills a 9:16 frame from 16:9 by cropping the sides', () => {
    expect(computeLayout(1920, 1080, 1080, 1920, { fit: 'fill', scale: 1, x: 0, y: 0 })).toEqual({
      width: 3414,
      height: 1920,
      left: -1167,
      top: 0,
    });
  });
  it('fits with bars, and moves by a fraction of the frame', () => {
    expect(computeLayout(1920, 1080, 1080, 1920, { fit: 'fit', scale: 1, x: 0.1, y: 0 })).toEqual({
      width: 1080,
      height: 608,
      left: 108,
      top: 656,
    });
  });
});
