// Turns raw measurements into per-second "interest" components, each 0..1 (ported from
// Clipalytics; Rec-It measures loudness, action and speech from local files).
import type { SignalKind, Word } from './types';
import { clamp, excitement, median, robustStd, smooth } from './series';
import { hypeHits } from './transcript';

export interface Sampled {
  /** Seconds per value. */
  step: number;
  values: number[];
}

export interface RawSignals {
  durationSec: number;
  /** Audio RMS (linear, 0..1) per step. */
  audioRms?: Sampled;
  /** Mean absolute difference between consecutive small grey frames (0..255) per step. */
  motion?: Sampled;
  words?: Word[];
}

export interface Components {
  n: number;
  parts: Partial<Record<SignalKind, Float64Array>>;
  /** Extra facts for reasons. */
  loudDb?: Float64Array;
  loudBaseDb?: number;
  hype: { t: number; phrase: string; weight: number }[];
  /** Hard cuts in the picture (seconds), for clean clip starts. */
  sceneCuts: number[];
}

/** Per-second averages of a sampled series (energy-averaged when `energy`). */
function perSecond(s: Sampled, n: number, energy = false): Float64Array {
  const out = new Float64Array(n);
  const count = new Float64Array(n);
  s.values.forEach((v, i) => {
    const sec = Math.floor(i * s.step);
    if (sec >= n) return;
    out[sec] = out[sec]! + (energy ? v * v : v);
    count[sec] = count[sec]! + 1;
  });
  for (let i = 0; i < n; i++) out[i] = count[i] ? out[i]! / count[i]! : 0;
  if (energy) for (let i = 0; i < n; i++) out[i] = Math.sqrt(out[i]!);
  return out;
}

export function buildComponents(raw: RawSignals): Components {
  const n = Math.max(1, Math.ceil(raw.durationSec));
  const parts: Components['parts'] = {};
  const result: Components = { n, parts, hype: [], sceneCuts: [] };

  if (raw.audioRms?.values.length) {
    const rms = perSecond(raw.audioRms, n, true);
    const db = new Float64Array(n);
    for (let i = 0; i < n; i++) db[i] = 20 * Math.log10(Math.max(1e-5, rms[i]!));
    result.loudDb = db;
    result.loudBaseDb = median(db);
    // Loudness relative to the surrounding minute; +3 robust deviations (min 2 dB each) = 1.
    const ex = excitement(db, 45, 2);
    // A sudden jump (a scream after quiet) is also exciting.
    const jump = new Float64Array(n);
    for (let i = 2; i < n; i++) jump[i] = clamp((db[i]! - Math.min(db[i - 1]!, db[i - 2]!)) / 12);
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = clamp(0.75 * ex[i]! + 0.4 * jump[i]!);
    parts.audio = smooth(a, 1);
  }

  if (raw.motion?.values.length) {
    const vals = raw.motion.values;
    const med = median(vals);
    const spread = Math.max(0.5, robustStd(vals));
    // Hard cuts: one frame much brighter-different than its neighbours.
    for (let i = 1; i < vals.length - 1; i++) {
      const v = vals[i]!;
      if (v > med + 8 * spread && v > 18 && v > 2.5 * Math.max(vals[i - 1]!, vals[i + 1]!))
        result.sceneCuts.push(Math.round(i * raw.motion.step * 100) / 100);
    }
    // Remove the cut spikes so a cut is not mistaken for action.
    const tamed = vals.map((v, i) =>
      result.sceneCuts.includes(Math.round(i * raw.motion!.step * 100) / 100) ? med : v,
    );
    const m = perSecond({ step: raw.motion.step, values: tamed }, n);
    parts.motion = smooth(excitement(m, 60, Math.max(0.5, spread)), 1.5);
  }

  if (raw.words?.length) {
    result.hype = hypeHits(raw.words);
    const w = new Float64Array(n);
    for (const h of result.hype) {
      const i = Math.floor(h.t);
      if (i >= 0 && i < n) w[i] = w[i]! + h.weight;
    }
    // ~2 strong hype phrases within a few seconds = 1.
    const s = smooth(w, 2.5);
    for (let i = 0; i < n; i++) s[i] = clamp(s[i]! / 0.35);
    parts.speech = s;
  }

  return result;
}

/** How much each signal counts. Renormalised over the signals a scan actually has. */
export const WEIGHTS: Record<SignalKind, number> = {
  audio: 0.45,
  speech: 0.32,
  motion: 0.23,
};

/** How much a single signal alone can be trusted to mean "this is a moment". */
const TRUST: Record<SignalKind, number> = {
  audio: 0.85,
  speech: 0.75,
  motion: 0.55,
};

export function combine(c: Components): Float64Array {
  const kinds = (Object.keys(c.parts) as SignalKind[]).filter((k) => c.parts[k]);
  const out = new Float64Array(c.n);
  if (!kinds.length) return out;
  const total = kinds.reduce((s, k) => s + WEIGHTS[k], 0);
  const peak = new Float64Array(c.n);
  for (const k of kinds) {
    const w = WEIGHTS[k] / total;
    const trust = TRUST[k];
    const p = c.parts[k]!;
    for (let i = 0; i < c.n; i++) {
      out[i] = out[i]! + w * p[i]!;
      peak[i] = Math.max(peak[i]!, trust * p[i]!);
    }
  }
  // Half average, half strongest signal: one very strong signal (a huge reaction) is enough
  // to make a moment worth a look, but agreement scores higher.
  for (let i = 0; i < c.n; i++) out[i] = 0.55 * out[i]! + 0.45 * peak[i]!;
  // Agreement bonus: two or more signals peaking together is the best evidence.
  for (let i = 0; i < c.n; i++) {
    let strong = 0;
    for (const k of kinds) if (c.parts[k]![i]! > 0.55) strong++;
    if (strong >= 2) out[i] = Math.min(1, out[i]! * (1 + 0.15 * (strong - 1)));
  }
  // Light smoothing only: gaming moments (a scream, a kill) can be just a few seconds long.
  return smooth(out, 1);
}
