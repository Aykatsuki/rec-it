import { createId } from '../ids';
import { snapToFrame, secondsToFlicks, type Flicks, type Rational } from '../time';
import {
  DEFAULT_TRANSFORM,
  itemEnd,
  type AssetLookup,
  type ProjectDocument,
  type Sequence,
  type TimelineItem,
  type Track,
  type TrackKind,
  type Transform,
} from './model';

/** Default length for still images dropped on the timeline. */
export const STILL_DURATION = secondsToFlicks(5);
/** Shortest item the editor allows (one frame is enforced too). */
const MIN_DURATION = secondsToFlicks(0.04);

export type Command =
  | {
      type: 'sequence.create';
      id?: string;
      name: string;
      width: number;
      height: number;
      fps: Rational;
    }
  | {
      type: 'sequence.update';
      sequenceId: string;
      name?: string;
      width?: number;
      height?: number;
      fps?: Rational;
    }
  | { type: 'track.add'; sequenceId: string; kind: TrackKind; id?: string }
  | {
      type: 'track.update';
      sequenceId: string;
      trackId: string;
      muted?: boolean;
      hidden?: boolean;
      locked?: boolean;
    }
  | {
      type: 'item.add';
      sequenceId: string;
      trackId: string;
      assetId: string;
      start: number;
      id?: string;
      sourceIn?: number;
      duration?: number;
    }
  | { type: 'item.move'; sequenceId: string; itemId: string; trackId: string; start: number }
  | { type: 'item.trim'; sequenceId: string; itemId: string; edge: 'start' | 'end'; time: number }
  | { type: 'item.split'; sequenceId: string; time: number; itemIds?: string[] }
  | { type: 'item.remove'; sequenceId: string; itemIds: string[]; ripple?: boolean }
  | {
      type: 'item.update';
      sequenceId: string;
      itemId: string;
      volume?: number;
      muted?: boolean;
      transform?: Partial<Transform>;
    };

export class CommandError extends Error {
  override name = 'CommandError';
}

const fail = (message: string): never => {
  throw new CommandError(message);
};

function sequenceOf(doc: ProjectDocument, id: string): Sequence {
  return doc.sequences.find((s) => s.id === id) ?? fail('That sequence no longer exists.');
}

function trackOf(seq: Sequence, id: string): Track {
  return seq.tracks.find((t) => t.id === id) ?? fail('That track no longer exists.');
}

function findItem(seq: Sequence, id: string): { track: Track; item: TimelineItem; index: number } {
  for (const track of seq.tracks) {
    const index = track.items.findIndex((i) => i.id === id);
    if (index >= 0) return { track, item: track.items[index]!, index };
  }
  return fail('That clip no longer exists.');
}

function unlocked(track: Track): void {
  if (track.locked) fail(`Track ${track.name} is locked.`);
}

const snap = (seq: Sequence, t: number) =>
  Math.max(0, snapToFrame(Math.round(t) as Flicks, seq.fps)) as Flicks;

function sortItems(track: Track): void {
  track.items.sort((a, b) => a.start - b.start);
}

/**
 * Overwrite edit: removes or shortens anything on `track` between start and end, splitting an
 * item that spans the whole range. Keeps the "no overlap" invariant.
 */
function clearRange(track: Track, start: number, end: number, exceptId?: string): void {
  const next: TimelineItem[] = [];
  for (const item of track.items) {
    const a = item.start;
    const b = itemEnd(item);
    if (item.id === exceptId || b <= start || a >= end) {
      next.push(item);
      continue;
    }
    if (a < start) next.push({ ...item, duration: (start - a) as Flicks });
    if (b > end) {
      next.push({
        ...item,
        id: a < start ? createId('item') : item.id,
        start: end as Flicks,
        duration: (b - end) as Flicks,
        sourceIn: (item.sourceIn + (end - a)) as Flicks,
      });
    }
  }
  track.items = next;
  sortItems(track);
}

function checkPlacement(track: Track, kind: 'video' | 'audio' | 'image', hasAudio: boolean): void {
  if (track.kind === 'video' && kind === 'audio') fail('Audio files go on an audio track.');
  if (track.kind === 'audio' && kind === 'image') fail('Images go on a video track.');
  if (track.kind === 'audio' && kind === 'video' && !hasAudio)
    fail('This video has no sound to put on an audio track.');
}

function nextTrackNumber(seq: Sequence, kind: TrackKind): number {
  const used = new Set(seq.tracks.filter((t) => t.kind === kind).map((t) => t.name));
  let n = 1;
  while (used.has(`${kind === 'video' ? 'V' : 'A'}${n}`)) n++;
  return n;
}

