import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTIONS,
  FRAME_RATES,
  History,
  emptyDocument,
  secondsToFlicks,
  type Command,
} from '@rec-it/core';
import {
  assColour,
  assTime,
  compileAss,
  generateCaptions,
  segmentCaptions,
  sequenceCaptionsAss,
  type CaptionWord,
} from './index';

const say = (text: string, start = 0, gap = 0.1, len = 0.3): CaptionWord[] => {
  let t = start;
  return text.split(' ').map((w) => {
    const word = { text: w, start: t, end: t + len };
    t += len + gap;
    return word;
  });
};

describe('caption segmentation', () => {
  it('fills lines up to the word limit and balances them', () => {
    const caps = segmentCaptions(say('one two three four five six seven'), {
      wordsPerLine: 3,
      lines: 2,
    });
    expect(caps.map((c) => c.lines.map((l) => l.words.map((w) => w.text).join(' ')))).toEqual([
      ['one two three', 'four five six'],
      ['seven'],
    ]);
  });

  it('breaks at sentence ends and pauses, and holds until the next caption', () => {
    const words = [...say('Hello there. How are'), ...say('you', 3)];
    const caps = segmentCaptions(words, { wordsPerLine: 4, lines: 2 });
    expect(caps.map((c) => c.lines.flatMap((l) => l.words).length)).toEqual([2, 2, 1]);
    // "How are" ends at 1.5 s; held 0.5 s (the next caption starts at 3 s).
    expect(caps[1]!.end).toBeCloseTo(2.0, 6);
    expect(caps[0]!.end).toBeCloseTo(caps[1]!.start, 6);
  });

  it('never keeps one caption up for more than four seconds', () => {
    const caps = segmentCaptions(say('a b c d e f', 0, 0.5, 0.4), { wordsPerLine: 8, lines: 2 });
    for (const c of caps) {
      const all = c.lines.flatMap((l) => l.words);
      expect(all.at(-1)!.end - all[0]!.start).toBeLessThanOrEqual(4);
    }
    expect(caps.length).toBeGreaterThan(1);
  });
});

describe('ASS output', () => {
  it('formats colours and times', () => {
    expect(assColour('#FFE600')).toBe('&H0000E6FF');
    expect(assColour('#000000B3')).toBe('&H4C000000');
    expect(assTime(3723.456)).toBe('1:02:03.46');
  });

  it('highlights each word in turn with exactly contiguous events', () => {
    const ass = compileAss(say('hi there {x}'), DEFAULT_CAPTIONS, { width: 1080, height: 1920 });
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(events).toHaveLength(3);
    expect(events[0]).toContain('{\\c&H0000E6FF}hi{\\c&H00FFFFFF} there x');
    expect(events[2]).toContain('hi there {\\c&H0000E6FF}x');
    // Each event ends where the next begins.
    const times = events.map((e) => e.split(',').slice(1, 3));
    expect(times[0]![1]).toBe(times[1]![0]);
    expect(ass).toContain('\\an5\\pos(540,1306)');
  });

  it('matches the snapshot for every style', () => {
    const words = say('Rec-It makes Shorts. Captions follow the words!');
    for (const style of ['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas'] as const)
      expect(
        compileAss(words, { ...DEFAULT_CAPTIONS, style }, { width: 1080, height: 1920 }),
      ).toMatchSnapshot(style);
  });
});

describe('caption clips', () => {
  const S = secondsToFlicks;
  const build = () => {
    const h = new History(emptyDocument());
    const lookup = (id: string) =>
      id === 'clip'
        ? { kind: 'video' as const, duration: S(10), hasAudio: true, width: 1920, height: 1080 }
        : undefined;
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
    run({ type: 'item.add', sequenceId: 's', trackId: v1, assetId: 'clip', start: 0 });
    // Transcript: "w1 w2 … w8", one word every 0.5 s.
    const transcript = say('w1 w2 w3 w4 w5 w6 w7 w8', 0.1, 0.1, 0.4);
    const captions = generateCaptions(
      h.doc.sequences[0]!,
      (id) => (id === 'clip' ? transcript : undefined),
      undefined,
    );
    run({ type: 'captions.generate', sequenceId: 's', captions });
    return { h, run, seq: () => h.doc.sequences[0]! };
  };

  it('generates one clip per caption from the transcript', () => {
    const { seq } = build();
    const track = seq().tracks[0]!;
    expect(track.kind).toBe('caption');
    expect(track.items.map((i) => i.caption!.words.map((w) => w.text).join(' '))).toEqual([
      'w1 w2 w3 w4 w5 w6',
      'w7 w8',
    ]);
  });

  it('draws each clip where it was moved, sized and turned, and only its visible words', () => {
    const { run, seq } = build();
    const [first, second] = seq().tracks[0]!.items.map((i) => i.id);
    run({
      type: 'item.update',
      sequenceId: 's',
      itemId: first!,
      transform: { x: 0.1, y: -0.2, scale: 1.5, rotation: 10 },
    });
    run({ type: 'item.trim', sequenceId: 's', itemId: second!, edge: 'start', time: S(3.5) });
    const ass = sequenceCaptionsAss(seq())!;
    const events = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    // 540 + 0.1 × 1080, 1306 − 0.2 × 1920; scale 150 %; angle −10° in ASS terms.
    expect(events[0]).toContain('{\\an5\\pos(648,922)\\fscx150\\fscy150\\frz-10}');
    // The trimmed clip starts at 3.5 s and shows "w8" only.
    const last = events.at(-1)!;
    expect(last).toContain('0:00:03.50');
    expect(last).not.toContain('w7');
    expect(last).toContain('w8');
  });

  it('leaves hidden caption tracks out, and caption text edits show up', () => {
    const { run, seq } = build();
    const track = seq().tracks[0]!;
    run({ type: 'caption.edit', sequenceId: 's', itemId: track.items[1]!.id, text: 'the end' });
    expect(sequenceCaptionsAss(seq())).toMatch(/the.* end/);
    run({ type: 'track.update', sequenceId: 's', trackId: track.id, hidden: true });
    expect(sequenceCaptionsAss(seq())).toBeNull();
  });
});
