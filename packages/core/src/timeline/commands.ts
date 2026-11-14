import { createId } from '../ids';
import { frameDuration, snapToFrame, secondsToFlicks, type Flicks, type Rational } from '../time';
import {
  EFFECT_KINDS,
  type EffectKind,
  CAPTION_ASSET,
  CAPTION_STYLES,
  type CaptionContent,
  DEFAULT_CAPTIONS,
  DEFAULT_TRANSFORM,
  type CaptionSettings,
  itemEnd,
  normalizeAngle,
  type AssetLookup,
  type ProjectDocument,
  type Sequence,
  type TimelineItem,
  type Track,
  type TrackKind,
  type Crop,
  type Transform,
  type Easing,
  type KeyframeProperty,
  valueAt,
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
  /** Deletes a track and every clip on it. The last video or audio track cannot be deleted. */
  | { type: 'track.remove'; sequenceId: string; trackId: string }
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
      volume?: number;
      muted?: boolean;
      transform?: Partial<Transform>;
    }
  | { type: 'item.move'; sequenceId: string; itemId: string; trackId: string; start: number }
  | {
      type: 'item.moveMany';
      sequenceId: string;
      moves: { itemId: string; trackId: string; start: number }[];
    }
  | {
      type: 'item.trim';
      sequenceId: string;
      itemId: string;
      edge: 'start' | 'end';
      time: number;
      /** Internal: trim this clip only, not its linked partners. */
      solo?: boolean;
    }
  /** Links clips (at least two) so they edit together; `linkId` is generated if omitted. */
  | { type: 'item.link'; sequenceId: string; itemIds: string[]; linkId?: string }
  /** Unlinks these clips and their partners. */
  | { type: 'item.unlink'; sequenceId: string; itemIds: string[] }
  /** Adds or replaces the keyframe at source time `t` (snapped to the frame grid). */
  | {
      type: 'keyframe.set';
      sequenceId: string;
      itemId: string;
      property: KeyframeProperty;
      t: number;
      value: number;
      easing?: Easing;
    }
  /**
   * Removes the keyframe at `t`. Removing the last one keeps its value as the static value, so
   * nothing jumps.
   */
  | {
      type: 'keyframe.remove';
      sequenceId: string;
      itemId: string;
      property: KeyframeProperty;
      t: number;
    }
  /** Removes all keyframes of a property, keeping the value at `t` as the static value. */
  | {
      type: 'keyframe.clear';
      sequenceId: string;
      itemId: string;
      property: KeyframeProperty;
      t: number;
    }
  | { type: 'item.split'; sequenceId: string; time: number; itemIds?: string[] }
  | { type: 'item.remove'; sequenceId: string; itemIds: string[]; ripple?: boolean }
  /**
   * Cuts a stretch out of a clip and its linked partners, given in *source* time (as transcript
   * words are). With ripple, later clips on those tracks move left to close the gap.
   */
  | {
      type: 'item.cutRange';
      sequenceId: string;
      itemId: string;
      from: number;
      to: number;
      ripple?: boolean;
    }
  | {
      type: 'item.update';
      sequenceId: string;
      itemId: string;
      volume?: number;
      muted?: boolean;
      transform?: Partial<Transform>;
      opacity?: number;
      /** Fade lengths in flicks; each is limited so the two fit in the clip. */
      fade?: { in?: number; out?: number };
    }
  /** Adds an effect to the end of a clip's effect stack (ADR-036). */
  | { type: 'effect.add'; sequenceId: string; itemId: string; kind: EffectKind; id?: string }
  | {
      type: 'effect.update';
      sequenceId: string;
      itemId: string;
      effectId: string;
      enabled?: boolean;
      params?: Partial<Record<'brightness' | 'contrast' | 'saturation', number>>;
    }
  | { type: 'effect.remove'; sequenceId: string; itemId: string; effectId: string }
  /** Moves an effect to position `index` in the stack (order matters). */
  | { type: 'effect.move'; sequenceId: string; itemId: string; effectId: string; index: number }
  /** Turns automatic captions on or off and changes their look (ADR-032). */
  | { type: 'captions.update'; sequenceId: string; captions: Partial<CaptionSettings> }
  /**
   * Puts captions on a caption track (creating one at the top if needed), replacing what was
   * there. Times are timeline flicks. ADR-033.
   */
  | {
      type: 'captions.generate';
      sequenceId: string;
      trackId?: string;
      captions: {
        start: number;
        duration: number;
        words: { text: string; start: number; end: number }[];
      }[];
    }
  /** Adds one caption clip with the given text, its words spread evenly over its length. */
  | {
      type: 'caption.add';
      sequenceId: string;
      trackId: string;
      start: number;
      duration: number;
      text: string;
      /** Exact word timings (flicks from the clip's start), e.g. when pasting. */
      words?: { text: string; start: number; end: number }[];
      transform?: Partial<Transform>;
      id?: string;
    }
  /** Replaces a caption clip's text; timing is kept per word when the word count is unchanged. */
  | { type: 'caption.edit'; sequenceId: string; itemId: string; text: string }
  /** Corrects one transcript word (empty text hides it from captions). */
  | { type: 'transcript.editWord'; assetId: string; index: number; from: string; to: string }
  /** Several commands applied as one undo step. Fails as a whole if any part fails. */
  | { type: 'batch'; commands: Command[] };

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

