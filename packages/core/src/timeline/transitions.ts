// Transitions between adjacent clips on one track (ADR-037). The document stores a transition on
// the clip after the cut (`transitionIn`); presentSequence() turns it into what preview and
// export draw: overlapping, faded clips. Everything else keeps using the plain timeline.
import type { Flicks } from '../time';
import {
  itemEnd,
  itemHandles,
  sliceItem,
  type Sequence,
  type TimelineItem,
  type Track,
} from './model';

/**
 * Length of an asset's media in flicks; null for still images (any length); undefined when
 * unknown (no extra media is assumed).
 */
export type MediaLength = (assetId: string) => number | null | undefined;

export interface TransitionSpan {
  /** The clip before the cut (A) and after it (B, which stores the transition). */
  fromId: string;
  toId: string;
  kind: NonNullable<TimelineItem['transitionIn']>['kind'];
  /** Timeline time of the cut, and where the transition starts and ends. */
  cut: Flicks;
  start: Flicks;
  end: Flicks;
}

/** Extra media after a clip's end and before its start (Infinity for stills). */
function handles(item: TimelineItem, length: MediaLength): { before: number; after: number } {
  return itemHandles(item, length(item.assetId));
}

/** The transitions a track shows, with their real extent. */
export function transitionSpans(track: Track, length: MediaLength): TransitionSpan[] {
  const spans: TransitionSpan[] = [];
  if (track.kind === 'caption') return spans;
  for (let i = 1; i < track.items.length; i++) {
    const b = track.items[i]!;
    const a = track.items[i - 1]!;
    const t = b.transitionIn;
    if (!t || itemEnd(a) !== b.start || t.duration <= 0) continue;
    const d = Math.min(t.duration, a.duration, b.duration);
    let pre: number;
    let post: number;
    if (t.kind === 'dissolve') {
      // Centred on the cut, using extra media before B and after A; when one side has too
      // little, the other side gives more.
      const hA = Math.min(handles(a, length).after, b.duration);
      const hB = Math.min(handles(b, length).before, a.duration);
      pre = Math.min(d / 2, hB);
      post = Math.min(d / 2, hA);
      if (pre < d / 2) post = Math.min(d - pre, hA);
      if (post < d / 2) pre = Math.min(d - post, hB);
      pre = Math.floor(pre);
      post = Math.floor(post);
    } else {
      pre = Math.floor(d / 2);
      post = Math.floor(d / 2);
    }
    if (pre + post <= 0) continue;
    spans.push({
      fromId: a.id,
      toId: b.id,
      kind: t.kind,
      cut: b.start,
      start: (b.start - pre) as Flicks,
      end: (b.start + post) as Flicks,
    });
  }
  return spans;
}

const zero = 0 as Flicks;

/**
 * The track's clips as preview and export draw them. Cross dissolve: B starts earlier (playing
 * the media before its in point) and fades in over A, which plays on past the cut underneath
 * while its sound fades out. Dip to black/white: A fades to the colour, B fades from it, and the
 * sound dips with it. The fades a transition replaces (A's fade-out, B's fade-in) are not used.
 */
export function presentTrack(track: Track, length: MediaLength): TimelineItem[] {
  const spans = transitionSpans(track, length);
  if (!spans.length) return track.items;
  const out = new Map(track.items.map((i) => [i.id, { ...i }]));
  for (const s of spans) {
    const a = out.get(s.fromId)!;
    const b = out.get(s.toId)!;
    const pre = s.cut - s.start;
    const post = s.end - s.cut;
    const fadeA = { in: a.fade?.in ?? zero, out: zero };
    const fadeB = { in: zero, out: b.fade?.out ?? zero };
    if (s.kind === 'dissolve') {
      Object.assign(a, sliceItem(a, a.start, itemEnd(a) + post));
      a.audioFade = { in: a.audioFade?.in ?? zero, out: (pre + post) as Flicks };
      Object.assign(b, sliceItem(b, s.start, itemEnd(b)));
      fadeB.in = (pre + post) as Flicks;
    } else {
      const color = s.kind === 'dipWhite' ? 'white' : 'black';
      a.tint = { in: a.tint?.in ?? zero, out: pre as Flicks, color };
      a.audioFade = { in: a.audioFade?.in ?? zero, out: pre as Flicks };
      b.tint = { in: post as Flicks, out: b.tint?.out ?? zero, color };
      b.audioFade = { in: post as Flicks, out: b.audioFade?.out ?? zero };
    }
    setFade(a, fadeA);
    setFade(b, fadeB);
  }
  return track.items.map((i) => out.get(i.id)!);
}

function setFade(item: TimelineItem, fade: { in: Flicks; out: Flicks }): void {
  if (fade.in > 0 || fade.out > 0) item.fade = fade;
  else delete item.fade;
}

/** The sequence with every track presented (same ids; for preview and export only). */
export function presentSequence(seq: Sequence, length: MediaLength): Sequence {
  const tracks = seq.tracks.map((t) => {
    const items = presentTrack(t, length);
    return items === t.items ? t : { ...t, items };
  });
  return tracks.every((t, i) => t === seq.tracks[i]) ? seq : { ...seq, tracks };
}
