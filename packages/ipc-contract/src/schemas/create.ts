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
  'cartoon',
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
/** The mouth-shape engine for talking characters (FLUX.2 Klein; ADR-049): same shape. */
export type AnimationStatus = ImageStatus;

/**
 * A voice: a Kokoro voice ("af_heart", fast) or a human-like Chatterbox voice: "hq:builtin",
 * "hq:<id>" for a voice cloned from one of your samples, or "hq:k-<kokoro voice>" for one cloned
 * from a reference that Kokoro voice reads (ADR-051).
 */
export const voiceIdSchema = z.string().regex(/^(?:[a-z]{2}_[a-z]+|hq:[a-z0-9_-]{1,40})$/);

/** A voice sample you added, cloned by the human-like voice. */
export const voiceSampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  seconds: z.number(),
});
export type VoiceSample = z.output<typeof voiceSampleSchema>;

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
    voice: voiceIdSchema,
    speed: z.number().min(0.7).max(1.5).default(1.1),
    /** What is behind the captions: footage, AI pictures per scene, or motion graphics. */
    visuals: z.enum(['footage', 'pictures', 'graphics']).default('footage'),
    pictureStyle: pictureStyleSchema.default('cartoon'),
    /** Footage for `visuals: footage`. */
    backgroundAssetId: z.string().min(1).max(100).nullable().default(null),
    /** Seconds into the background footage; null picks a random start. */
    backgroundStart: seconds.nullable().default(null),
    keepBackgroundSound: z.boolean().default(false),
    musicAssetId: z.string().min(1).max(100).nullable().default(null),
    musicVolume: z.number().min(0).max(1).default(0.12),
    card: z.boolean().default(true),
    theme: z.enum(['light', 'dark']).default('light'),
    captionStyle: z
      .enum(['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas', 'retro'])
      .default('pop'),
    upvotes: z.number().int().min(0).max(10_000_000).default(0),
    comments: z.number().int().min(0).max(10_000_000).default(0),
  })
  .strict();
export type StoryShortInput = z.input<typeof storyShortSchema>;

export const CHARACTER_MOODS = [
  'serious',
  'neutral',
  'determined',
  'worried',
  'sad',
  'happy',
] as const;
export type CharacterMood = (typeof CHARACTER_MOODS)[number];

/**
 * One talking-character shot (ADR-048/049): a Pixar-style picture of the character, its mouth
 * shapes, and the line in an AI voice with the mouth in time. Builds a short test sequence.
 */
export const talkTestSchema = z
  .object({
    /** Who is talking, e.g. "a cheerful orange fox in a green scarf". */
    character: z.string().trim().min(3).max(300),
    /** What they say. */
    line: z.string().trim().min(1).max(600),
    voice: voiceIdSchema,
    /** 2D stick-figure cartoon (the default) or a Pixar-style 3D character. */
    style: z.enum(['cartoon', 'render3d']).default('cartoon'),
    /** Where they are, drawn as the background, e.g. "a muddy battlefield in the rain". */
    setting: z.string().trim().max(300).default(''),
    /** The face they keep while talking (only the mouth moves). */
    mood: z.enum(CHARACTER_MOODS).default('serious'),
    /** How much the mouth moves: 0 calm … 1 lively. */
    liveliness: z.number().min(0).max(1).default(0.6),
  })
  .strict();
export type TalkTestInput = z.input<typeof talkTestSchema>;

export const templateJobSchema = z.object({
  id: z.string(),
  kind: z.enum(['story', 'talk-test', 'episode', 'lowpoly']),
  title: z.string(),
  state: z.enum(['running', 'done', 'failed', 'cancelled']),
  /** What it is doing now, e.g. "Recording the voiceover…". */
  stage: z.string(),
  progress: z.number().min(0).max(1),
  error: z.string().optional(),
  sequenceId: z.string().optional(),
});
export type TemplateJob = z.output<typeof templateJobSchema>;

/**
 * An episode from a brief (ADR-052): the AI plans the cast and shots from your brief (style,
 * story, dialogue), then Rec-It draws, voices, lip-syncs and builds it.
 */
export const episodeSchema = z
  .object({
    /** The brief: style, story, characters. Optional when a script is given. */
    brief: z.string().trim().max(12000).default(''),
    /** A written script, spoken exactly as written (ADR-053): "NAME: line" or NARRATOR lines. */
    script: z.string().trim().max(20000).default(''),
    /** Target length in seconds. */
    seconds: z.number().min(30).max(90).default(60),
    /** The narrator's voice; characters are cast automatically. */
    narrator: voiceIdSchema,
    liveliness: z.number().min(0).max(1).default(0.6),
    musicAssetId: z.string().min(1).max(100).nullable().default(null),
    musicVolume: z.number().min(0).max(1).default(0.15),
    captionStyle: z
      .enum(['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas', 'retro'])
      .default('pop'),
  })
  .strict()
  .refine((e) => e.brief.length >= 20 || e.script.length >= 10, {
    message: 'Write a brief of at least 20 characters or a script.',
  });
/** A character remembered by the project (ADR-053). */
export const storedCharacterSchema = z.object({
  id: z.string(),
  name: z.string(),
  look: z.string(),
});
export type EpisodeInput = z.input<typeof episodeSchema>;

/**
 * A low-poly 3D Short (ADR-054): a topic the AI writes up in the genre's style, or your own
 * script spoken as written; the AI storyboards it with the 3D kit and Rec-It films it.
 */
export const lowPolySchema = z
  .object({
    topic: z.string().trim().max(2000).default(''),
    script: z.string().trim().max(6000).default(''),
    /** Target length when the AI writes the script. */
    seconds: z.number().min(15).max(90).default(40),
    narrator: voiceIdSchema,
    /** Narration speed (the genre talks fast). */
    speed: z.number().min(0.7).max(1.5).default(1.1),
    /** Channel name flashed early on, like a watermark ("" for none). */
    brand: z.string().trim().max(40).default(''),
    /** How solid the channel name is on screen. */
    brandOpacity: z.number().min(0.1).max(1).default(0.9),
    /** How chunky the pixels are: the height the 3D is drawn at. */
    pixels: z.enum(['chunky', 'classic', 'clean']).default('classic'),
    musicAssetId: z.string().min(1).max(100).nullable().default(null),
    musicVolume: z.number().min(0).max(1).default(0.12),
    captionStyle: z
      .enum(['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas', 'retro'])
      .default('retro'),
  })
  .strict()
  .refine((e) => e.topic.length >= 3 || e.script.length >= 10, {
    message: 'Give a topic or a script.',
  });
export type LowPolyInput = z.input<typeof lowPolySchema>;

export const lowPolyIdeaSchema = z.object({ title: z.string(), premise: z.string() });