/** Applies a command to a mutable draft (Immer). Throws CommandError when it is not allowed. */
export function applyCommand(doc: ProjectDocument, command: Command, assets: AssetLookup): void {
  switch (command.type) {
    case 'sequence.create': {
      validSize(command.width, command.height);
      const seq: Sequence = {
        id: command.id ?? createId('sequence'),
        name: command.name.trim() || 'Sequence',
        width: command.width,
        height: command.height,
        fps: command.fps,
        tracks: [
          blankTrack('video', 'V2'),
          blankTrack('video', 'V1'),
          blankTrack('audio', 'A1'),
          blankTrack('audio', 'A2'),
        ],
      };
      doc.sequences.push(seq);
      doc.activeSequenceId = seq.id;
      return;
    }
    case 'sequence.update': {
      const seq = sequenceOf(doc, command.sequenceId);
      if (command.name !== undefined) seq.name = command.name.trim() || seq.name;
      if (command.width !== undefined || command.height !== undefined) {
        validSize(command.width ?? seq.width, command.height ?? seq.height);
        seq.width = command.width ?? seq.width;
        seq.height = command.height ?? seq.height;
      }
      if (command.fps) {
        seq.fps = command.fps;
        // Re-align every edit to the new frame grid.
        for (const track of seq.tracks) {
          for (const item of track.items) {
            const start = snap(seq, item.start);
            const end = snap(seq, itemEnd(item));
            item.start = start;
            item.duration = Math.max(end - start, snap(seq, MIN_DURATION) || 1) as Flicks;
          }
          fixOverlaps(track);
        }
      }
      return;
    }
    case 'track.add': {
      const seq = sequenceOf(doc, command.sequenceId);
      const n = nextTrackNumber(seq, command.kind);
      const track = blankTrack(
        command.kind,
        `${command.kind === 'video' ? 'V' : 'A'}${n}`,
        command.id,
      );
      if (command.kind === 'video') seq.tracks.unshift(track);
      else seq.tracks.push(track);
      return;
    }
    case 'track.update': {
      const track = trackOf(sequenceOf(doc, command.sequenceId), command.trackId);
      if (command.muted !== undefined) track.muted = command.muted;
      if (command.hidden !== undefined) track.hidden = command.hidden;
      if (command.locked !== undefined) track.locked = command.locked;
      return;
    }
    case 'item.add': {
      const seq = sequenceOf(doc, command.sequenceId);
      const track = trackOf(seq, command.trackId);
      unlocked(track);
      const asset = assets(command.assetId) ?? fail('That media is not ready yet.');
      checkPlacement(track, asset.kind, asset.hasAudio);
      const sourceIn = snap(seq, command.sourceIn ?? 0);
      const available = asset.duration === null ? Infinity : asset.duration - sourceIn;
      if (available <= 0) fail('The clip starts after the end of the media.');
      const wanted = command.duration ?? (asset.duration === null ? STILL_DURATION : available);
      const start = snap(seq, command.start);
      const duration = Math.max(1, Math.min(wanted, available)) as Flicks;
      const end = snap(seq, start + duration) || start + duration;
      clearRange(track, start, end);
      track.items.push({
        id: command.id ?? createId('item'),
        assetId: command.assetId,
        start,
        duration: (end - start) as Flicks,
        sourceIn,
        volume: 1,
        muted: false,
        transform: { ...DEFAULT_TRANSFORM },
      });
      sortItems(track);
      return;
    }
    case 'item.move': {
      const seq = sequenceOf(doc, command.sequenceId);
      const from = findItem(seq, command.itemId);
      const to = trackOf(seq, command.trackId);
      unlocked(from.track);
      unlocked(to);
      if (to.kind !== from.track.kind) {
        const asset = assets(from.item.assetId);
        if (!asset) fail('That media is missing.');
        else checkPlacement(to, asset.kind, asset.hasAudio);
      }
      const item = { ...from.item, start: snap(seq, command.start) };
      from.track.items.splice(from.index, 1);
      clearRange(to, item.start, itemEnd(item));
      to.items.push(item);
      sortItems(to);
      return;
    }
    case 'item.trim': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item, index } = findItem(seq, command.itemId);
      unlocked(track);
      const asset = assets(item.assetId);
      const sourceEnd = asset?.duration ?? Infinity;
      const minLen = Math.max(snap(seq, MIN_DURATION), 1);
      const prevEnd = index > 0 ? itemEnd(track.items[index - 1]!) : 0;
      const nextStart = track.items[index + 1]?.start ?? Infinity;
      const time = snap(seq, command.time);
      if (command.edge === 'start') {
        // The earliest possible start is limited by the source's first frame and the previous clip.
        const earliest = Math.max(prevEnd, item.start - item.sourceIn);
        const newStart = Math.min(Math.max(time, earliest), itemEnd(item) - minLen);
        const delta = newStart - item.start;
        item.sourceIn = (item.sourceIn + delta) as Flicks;
        item.duration = (item.duration - delta) as Flicks;
        item.start = newStart as Flicks;
      } else {
        const latest = Math.min(nextStart, item.start + (sourceEnd - item.sourceIn));
        const newEnd = Math.max(Math.min(time, latest), item.start + minLen);
        item.duration = (newEnd - item.start) as Flicks;
      }
      return;
    }
    case 'item.split': {
      const seq = sequenceOf(doc, command.sequenceId);
      const time = snap(seq, command.time);
      const only = command.itemIds ? new Set(command.itemIds) : null;
      let split = 0;
      for (const track of seq.tracks) {
        if (track.locked) continue;
        const next: TimelineItem[] = [];
        for (const item of track.items) {
          const inside = time > item.start && time < itemEnd(item);
          if (!inside || (only && !only.has(item.id))) {
            next.push(item);
            continue;
          }
          const first = time - item.start;
          next.push({ ...item, duration: first as Flicks });
          next.push({
            ...item,
            id: createId('item'),
            start: time,
            duration: (item.duration - first) as Flicks,
            sourceIn: (item.sourceIn + first) as Flicks,
          });
          split++;
        }
        track.items = next;
      }
      if (!split) fail('There is no clip under the playhead to split.');
      return;
    }
    case 'item.remove': {
      const seq = sequenceOf(doc, command.sequenceId);
      const ids = new Set(command.itemIds);
      for (const track of seq.tracks) {
        const removed = track.items.filter((i) => ids.has(i.id));
        if (!removed.length) continue;
        unlocked(track);
        track.items = track.items.filter((i) => !ids.has(i.id));
        if (command.ripple) {
          // Close the gaps: shift later items left by the removed lengths before them.
          for (const item of track.items) {
            const shift = removed
              .filter((r) => r.start < item.start)
              .reduce((n, r) => n + r.duration, 0);
            item.start = (item.start - shift) as Flicks;
          }
        }
      }
      return;
    }
    case 'item.update': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      if (command.volume !== undefined) item.volume = Math.min(2, Math.max(0, command.volume));
      if (command.muted !== undefined) item.muted = command.muted;
      if (command.transform) {
        const t = { ...item.transform, ...command.transform };
        item.transform = {
          fit: t.fit === 'fit' ? 'fit' : 'fill',
          scale: Math.min(10, Math.max(0.05, t.scale)),
          x: Math.min(2, Math.max(-2, t.x)),
          y: Math.min(2, Math.max(-2, t.y)),
        };
      }
      return;
    }
  }
}

