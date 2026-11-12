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
}

export type TrackKind = 'video' | 'audio';

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
  /** Video tracks first, top layer first; then audio tracks. */
  tracks: Track[];
}

export interface ProjectDocument {
  schemaVersion: 1;
  sequences: Sequence[];
  activeSequenceId: string | null;
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
}

/** Where a source of `srcW`×`srcH` lands in a `frameW`×`frameH` frame. Shared by preview and export. */
export function computeLayout(
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  t: Transform,
): Layout {
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
    return { width, height, left, top, rotation, bounds: { width, height, left, top } };
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
  return { width, height, left, top, rotation, bounds };
}
