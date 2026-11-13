import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import type { Command } from './commands';
import { checkInvariants } from './commands';
import { History } from './history';
import { emptyDocument, itemEnd, type Sequence } from './model';

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
  const seq = () => h.doc.sequences[0]! as Sequence;
  const w = (text: string, a: number, b: number) => ({ text, start: S(a), end: S(b) });
  run({
    type: 'captions.generate',
    sequenceId: 's',
    captions: [
      { start: S(1), duration: S(1.5), words: [w('hello', 1, 1.4), w('there', 1.5, 2.2)] },
      { start: S(2.5), duration: S(1), words: [w('big', 2.5, 2.8), w('world', 2.9, 3.4)] },
    ],
  });
  const track = () => seq().tracks[0]!;
  return { h, run, seq, track, w };
}

describe('caption tracks', () => {
  it('generates caption clips on a new caption track above the video', () => {
    const { seq, track } = setup();
    expect(seq().tracks.map((t) => `${t.name}:${t.kind}`)).toEqual([
      'C1:caption',
      'V2:video',
      'V1:video',
      'A1:audio',
      'A2:audio',
    ]);
    expect(track().items.map((i) => [i.start, i.duration])).toEqual([
      [S(1), S(1.5)],
      [S(2.5), S(1)],
    ]);
    // Word times are relative to the clip, so moving the clip moves its words.
    expect(track().items[0]!.caption!.words[1]).toEqual({
      text: 'there',
      start: S(0.5),
      end: S(1.2),
    });
    expect(seq().captions?.enabled).toBe(true);
    checkInvariants({ ...emptyDocument(), sequences: [seq()] });
  });

  it('edits text, keeping word timing when the count matches', () => {
    const { run, track } = setup();
    const id = track().items[0]!.id;
    run({ type: 'caption.edit', sequenceId: 's', itemId: id, text: 'Hello  everyone' });
    expect(track().items[0]!.caption!.words.map((x) => [x.text, x.start])).toEqual([
      ['Hello', 0],
      ['everyone', S(0.5)],
    ]);
    run({ type: 'caption.edit', sequenceId: 's', itemId: id, text: 'one two three' });
    const words = track().items[0]!.caption!.words;
    expect(words.map((x) => x.text)).toEqual(['one', 'two', 'three']);
    expect(words[0]!.start).toBe(0);
    expect(words[2]!.end).toBe(S(1.2));
    expect(() => run({ type: 'caption.edit', sequenceId: 's', itemId: id, text: '  ' })).toThrow(
      /needs some text/,
    );
  });

  it('moves, trims and splits like any clip, but stays on caption tracks', () => {
    const { run, seq, track } = setup();
    const [a, b] = track().items.map((i) => i.id);
    const v1 = seq().tracks.find((t) => t.name === 'V1')!.id;
    run({ type: 'item.move', sequenceId: 's', itemId: b!, trackId: track().id, start: S(5) });
    expect(track().items[1]!.start).toBe(S(5));
    run({ type: 'item.trim', sequenceId: 's', itemId: a!, edge: 'start', time: S(1.5) });
    expect(track().items[0]!.sourceIn).toBe(S(0.5));
    run({ type: 'item.split', sequenceId: 's', time: S(5.5), itemIds: [b!] });
    expect(track().items).toHaveLength(3);
    expect(track().items[2]!.caption!.words).toHaveLength(2);
    expect(track().items[2]!.sourceIn).toBe(S(0.5));
    expect(() =>
      run({ type: 'item.move', sequenceId: 's', itemId: a!, trackId: v1, start: S(0) }),
    ).toThrow(/stay on caption tracks/);
    expect(() =>
      run({ type: 'keyframe.set', sequenceId: 's', itemId: a!, property: 'x', t: 0, value: 0.1 }),
    ).toThrow(/animated/);
    run({ type: 'item.update', sequenceId: 's', itemId: a!, transform: { y: -0.2, scale: 1.5 } });
    expect(track().items[0]!.transform).toMatchObject({ y: -0.2, scale: 1.5 });
  });

  it('adds a caption by hand, replaces on regenerate, and can be removed entirely', () => {
    const { run, seq, track, w, h } = setup();
    run({
      type: 'caption.add',
      sequenceId: 's',
      trackId: track().id,
      start: S(6),
      duration: S(2),
      text: 'My own words',
    });
    const own = track().items.at(-1)!;
    expect(own.caption!.words.map((x) => x.text)).toEqual(['My', 'own', 'words']);
    expect(itemEnd(own)).toBe(S(8));
    run({
      type: 'captions.generate',
      sequenceId: 's',
      captions: [{ start: S(0), duration: S(1), words: [w('again', 0.1, 0.5)] }],
    });
    expect(track().items).toHaveLength(1);
    run({ type: 'track.remove', sequenceId: 's', trackId: track().id });
    expect(seq().tracks.some((t) => t.kind === 'caption')).toBe(false);
    h.undo();
    expect(track().kind).toBe('caption');
  });

  it('refuses media on caption tracks', () => {
    const { run, track } = setup();
    expect(() =>
      run({ type: 'item.add', sequenceId: 's', trackId: track().id, assetId: 'clip', start: 0 }),
    ).toThrow(/Only captions/);
  });
});
