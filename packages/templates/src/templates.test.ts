import { describe, expect, it } from 'vitest';
import {
  History,
  emptyDocument,
  secondsToFlicks,
  FLICKS_PER_SECOND,
  type AssetLookup,
} from '@rec-it/core';
import {
  STORY_CAPTIONS,
  TAIL,
  fallbackScenes,
  normaliseScenes,
  randomStart,
  sceneCount,
  splitSentences,
  storyShort,
  talkingShot,
  characterPrompt,
  type StoryShortInput,
} from './index';

const s = (f: number) => f / FLICKS_PER_SECOND;
const lengths: Record<string, number | null> = { voice: 20, card: null, bg: 8, music: 120 };
const assets: AssetLookup = (id) =>
  id in lengths
    ? {
        kind: id === 'card' ? 'image' : id === 'voice' || id === 'music' ? 'audio' : 'video',
        duration: lengths[id] === null ? null : secondsToFlicks(lengths[id]!),
        hasAudio: id !== 'card',
        ...(id === 'card'
          ? { width: 960, height: 480 }
          : id === 'bg'
            ? { width: 1920, height: 1080 }
            : {}),
      }
    : undefined;

function input(over: Partial<StoryShortInput> = {}): StoryShortInput {
  const words = [];
  // Title words 0–3 s, story words from 3.5 s every 0.4 s.
  for (let i = 0; i < 6; i++) words.push({ text: `t${i}`, start: i * 0.5, end: i * 0.5 + 0.3 });
  for (let i = 0; i < 40; i++)
    words.push({ text: `w${i}`, start: 3.5 + i * 0.4, end: 3.8 + i * 0.4 });
  return {
    sequenceId: 'story1',
    name: 'Story',
    voice: { assetId: 'voice', duration: 20, words, titleEnd: 3 },
    card: { assetId: 'card' },
    background: { assetId: 'bg', duration: 8, start: 5 },
    music: { assetId: 'music', duration: 120, volume: 0.12 },
    captions: {},
    ids: { voice: 'v', card: 'c', background: (n) => `bg${n}`, music: 'm' },
    ...over,
  };
}

describe('story Short', () => {
  it('builds the whole Short as one undo step', () => {
    const h = new History(emptyDocument());
    const { command, length } = storyShort(input());
    h.execute(command, assets);
    const seq = h.doc.sequences[0]!;
    expect([seq.width, seq.height]).toEqual([1080, 1920]);
    expect(length).toBeCloseTo(20 + TAIL);
    const byTrack = Object.fromEntries(seq.tracks.map((t) => [t.name, t.items]));
    // Background: 3 s from 5 s, then the footage again from the start until the end.
    const bg = byTrack.V1!;
    expect(bg.map((i) => [s(i.start), s(i.sourceIn)])).toEqual([
      [0, 5],
      [3, 0],
      [11, 0],
      [19, 0],
    ]);
    expect(s(bg.at(-1)!.start + bg.at(-1)!.duration)).toBeCloseTo(length, 1);
    expect(bg.every((i) => i.muted)).toBe(true);
    // Card while the title is read, popping in.
    const card = byTrack.V2![0]!;
    expect(s(card.duration)).toBeCloseTo(3.25, 1);
    expect(card.keyframes?.scale?.map((k) => k.v)).toEqual([0.75, 0.9]);
    expect(card.fade?.in ?? 0).toBe(0);
    expect(byTrack.A1![0]!.assetId).toBe('voice');
    expect(byTrack.A2![0]!.volume).toBe(0.12);
    // Captions for the story only, in the story look.
    const caps = seq.tracks.find((t) => t.kind === 'caption')!.items;
    const words = caps.flatMap((c) => c.caption!.words.map((w) => w.text));
    expect(words[0]).toBe('w0');
    expect(words).toHaveLength(40);
    expect(seq.captions).toMatchObject(STORY_CAPTIONS);
    h.undo();
    expect(h.doc.sequences).toEqual([]);
  });

  it('captions the title too when there is no card', () => {
    const h = new History(emptyDocument());
    h.execute(storyShort(input({ card: undefined, music: undefined })).command, assets);
    const seq = h.doc.sequences[0]!;
    const caps = seq.tracks.find((t) => t.kind === 'caption')!.items;
    expect(caps[0]!.caption!.words[0]!.text).toBe('t0');
    expect(seq.tracks.find((t) => t.name === 'A2')!.items).toEqual([]);
  });

  it('refuses a background that is too short and picks a start with room', () => {
    expect(() =>
      storyShort(input({ background: { assetId: 'bg', duration: 0.2, start: 0 } })),
    ).toThrow(/too short/);
    expect(randomStart(600, 60, () => 0.5)).toBe(270);
    expect(randomStart(30, 60)).toBe(0);
  });
});

