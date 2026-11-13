import { z } from 'zod';

/** Face boxes per sampled frame: [x, y, width, height, score] as fractions of the picture. */
export const faceTrackSchema = z.object({
  assetId: z.string(),
  fps: z.number().positive().max(60),
  engine: z.string(),
  frames: z.array(z.array(z.array(z.number()).length(5)).max(50)),
});
export type FaceTrackData = z.output<typeof faceTrackSchema>;

export const faceJobSchema = z.object({
  assetId: z.string(),
  state: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1),
  error: z.string().optional(),
});

/** Face analysis engine, jobs and analysed media (ADR-035). */
export const faceStatusSchema = z.object({
  available: z.boolean().nullable(),
  engine: z.string().optional(),
  blocked: z.string().optional(),
  install: z.object({
    state: z.enum(['idle', 'running', 'failed']),
    message: z.string().optional(),
  }),
  jobs: z.array(faceJobSchema),
  analysed: z.array(z.string()),
});
export type FaceStatus = z.output<typeof faceStatusSchema>;
export type FaceJob = z.output<typeof faceJobSchema>;
