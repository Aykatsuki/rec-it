import { z } from 'zod';

/** One recognised word; times are seconds in the media file. `p` is the confidence (0–1). */
export const wordSchema = z.object({
  text: z.string(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  p: z.number().min(0).max(1),
});
export type Word = z.output<typeof wordSchema>;

export const transcriptSchema = z.object({
  assetId: z.string(),
  language: z.string(),
  model: z.string(),
  device: z.string().optional(),
  words: z.array(wordSchema),
});
export type Transcript = z.output<typeof transcriptSchema>;

export const transcriptionJobSchema = z.object({
  assetId: z.string(),
  state: z.enum(['queued', 'extracting', 'transcribing', 'done', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1),
  /** What it is doing now, e.g. "Downloading the speech model (large-v3-turbo)…". */
  message: z.string().optional(),
  error: z.string().optional(),
});
export type TranscriptionJob = z.output<typeof transcriptionJobSchema>;

/** Everything the transcript panel needs, sent as one event when anything changes. */
export const transcriptionStatusSchema = z.object({
  /** faster-whisper is installed (or the test engine is on). null while checking. */
  available: z.boolean().nullable(),
  engine: z.string().optional(),
  /** Why transcription cannot run at all (the helper is off or failed to start). */
  blocked: z.string().optional(),
  /** Installing the transcription extra (one-time download). */
  install: z.object({
    state: z.enum(['idle', 'running', 'failed']),
    message: z.string().optional(),
  }),
  jobs: z.array(transcriptionJobSchema),
  /** Media in the open project that has a transcript. */
  transcribed: z.array(z.string()),
});
export type TranscriptionStatus = z.output<typeof transcriptionStatusSchema>;
