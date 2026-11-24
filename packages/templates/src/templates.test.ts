import { describe, expect, it } from 'vitest';
import {
  History,
  emptyDocument,
  secondsToFlicks,
  FLICKS_PER_SECOND,
  type AssetLookup,
} from '@rec-it/core';
import { STORY_CAPTIONS, TAIL, randomStart, storyShort, type StoryShortInput } from './index';

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
