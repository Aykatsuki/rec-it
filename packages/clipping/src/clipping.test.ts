// Ported from Clipalytics' engine tests, with Rec-It's local signals (loudness, action, speech).
import { describe, expect, it } from 'vitest';
import { analyze } from './analyze';
import { findPeaks, growWindow } from './moments';
import { applyScores, resultsBrief, scoringBundle, submitSchema } from './scoring';
import { hypeHits, sentences } from './transcript';
import type { Word } from './types';

const DUR = 900;

/** A fake 15-minute gameplay video with three planted moments. */
function fakeSignals() {
  // Audio: steady commentary with a scream at 120–124 s.
  const rms: number[] = [];
  for (let i = 0; i < DUR * 4; i++) {
    const t = i / 4;
    rms.push((t >= 120 && t < 124 ? 0.6 : 0.05) * (1 + 0.2 * Math.sin(i * 1.7)));
  }
  // Words every 0.5 s, a sentence end every 8 words; "NO WAY" at 121 s and a burst of hype
  // ("let's go", "oh my god") around 300 s.
  const words: Word[] = [];
  const planted: Record<string, string> = {
    '121': 'NO',
    '121.5': 'WAY!!',
    '299': "LET'S",
    '299.5': 'GO!!',
    '300.5': 'OH',
    '301': 'MY',
    '301.5': 'GOD!!',
    '303': 'insane',
  };
  for (let t = 1, k = 0; t < DUR - 1; t += 0.5, k++) {
    const text = planted[String(t)] ?? (k % 8 === 7 ? 'okay.' : 'word');
    words.push({ text, start: t, end: t + 0.4 });
  }
  // Action: calm picture with fast action at 598–606 s, and one scene cut at 450 s.
  const motion: number[] = [];
  for (let i = 0; i < DUR * 4; i++) {
    const t = i / 4;
    motion.push(t === 450 ? 90 : (t >= 598 && t < 606 ? 30 : 3) + (i % 3));
  }
  return { rms, words, motion };
}

function run(keep = 8) {
  const s = fakeSignals();
  return analyze({
    id: 'a1',
    source: { assetId: 'asset_1', title: 'Test stream', durationSec: DUR },
    raw: {
      durationSec: DUR,
      audioRms: { step: 0.25, values: s.rms },
      motion: { step: 0.25, values: s.motion },
      words: s.words,
    },
    minLen: 15,
    maxLen: 60,
    targetLen: 35,
    keep,
    now: '2026-11-24T00:00:00.000Z',
  });
}

describe('analyze', () => {
  it('finds the three planted moments at the top', () => {
    const a = run();
    expect([...a.signals].sort()).toEqual(['audio', 'motion', 'speech']);
    const top3 = a.moments.slice(0, 3);
    const covers = (t: number) => top3.some((m) => m.start <= t && m.end >= t);
    expect(covers(122)).toBe(true);
    expect(covers(300)).toBe(true);
    expect(covers(602)).toBe(true);
    for (const m of a.moments) {
      expect(m.end - m.start).toBeGreaterThanOrEqual(14.5);
      expect(m.end - m.start).toBeLessThanOrEqual(60.5);
      expect(m.localScore).toBeGreaterThanOrEqual(0);
      expect(m.localScore).toBeLessThanOrEqual(10);
    }
    expect(a.clippability).toBeGreaterThan(3);
    expect(a.curve.length).toBeLessThanOrEqual(600);
  });

  it('gives each planted moment the right reasons', () => {
    const a = run();
    const at = (t: number) => a.moments.find((m) => m.start <= t && m.end >= t)!;
    expect(at(122).reasons.map((r) => r.signal)).toContain('audio');
    expect(at(122).hypeWords).toContain('no way');
    expect(at(300).reasons.map((r) => r.signal)).toContain('speech');
    expect(at(300).hypeWords).toEqual(expect.arrayContaining(["let's go", 'oh my god']));
    expect(at(602).reasons.map((r) => r.signal)).toContain('motion');
  });

  it('does not count a scene cut as action', () => {
    const a = run(12);
    const cut = a.moments.find((m) => m.peak >= 448 && m.peak <= 452);
    expect(cut?.reasons.some((r) => r.signal === 'motion')).toBeFalsy();
  });

  it('does not let clips overlap much', () => {
    const a = run(12);
    for (const x of a.moments)
      for (const y of a.moments) {
        if (x === y) continue;
        const inter = Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
        expect(inter / Math.min(x.end - x.start, y.end - y.start)).toBeLessThanOrEqual(0.36);
      }
  });

  it('works with loudness alone (no transcript yet)', () => {
    const s = fakeSignals();
    const a = analyze({
      id: 'q',
      source: { assetId: 'x', title: 't', durationSec: DUR },
      raw: { durationSec: DUR, audioRms: { step: 0.25, values: s.rms } },
      minLen: 15,
      maxLen: 60,
      targetLen: 35,
      keep: 5,
    });
    expect(a.signals).toEqual(['audio']);
    expect(a.moments[0]!.start).toBeLessThanOrEqual(122);
    expect(a.moments[0]!.end).toBeGreaterThanOrEqual(122);
  });

  it('copes with no signals and very short videos', () => {
    const a = analyze({
      id: 'e',
      source: { assetId: 'x', title: 't', durationSec: 8 },
      raw: { durationSec: 8 },
      minLen: 15,
      maxLen: 60,
      targetLen: 35,
      keep: 5,
    });
    expect(a.moments).toEqual([]);
    expect(a.clippability).toBe(0);
  });
});

