import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFlicks as S } from '../time';
import { History } from './history';
import { emptyDocument, type Sequence } from './model';
import type { Command } from './commands';
import { cutWordsCommands, sequenceWords, wordAt, type TranscriptWord } from './transcript';

// "word1" at 0.1–0.5 s, "word2" at 0.6–1.0 s, ... (the sidecar's fake engine produces the same).
const WORDS: TranscriptWord[] = Array.from({ length: 16 }, (_, i) => ({
  text: `word${i + 1}`,
  start: 0.1 + i * 0.5,
  end: 0.5 + i * 0.5,
}));
const wordsOf = (id: string) => (id === 'clip' ? WORDS : undefined);
const lookup = () => ({
  kind: 'video' as const,
  duration: S(8),
  hasAudio: true,
  width: 1920,
  height: 1080,
});

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
  const [v1, a1] = [seq().tracks[1]!.id, seq().tracks[2]!.id];
  // Source 1–5 s placed at 2 s, with its sound detached and linked.
  for (const [id, trackId] of [
    ['v', v1],
    ['a', a1],
  ] as const)
    run({
      type: 'item.add',
      sequenceId: 's',
      trackId,
      assetId: 'clip',
      id,
      start: S(2),
      sourceIn: S(1),
      duration: S(4),
    } as Command);
  run({ type: 'item.link', sequenceId: 's', itemIds: ['v', 'a'] });
  return { h, run, seq };
}

describe('text-based editing', () => {
  it('lists the words a sequence plays, once per linked pair, in timeline seconds', () => {
    const { seq } = setup();
    const words = sequenceWords(seq(), wordsOf);
    // Source 1–5 s holds word3 (1.1–1.5) … word10 (4.6–5.0).
    expect(words.map((w) => w.text)).toEqual([
      'word3',
      'word4',
      'word5',
      'word6',
      'word7',
      'word8',
      'word9',
      'word10',
    ]);
    expect(words[0]!.start).toBeCloseTo(2.1, 6);
    expect(wordAt(words, 2.7)?.text).toBe('word4');
    expect(wordAt(words, 2.55)).toBeUndefined();
  });

  it('cuts selected words with the pause after them and closes the gap', () => {
    const { run, seq, h } = setup();
    const words = sequenceWords(seq(), wordsOf);
    const pick = new Set(
      words.filter((w) => ['word4', 'word5', 'word8'].includes(w.text)).map((w) => w.key),
    );
    const commands = cutWordsCommands(seq(), words, pick, wordsOf);
    expect(commands).toHaveLength(2);
    run({ type: 'batch', commands });
    const after = sequenceWords(seq(), wordsOf).map((w) => w.text);
    expect(after).toEqual(['word3', 'word6', 'word7', 'word9', 'word10']);
    // 2 × 0.5 s for word4+5 and 0.5 s for word8 are gone: 4 s → 2.5 s, on both tracks.
    const ends = seq()
      .tracks.filter((t) => t.items.length)
      .map((t) => Math.max(...t.items.map((i) => i.start + i.duration)));
    expect(ends.map((e) => Math.round((e / S(1)) * 1000) / 1000)).toEqual([4.5, 4.5]);
    h.undo();
    expect(sequenceWords(seq(), wordsOf)).toHaveLength(8);
  });
});
