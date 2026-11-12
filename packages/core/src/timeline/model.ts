import type { Flicks, Rational } from '../time';

/**
 * How a clip sits in the frame. `fill` covers the frame (cropping the overflow), `fit` shows
 * the whole picture (with bars). `scale` multiplies that size; `x`/`y` move the centre by a
 * fraction of the frame size (0 = centred). Preview and export both use computeLayout().
 */
export interface Transform {
  fit: 'fill' | 'fit';
  scale: number;
  x: number;
  y: number;
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

export const DEFAULT_TRANSFORM: Transform = { fit: 'fill', scale: 1, x: 0, y: 0 };

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
  /** Size and top-left position in output pixels. */
  width: number;
  height: number;
  left: number;
  top: number;
}

/** Where a source of `srcW`×`srcH` lands in a `frameW`×`frameH` frame. Shared by preview and export. */
export function computeLayout(srcW: number, srcH: number, frameW: number, frameH: number, t: Transform): Layout {
  const base = t.fit === 'fill' ? Math.max(frameW / srcW, frameH / srcH) : Math.min(frameW / srcW, frameH / srcH);
  const s = base * t.scale;
  // Even sizes keep H.264's chroma subsampling happy and match FFmpeg's scale filter.
  const width = Math.max(2, Math.round((srcW * s) / 2) * 2);
  const height = Math.max(2, Math.round((srcH * s) / 2) * 2);
  const left = Math.round((frameW - width) / 2 + t.x * frameW);
  const top = Math.round((frameH - height) / 2 + t.y * frameH);
  return { width, height, left, top };
}
