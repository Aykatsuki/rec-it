import type { Flicks, Rational } from '../time';

/**
 * How a clip sits in the frame. `fill` covers the frame (cropping the overflow), `fit` shows
 * the whole picture (with bars). `scale` multiplies that size; `x`/`y` move the centre by a
 * fraction of the frame size (0 = centred), and `rotation` turns it around its centre. Preview and export both use computeLayout().
 */
export interface Transform {
  fit: 'fill' | 'fit';
  scale: number;
  x: number;
  y: number;
  /** Clockwise rotation in degrees, -180..180, around the picture's centre. */
  rotation: number;
  /** Part of the picture cut off each edge, as fractions of its size (ADR-034). */
  crop?: Crop;
}

export interface Crop {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The part of a `srcW × srcH` picture that a crop keeps, in whole, even pixels (so preview and
 * export cut exactly the same pixels, and H.264's chroma subsampling stays aligned).
 */
export function cropRect(
  srcW: number,
  srcH: number,
  crop: Crop | undefined,
): { x: number; y: number; w: number; h: number } {
  if (!crop) return { x: 0, y: 0, w: srcW, h: srcH };
  const evenDown = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
  const x = Math.min(evenDown(crop.left * srcW), Math.max(0, srcW - 2));
  const y = Math.min(evenDown(crop.top * srcH), Math.max(0, srcH - 2));
  const w = Math.max(2, Math.min(srcW - x, evenDown(srcW * (1 - crop.left - crop.right))));
  const h = Math.max(2, Math.min(srcH - y, evenDown(srcH * (1 - crop.top - crop.bottom))));
  return { x, y, w, h };
}

/** Properties that can be animated with keyframes. */
export type KeyframeProperty = 'x' | 'y' | 'scale' | 'rotation' | 'volume';
export const KEYFRAME_PROPERTIES: readonly KeyframeProperty[] = [
  'x',
  'y',
  'scale',
  'rotation',
  'volume',
];
/** How a value moves from this keyframe to the next. */
export type Easing = 'linear' | 'ease' | 'hold';

export interface Keyframe {
  /**
   * Time in the *source* media (flicks), so animation stays attached to the picture when the
   * clip is trimmed or split.
   */
  t: Flicks;
  v: number;
  e: Easing;
}

export interface TimelineItem {
  id: string;
  assetId: string;
  /** Position on the timeline. */
  start: Flicks;
  /** Length on the timeline. */
  duration: Flicks;
  /** Offset into the source media where the item begins. */
  sourceIn: Flicks;
  /** Linear gain, 0..2 (1 = unchanged). Applies to the clip's own audio. */
  volume: number;
  muted: boolean;
  transform: Transform;
  /**
   * Animated properties, each sorted by time. A property with keyframes ignores its static value
   * (transform.* or volume).
   */
  keyframes?: Partial<Record<KeyframeProperty, Keyframe[]>>;
  /** Clips sharing a linkId (a video and its detached sound) move, trim, split and delete together. */
  linkId?: string;
  /** Set on caption clips (on caption tracks; assetId is CAPTION_ASSET). ADR-033. */
  caption?: CaptionContent;
}

/** The pseudo media id of caption clips (they have no media file). */
export const CAPTION_ASSET = 'captions';

/**
 * A caption clip's words. Times are in the clip's own "source" time, like media: the word at
 * `start` shows at timeline time `item.start + (start - item.sourceIn)`. Trimming and splitting a
 * caption therefore work exactly like trimming and splitting a video clip.
 */
export interface CaptionContent {
  words: { text: string; start: Flicks; end: Flicks }[];
}

export const isCaption = (item: TimelineItem): boolean => item.caption !== undefined;

export type TrackKind = 'video' | 'audio' | 'caption';

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  hidden: boolean;
  locked: boolean;
  /** Sorted by start, never overlapping. */
  items: TimelineItem[];
}

export interface Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: Rational;
  /** Caption tracks first, then video tracks (top layer first), then audio tracks. */
  tracks: Track[];
  /** Automatic captions from the transcripts of the clips (ADR-032). Absent = off. */
  captions?: CaptionSettings;
}

/** Built-in caption looks (packages/captions defines them). */
export const CAPTION_STYLES = ['highlight', 'pop', 'karaoke', 'caps', 'clean', 'bebas'] as const;
export type CaptionStyleId = (typeof CAPTION_STYLES)[number];

export interface CaptionSettings {
  enabled: boolean;
  style: CaptionStyleId;
  /** Text size relative to the style's own size (0.5–2). */
  size: number;
  /** Vertical position of the caption's centre, as a fraction of the frame height (0.1–0.9). */
  position: number;
  /** Words per line (1–8) and lines per caption (1–2). */
  wordsPerLine: number;
  lines: 1 | 2;
  uppercase: boolean;
  /** Colour of the spoken word (highlight, pop, karaoke), "#RRGGBB". */
  highlight: string;
}

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: true,
  style: 'highlight',
  size: 1,
  position: 0.68,
  wordsPerLine: 3,
  lines: 2,
  uppercase: false,
  highlight: '#FFE600',
};

/**
 * Corrections to a transcript word, by asset and word index. `from` is the word as Whisper wrote
 * it, so a correction is ignored if the media is transcribed again and the word changed. `to`
 * may hold several words (they share the original timing) or be empty (hidden from captions).
 */
