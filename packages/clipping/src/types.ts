// Types of the clip finder (ported from Clipalytics, ADR-046). Rec-It measures local files only:
// loudness, on-screen action and speech.

export type SignalKind = 'audio' | 'motion' | 'speech';

export const SIGNAL_LABELS: Record<SignalKind, string> = {
  audio: 'Loudness',
  motion: 'Action',
  speech: 'Speech',
};

export interface Word {
  text: string;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
}

/** A sentence-like run of words, used for clean clip boundaries and excerpts. */
export interface Sentence {
  start: number;
  end: number;
  text: string;
}

export interface Reason {
  signal: SignalKind | 'words';
  /** Short, human text, e.g. "Loud reaction (+9 dB)". */
  text: string;
}

/** The AI's judgement of one moment (Ollama, Kimi or Claude). */
export interface AiScores {
  hook: number;
  payoff: number;
  standalone: number;
  clarity: number;
  title: string;
  hookLine?: string;
  reason: string;
  /** What to do in the edit, e.g. "start on the push, cut the reload at 0:12". */
  editNote?: string;
}

export interface Moment {
  /** Stable within an analysis, e.g. "m3". */
  id: string;
  start: number;
  end: number;
  /** Peak of the interest curve inside the clip (seconds). */
  peak: number;
  /** 0..10 from local signals only. */
  localScore: number;
  /** 0..10, local blended with the AI's judgement when present. */
  score: number;
  /** 1 = best. */
  rank: number;
  reasons: Reason[];
  /** Words spoken in the clip, trimmed. */
  excerpt: string;
  /** Hype words found in the clip ("no way", "let's go"…). */
  hypeWords: string[];
  /** Automatic title from the strongest reason (replaced by the AI's when scored). */
  autoTitle: string;
  ai?: AiScores;
}

export interface SourceInfo {
  /** The media file in the project. */
  assetId: string;
  title: string;
  durationSec: number;
}

export interface Analysis {
  id: string;
  version: 1;
  createdAt: string;
  updatedAt: string;
  source: SourceInfo;
  settings: { minLen: number; maxLen: number; targetLen: number };
  signals: SignalKind[];
  /** Combined interest per second, 0..1, downsampled to ≤ 600 points for the UI. */
  curve: number[];
  /** Seconds per curve point. */
  curveStep: number;
  moments: Moment[];
  /** 0..10: how much good Shorts material the video has. */
  clippability: number;
  /** One or two plain sentences. */
  summary: string;
  aiSummary?: string;
  aiScoredAt?: string;
  notes: string[];
}