describe('scenes', () => {
  it('splits a script into sentences, breaking very long ones at commas', () => {
    const long = `${'word '.repeat(15).trim()}, ${'more '.repeat(15).trim()}, end.`;
    expect(splitSentences('First one. Second? *Third*! 🎉')).toEqual([
      'First one.',
      'Second?',
      'Third!',
    ]);
    expect(splitSentences(long).length).toBe(2);
  });

  it('cleans up an AI plan: order, full coverage, defaults', () => {
    const s = ['a.', 'b.', 'c.', 'd.', 'e.'];
    const scenes = normaliseScenes(
      [
        { from: 3, to: 4, picture: 'third' },
        { from: 1, to: 1, picture: 'first', motion: 'panLeft', palette: ['#000000', '#FFFFFF'] },
        { from: 2, to: 2, picture: 'dup of first', motion: 'zoomOut' },
        { from: 9, to: 2, picture: 'backwards' },
      ],
      s,
    );
    expect(scenes.map((x) => [x.from, x.to, x.picture])).toEqual([
      [0, 0, 'first'],
      [1, 1, 'dup of first'],
      [2, 4, 'third'],
    ]);
    expect(scenes[2]!.text).toBe('c. d. e.');
    expect(scenes[0]!.motion).toBe('panLeft');
    expect(scenes[2]!.palette).toHaveLength(3);
    // Nothing usable: fall back to grouping.
    expect(normaliseScenes([], s).length).toBe(3);
    expect(fallbackScenes(s, 2).map((x) => [x.from, x.to])).toEqual([
      [0, 1],
      [2, 4],
    ]);
    expect(sceneCount(60)).toBe(13);
  });

  it('animates one picture per scene with dissolves between them', () => {
    const h = new History(emptyDocument());
    const pics: Record<string, number | null> = { p1: null, p2: null, p3: null };
    const lookup: AssetLookup = (id) =>
      id in pics
        ? { kind: 'image', duration: null, hasAudio: false, width: 576, height: 1024 }
        : assets(id);
    const { command, length } = storyShort(
      input({
        card: undefined,
        music: undefined,
        background: {
          kind: 'scenes',
          scenes: [
            { assetId: 'p1', start: 0, end: 7, motion: 'zoomIn' },
            { assetId: 'p2', start: 7, end: 14, motion: 'panLeft' },
            { assetId: 'p3', start: 14, end: 20, motion: 'zoomOut' },
          ],
        },
      }),
    );
    h.execute(command, lookup);
    const v1 = h.doc.sequences[0]!.tracks.find((t) => t.name === 'V1')!.items;
    expect(v1.map((i) => [i.assetId, s(i.start)])).toEqual([
      ['p1', 0],
      ['p2', 7],
      ['p3', 14],
    ]);
    expect(s(v1[2]!.start + v1[2]!.duration)).toBeCloseTo(length, 1);
    expect(v1[0]!.keyframes?.scale?.map((k) => k.v)).toEqual([1, 1.14]);
    expect(v1[1]!.transform.scale).toBe(1.14);
    expect(v1[1]!.keyframes?.x?.map((k) => k.v)).toEqual([0.06, -0.06]);
    expect(v1[2]!.keyframes?.scale?.map((k) => k.v)).toEqual([1.14, 1]);
    expect(v1[1]!.transitionIn?.kind).toBe('dissolve');
    expect(v1[0]!.transitionIn).toBeUndefined();
  });

  it('joins scenes with awkward voice timings exactly; a too-short scene gives way to the next', () => {
    const h = new History(emptyDocument());
    const lookup: AssetLookup = (id) =>
      id.startsWith('p')
        ? { kind: 'image', duration: null, hasAudio: false, width: 576, height: 1024 }
        : assets(id);
    // Times like the voice produces: not on frame boundaries, and one scene only 0.2 s long.
    const starts = [0, 3.0167, 6.4917, 6.6917, 10.3375, 14.8042, 17.0209];
    const { command } = storyShort(
      input({
        card: undefined,
        music: undefined,
        background: {
          kind: 'scenes',
          scenes: starts.map((start, i) => ({
            assetId: `p${i}`,
            start,
            end: starts[i + 1] ?? 20,
            motion: i % 2 ? 'panRight' : 'zoomIn',
          })),
        },
      }),
    );
    h.execute(command, lookup); // threw "A transition needs another clip ending right where…"
    const v1 = h.doc.sequences[0]!.tracks.find((t) => t.name === 'V1')!.items;
    expect(v1.map((i) => i.assetId)).toEqual(['p0', 'p1', 'p3', 'p4', 'p5', 'p6']);
    for (let i = 1; i < v1.length; i++) {
      expect(v1[i]!.start).toBe(v1[i - 1]!.start + v1[i - 1]!.duration);
      expect(v1[i]!.transitionIn?.kind).toBe('dissolve');
    }
  });
  it('always joins scene clips exactly, whatever the voice timings', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const lookup: AssetLookup = (id) =>
      id.startsWith('p')
        ? { kind: 'image', duration: null, hasAudio: false, width: 576, height: 1024 }
        : assets(id);
    for (let run = 0; run < 300; run++) {
      const starts = [0];
      while (starts.length < 12) starts.push(starts[starts.length - 1]! + 0.05 + rand() * 3);
      const length = starts[starts.length - 1]! + 0.5 + rand() * 3;
      const h = new History(emptyDocument());
      const { command } = storyShort(
        input({
          card: undefined,
          music: undefined,
          voice: { assetId: 'voice', duration: length - TAIL, words: [], titleEnd: 0 },
          background: {
            kind: 'scenes',
            scenes: starts.map((start, i) => ({
              assetId: `p${i}`,
              start,
              end: starts[i + 1] ?? length,
              motion: 'zoomIn',
            })),
          },
        }),
      );
      lengths.voice = length;
      h.execute(command, lookup);
      const v1 = h.doc.sequences[0]!.tracks.find((t) => t.name === 'V1')!.items;
      for (let i = 1; i < v1.length; i++)
        expect(v1[i]!.start).toBe(v1[i - 1]!.start + v1[i - 1]!.duration);
    }
    lengths.voice = 20;
  });
});

