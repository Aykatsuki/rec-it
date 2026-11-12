import { z } from 'zod';
import { secretStatusSchema } from './secrets';

export const checkStateSchema = z.enum(['checking', 'ok', 'missing', 'error']);
export type CheckState = z.output<typeof checkStateSchema>;

export const ffmpegStatusSchema = z.object({
  state: checkStateSchema,
  path: z.string().optional(),
  source: z.enum(['env', 'bundled', 'path']).optional(),
  version: z.string().optional(),
  /** "gpl" when the build was configured with --enable-gpl (needed for libx264, ADR-007). */
  licence: z.enum(['gpl', 'lgpl', 'nonfree', 'unknown']).optional(),
  encoders: z.record(z.string(), z.boolean()).default({}),
  hwaccels: z.array(z.string()).default([]),
  /** Result of a real one-frame NVENC test encode; null when NVENC is not compiled in. */
  nvencUsable: z.boolean().nullable().default(null),
  hasLibass: z.boolean().default(false),
  hasZimg: z.boolean().default(false),
  message: z.string().optional(),
});
export type FfmpegStatus = z.output<typeof ffmpegStatusSchema>;

export const gpuSchema = z.object({
  name: z.string(),
  memoryMb: z.number().int().nonnegative(),
  driverVersion: z.string(),
});

export const sidecarStatusSchema = z.object({
  state: checkStateSchema,
  version: z.string().optional(),
  python: z.string().optional(),
  gpus: z.array(gpuSchema).default([]),
  cuda: z
    .object({
      available: z.boolean(),
      deviceCount: z.number().int().nonnegative(),
      via: z.enum(['ctranslate2', 'nvidia-smi', 'none']),
    })
    .optional(),
  message: z.string().optional(),
});
export type SidecarStatus = z.output<typeof sidecarStatusSchema>;

export const systemStatusSchema = z.object({
  backend: z.object({
    version: z.string(),
    startedAt: z.number(),
    nodeVersion: z.string(),
    electronVersion: z.string().optional(),
    platform: z.string(),
    arch: z.string(),
  }),
  database: z.object({ path: z.string(), schemaVersion: z.number().int() }),
  ffmpeg: ffmpegStatusSchema,
  sidecar: sidecarStatusSchema,
  secrets: z.record(z.string(), secretStatusSchema),
});
export type SystemStatus = z.output<typeof systemStatusSchema>;
