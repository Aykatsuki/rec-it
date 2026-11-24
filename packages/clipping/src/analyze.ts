// The whole local analysis: raw signals in, ranked moments and a report out. Pure and fast
// (an hour of video is a few thousand numbers per signal), so it is easy to test.
import type { Analysis, SignalKind, SourceInfo, Word } from './types';
import { clippability, findMoments } from './moments';
import { buildComponents, combine, type RawSignals } from './signals';
import { clock, downsample } from './series';
import { sentences } from './transcript';

export interface AnalyzeInput {
  id: string;
  source: SourceInfo;
  raw: RawSignals;
  minLen: number;
  maxLen: number;
  targetLen: number;
  /** Moments to keep (the top few are shown; the rest can go to the AI). */
  keep: number;
  notes?: string[];
  now?: string;
}

const MAX_POINTS = 600;

export function analyze(input: AnalyzeInput): Analysis {
  const { raw } = input;
  const comps = buildComponents(raw);
  const curve = combine(comps);
  const words: Word[] = raw.words ?? [];
  const moments = findMoments(curve, comps, words, sentences(words), {
    minLen: input.minLen,
    maxLen: input.maxLen,
    targetLen: input.targetLen,
    keep: input.keep,
  });
  const signals = (Object.keys(comps.parts) as SignalKind[]).filter((k) => comps.parts[k]);
  const points = Math.min(MAX_POINTS, comps.n);
  const now = input.now ?? new Date().toISOString();
  const analysis: Analysis = {
    id: input.id,
    version: 1,
    createdAt: now,
    updatedAt: now,
    source: input.source,
    settings: { minLen: input.minLen, maxLen: input.maxLen, targetLen: input.targetLen },
    signals,
    curve: downsample(curve, points),
    curveStep: comps.n / points,
    moments,
    clippability: clippability(moments),
    summary: '',
    notes: [...(input.notes ?? [])],
  };
  if (!signals.length)
    analysis.notes.push('No signals could be measured, so no moments were found.');
  analysis.summary = summarise(analysis);
  return analysis;
}

export function verdict(score: number): string {
  if (score >= 7.5) return 'Excellent Shorts material';
  if (score >= 6) return 'Good Shorts material';
  if (score >= 4.5) return 'Some usable moments';
  if (score > 0) return 'Few stand-out moments';
  return 'No clear moments';
}

export function summarise(a: Analysis): string {
  const strong = a.moments.filter((m) => m.score >= 6).length;
  const best = a.moments[0];
  const parts = [
    `${verdict(a.clippability)} (${a.clippability}/10).`,
    a.moments.length
      ? `${strong || 'No'} strong moment${strong === 1 ? '' : 's'} out of ${a.moments.length} found${
          best ? `; the best is at ${clock(best.start)}–${clock(best.end)}` : ''
        }.`
      : '',
  ];
  return parts.filter(Boolean).join(' ');
}