const frameOf = (seq: Sequence) => frameDuration(seq.fps);

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
        // An overwrite that cuts a linked clip in two keeps only the first part linked.
        ...(a < start ? { linkId: undefined } : {}),
        start: end as Flicks,
        duration: (b - end) as Flicks,
        sourceIn: (item.sourceIn + (end - a)) as Flicks,
      });
    }
  }
  track.items = next;
  sortItems(track);
}

/** A piece of a split clip keeps only the fade at its own outer edge. */
function withoutFade(item: TimelineItem, side: 'in' | 'out' | null): TimelineItem {
  if (!side || !item.fade) return item;
  const fade = { ...item.fade, [side]: 0 as Flicks };
  const { fade: _old, ...rest } = item;
  const piece: TimelineItem = fade.in || fade.out ? { ...rest, fade } : rest;
  if (piece.fade) {
    const out = Math.min(piece.fade.out, piece.duration);
    piece.fade = {
      in: Math.min(piece.fade.in, piece.duration - out) as Flicks,
      out: out as Flicks,
    };
  }
  return piece;
}

/** Fades never overlap: when the clip gets shorter, the fade-out keeps its length first. */
function fitFades(seq: Sequence, item: TimelineItem): void {
  if (!item.fade) return;
  const d = item.duration;
  const out = Math.min(item.fade.out, d);
  const inn = Math.min(item.fade.in, d - out);
  if (inn <= 0 && out <= 0) delete item.fade;
  else item.fade = { in: Math.max(0, inn) as Flicks, out: Math.max(0, out) as Flicks };
  void seq;
}

const TRACK_LETTER: Record<TrackKind, string> = { video: 'V', audio: 'A', caption: 'C' };

function captionItem(
  id: string,
  start: number,
  duration: number,
  words: CaptionContent['words'],
): TimelineItem {
  return {
    id,
    assetId: CAPTION_ASSET,
    start: start as Flicks,
    duration: duration as Flicks,
    sourceIn: 0 as Flicks,
    volume: 1,
    muted: false,
    transform: { ...DEFAULT_TRANSFORM },
    caption: { words },
  };
}

/** Words of `text` spread over [from, to) (flicks) by letter count. */
function spreadWords(text: string, from: number, to: number): CaptionContent['words'] {
  const texts = text.split(/\s+/).filter(Boolean);
  const total = texts.reduce((n, t) => n + t.length, 0) || 1;
  let t = from;
  return texts.map((w, i) => {
    const end = i === texts.length - 1 ? to : t + Math.round(((to - from) * w.length) / total);
    const word = { text: w, start: Math.round(t) as Flicks, end: Math.round(end) as Flicks };
    t = end;
    return word;
  });
}