function blankTrack(kind: TrackKind, name: string, id?: string): Track {
  return {
    id: id ?? createId('track'),
    kind,
    name,
    muted: false,
    hidden: false,
    locked: false,
    items: [],
  };
}

function validSize(width: number, height: number): void {
  const ok = (n: number) => Number.isInteger(n) && n >= 16 && n <= 7680 && n % 2 === 0;
  if (!ok(width) || !ok(height)) fail('Width and height must be even numbers between 16 and 7680.');
}

/** After re-snapping, adjacent items can overlap by a frame; trim the earlier one. */
function fixOverlaps(track: Track): void {
  sortItems(track);
  for (let i = 1; i < track.items.length; i++) {
    const prev = track.items[i - 1]!;
    const cur = track.items[i]!;
    if (itemEnd(prev) > cur.start) prev.duration = Math.max(1, cur.start - prev.start) as Flicks;
  }
}

/** Throws if a document breaks an invariant. Used by tests and on load. */
export function checkInvariants(doc: ProjectDocument): void {
  for (const seq of doc.sequences) {
    for (const track of seq.tracks) {
      for (let i = 0; i < track.items.length; i++) {
        const item = track.items[i]!;
        if (!Number.isSafeInteger(item.start) || item.start < 0) fail(`Bad start on ${item.id}`);
        if (!Number.isSafeInteger(item.duration) || item.duration <= 0)
          fail(`Bad duration on ${item.id}`);
        if (item.sourceIn < 0) fail(`Bad sourceIn on ${item.id}`);
        const prev = track.items[i - 1];
        if (prev && itemEnd(prev) > item.start) fail(`Overlap on ${track.name} at ${item.id}`);
      }
    }
  }
}