export type TranscriptEdits = Record<string, Record<number, { from: string; to: string }>>;

export interface ProjectDocument {
  schemaVersion: 1;
  sequences: Sequence[];
  activeSequenceId: string | null;
  transcriptEdits?: TranscriptEdits;
}

/** What commands need to know about media (supplied by the backend from the asset table). */
export interface AssetInfo {
  kind: 'video' | 'audio' | 'image';
  /** null for still images, which can be any length. */
  duration: Flicks | null;
  hasAudio: boolean;
  width?: number;
  height?: number;
}
export type AssetLookup = (assetId: string) => AssetInfo | undefined;

export const DEFAULT_TRANSFORM: Transform = { fit: 'fill', scale: 1, x: 0, y: 0, rotation: 0 };

/** Wraps an angle into -180..180. */
export function normalizeAngle(degrees: number): number {
  let a = degrees % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

export function emptyDocument(): ProjectDocument {
  return { schemaVersion: 1, sequences: [], activeSequenceId: null };
}

export function sequenceDuration(sequence: Sequence): Flicks {
  let end = 0;
  for (const track of sequence.tracks) {
    const last = track.items.at(-1);
    if (last) end = Math.max(end, last.start + last.duration);
  }
  return end as Flicks;
}

export function itemEnd(item: TimelineItem): Flicks {
  return (item.start + item.duration) as Flicks;
}

export interface Layout {
  /** Size and top-left position in output pixels, before rotation. */
  width: number;
  height: number;
  left: number;
  top: number;
  /** Rotation in degrees around the centre of that box. */
  rotation: number;
  /**
   * The rotated picture's bounding box (even sizes, centred on the same point). Equal to the
   * unrotated box when rotation is 0. Export rotates into this box and overlays it here.
   */
  bounds: { width: number; height: number; left: number; top: number };
  /** The part of the source picture shown (after cropping), in source pixels. */
  source: { x: number; y: number; w: number; h: number };
}

/** Where a source of `srcW`×`srcH` lands in a `frameW`×`frameH` frame. Shared by preview and export. */
export function computeLayout(
  fullW: number,
  fullH: number,
  frameW: number,
  frameH: number,
  t: Transform,
): Layout {
  // A cropped picture is laid out as if it were only the part that is kept.
  const source = cropRect(fullW, fullH, t.crop);
  const srcW = source.w;
  const srcH = source.h;
  const base =
    t.fit === 'fill'
      ? Math.max(frameW / srcW, frameH / srcH)
      : Math.min(frameW / srcW, frameH / srcH);
  const s = base * t.scale;
  // Even sizes keep H.264's chroma subsampling happy and match FFmpeg's scale filter.
  const width = Math.max(2, Math.round((srcW * s) / 2) * 2);
  const height = Math.max(2, Math.round((srcH * s) / 2) * 2);
  const left = Math.round((frameW - width) / 2 + t.x * frameW);
  const top = Math.round((frameH - height) / 2 + t.y * frameH);
  const rotation = normalizeAngle(t.rotation ?? 0);
  if (rotation === 0)
    return { width, height, left, top, rotation, bounds: { width, height, left, top }, source };
  const r = (rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  const bw = Math.ceil((width * cos + height * sin) / 2 - 1e-6) * 2;
  const bh = Math.ceil((width * sin + height * cos) / 2 - 1e-6) * 2;
  const bounds = {
    width: bw,
    height: bh,
    left: left + (width - bw) / 2,
    top: top + (height - bh) / 2,
  };
  return { width, height, left, top, rotation, bounds, source };
}

/** Easing curve applied to progress 0..1. */
export function ease(e: Easing, p: number): number {
  if (e === 'hold') return 0;
  if (e === 'ease') return p * p * (3 - 2 * p);
  return p;
}

/** Value of a keyframed property at source time `t` (holds before the first and after the last). */
export function valueAt(keys: readonly Keyframe[], t: number): number {
  const first = keys[0]!;
  if (t <= first.t) return first.v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t < b.t) return a.v + (b.v - a.v) * ease(a.e, (t - a.t) / (b.t - a.t));
  }
  return keys.at(-1)!.v;
}

/** Source-media time shown at timeline time `time` by this item. */
export const sourceTimeAt = (item: TimelineItem, time: number) =>
  item.sourceIn + (time - item.start);

const animated = (item: TimelineItem, p: KeyframeProperty) => {
  const k = item.keyframes?.[p];
  return k && k.length ? k : undefined;
};

export function hasKeyframes(item: TimelineItem, p?: KeyframeProperty): boolean {
  return p ? !!animated(item, p) : KEYFRAME_PROPERTIES.some((q) => animated(item, q));
}

/** The item's transform at timeline time `time`, with keyframes applied. */
export function transformAt(item: TimelineItem, time: number): Transform {
  if (!item.keyframes) return item.transform;
  const src = sourceTimeAt(item, time);
  const t = { ...item.transform };
  for (const p of ['x', 'y', 'scale', 'rotation'] as const) {
    const k = animated(item, p);
    if (k) t[p] = valueAt(k, src);
  }
  return t;
}

/** The item's volume at timeline time `time`, with keyframes applied. */
export function volumeAt(item: TimelineItem, time: number): number {
  const k = animated(item, 'volume');
  return k ? valueAt(k, sourceTimeAt(item, time)) : item.volume;
}