function checkPlacement(track: Track, kind: 'video' | 'audio' | 'image', hasAudio: boolean): void {
  if (track.kind === 'caption') fail('Only captions go on caption tracks.');
  if (track.kind === 'video' && kind === 'audio') fail('Audio files go on an audio track.');
  if (track.kind === 'audio' && kind === 'image') fail('Images go on a video track.');
  if (track.kind === 'audio' && kind === 'video' && !hasAudio)
    fail('This video has no sound to put on an audio track.');
}

function nextTrackNumber(seq: Sequence, kind: TrackKind): number {
  const used = new Set(seq.tracks.filter((t) => t.kind === kind).map((t) => t.name));
  let n = 1;
  while (used.has(`${TRACK_LETTER[kind]}${n}`)) n++;
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
      const track = blankTrack(command.kind, `${TRACK_LETTER[command.kind]}${n}`, command.id);
      if (command.kind === 'caption') seq.tracks.unshift(track);
      else if (command.kind === 'video') {
        // New video tracks go on top of the video tracks, below any caption tracks.
        const firstVideo = seq.tracks.findIndex((t) => t.kind === 'video');
        seq.tracks.splice(firstVideo < 0 ? 0 : firstVideo, 0, track);
      } else seq.tracks.push(track);
      return;
    }
    case 'track.remove': {
      const seq = sequenceOf(doc, command.sequenceId);
      const track = trackOf(seq, command.trackId);
      unlocked(track);
      if (track.kind !== 'caption' && seq.tracks.filter((t) => t.kind === track.kind).length <= 1)
        fail(`A sequence needs at least one ${track.kind} track.`);
      seq.tracks = seq.tracks.filter((t) => t.id !== track.id);
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
        volume: clampVolume(command.volume ?? 1),
        muted: command.muted ?? false,
        transform: cleanTransform({ ...DEFAULT_TRANSFORM, ...command.transform }),
      });
      sortItems(track);
      return;
    }
    case 'item.move': {
      // Same as moving a group of one (linked partners follow).
      applyCommand(
        doc,
        {
          type: 'item.moveMany',
          sequenceId: command.sequenceId,
          moves: [{ itemId: command.itemId, trackId: command.trackId, start: command.start }],
        },
        assets,
      );
      return;
    }
    case 'item.moveMany': {
      const seq = sequenceOf(doc, command.sequenceId);
      // Linked partners move by the same amount, staying on their own tracks.
      const moves = [...command.moves];
      const moving = new Set(moves.map((m) => m.itemId));
      for (const move of command.moves) {
        const { item } = findItem(seq, move.itemId);
        for (const p of partnersOf(seq, item)) {
          if (moving.has(p.item.id)) continue;
          moving.add(p.item.id);
          moves.push({
            itemId: p.item.id,
            trackId: p.track.id,
            start: Math.max(0, p.item.start + (move.start - item.start)),
          });
        }
      }
      // Take every moving clip out first so they cannot overwrite each other on the way.
      const lifted = moves.map((move) => {
        const from = findItem(seq, move.itemId);
        const to = trackOf(seq, move.trackId);
        unlocked(from.track);
        unlocked(to);
        if ((to.kind === 'caption') !== !!from.item.caption)
          fail(
            from.item.caption
              ? 'Captions stay on caption tracks.'
              : 'Only captions go on caption tracks.',
          );
        if (to.kind !== from.track.kind) {
          const asset = assets(from.item.assetId);
          if (!asset) fail('That media is missing.');
          else checkPlacement(to, asset.kind, asset.hasAudio);
        }
        return { item: { ...from.item, start: snap(seq, move.start) }, to };
      });
      for (const track of seq.tracks) track.items = track.items.filter((i) => !moving.has(i.id));
      for (const { item, to } of lifted) {
        clearRange(to, item.start, itemEnd(item));
        to.items.push(item);
        sortItems(to);
      }
      return;
    }
    case 'batch': {
      if (!command.commands.length) fail('Nothing to do.');
      for (const sub of command.commands) {
        if (sub.type === 'batch') fail('Batches cannot be nested.');
        applyCommand(doc, sub, assets);
      }
      return;
    }
    case 'item.trim': {
      trimOne(doc, command, assets);
      if (command.solo) return;
      // Linked partners get the same edge, each limited by its own media and neighbours.
      const seq = sequenceOf(doc, command.sequenceId);
      const { item } = findItem(seq, command.itemId);
      const edge = command.edge === 'start' ? item.start : itemEnd(item);
      for (const p of partnersOf(seq, item))
        trimOne(doc, { ...command, itemId: p.item.id, time: edge, solo: true }, assets);
      return;
    }
    case 'item.split': {
      const seq = sequenceOf(doc, command.sequenceId);
      const time = snap(seq, command.time);
      const only = command.itemIds ? new Set(command.itemIds) : null;
      if (only)
        for (const id of [...only]) {
          const found = seq.tracks.flatMap((t) => t.items).find((i) => i.id === id);
          if (found) for (const p of partnersOf(seq, found)) only.add(p.item.id);
        }
      // The right-hand pieces of linked clips are linked to each other with a new id.
      const newLinks = new Map<string, string>();
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
          next.push(withoutFade({ ...item, duration: first as Flicks }, 'out'));
          let linkId = item.linkId;
          if (linkId) {
            if (!newLinks.has(linkId)) newLinks.set(linkId, createId('link'));
            linkId = newLinks.get(linkId);
          }
          next.push(
            withoutFade(
              {
                ...item,
                id: createId('item'),
                start: time,
                duration: (item.duration - first) as Flicks,
                sourceIn: (item.sourceIn + first) as Flicks,
                ...(linkId ? { linkId } : {}),
              },
              'in',
            ),
          );
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
      for (const track of seq.tracks)
        for (const item of track.items)
          if (ids.has(item.id)) for (const p of partnersOf(seq, item)) ids.add(p.item.id);
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
    case 'item.cutRange': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { item, track } = findItem(seq, command.itemId);
      const a = Math.max(item.start, snap(seq, item.start + (command.from - item.sourceIn)));
      const b = Math.min(itemEnd(item), snap(seq, item.start + (command.to - item.sourceIn)));
      if (b - a < frameOf(seq)) fail('That part of the clip is shorter than a frame.');
      const targets = [{ track, item }, ...partnersOf(seq, item)];
      for (const t of targets) unlocked(t.track);
      const newLinks = new Map<string, string>();
      for (const { track: tr, item: it } of targets) {
        const end = itemEnd(it);
        const left = a > it.start;
        const right = b < end;
        const pieces: TimelineItem[] = [];
        if (left)
          pieces.push(
            withoutFade(
              { ...it, duration: (Math.min(a, end) - it.start) as Flicks },
              right ? 'out' : null,
            ),
          );
        if (right) {
          const cut = Math.max(b, it.start);
          let linkId = it.linkId;
          if (left && linkId) {
            if (!newLinks.has(linkId)) newLinks.set(linkId, createId('link'));
            linkId = newLinks.get(linkId);
          }
          pieces.push(
            withoutFade(
              {
                ...it,
                id: left ? createId('item') : it.id,
                start: cut as Flicks,
                duration: (end - cut) as Flicks,
                sourceIn: (it.sourceIn + (cut - it.start)) as Flicks,
                ...(linkId ? { linkId } : {}),
              },
              left ? 'in' : null,
            ),
          );
        }
        tr.items = tr.items.flatMap((x) => (x.id === it.id ? pieces : [x]));
      }
      if (command.ripple) {
        const gap = b - a;
        for (const tr of new Set(targets.map((t) => t.track)))
          for (const x of tr.items) if (x.start >= b) x.start = (x.start - gap) as Flicks;
      }
      for (const tr of new Set(targets.map((t) => t.track))) sortItems(tr);
      return;
    }
    case 'captions.update': {
      const seq = sequenceOf(doc, command.sequenceId);
      const next = { ...DEFAULT_CAPTIONS, ...seq.captions, ...command.captions };
      if (!CAPTION_STYLES.includes(next.style)) fail('Unknown caption style.');
      if (!/^#[0-9a-fA-F]{6}$/.test(next.highlight)) fail('Colours look like #FFE600.');
      next.size = Math.min(2, Math.max(0.5, next.size));
      next.position = Math.min(0.9, Math.max(0.1, next.position));
      next.wordsPerLine = Math.min(8, Math.max(1, Math.round(next.wordsPerLine)));
      next.lines = next.lines === 1 ? 1 : 2;
      seq.captions = next;
      return;
    }
    case 'transcript.editWord': {
      if (!Number.isInteger(command.index) || command.index < 0) fail('No such word.');
      const to = command.to.replace(/\s+/g, ' ').trim();
      if (to.length > 200) fail('That correction is too long.');
      const edits = (doc.transcriptEdits ??= {});
      const forAsset = (edits[command.assetId] ??= {});
      if (to === command.from.trim()) delete forAsset[command.index];
      else forAsset[command.index] = { from: command.from, to };
      if (!Object.keys(forAsset).length) delete edits[command.assetId];
      if (!Object.keys(edits).length) delete doc.transcriptEdits;
      return;
    }
    case 'captions.generate': {
      const seq = sequenceOf(doc, command.sequenceId);
      let track = command.trackId
        ? trackOf(seq, command.trackId)
        : seq.tracks.find((t) => t.kind === 'caption');
      if (track && track.kind !== 'caption') fail('Captions go on a caption track.');
      if (!track) {
        track = blankTrack('caption', `C${nextTrackNumber(seq, 'caption')}`, command.trackId);
        seq.tracks.unshift(track);
      }
      unlocked(track);
      const items: TimelineItem[] = [];
      for (const c of command.captions) {
        const start = snap(seq, c.start);
        const end = Math.max(snap(seq, c.start + c.duration), start + frameOf(seq));
        const words = c.words
          .map((w) => ({
            text: w.text.trim(),
            start: (w.start - start) as Flicks,
            end: (w.end - start) as Flicks,
          }))
          .filter((w) => w.text);
        if (!words.length) continue;
        const prev = items.at(-1);
        // Captions on one track never overlap: an earlier one ends where the next begins.
        if (prev && itemEnd(prev) > start) {
          if (start - prev.start < frameOf(seq)) continue;
          prev.duration = (start - prev.start) as Flicks;
        }
        items.push(captionItem(createId('item'), start, end - start, words));
      }
      track.items = items;
      seq.captions = { ...DEFAULT_CAPTIONS, ...seq.captions, enabled: true };
      return;
    }
    case 'caption.add': {
      const seq = sequenceOf(doc, command.sequenceId);
      const track = trackOf(seq, command.trackId);
      unlocked(track);
      if (track.kind !== 'caption') fail('Captions go on a caption track.');
      const start = snap(seq, command.start);
      const duration = Math.max(snap(seq, command.duration), frameOf(seq));
      const words = command.words?.length
        ? command.words.map((w) => ({
            text: w.text,
            start: w.start as Flicks,
            end: w.end as Flicks,
          }))
        : spreadWords(command.text, 0, duration);
      if (!words.length) fail('Type some text for the caption.');
      clearRange(track, start, start + duration);
      const item = captionItem(command.id ?? createId('item'), start, duration, words);
      if (command.transform)
        item.transform = cleanTransform({ ...item.transform, ...command.transform });
      track.items.push(item);
      sortItems(track);
      seq.captions ??= { ...DEFAULT_CAPTIONS };
      return;
    }
    case 'caption.edit': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      if (!item.caption) fail('That clip is not a caption.');
      const from = item.sourceIn;
      const to = item.sourceIn + item.duration;
      const visible = item.caption!.words.filter(
        (w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to,
      );
      const hidden = item.caption!.words.filter((w) => !visible.includes(w));
      const texts = command.text.split(/\s+/).filter(Boolean);
      if (!texts.length) fail('A caption needs some text. Delete the clip to remove it.');
      if (texts.length > 200) fail('That caption is too long.');
      let words: CaptionContent['words'];
      if (texts.length === visible.length) {
        words = visible.map((w, i) => ({ ...w, text: texts[i]! }));
      } else {
        // Share the time the old words covered (or the whole clip) by letter count.
        const a = visible.length ? visible[0]!.start : from;
        const b = visible.length ? visible.at(-1)!.end : to;
        words = spreadWords(command.text, Math.max(from, a), Math.min(to, Math.max(b, a + 1)));
      }
      item.caption = { words: [...hidden, ...words].sort((x, y) => x.start - y.start) };
      return;
    }
    case 'item.link': {
      const seq = sequenceOf(doc, command.sequenceId);
      const items = [...new Set(command.itemIds)].map((id) => findItem(seq, id));
      if (items.length < 2) fail('Select at least two clips to link.');
      if (items.some((i) => i.item.caption)) fail('Captions cannot be linked.');
      const linkId = command.linkId ?? createId('link');
      for (const { track, item } of items) {
        unlocked(track);
        item.linkId = linkId;
      }
      return;
    }
    case 'item.unlink': {
      const seq = sequenceOf(doc, command.sequenceId);
      for (const id of command.itemIds) {
        const { track, item } = findItem(seq, id);
        unlocked(track);
        for (const p of partnersOf(seq, item)) delete p.item.linkId;
        delete item.linkId;
      }
      return;
    }
    case 'keyframe.set': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      if (item.caption) fail('Captions cannot be animated yet.');
      const half = Math.floor(frameOf(seq) / 2);
      // Snap to the sequence's frame grid as seen on the timeline.
      const local = snap(seq, item.start + (command.t - item.sourceIn)) - item.start;
      const t = (item.sourceIn + local) as Flicks;
      const [lo, hi] = KEY_LIMITS[command.property];
      const v = Math.min(hi, Math.max(lo, command.value));
      if (!Number.isFinite(v)) fail('That value is not a number.');
      item.keyframes ??= {};
      const keys = (item.keyframes[command.property] ??= []);
      const at = keys.findIndex((k) => Math.abs(k.t - t) <= half);
      const easing = command.easing ?? (at >= 0 ? keys[at]!.e : 'linear');
      if (at >= 0) keys[at] = { t: keys[at]!.t, v, e: easing };
      else keys.push({ t, v, e: easing });
      keys.sort((a, b) => a.t - b.t);
      return;
    }
    case 'keyframe.remove': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      const keys = item.keyframes?.[command.property];
      const half = Math.floor(frameOf(seq) / 2);
      const at = keys?.findIndex((k) => Math.abs(k.t - command.t) <= half) ?? -1;
      if (!keys || at < 0) fail('There is no keyframe there.');
      const [removed] = keys!.splice(at, 1);
      if (!keys!.length) {
        delete item.keyframes![command.property];
        setStatic(item, command.property, removed!.v);
      }
      if (item.keyframes && !Object.keys(item.keyframes).length) delete item.keyframes;
      return;
    }
    case 'keyframe.clear': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      const keys = item.keyframes?.[command.property];
      if (!keys?.length) return;
      setStatic(item, command.property, valueAt(keys, command.t));
      delete item.keyframes![command.property];
      if (!Object.keys(item.keyframes!).length) delete item.keyframes;
      return;
    }
    case 'item.update': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      // A static value replaces that property's animation.
      const replaced = [
        ...(command.volume !== undefined ? ['volume'] : []),
        ...Object.keys(command.transform ?? {}).filter((k) => k !== 'fit'),
      ] as KeyframeProperty[];
      for (const p of replaced) delete item.keyframes?.[p];
      if (item.keyframes && !Object.keys(item.keyframes).length) delete item.keyframes;
      if (command.volume !== undefined) item.volume = clampVolume(command.volume);
      if (command.muted !== undefined) item.muted = command.muted;
      if (command.transform)
        item.transform = cleanTransform({ ...item.transform, ...command.transform });
      if (command.opacity !== undefined) {
        if (item.caption) fail('Caption opacity comes from the caption style.');
        const o = Math.min(1, Math.max(0, command.opacity));
        if (o === 1) delete item.opacity;
        else item.opacity = o;
      }
      if (command.fade) {
        item.fade = {
          in: Math.max(0, Math.round(command.fade.in ?? item.fade?.in ?? 0)) as Flicks,
          out: Math.max(0, Math.round(command.fade.out ?? item.fade?.out ?? 0)) as Flicks,
        };
        fitFades(seq, item);
      }
      return;
    }
    case 'effect.add': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      if (item.caption || track.kind !== 'video') fail('Effects go on video clips and images.');
      if (!EFFECT_KINDS.includes(command.kind)) fail('Unknown effect.');
      if ((item.effects?.length ?? 0) >= 16) fail('A clip can have up to 16 effects.');
      (item.effects ??= []).push({
        id: command.id ?? createId('fx'),
        kind: 'color',
        enabled: true,
        brightness: 0,
        contrast: 1,
        saturation: 1,
      });
      return;
    }
    case 'effect.update': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      const fx = item.effects?.find((e) => e.id === command.effectId) ?? fail('No such effect.');
      if (command.enabled !== undefined) fx.enabled = command.enabled;
      const p = command.params ?? {};
      const clamp = (v: number | undefined, lo: number, hi: number, d: number) =>
        v === undefined || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, v));
      fx.brightness = clamp(p.brightness, -1, 1, fx.brightness);
      fx.contrast = clamp(p.contrast, 0, 3, fx.contrast);
      fx.saturation = clamp(p.saturation, 0, 3, fx.saturation);
      return;
    }
    case 'effect.remove': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      item.effects = item.effects?.filter((e) => e.id !== command.effectId);
      if (!item.effects?.length) delete item.effects;
      return;
    }
    case 'effect.move': {
      const seq = sequenceOf(doc, command.sequenceId);
      const { track, item } = findItem(seq, command.itemId);
      unlocked(track);
      const list = item.effects ?? [];
      const from = list.findIndex((e) => e.id === command.effectId);
      if (from < 0) fail('No such effect.');
      const [fx] = list.splice(from, 1);
      list.splice(Math.min(Math.max(0, command.index), list.length), 0, fx!);
      return;
    }
  }
}

