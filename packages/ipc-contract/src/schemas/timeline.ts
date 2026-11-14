import { z } from 'zod';

const flicks = z.number().int().nonnegative();
const id = z.string().min(1).max(100);
const rational = z.object({ num: z.number().int().positive(), den: z.number().int().positive() });

const transformShape = {
  fit: z.enum(['fill', 'fit']),
  scale: z.number().min(0.05).max(10),
  x: z.number().min(-2).max(2),
  y: z.number().min(-2).max(2),
  rotation: z.number().min(-3600).max(3600),
  crop: z
    .object({
      left: z.number().min(-1).max(1),
      top: z.number().min(-1).max(1),
      right: z.number().min(-1).max(1),
      bottom: z.number().min(-1).max(1),
    })
    .optional(),
};
/** Documents saved before rotation existed load with rotation 0. */
export const transformSchema = z.object({
  ...transformShape,
  rotation: transformShape.rotation.default(0),
});
const transformPatchSchema = z
  .object({
    fit: transformShape.fit.optional(),
    scale: transformShape.scale.optional(),
    x: transformShape.x.optional(),
    y: transformShape.y.optional(),
    rotation: transformShape.rotation.optional(),
    crop: transformShape.crop,
  })
  .strict();

const keyframeProperty = z.enum(['x', 'y', 'scale', 'rotation', 'volume']);
const easing = z.enum(['linear', 'ease', 'hold']);
const keyframeSchema = z.object({ t: flicks, v: z.number().min(-3600).max(3600), e: easing });

export const timelineItemSchema = z.object({
  id,
  assetId: id,
  start: flicks,
  duration: flicks,
  sourceIn: flicks,
  volume: z.number().min(0).max(2),
  muted: z.boolean(),
  transform: transformSchema,
  keyframes: z.partialRecord(keyframeProperty, z.array(keyframeSchema).max(10_000)).optional(),
  linkId: id.optional(),
  opacity: z.number().min(0).max(1).optional(),
  fade: z.object({ in: flicks, out: flicks }).optional(),
  effects: z
    .array(
      z.object({
        id,
        kind: z.literal('color'),
        enabled: z.boolean(),
        brightness: z.number().min(-1).max(1),
        contrast: z.number().min(0).max(3),
        saturation: z.number().min(0).max(3),
      }),
    )
    .max(16)
    .optional(),
  caption: z
    .object({
      words: z
        .array(
          z.object({ text: z.string().max(200), start: z.number().int(), end: z.number().int() }),
        )
        .max(400),
    })
    .optional(),
});

export const trackSchema = z.object({
  id,
  kind: z.enum(['video', 'audio', 'caption']),
  name: z.string(),
  muted: z.boolean(),
  hidden: z.boolean(),
  locked: z.boolean(),
  items: z.array(timelineItemSchema),
});

const captionStyle = z.enum(['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas']);
export const captionSettingsSchema = z.object({
  enabled: z.boolean(),
  style: captionStyle,
  size: z.number().min(0.5).max(2),
  position: z.number().min(0.1).max(0.9),
  wordsPerLine: z.number().int().min(1).max(8),
  lines: z.union([z.literal(1), z.literal(2)]),
  uppercase: z.boolean(),
  highlight: z.string().regex(/^#[0-9a-fA-F]{6}$/),
});

export const sequenceSchema = z.object({
  id,
  name: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  fps: rational,
  tracks: z.array(trackSchema),
  captions: captionSettingsSchema.optional(),
});

export const projectDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  sequences: z.array(sequenceSchema),
  activeSequenceId: id.nullable(),
  transcriptEdits: z
    .record(
      z.string(),
      z.record(z.string(), z.object({ from: z.string(), to: z.string().max(200) })),
    )
    .optional(),
});

