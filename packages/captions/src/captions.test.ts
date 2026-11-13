import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPTIONS } from '@rec-it/core';
import { assColour, assTime, compileAss, segmentCaptions, type CaptionWord } from './index';

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