describe('talking shot', () => {
  it('puts the character clip over the voice in a 9:16 sequence', () => {
    const h = new History(emptyDocument());
    const lookup: AssetLookup = (id) =>
      id === 'clip'
        ? {
            kind: 'video',
            duration: secondsToFlicks(2.5625),
            hasAudio: false,
            width: 480,
            height: 832,
          }
        : id === 'line'
          ? { kind: 'audio', duration: secondsToFlicks(2.4), hasAudio: true }
          : undefined;
    h.execute(
      talkingShot({
        sequenceId: 'talk1',
        name: 'Fox test',
        video: { assetId: 'clip', duration: 2.5625 },
        voice: { assetId: 'line', duration: 2.4 },
        ids: { video: 'v', voice: 'a' },
      }),
      lookup,
    );
    const seq = h.doc.sequences[0]!;
    expect([seq.width, seq.height]).toEqual([1080, 1920]);
    const v1 = seq.tracks.find((t) => t.name === 'V1')!.items;
    const a1 = seq.tracks.find((t) => t.name === 'A1')!.items;
    expect(v1.map((i) => [i.assetId, i.start, i.transform.fit])).toEqual([['clip', 0, 'fill']]);
    expect(a1.map((i) => [i.assetId, s(i.duration)])).toEqual([['line', 2.4]]);
    expect(characterPrompt(' a fox ')).toMatch(/^a fox, Pixar-style 3D/);
  });
});