const seqId = { sequenceId: id };
/** Every edit the UI (and later Claude) can make to the timeline. Mirrors core's Command type. */
const singleCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sequence.create'),
    id: id.optional(),
    name: z.string().max(120),
    width: z.number().int(),
    height: z.number().int(),
    fps: rational,
  }),
  z.object({
    type: z.literal('sequence.update'),
    ...seqId,
    name: z.string().max(120).optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    fps: rational.optional(),
  }),
  z.object({
    type: z.literal('track.add'),
    ...seqId,
    kind: z.enum(['video', 'audio', 'caption']),
    id: id.optional(),
  }),
  z.object({ type: z.literal('track.remove'), ...seqId, trackId: id }),
  z.object({
    type: z.literal('track.update'),
    ...seqId,
    trackId: id,
    muted: z.boolean().optional(),
    hidden: z.boolean().optional(),
    locked: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('item.add'),
    ...seqId,
    trackId: id,
    assetId: id,
    start: flicks,
    id: id.optional(),
    sourceIn: flicks.optional(),
    duration: flicks.optional(),
    volume: z.number().min(0).max(2).optional(),
    muted: z.boolean().optional(),
    transform: transformPatchSchema.optional(),
  }),
  z.object({ type: z.literal('item.move'), ...seqId, itemId: id, trackId: id, start: flicks }),
  z.object({
    type: z.literal('item.link'),
    ...seqId,
    itemIds: z.array(id).min(2).max(100),
    linkId: id.optional(),
  }),
  z.object({ type: z.literal('item.unlink'), ...seqId, itemIds: z.array(id).min(1).max(1000) }),
  z.object({
    type: z.literal('keyframe.set'),
    ...seqId,
    itemId: id,
    property: keyframeProperty,
    t: flicks,
    value: z.number().min(-3600).max(3600),
    easing: easing.optional(),
  }),
  z.object({
    type: z.literal('keyframe.remove'),
    ...seqId,
    itemId: id,
    property: keyframeProperty,
    t: flicks,
  }),
  z.object({
    type: z.literal('keyframe.clear'),
    ...seqId,
    itemId: id,
    property: keyframeProperty,
    t: flicks,
  }),
  z.object({
    type: z.literal('item.moveMany'),
    ...seqId,
    moves: z
      .array(z.object({ itemId: id, trackId: id, start: flicks }))
      .min(1)
      .max(1000),
  }),
  z.object({
    type: z.literal('item.trim'),
    ...seqId,
    itemId: id,
    edge: z.enum(['start', 'end']),
    time: flicks,
  }),
  z.object({
    type: z.literal('item.split'),
    ...seqId,
    time: flicks,
    itemIds: z.array(id).optional(),
  }),
  z.object({
    type: z.literal('item.remove'),
    ...seqId,
    itemIds: z.array(id).min(1),
    ripple: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('captions.update'),
    ...seqId,
    captions: captionSettingsSchema.partial(),
  }),
  z.object({
    type: z.literal('captions.generate'),
    ...seqId,
    trackId: id.optional(),
    captions: z
      .array(
        z.object({
          start: flicks,
          duration: flicks,
          words: z
            .array(z.object({ text: z.string().max(200), start: flicks, end: flicks }))
            .max(400),
        }),
      )
      .max(20_000),
  }),
  z.object({
    type: z.literal('caption.add'),
    ...seqId,
    trackId: id,
    start: flicks,
    duration: flicks,
    text: z.string().max(2000),
    words: z
      .array(
        z.object({ text: z.string().max(200), start: z.number().int(), end: z.number().int() }),
      )
      .max(400)
      .optional(),
    transform: transformPatchSchema.optional(),
    id: id.optional(),
  }),
  z.object({
    type: z.literal('caption.edit'),
    ...seqId,
    itemId: id,
    text: z.string().max(2000),
  }),
  z.object({
    type: z.literal('transcript.editWord'),
    assetId: id,
    index: z.number().int().nonnegative(),
    from: z.string().max(200),
    to: z.string().max(400),
  }),
  z.object({
    type: z.literal('item.cutRange'),
    ...seqId,
    itemId: id,
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    ripple: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('item.update'),
    ...seqId,
    itemId: id,
    volume: z.number().min(0).max(2).optional(),
    muted: z.boolean().optional(),
    transform: transformPatchSchema.optional(),
    opacity: z.number().min(0).max(1).optional(),
    fade: z.object({ in: flicks.optional(), out: flicks.optional() }).strict().optional(),
  }),
  z.object({
    type: z.literal('effect.add'),
    ...seqId,
    itemId: id,
    kind: z.enum(['color']),
    id: id.optional(),
  }),
  z.object({
    type: z.literal('effect.update'),
    ...seqId,
    itemId: id,
    effectId: id,
    enabled: z.boolean().optional(),
    params: z
      .object({
        brightness: z.number().min(-1).max(1).optional(),
        contrast: z.number().min(0).max(3).optional(),
        saturation: z.number().min(0).max(3).optional(),
      })
      .strict()
      .optional(),
  }),
  z.object({ type: z.literal('effect.remove'), ...seqId, itemId: id, effectId: id }),
  z.object({
    type: z.literal('effect.move'),
    ...seqId,
    itemId: id,
    effectId: id,
    index: z.number().int().min(0).max(64),
  }),
]);

export const commandSchema = z.union([
  singleCommandSchema,
  z.object({
    type: z.literal('batch'),
    commands: z.array(singleCommandSchema).min(1).max(1000),
  }),
]);
export type CommandInput = z.input<typeof commandSchema>;

export const documentStateSchema = z.object({
  doc: projectDocumentSchema,
  version: z.number().int(),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export type DocumentState = z.output<typeof documentStateSchema>;

export const exportQualitySchema = z.enum(['draft', 'standard', 'high']);

/** What the user picks in the export dialog (ADR-027). */
export const exportSettingsSchema = z
  .object({
    /** Output size as a fraction of the sequence size. */
    scale: z.number().min(0.25).max(1),
    codec: z.enum(['h264', 'hevc']),
    /** auto = graphics card when it works, otherwise software. */
    encoder: z.enum(['auto', 'gpu', 'cpu']),
    quality: exportQualitySchema,
    audioBitrate: z.union([z.literal(128), z.literal(192), z.literal(256), z.literal(320)]),
    /** Integrated loudness target in LUFS (two-pass), or null to leave levels alone. */
    loudness: z.number().min(-30).max(-5).nullable(),
  })
  .strict();
export type ExportSettings = z.output<typeof exportSettingsSchema>;

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  scale: 1,
  codec: 'h264',
  encoder: 'auto',
  quality: 'standard',
  audioBitrate: 192,
  loudness: -14,
};

export const exportStateSchema = z.object({
  state: z.enum(['idle', 'running', 'done', 'failed', 'cancelled']),
  progress: z.number().min(0).max(1),
  path: z.string().optional(),
  sequenceName: z.string().optional(),
  encoder: z.string().optional(),
  /** analysing = measuring loudness (pass 1); encoding = writing the file. */
  phase: z.enum(['analysing', 'encoding']).optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  sizeBytes: z.number().optional(),
  /** Set when the graphics card encoder failed and the export was redone in software. */
  note: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});
export type ExportState = z.output<typeof exportStateSchema>;
