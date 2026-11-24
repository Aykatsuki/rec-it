// Finds the clippable moments: peaks of the interest curve, grown into clips of a good length
// that start and end on clean boundaries (sentence ends, pauses, scene cuts).
import type { Moment, Reason, Sentence, Word } from './types';
import type { Components } from './signals';
import { clamp, clock, max, mean, percentile, round1 } from './series';
import { excerpt } from './transcript';

export interface MomentOptions {
  minLen: number;
  maxLen: number;
  targetLen: number;
  /** How many moments to keep (best first). */
  keep: number;
}

interface Window {
  start: number;
  end: number;
  peak: number;
}

/** Local maxima, strongest first, at least `gap` seconds apart. */
export function findPeaks(curve: ArrayLike<number>, gap: number, limit: number): number[] {
  const n = curve.length;
  const floor = Math.max(0.12, percentile(curve, 0.7));
  const cands: number[] = [];
  for (let i = 0; i < n; i++) {
    const v = curve[i]!;
    if (v < floor) continue;
    const l = i > 0 ? curve[i - 1]! : -1;
    const r = i < n - 1 ? curve[i + 1]! : -1;
    if (v >= l && v > r) cands.push(i);
  }
  cands.sort((a, b) => curve[b]! - curve[a]!);
  const picked: number[] = [];
  for (const i of cands) {
    if (picked.every((p) => Math.abs(p - i) >= gap)) picked.push(i);
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * The clip around a peak that collects the most "above-threshold" interest, with a setup before
 * the peak and room for the reaction after it, within the length limits.
 */
export function growWindow(curve: ArrayLike<number>, peak: number, o: MomentOptions): Window {
  const n = curve.length;
  const pv = curve[peak] ?? 0;
  const tau = Math.max(percentile(curve, 0.6), 0.45 * pv);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + (curve[i]! - tau);
  const minLen = Math.min(o.minLen, n);
  const maxLen = Math.min(o.maxLen, n);
  let best: Window = {
    start: Math.max(0, Math.min(n - minLen, peak - Math.round(o.targetLen * 0.65))),
    end: 0,
    peak,
  };
  best.end = Math.min(n, best.start + Math.max(minLen, Math.min(o.targetLen, maxLen)));
  let bestScore = -Infinity;
  const setup = (len: number) => Math.min(8, len * 0.3);
  for (let s = Math.max(0, peak - maxLen); s <= peak; s++) {
    for (let e = Math.max(peak + 3, s + minLen); e <= Math.min(n, s + maxLen); e++) {
      const len = e - s;
      if (peak - s < setup(len)) continue;
      // Slight pull towards the target length so clips do not all hit the limits.
      const score = prefix[e]! - prefix[s]! - 0.004 * Math.abs(len - o.targetLen) * (pv + 0.1) * 10;
      if (score > bestScore) {
        bestScore = score;
        best = { start: s, end: e, peak };
      }
    }
  }
  return best;
}

/** Moves the edges to nearby sentence boundaries, pauses or scene cuts. */
export function snapWindow(
  w: Window,
  sentencesList: Sentence[],
  words: Word[],
  cuts: number[],
  o: MomentOptions,
  duration: number,
): Window {
  const pick = (t: number, options: number[], lo: number, hi: number) => {
    const inRange = options.filter((x) => x >= t - lo && x <= t + hi);
    if (!inRange.length) return t;
    return inRange.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
  };
  // Start: a scene cut is the cleanest; else the start of a sentence; else a pause between words.
  const pauses: number[] = [];
  for (let i = 1; i < words.length; i++)
    if (words[i]!.start - words[i - 1]!.end >= 0.35) pauses.push(words[i]!.start - 0.1);
  let start = pick(w.start, cuts, 1.5, 1.5);
  if (start === w.start)
    start = pick(
      w.start,
      sentencesList.map((s) => s.start - 0.15),
      4,
      2,
    );
  if (start === w.start) start = pick(w.start, pauses, 3, 2);
  // End: just after a sentence finishes, or at a pause.
  const ends: number[] = sentencesList.map((s) => s.end + 0.35);
  let end = pick(w.end, ends, 2, 4);
  if (end === w.end)
    end = pick(
      w.end,
      pauses.map((p) => p + 0.05),
      2,
      3,
    );
  start = Math.max(0, start);
  end = Math.min(duration, end);
  const len = end - start;
  if (len < o.minLen - 0.5 || len > o.maxLen + 0.5 || start > w.peak || end < w.peak)
    return { start: w.start, end: Math.min(duration, w.end), peak: w.peak };
  return { start, end, peak: w.peak };
}

const overlap = (a: Window, b: Window) => {
  const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return inter / Math.min(a.end - a.start, b.end - b.start);
};

export function reasonsFor(
  c: Components,
  w: Window,
): { reasons: Reason[]; strength: Record<string, number> } {
  const lo = Math.floor(w.start);
  const hi = Math.ceil(w.end);
  const reasons: { r: Reason; s: number }[] = [];
  const strength: Record<string, number> = {};
  const p = c.parts;
  if (p.audio && c.loudDb) {
    const v = max(p.audio, lo, hi);
    strength.audio = v;
    const rise = max(c.loudDb, lo, hi) - (c.loudBaseDb ?? 0);
    if (v >= 0.4)
      reasons.push({
        r: { signal: 'audio', text: `Loud reaction (+${Math.round(rise)} dB)` },
        s: v,
      });
  }
  if (p.motion) {
    const v = max(p.motion, lo, hi);
    strength.motion = v;
    if (v >= 0.5)
      reasons.push({ r: { signal: 'motion', text: 'Fast action on screen' }, s: v * 0.8 });
  }
  if (p.speech) {
    const v = max(p.speech, lo, hi);
    strength.speech = v;
    const phrases = [
      ...new Set(
        c.hype.filter((h) => h.t >= w.start && h.t <= w.end && h.weight >= 1).map((h) => h.phrase),
      ),
    ].slice(0, 3);
    if (phrases.length)
      reasons.push({
        r: { signal: 'speech', text: `Says ${phrases.map((x) => `“${x}”`).join(', ')}` },
        s: v,
      });
  }
  reasons.sort((a, b) => b.s - a.s);
  return { reasons: reasons.map((x) => x.r), strength };
}

export function findMoments(
  curve: Float64Array,
  c: Components,
  words: Word[],
  sentenceList: Sentence[],
  o: MomentOptions,
): Moment[] {
  const n = curve.length;
  if (n < Math.max(5, o.minLen * 0.6)) return [];
  const opts = { ...o, minLen: Math.min(o.minLen, n), maxLen: Math.min(o.maxLen, n) };
  const peaks = findPeaks(curve, Math.max(12, opts.minLen * 0.8), o.keep * 4);
  const windows: Window[] = [];
  for (const pk of peaks) {
    const w = snapWindow(growWindow(curve, pk, opts), sentenceList, words, c.sceneCuts, opts, n);
    if (windows.some((x) => overlap(x, w) > 0.35)) continue;
    windows.push(w);
    if (windows.length >= o.keep) break;
  }
  const moments: Moment[] = windows.map((w, idx) => {
    const lo = Math.floor(w.start);
    const hi = Math.ceil(w.end);
    const pv = max(curve, lo, hi);
    const mv = mean(curve, lo, hi);
    const local = round1(10 * Math.pow(clamp(0.6 * pv + 0.4 * Math.min(1, mv * 1.6)), 0.75));
    const { reasons } = reasonsFor(c, w);
    const hypeWords = [
      ...new Set(
        c.hype.filter((h) => h.t >= w.start && h.t <= w.end && h.weight >= 1).map((h) => h.phrase),
      ),
    ];
    const text = excerpt(words, w.start, w.end, 120);
    return {
      id: `m${idx + 1}`,
      start: round1(w.start),
      end: round1(w.end),
      peak: w.peak,
      localScore: local,
      score: local,
      rank: 0,
      reasons,
      excerpt: text,
      hypeWords,
      autoTitle: autoTitle(reasons, hypeWords, w.peak),
    };
  });
  return rank(moments);
}

export function autoTitle(reasons: Reason[], hype: string[], peak: number): string {
  const first = hype[0];
  if (first) return `“${first.replace(/^\w/, (x) => x.toUpperCase())}” moment at ${clock(peak)}`;
  const r = reasons[0];
  if (!r) return `Moment at ${clock(peak)}`;
  const kind: Record<string, string> = {
    audio: 'Big reaction',
    motion: 'Action burst',
    speech: 'Reaction',
    words: 'Moment',
  };
  return `${kind[r.signal] ?? 'Moment'} at ${clock(peak)}`;
}

/** Sorts by score (ties: earlier first) and numbers the ranks. */
export function rank(moments: Moment[]): Moment[] {
  const sorted = [...moments].sort((a, b) => b.score - a.score || a.start - b.start);
  sorted.forEach((m, i) => (m.rank = i + 1));
  return sorted;
}

/** 0..10 for the whole video: mostly its best three moments. */
export function clippability(moments: Moment[]): number {
  if (!moments.length) return 0;
  const s = moments.map((m) => m.score).sort((a, b) => b - a);
  const top = s.slice(0, 3);
  const avg = top.reduce((a, b) => a + b, 0) / 3; // missing moments count as 0
  const depth = s.filter((x) => x >= 6).length;
  return round1(Math.min(10, avg * 0.9 + Math.min(1, depth * 0.15)));
}