/** Trims one clip (no linked partners). */
function trimOne(
  doc: ProjectDocument,
  command: Extract<Command, { type: 'item.trim' }>,
  assets: AssetLookup,
): void {
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
  fitFades(seq, item);
}

/** Other clips linked to `item`. */
function partnersOf(seq: Sequence, item: TimelineItem): { track: Track; item: TimelineItem }[] {
  if (!item.linkId) return [];
  return seq.tracks.flatMap((track) =>
    track.items
      .filter((i) => i.linkId === item.linkId && i.id !== item.id)
      .map((i) => ({ track, item: i })),
  );
}

const KEY_LIMITS: Record<KeyframeProperty, [number, number]> = {
  x: [-2, 2],
  y: [-2, 2],
  scale: [0.05, 10],
  rotation: [-3600, 3600],
  volume: [0, 2],
};

/** Sets a property's static value (used when its last keyframe goes away). */
function setStatic(item: TimelineItem, p: KeyframeProperty, v: number): void {
  if (p === 'volume') item.volume = clampVolume(v);
  else item.transform = cleanTransform({ ...item.transform, [p]: v });
}

const clampVolume = (v: number) => Math.min(2, Math.max(0, v));

function cleanTransform(t: Transform): Transform {
  const crop = cleanCrop(t.crop);
  return {
    fit: t.fit === 'fit' ? 'fit' : 'fill',
    scale: Math.min(10, Math.max(0.05, t.scale)),
    x: Math.min(2, Math.max(-2, t.x)),
    y: Math.min(2, Math.max(-2, t.y)),
    rotation: normalizeAngle(t.rotation ?? 0),
    ...(crop ? { crop } : {}),
  };
}

/** Keeps at least 5% of the picture each way; a crop of nothing is removed. */
function cleanCrop(c: Crop | undefined): Crop | undefined {
  if (!c) return undefined;
  const f = (n: number) =>
    Math.round(Math.min(0.95, Math.max(0, Number.isFinite(n) ? n : 0)) * 10000) / 10000;
  const left = f(c.left);
  const top = f(c.top);
  let right = f(c.right);
  let bottom = f(c.bottom);
  if (left + right > 0.95) right = Math.max(0, 0.95 - left);
  if (top + bottom > 0.95) bottom = Math.max(0, 0.95 - top);
  if (!left && !top && !right && !bottom) return undefined;
  return { left, top, right, bottom };
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
