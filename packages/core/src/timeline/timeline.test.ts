import { describe, expect, it } from 'vitest';
import { FRAME_RATES, frameDuration, secondsToFlicks, type Flicks } from '../time';
import { CommandError, checkInvariants, type Command } from './commands';
import { History } from './history';
import {
  transformAt,
  volumeAt,
  DEFAULT_TRANSFORM,
  computeLayout,
  emptyDocument,
  sequenceDuration,
  type AssetInfo,
  type ProjectDocument,
} from './model';

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
  h.execute(
    {
      type: 'sequence.create',
      id: 'seq',
      name: 'Short',
      width: 1080,
      height: 1920,
      fps: FRAME_RATES.fps30,
    },
    lookup,
  );
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
    expect(seq().tracks.map((t) => `${t.kind}:${t.name}`)).toEqual([
      'video:V2',
      'video:V1',
      'audio:A1',
      'audio:A2',
    ]);
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
    expect(() =>
      run({ type: 'item.add', trackId: track('V1').id, assetId: 'song', start: 0 }),
    ).toThrow(CommandError);
    expect(() =>
      run({ type: 'item.add', trackId: track('A1').id, assetId: 'silent', start: 0 }),
    ).toThrow(/no sound/);
    run({ type: 'track.update', trackId: track('V1').id, locked: true });
    expect(() =>
      run({ type: 'item.add', trackId: track('V1').id, assetId: 'clip10', start: 0 }),
    ).toThrow(/locked/);
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
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    let applied = 0;
    for (let i = 0; i < 3000; i++) {
      const tracks = seq().tracks;
      const items = tracks.flatMap((t) => t.items);
      const t = (rnd() * 40 * 705_600_000) as Flicks;
      const commands: Command[] = [
        {
          type: 'item.add',
          sequenceId: 'seq',
          trackId: pick(tracks).id,
          assetId: pick(Object.keys(ASSETS)),
          start: t,
        },
        ...(items.length
          ? ([
              {
                type: 'item.move',
                sequenceId: 'seq',
                itemId: pick(items).id,
                trackId: pick(tracks).id,
                start: t,
              },
              {
                type: 'item.trim',
                sequenceId: 'seq',
                itemId: pick(items).id,
                edge: pick(['start', 'end'] as const),
                time: t,
              },
              { type: 'item.split', sequenceId: 'seq', time: t },
              { type: 'item.link', sequenceId: 'seq', itemIds: [pick(items).id, pick(items).id] },
              { type: 'item.unlink', sequenceId: 'seq', itemIds: [pick(items).id] },
              {
                type: 'keyframe.set',
                sequenceId: 'seq',
                itemId: pick(items).id,
                property: pick(['x', 'scale', 'rotation', 'volume'] as const),
                t,
                value: rnd() * 2,
              },
              {
                type: 'item.moveMany',
                sequenceId: 'seq',
                moves: [pick(items), pick(items)]
                  .filter((x, k, all) => all.findIndex((y) => y.id === x.id) === k)
                  .map((x) => ({
                    itemId: x.id,
                    trackId: pick(tracks).id,
                    start: (x.start + t / 4) as Flicks,
                  })),
              },
              {
                type: 'batch',
                commands: [
                  {
                    type: 'item.update',
                    sequenceId: 'seq',
                    itemId: pick(items).id,
                    transform: { rotation: rnd() * 720 - 360, scale: rnd() * 3 },
                  },
                  { type: 'item.split', sequenceId: 'seq', time: t },
                ],
              },
              {
                type: 'item.remove',
                sequenceId: 'seq',
                itemIds: [pick(items).id],
                ripple: rnd() > 0.5,
              },
              {
                type: 'captions.generate',
                sequenceId: 'seq',
                captions: [0, 1, 2].map((k) => {
                  const start = Math.round(rnd() * secondsToFlicks(8));
                  return {
                    start,
                    duration: Math.round(rnd() * secondsToFlicks(3)),
                    words: [{ text: `w${k}`, start, end: start + secondsToFlicks(0.3) }],
                  };
                }),
              },
              {
                type: 'caption.edit',
                sequenceId: 'seq',
                itemId: pick(items).id,
                text: rnd() > 0.5 ? 'one two' : 'single',
              },
              {
                type: 'item.cutRange',
                sequenceId: 'seq',
                itemId: pick(items).id,
                from: Math.round(rnd() * secondsToFlicks(8)),
                to: Math.round(rnd() * secondsToFlicks(8)),
                ripple: rnd() > 0.5,
              },
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
        h2.execute(
          {
            type: 'item.add',
            sequenceId: 'seq',
            trackId: pick(seq().tracks).id,
            assetId: 'clip10',
            start: (rnd() * 20 * 705_600_000) as Flicks,
          },
          lookup,
        );
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
  it('lays out only the cropped part, cut on even pixels', () => {
    // A 1920×1080 picture cropped to its left third and top half (a facecam corner).
    const crop = { left: 0, top: 0, right: 2 / 3, bottom: 0.5 };
    const l = computeLayout(1920, 1080, 1080, 1920, { ...DEFAULT_TRANSFORM, fit: 'fit', crop });
    expect(l.source).toEqual({ x: 0, y: 0, w: 640, h: 540 });
    expect([l.width, l.height]).toEqual([1080, 912]); // 640×540 fitted to 1080 wide
    // Odd sizes round down to even pixels, never past the picture.
    const odd = computeLayout(1279, 721, 1080, 1920, {
      ...DEFAULT_TRANSFORM,
      crop: { left: 0.333, top: 0.1, right: 0.2, bottom: 0.0 },
    });
    expect((odd.source.x % 2) + (odd.source.y % 2) + (odd.source.w % 2) + (odd.source.h % 2)).toBe(
      0,
    );
    expect(odd.source.x + odd.source.w).toBeLessThanOrEqual(1279);
  });

  it('fills a 9:16 frame from 16:9 by cropping the sides', () => {
    expect(
      computeLayout(1920, 1080, 1080, 1920, { fit: 'fill', scale: 1, x: 0, y: 0, rotation: 0 }),
    ).toMatchObject({
      width: 3414,
      height: 1920,
      left: -1167,
      top: 0,
    });
  });
  it('fits with bars, and moves by a fraction of the frame', () => {
    expect(
      computeLayout(1920, 1080, 1080, 1920, { fit: 'fit', scale: 1, x: 0.1, y: 0, rotation: 0 }),
    ).toMatchObject({
      width: 1080,
      height: 608,
      left: 108,
      top: 656,
    });
  });
  it('rotates around the centre and reports the rotated bounds', () => {
    const l = computeLayout(1000, 500, 1000, 1000, {
      fit: 'fit',
      scale: 1,
      x: 0,
      y: 0,
      rotation: 90,
    });
    expect(l).toMatchObject({ width: 1000, height: 500, left: 0, top: 250, rotation: 90 });
    expect(l.bounds).toEqual({ width: 500, height: 1000, left: 250, top: 0 });
    expect(
      computeLayout(10, 10, 10, 10, { fit: 'fit', scale: 1, x: 0, y: 0, rotation: 270 }).rotation,
    ).toBe(-90);
  });
});

describe('group edits', () => {
  const assets = (id: string) =>
    id === 'img'
      ? { kind: 'image' as const, duration: null, hasAudio: false, width: 10, height: 10 }
      : undefined;
  const fps = FRAME_RATES.fps30;
  const setup = () => {
    const h = new History(emptyDocument());
    h.execute(
      { type: 'sequence.create', id: 's', name: 'S', width: 1080, height: 1920, fps },
      assets,
    );
    const v1 = h.doc.sequences[0]!.tracks.find((t) => t.name === 'V1')!.id;
    const s = (sec: number) => secondsToFlicks(sec);
    h.execute(
      {
        type: 'batch',
        commands: [
          {
            type: 'item.add',
            sequenceId: 's',
            trackId: v1,
            assetId: 'img',
            start: s(0),
            id: 'a',
            duration: s(1),
          },
          {
            type: 'item.add',
            sequenceId: 's',
            trackId: v1,
            assetId: 'img',
            start: s(1),
            id: 'b',
            duration: s(1),
          },
        ],
      },
      assets,
    );
    return { h, v1, s };
  };

  it('applies a batch as one undo step', () => {
    const { h } = setup();
    expect(h.doc.sequences[0]!.tracks.flatMap((t) => t.items)).toHaveLength(2);
    h.undo();
    expect(h.doc.sequences[0]!.tracks.flatMap((t) => t.items)).toHaveLength(0);
  });

  it('moves several clips together without them overwriting each other', () => {
    const { h, v1, s } = setup();
    h.execute(
      {
        type: 'item.moveMany',
        sequenceId: 's',
        moves: [
          { itemId: 'a', trackId: v1, start: s(0.5) },
          { itemId: 'b', trackId: v1, start: s(1.5) },
        ],
      },
      assets,
    );
    const items = h.doc.sequences[0]!.tracks.find((t) => t.id === v1)!.items;
    expect(items.map((i) => [i.id, i.start, i.duration])).toEqual([
      ['a', s(0.5), s(1)],
      ['b', s(1.5), s(1)],
    ]);
    checkInvariants(h.doc);
  });

  it('rolls back a whole batch when one part fails', () => {
    const { h, v1 } = setup();
    const before = h.doc;
    expect(() =>
      h.execute(
        {
          type: 'batch',
          commands: [
            { type: 'item.update', sequenceId: 's', itemId: 'a', transform: { rotation: 45 } },
            { type: 'item.move', sequenceId: 's', itemId: 'missing', trackId: v1, start: 0 },
          ],
        },
        assets,
      ),
    ).toThrow(CommandError);
    expect(h.doc).toBe(before);
  });
});

describe('linked clips and keyframes', () => {
  const info = {
    clip: {
      kind: 'video' as const,
      duration: secondsToFlicks(10),
      hasAudio: true,
      width: 1920,
      height: 1080,
    },
  };
  const lookup = (id: string) => (info as Record<string, (typeof info)['clip']>)[id];
  const S = secondsToFlicks;
  const setup = () => {
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
    const tracks = () => h.doc.sequences[0]!.tracks;
    const v1 = tracks()[1]!.id;
    const a1 = tracks()[2]!.id;
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: v1,
      assetId: 'clip',
      start: S(1),
      id: 'v',
      duration: S(4),
    });
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId: a1,
      assetId: 'clip',
      start: S(1),
      id: 'a',
      duration: S(4),
    });
    run({ type: 'item.link', sequenceId: 's', itemIds: ['v', 'a'] });
    const item = (id: string) =>
      tracks()
        .flatMap((t) => t.items)
        .find((i) => i.id === id);
    return { h, run, item, tracks, v1, a1 };
  };

  it('moves, trims, splits and deletes linked clips together', () => {
    const { h, run, item, tracks, v1 } = setup();
    run({ type: 'item.move', sequenceId: 's', itemId: 'v', trackId: v1, start: S(2) });
    expect([item('v')!.start, item('a')!.start]).toEqual([S(2), S(2)]);
    run({ type: 'item.trim', sequenceId: 's', itemId: 'a', edge: 'end', time: S(5) });
    expect([item('v')!.duration, item('a')!.duration]).toEqual([S(3), S(3)]);
    run({ type: 'item.split', sequenceId: 's', time: S(3), itemIds: ['v'] });
    const all = tracks().flatMap((t) => t.items);
    expect(all).toHaveLength(4);
    const right = all.filter((i) => i.start === S(3));
    expect(right).toHaveLength(2);
    expect(right[0]!.linkId).toBeDefined();
    expect(right[0]!.linkId).toBe(right[1]!.linkId);
    expect(right[0]!.linkId).not.toBe(item('v')!.linkId);
    run({ type: 'item.remove', sequenceId: 's', itemIds: ['v'] });
    expect(tracks().flatMap((t) => t.items)).toHaveLength(2);
    checkInvariants(h.doc);
  });

  it('cuts a source-time range out of linked clips, with and without ripple', () => {
    const { h, run, item, tracks } = setup();
    // Clip v/a sits at 1–5 s on the timeline and shows source 0–4 s. Cut source 1–2 s.
    run({
      type: 'item.cutRange',
      sequenceId: 's',
      itemId: 'v',
      from: S(1),
      to: S(2),
      ripple: true,
    });
    const all = () =>
      tracks()
        .flatMap((t) => t.items)
        .map((i) => [i.start, i.duration, i.sourceIn]);
    expect(all()).toEqual([
      [S(1), S(1), 0],
      [S(2), S(2), S(2)],
      [S(1), S(1), 0],
      [S(2), S(2), S(2)],
    ]);
    const rights = tracks()
      .flatMap((t) => t.items)
      .filter((i) => i.start === S(2));
    expect(rights[0]!.linkId).toBe(rights[1]!.linkId);
    expect(rights[0]!.linkId).not.toBe(item('v')!.linkId);
    checkInvariants(h.doc);
    h.undo();
    // Without ripple a gap is left; cutting from the very start keeps the clip's id.
    run({ type: 'item.cutRange', sequenceId: 's', itemId: 'v', from: 0, to: S(1) });
    expect([item('v')!.start, item('v')!.sourceIn, item('a')!.start]).toEqual([S(2), S(1), S(2)]);
    expect(() =>
      run({ type: 'item.cutRange', sequenceId: 's', itemId: 'v', from: S(9), to: S(9.5) }),
    ).toThrow(/shorter than a frame/);
    checkInvariants(h.doc);
  });

  it('unlinks so clips edit separately', () => {
    const { run, item, v1 } = setup();
    run({ type: 'item.unlink', sequenceId: 's', itemIds: ['a'] });
    run({ type: 'item.move', sequenceId: 's', itemId: 'v', trackId: v1, start: S(3) });
    expect([item('v')!.start, item('a')!.start]).toEqual([S(3), S(1)]);
  });

  it('interpolates keyframes in source time, with easing and hold', () => {
    const { run, item } = setup();
    // The clip starts at 1 s on the timeline with sourceIn 0: source time = timeline time - 1 s.
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'scale',
      t: S(0),
      value: 1,
    });
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'scale',
      t: S(2),
      value: 2,
    });
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'x',
      t: S(0),
      value: 0,
      easing: 'hold',
    });
    run({ type: 'keyframe.set', sequenceId: 's', itemId: 'v', property: 'x', t: S(2), value: 0.5 });
    const v = item('v')!;
    expect(transformAt(v, S(2)).scale).toBeCloseTo(1.5);
    expect(transformAt(v, S(0)).scale).toBe(1);
    expect(transformAt(v, S(9)).scale).toBe(2);
    expect(transformAt(v, S(2.9)).x).toBe(0);
    expect(transformAt(v, S(3)).x).toBe(0.5);
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'scale',
      t: S(1),
      value: 3,
      easing: 'ease',
    });
    expect(transformAt(item('v')!, S(2)).scale).toBe(3);
    expect(transformAt(item('v')!, S(2.5)).scale).toBeCloseTo(2.5);
    // Trimming the start keeps the animation on the same picture.
    run({ type: 'item.trim', sequenceId: 's', itemId: 'v', edge: 'start', time: S(2) });
    expect(transformAt(item('v')!, S(2)).scale).toBe(3);
  });

  it('removing the last keyframe keeps its value; a static edit replaces the animation', () => {
    const { run, item } = setup();
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'rotation',
      t: S(1),
      value: 30,
    });
    run({ type: 'keyframe.remove', sequenceId: 's', itemId: 'v', property: 'rotation', t: S(1) });
    expect(item('v')!.keyframes).toBeUndefined();
    expect(item('v')!.transform.rotation).toBe(30);
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'volume',
      t: S(0),
      value: 0,
    });
    run({
      type: 'keyframe.set',
      sequenceId: 's',
      itemId: 'v',
      property: 'volume',
      t: S(1),
      value: 1,
    });
    expect(volumeAt(item('v')!, S(1.5))).toBeCloseTo(0.5);
    run({ type: 'item.update', sequenceId: 's', itemId: 'v', volume: 0.8 });
    expect(item('v')!.keyframes).toBeUndefined();
    expect(volumeAt(item('v')!, S(1.5))).toBe(0.8);
  });
});
