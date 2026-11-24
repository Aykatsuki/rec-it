// Sentences, spoken hype and excerpts from word-timed transcripts (ported from Clipalytics).
import type { Sentence, Word } from './types';

/** Groups words into sentences at punctuation or pauses (≥ 0.7 s), capped at ~25 words. */
export function sentences(words: Word[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({
      start: cur[0]!.start,
      end: cur[cur.length - 1]!.end,
      text: cur.map((w) => w.text).join(' '),
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const prev = cur[cur.length - 1];
    if (prev && w.start - prev.end >= 0.7) flush();
    cur.push(w);
    if (/[.!?…]["')\]]?$/.test(w.text) || cur.length >= 25) flush();
  }
  flush();
  return out;
}

/** Spoken excitement typical of gaming and reaction content. Matched case-insensitively. */
export const SPOKEN_HYPE = [
  'no way',
  "let's go",
  'lets go',
  'let’s go',
  'oh my god',
  'oh my gosh',
  'omg',
  'what the',
  'holy',
  'clutch',
  'insane',
  'crazy',
  'unbelievable',
  'are you kidding',
  'oh no',
  'wtf',
  'headshot',
  'one tap',
  'ace',
  'gg',
  'we did it',
  'i did it',
  'yes yes',
  'no no no',
  'run',
  'help',
  'look at this',
  'watch this',
  'did you see',
  'bro',
  'dude',
  'yo',
  'sheesh',
  'oh',
  'wait',
  'what',
  'haha',
  'lmao',
  '[laughter]',
  '[laughs]',
  '[applause]',
  '[screaming]',
  '[cheering]',
];

// Very common words are weaker on their own.
const WEAK = new Set(['oh', 'wait', 'what', 'yo', 'bro', 'dude', 'run', 'help']);

export function hypeHits(words: Word[]): { t: number; phrase: string; weight: number }[] {
  const hits: { t: number; phrase: string; weight: number }[] = [];
  const lower = words.map((w) => w.text.toLowerCase().replace(/[^\p{L}\p{N}'’[\]]+/gu, ''));
  for (let i = 0; i < words.length; i++) {
    for (const phrase of SPOKEN_HYPE) {
      const parts = phrase.split(' ');
      let ok = true;
      for (let k = 0; k < parts.length; k++) {
        if (lower[i + k] !== parts[k]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      // Shouting in captions ("WHAT", "NO WAY!!") counts double.
      const raw = words
        .slice(i, i + parts.length)
        .map((w) => w.text)
        .join(' ');
      const loud = /[A-Z]{3,}/.test(raw) || /!{2,}/.test(raw);
      hits.push({
        t: words[i]!.start,
        phrase,
        weight: (WEAK.has(phrase) ? 0.35 : 1) * (loud ? 1.6 : 1),
      });
    }
  }
  return hits;
}

/** Words between two times, as text; long runs keep the opening and the ending. */
export function excerpt(words: Word[], start: number, end: number, maxWords: number): string {
  const inside = words.filter((w) => w.end > start && w.start < end).map((w) => w.text);
  if (inside.length <= maxWords) return inside.join(' ');
  const head = Math.ceil(maxWords * 0.65);
  const tail = maxWords - head;
  return `${inside.slice(0, head).join(' ')} … ${inside.slice(-tail).join(' ')}`;
}
