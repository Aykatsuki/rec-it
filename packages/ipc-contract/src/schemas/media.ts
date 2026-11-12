import { z } from 'zod';

const rational = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

export const probeInfoSchema = z.object({
  kind: z.enum(['video', 'audio', 'image']),
  container: z.string(),
  durationSec: z.number().nonnegative(),
  durationFlicks: z.number().int().nonnegative(),
  bitRate: z.number().optional(),
  audioStreamCount: z.number().int().nonnegative(),
  video: z
    .object({
      codec: z.string(),
      profile: z.string().optional(),
      width: z.number().int(),
      height: z.number().int(),
      displayWidth: z.number().int(),
      displayHeight: z.number().int(),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      fps: rational,
      avgFps: rational,
      isVfr: z.boolean(),
      pixFmt: z.string(),
      bitDepth: z.number().int(),
      colorTransfer: z.string().optional(),
      colorPrimaries: z.string().optional(),
      hdr: z.boolean(),
      frameCount: z.number().int().optional(),
    })
    .optional(),
  audio: z
    .object({ codec: z.string(), sampleRate: z.number(), channels: z.number().int() })
    .optional(),
});
export type ProbeInfoDto = z.output<typeof probeInfoSchema>;

/** Where an asset came from and whether it may be used (ARCHITECTURE §15.2, ADR-012). */
export const rightsSourceSchema = z.enum([
  'own-recording',
  'own-youtube-upload',
  'creative-commons',
  'licensed-stock',
  'licensed-other',
  'unknown',
]);
export type RightsSource = z.output<typeof rightsSourceSchema>;

export const rightsInputSchema = z
  .object({
    source: rightsSourceSchema,
    licence: z.string().max(200).optional(),
    author: z.string().max(200).optional(),
    originUrl: z
      .string()
      .max(2000)
      .regex(/^https?:\/\//, 'Must be a web address')
      .optional(),
    notes: z.string().max(2000).optional(),
    userAttested: z.boolean(),
  })
  .strict();
export type RightsInput = z.output<typeof rightsInputSchema>;

export const rightsRecordSchema = rightsInputSchema.extend({
  attributionText: z.string().optional(),
  attestedAt: z.string().optional(),
});
export type RightsRecord = z.output<typeof rightsRecordSchema>;

export const jobKindSchema = z.enum(['probe', 'proxy', 'thumbnails', 'waveform']);
export type JobKind = z.output<typeof jobKindSchema>;

export const jobStateSchema = z.object({
  state: z.enum(['pending', 'running', 'done', 'failed', 'cancelled', 'skipped']),
  progress: z.number().min(0).max(1),
  error: z.string().optional(),
});
export type JobState = z.output<typeof jobStateSchema>;

export const assetStatusSchema = z.enum(['processing', 'ready', 'failed', 'missing']);
export type AssetStatus = z.output<typeof assetStatusSchema>;

export const spriteInfoSchema = z.object({
  url: z.string(),
  interval: z.number().positive(),
  count: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** An asset as the renderer sees it. URLs use the recit-media:// protocol. */
export const mediaAssetSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['video', 'audio', 'image']).nullable(),
  originalPath: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  importedAt: z.string(),
  status: assetStatusSchema,
  missing: z.boolean(),
  probe: probeInfoSchema.nullable(),
  rights: rightsRecordSchema,
  jobs: z.record(jobKindSchema, jobStateSchema),
  urls: z.object({
    proxy: z.string().optional(),
    poster: z.string().optional(),
    waveform: z.string().optional(),
    sprite: spriteInfoSchema.optional(),
  }),
});
export type MediaAsset = z.output<typeof mediaAssetSchema>;

export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  createdAt: z.string(),
  cacheDir: z.string(),
});
export type ProjectInfo = z.output<typeof projectInfoSchema>;

export const recentProjectSchema = z.object({
  path: z.string(),
  name: z.string(),
  openedAt: z.string(),
  exists: z.boolean(),
});
export type RecentProject = z.output<typeof recentProjectSchema>;

export const jobSummarySchema = z.object({
  assetId: z.string(),
  assetName: z.string(),
  kind: jobKindSchema,
  state: jobStateSchema.shape.state,
  progress: z.number(),
});
export type JobSummary = z.output<typeof jobSummarySchema>;

/** File extensions the importer accepts (checked again after probing). */
export const IMPORT_EXTENSIONS = [
  'mp4',
  'mov',
  'm4v',
  'mkv',
  'webm',
  'avi',
  'mts',
  'm2ts',
  'mxf',
  'wmv',
  'flv',
  '3gp',
  'ts',
  'mp3',
  'wav',
  'aac',
  'm4a',
  'flac',
  'ogg',
  'opus',
  'aif',
  'aiff',
  'wma',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'gif',
  'heic',
] as const;

/** Absolute file path from a trusted dialog or a dropped file. */
export const filePathSchema = z.string().min(1).max(4096);
