import { z } from 'zod';

// AI text, AI voice and faceless templates (ADR-046).

export const aiStatusSchema = z.object({
  provider: z.enum(['ollama', 'kimi', 'custom']),
  baseUrl: z.string(),
  model: z.string(),
  /** The provider needs an API key and one is saved. */
  needsKey: z.boolean(),
  keySet: z.boolean(),
});
export type AiStatus = z.output<typeof aiStatusSchema>;

export const storyGenreSchema = z.enum([
  'aita',
  'tifu',
  'revenge',
  'relationship',
  'scary',
  'wholesome',
  'askreddit',
  'facts',
  'motivation',
  'history',
]);

export const pictureStyleSchema = z.enum([
  'cinematic',
  'anime',
  'render3d',
  'comic',
  'watercolour',
  'dark',
  'historical',
]);

/** The AI picture engine (Z-Image Turbo via stable-diffusion.cpp; ADR-047). */
export const imageStatusSchema = z.object({
  available: z.boolean().nullable(),
  engine: z.string().optional(),
  /** This computer can download the engine (Windows), or one is configured. */
  installable: z.boolean(),
  reason: z.string().optional(),
  blocked: z.string().optional(),
  install: z.object({
    state: z.enum(['idle', 'running', 'failed']),
    message: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
  }),
});
export type ImageStatus = z.output<typeof imageStatusSchema>;

export const storyTextSchema = z.object({
  title: z.string(),
  story: z.string(),
  username: z.string().optional(),
});

export const installStateSchema = z.object({
  state: z.enum(['idle', 'running', 'failed']),
  message: z.string().optional(),
});

export const voiceStatusSchema = z.object({
  /** The voice engine is installed (or the test engine is on). null while checking. */
  available: z.boolean().nullable(),
  engine: z.string().optional(),
  blocked: z.string().optional(),
  install: installStateSchema,
});
export type VoiceStatus = z.output<typeof voiceStatusSchema>;

const seconds = z
  .number()
  .min(0)
  .max(24 * 3600);

/** Everything the story template needs; the backend writes, voices and builds the rest. */
export const storyShortSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    story: z.string().trim().min(1).max(8000),
    community: z.string().max(40).default(''),
    username: z.string().max(40).default(''),
    voice: z.string().regex(/^[a-z]{2}_[a-z]+$/),
    speed: z.number().min(0.7).max(1.5).default(1.1),
    /** What is behind the captions: footage, AI pictures per scene, or motion graphics. */
    visuals: z.enum(['footage', 'pictures', 'graphics']).default('footage'),
    pictureStyle: pictureStyleSchema.default('cinematic'),
    /** Footage for `visuals: footage`. */
    backgroundAssetId: z.string().min(1).max(100).nullable().default(null),
    /** Seconds into the background footage; null picks a random start. */
    backgroundStart: seconds.nullable().default(null),
    keepBackgroundSound: z.boolean().default(false),
    musicAssetId: z.string().min(1).max(100).nullable().default(null),
    musicVolume: z.number().min(0).max(1).default(0.12),
    card: z.boolean().default(true),
    theme: z.enum(['light', 'dark']).default('light'),
    captionStyle: z.enum(['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas']).default('pop'),
    upvotes: z.number().int().min(0).max(10_000_000).default(0),
    comments: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export type StoryShortInput = z.input<typeof storyShortSchema>;

export const templateJobSchema = z.object({
  id: z.string(),
  kind: z.literal('story'),
  title: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  /** What it is doing now, e.g. "Recording the voiceover…". */
  stage: z.string(),
  progress: z.number().min(0).max(1),
  error: z.string().optional(),
  sequenceId: z.string().optional(),
});
export type TemplateJob = z.output<typeof templateJobSchema>;