describe('peaks and windows', () => {
  it('keeps peaks apart', () => {
    const c = new Float64Array(200);
    c[50] = 1;
    c[55] = 0.9;
    c[150] = 0.8;
    expect(findPeaks(c, 20, 5)).toEqual([50, 150]);
  });
  it('puts setup before the peak and reaction after', () => {
    const c = new Float64Array(300).fill(0.1);
    for (let i = 100; i < 140; i++) c[i] = 0.8;
    const w = growWindow(c, 130, { minLen: 15, maxLen: 60, targetLen: 35, keep: 5 });
    expect(w.start).toBeLessThan(130 - 5);
    expect(w.end).toBeGreaterThanOrEqual(133);
    expect(w.end - w.start).toBeGreaterThanOrEqual(15);
    expect(w.end - w.start).toBeLessThanOrEqual(60);
  });
});

describe('AI scoring', () => {
  it('keeps the bundle small', () => {
    const a = run(10);
    const text = scoringBundle(a, 10);
    // ~4 characters per token: the whole request stays around 2K tokens.
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain('analysis_id=a1');
    expect(text.split('\n').filter((l) => /^m\d+ /.test(l))).toHaveLength(a.moments.length);
  });

  it('applies scores, re-ranks and allows only small trims', () => {
    const a = run(5);
    const last = a.moments[a.moments.length - 1]!;
    const { analysis, applied, ignored } = applyScores(
      a,
      submitSchema.parse({
        analysis_id: a.id,
        video_summary: 'Great clutch moments.',
        scores: [
          {
            id: last.id,
            hook: 10,
            payoff: 10,
            standalone: 10,
            clarity: 10,
            title: 'Best one',
            reason: 'x',
            start: last.start + 2,
            end: last.end + 50,
          },
          { id: 'nope', hook: 1, payoff: 1, standalone: 1, clarity: 1, title: 't', reason: 'r' },
        ],
      }),
    );
    expect(applied).toBe(1);
    expect(ignored).toEqual(['nope']);
    const m = analysis.moments.find((x) => x.id === last.id)!;
    expect(m.start).toBe(last.start + 2);
    expect(m.end).toBe(last.end); // +50 s refused
    expect(m.ai?.title).toBe('Best one');
    expect(m.score).toBeCloseTo(0.6 * 10 + 0.4 * last.localScore, 1);
    expect(analysis.moments.map((x) => x.rank)).toEqual(analysis.moments.map((_, i) => i + 1));
    expect(analysis.aiScoredAt).toBeTruthy();
    const brief = resultsBrief(analysis, 5);
    expect(brief.top.map((t) => t.title)).toContain('Best one');
    expect(brief.summary).toContain('Great clutch');
  });
});

describe('transcripts', () => {
  it('makes sentences and spots hype', () => {
    const words: Word[] = [
      { text: 'Hi.', start: 0, end: 0.3 },
      { text: 'Look', start: 2, end: 2.2 },
      { text: 'at', start: 2.2, end: 2.3 },
      { text: 'this', start: 2.3, end: 2.5 },
    ];
    expect(sentences(words).map((s) => s.text)).toEqual(['Hi.', 'Look at this']);
    expect(hypeHits(words).map((h) => h.phrase)).toContain('look at this');
  });
});
