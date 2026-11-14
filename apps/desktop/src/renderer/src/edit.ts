// Timeline editing helpers used by the timeline, inspector and shortcuts.
import {
  FLICKS_PER_SECOND,
  autoReframe,
  hasKeyframes,
  normalizeAngle,
  sourceTimeAt,
  transformAt,
  volumeAt,
  type Keyframe,
  sequenceDuration,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
  type TransitionKind,
  type Transform,
  type KeyframeProperty,
  type Crop,
} from '@rec-it/core';
import type { CommandInput, MediaAsset } from '@rec-it/ipc-contract';
import { backend } from './api';
import { notify } from './notifications';
import { activeSequence, setOnFacesReady, useApp, type ClipboardClip } from './store';

/** Drag-and-drop type for media dragged from the media bin to the timeline. */
export const ASSET_MIME = 'application/x-recit-asset';

export const toFlicks = (seconds: number) => Math.max(0, Math.round(seconds * FLICKS_PER_SECOND));
export const toSeconds = (flicks: number) => flicks / FLICKS_PER_SECOND;
export const itemEndSec = (i: TimelineItem) => toSeconds(i.start + i.duration);
export const sequenceSeconds = (seq: Sequence | null) =>
  seq ? toSeconds(sequenceDuration(seq)) : 0;

/** Runs an edit; problems (e.g. "Track is locked") are shown as a toast instead of thrown. */
export async function edit(command: CommandInput): Promise<boolean> {
  try {
    await backend.invoke('doc.execute', { command });
    return true;
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'warn');
    return false;
  }
}

export async function undo(): Promise<void> {
  if (useApp.getState().docState?.canUndo) await backend.invoke('doc.undo', {}).catch(() => {});
}
export async function redo(): Promise<void> {
  if (useApp.getState().docState?.canRedo) await backend.invoke('doc.redo', {}).catch(() => {});
}

export const STANDARD_RATES: { label: string; rate: Rational }[] = [
  { label: '23.976', rate: { num: 24000, den: 1001 } },
  { label: '24', rate: { num: 24, den: 1 } },
  { label: '25', rate: { num: 25, den: 1 } },
  { label: '29.97', rate: { num: 30000, den: 1001 } },
  { label: '30', rate: { num: 30, den: 1 } },
  { label: '50', rate: { num: 50, den: 1 } },
  { label: '59.94', rate: { num: 60000, den: 1001 } },
  { label: '60', rate: { num: 60, den: 1 } },
];

/** The standard rate closest to a clip's own frame rate (so a 60 fps phone clip makes a 60 fps Short). */
export function rateFor(asset: MediaAsset | undefined): Rational {
  const v = asset?.probe?.video;
  if (!v || asset?.kind !== 'video') return { num: 30, den: 1 };
  const fps = (v.isVfr ? v.avgFps.num / v.avgFps.den : v.fps.num / v.fps.den) || 30;
  return STANDARD_RATES.reduce((best, r) =>
    Math.abs(r.rate.num / r.rate.den - fps) < Math.abs(best.rate.num / best.rate.den - fps)
      ? r
      : best,
  ).rate;
}

/** Creates the default 9:16 sequence if the project has none yet. Returns its id. */
export async function ensureSequence(firstAsset?: MediaAsset): Promise<Sequence | null> {
  const existing = activeSequence(useApp.getState());
  if (existing) return existing;
  const ok = await edit({
    type: 'sequence.create',
    name: 'Short 1',
    width: 1080,
    height: 1920,
    fps: rateFor(firstAsset),
  });
  return ok ? activeSequence(useApp.getState()) : null;
}

/** Adds media to the timeline. Video and stills go on V1 (or the given track), audio on A1. */
export async function addToTimeline(
  asset: MediaAsset,
  opts: { trackId?: string; start?: number } = {},
): Promise<void> {
  if (asset.status !== 'ready' || !asset.kind) {
    notify(
      asset.status === 'processing'
        ? `${asset.name} is still being prepared.`
        : `${asset.name} cannot be used.`,
      'warn',
    );
    return;
  }
  const seq = await ensureSequence(asset);
  if (!seq) return;
  const kind = asset.kind === 'audio' ? 'audio' : 'video';
  let track: Track | undefined = opts.trackId
    ? seq.tracks.find((t) => t.id === opts.trackId)
    : undefined;
  if (track && track.kind !== kind && !(track.kind === 'audio' && asset.probe?.audio))
    track = undefined;
  track ??= seq.tracks.filter((t) => t.kind === kind).at(kind === 'video' ? -1 : 0);
  if (!track) return;
  const start = opts.start ?? sequenceSeconds({ ...seq, tracks: [track] });
  const ok = await edit({
    type: 'item.add',
    sequenceId: seq.id,
    trackId: track.id,
    assetId: asset.id,
    start: toFlicks(start),
  });
  if (ok) useApp.getState().setPlayhead(start);
}

export function findItem(
  seq: Sequence | null,
  id: string,
): { track: Track; item: TimelineItem } | null {
  for (const track of seq?.tracks ?? []) {
    const item = track.items.find((i) => i.id === id);
    if (item) return { track, item };
  }
  return null;
}

export async function splitAtPlayhead(): Promise<void> {
  const state = useApp.getState();
  const seq = activeSequence(state);
  if (!seq) return;
  await edit({
    type: 'item.split',
    sequenceId: seq.id,
    time: toFlicks(state.playhead),
    ...(state.selectedItemIds.length ? { itemIds: state.selectedItemIds } : {}),
  });
}

export async function deleteSelected(ripple: boolean): Promise<void> {
  const state = useApp.getState();
  const seq = activeSequence(state);
  if (!seq || !state.selectedItemIds.length) return;
  await edit({ type: 'item.remove', sequenceId: seq.id, itemIds: state.selectedItemIds, ripple });
}

// ---------------------------------------------------------------------------------------------
// Selection, clipboard and clip operations (context menus and shortcuts).

/** Selected clips with their tracks, in timeline order. */
export function selectedClips(seq: Sequence | null): { track: Track; item: TimelineItem }[] {
  const ids = new Set(useApp.getState().selectedItemIds);
  return (seq?.tracks ?? []).flatMap((track) =>
    track.items.filter((item) => ids.has(item.id)).map((item) => ({ track, item })),
  );
}

const kindIndex = (seq: Sequence, track: Track) =>
  seq.tracks.filter((t) => t.kind === track.kind).indexOf(track);

export function copySelected(): boolean {
  const seq = activeSequence(useApp.getState());
  const clips = selectedClips(seq);
  if (!seq || !clips.length) return false;
  const first = Math.min(...clips.map((c) => c.item.start));
  const clipboard: ClipboardClip[] = clips.map(({ track, item }) => ({
    assetId: item.assetId,
    trackKind: track.kind,
    trackIndex: kindIndex(seq, track),
    offset: item.start - first,
    sourceIn: item.sourceIn,
    duration: item.duration,
    volume: item.volume,
    muted: item.muted,
    transform: { ...item.transform },
    ...(item.keyframes ? { keyframes: structuredClone(item.keyframes) } : {}),
    ...(item.linkId ? { linkKey: item.linkId } : {}),
    ...(item.caption
      ? {
          caption: item.caption.words
            .filter((w) => w.end > item.sourceIn && w.start < item.sourceIn + item.duration)
            .map((w) => ({
              text: w.text,
              start: Math.max(0, w.start - item.sourceIn),
              end: Math.min(item.duration, w.end - item.sourceIn),
            })),
        }
      : {}),
  }));
  useApp.setState({ clipboard });
  return true;
}

export async function cutSelected(): Promise<void> {
  if (copySelected()) await deleteSelected(false);
}

/**
 * Pastes the clipboard at `at` seconds (default: the playhead), keeping the clips' relative
 * timing and tracks. `trackId` moves the top of the pasted group to that track. Overwrites.
 */
export async function paste(at?: number, trackId?: string): Promise<void> {
  const state = useApp.getState();
  const seq = activeSequence(state);
  const clips = state.clipboard;
  if (!seq || !clips.length) return;
  const start = toFlicks(at ?? state.playhead);
  const target = trackId ? seq.tracks.find((t) => t.id === trackId) : undefined;
  const ids: string[] = [];
  const commands: CommandInput[] = [];
  for (const clip of clips) {
    const tracks = seq.tracks.filter((t) => t.kind === clip.trackKind);
    let index = clip.trackIndex;
    if (target?.kind === clip.trackKind) {
      const base = Math.min(
        ...clips.filter((c) => c.trackKind === clip.trackKind).map((c) => c.trackIndex),
      );
      index = tracks.indexOf(target) + (clip.trackIndex - base);
    }
    const track = tracks[Math.min(Math.max(index, 0), tracks.length - 1)];
    if (!track) continue;
    const id = `item_${crypto.randomUUID()}`;
    ids.push(id);
    if (clip.caption) {
      commands.push({
        type: 'caption.add',
        sequenceId: seq.id,
        trackId: track.id,
        id,
        start: start + clip.offset,
        duration: clip.duration,
        text: clip.caption.map((w) => w.text).join(' '),
        words: clip.caption,
        transform: clip.transform,
      });
      continue;
    }
    commands.push({
      type: 'item.add',
      sequenceId: seq.id,
      trackId: track.id,
      assetId: clip.assetId,
      id,
      start: start + clip.offset,
      sourceIn: clip.sourceIn,
      duration: clip.duration,
      volume: clip.volume,
      muted: clip.muted,
      transform: clip.transform,
    });
    for (const [property, keys] of Object.entries(clip.keyframes ?? {}))
      for (const k of keys ?? [])
        commands.push({
          type: 'keyframe.set',
          sequenceId: seq.id,
          itemId: id,
          property: property as KeyframeProperty,
          t: k.t,
          value: k.v,
          easing: k.e,
        });
  }
  // Pasted copies of linked clips are linked to each other (not to the originals).
  const groups = new Map<string, string[]>();
  clips.forEach((clip, i) => {
    if (clip.linkKey && ids[i])
      groups.set(clip.linkKey, [...(groups.get(clip.linkKey) ?? []), ids[i]!]);
  });
  for (const itemIds of groups.values())
    if (itemIds.length > 1) commands.push({ type: 'item.link', sequenceId: seq.id, itemIds });
  if (commands.length && (await edit({ type: 'batch', commands } as CommandInput)))
    state.selectItems(ids);
}

/** Copies the selection and pastes it straight after itself. */
export async function duplicateSelected(): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const clips = selectedClips(seq);
  if (!clips.length) return;
  const end = Math.max(...clips.map((c) => c.item.start + c.item.duration));
  const previous = useApp.getState().clipboard;
  copySelected();
  await paste(toSeconds(end));
  useApp.setState({ clipboard: previous });
}

/** Applies the same change to every selected clip as one undo step. */
export async function updateSelected(change: {
  volume?: number;
  muted?: boolean;
  transform?: Partial<Transform>;
}): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const clips = selectedClips(seq);
  if (!seq || !clips.length) return;
  await edit({
    type: 'batch',
    commands: clips.map(({ item }) => ({
      type: 'item.update' as const,
      sequenceId: seq.id,
      itemId: item.id,
      ...change,
      ...(change.transform ? { transform: change.transform } : {}),
    })),
  });
}

/** Turns every selected clip by `degrees`. */
export async function rotateSelected(degrees: number): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const clips = selectedClips(seq).filter((c) => c.track.kind === 'video');
  if (!seq || !clips.length) return;
  await edit({
    type: 'batch',
    commands: clips.map(({ item }) => ({
      type: 'item.update' as const,
      sequenceId: seq.id,
      itemId: item.id,
      transform: { rotation: normalizeAngle(item.transform.rotation + degrees) },
    })),
  });
}

/**
 * Puts a video clip's sound on its own audio clip (same timing) and mutes the video clip,
 * so the sound can be moved, trimmed or deleted separately.
 */
export async function detachAudio(itemId: string): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const found = findItem(seq, itemId);
  if (!seq || !found) return;
  const { item } = found;
  const end = item.start + item.duration;
  const audioTracks = seq.tracks.filter((t) => t.kind === 'audio');
  // The first audio track with room, or a new one.
  const free = audioTracks.find((t) =>
    t.items.every((i) => i.start + i.duration <= item.start || i.start >= end),
  );
  const commands: CommandInput[] = [];
  let trackId = free?.id;
  if (!trackId) {
    trackId = `track_${crypto.randomUUID()}`;
    commands.push({ type: 'track.add', sequenceId: seq.id, kind: 'audio', id: trackId });
  }
  const id = `item_${crypto.randomUUID()}`;
  commands.push(
    {
      type: 'item.add',
      sequenceId: seq.id,
      trackId,
      assetId: item.assetId,
      id,
      start: item.start,
      sourceIn: item.sourceIn,
      duration: item.duration,
      volume: item.volume,
    },
    { type: 'item.update', sequenceId: seq.id, itemId: item.id, muted: true },
    // Linked, so the picture and its sound stay in sync when edited.
    { type: 'item.link', sequenceId: seq.id, itemIds: [item.id, id] },
  );
  if (await edit({ type: 'batch', commands } as CommandInput)) useApp.getState().selectItems([id]);
}

export function selectAll(trackId?: string, from?: number): void {
  const seq = activeSequence(useApp.getState());
  if (!seq) return;
  const ids = seq.tracks
    .filter((t) => !trackId || t.id === trackId)
    .flatMap((t) => t.items)
    .filter((i) => from === undefined || i.start + i.duration > toFlicks(from))
    .map((i) => i.id);
  useApp.getState().selectItems(ids);
}

/** Moves the selected clips to another track of the same kind, keeping their times. */
export async function moveSelectedToTrack(trackId: string): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const clips = selectedClips(seq);
  if (!seq || !clips.length) return;
  await edit({
    type: 'item.moveMany',
    sequenceId: seq.id,
    moves: clips.map(({ item }) => ({ itemId: item.id, trackId, start: item.start })),
  });
}

/** Ids of clips that the playhead is over. */
export function clipsAtPlayhead(seq: Sequence | null): string[] {
  const t = toFlicks(useApp.getState().playhead);
  return (seq?.tracks ?? [])
    .flatMap((tr) => tr.items)
    .filter((i) => t > i.start && t < i.start + i.duration)
    .map((i) => i.id);
}

/** Clips linked to any of `ids` (not including them). */
export function linkedPartners(seq: Sequence | null, ids: string[]): string[] {
  const all = (seq?.tracks ?? []).flatMap((t) => t.items);
  const links = new Set(all.filter((i) => ids.includes(i.id) && i.linkId).map((i) => i.linkId));
  return all.filter((i) => i.linkId && links.has(i.linkId) && !ids.includes(i.id)).map((i) => i.id);
}

/** True when the item has a linked partner on the timeline. */
export function isLinked(seq: Sequence | null, item: TimelineItem): boolean {
  return !!item.linkId && linkedPartners(seq, [item.id]).length > 0;
}

export async function linkSelected(link: boolean): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const ids = useApp.getState().selectedItemIds;
  if (!seq || !ids.length) return;
  await edit(
    link
      ? { type: 'item.link', sequenceId: seq.id, itemIds: ids }
      : { type: 'item.unlink', sequenceId: seq.id, itemIds: ids },
  );
}

/**
 * The clip the inspector and transform box work on: the only selected clip, or — when the
 * selection is one linked group — its picture (video-track) clip.
 */
export function primaryClip(
  seq: Sequence | null,
  ids: string[],
): { track: Track; item: TimelineItem } | null {
  if (ids.length === 1) return findItem(seq, ids[0]!);
  const found = ids.map((id) => findItem(seq, id)).filter((f) => f !== null);
  if (found.length !== ids.length || !found.length) return null;
  const link = found[0]!.item.linkId;
  if (!link || !found.every((f) => f.item.linkId === link)) return null;
  return found.find((f) => f.track.kind === 'video') ?? found[0]!;
}

// ---------------------------------------------------------------------------------------------
// Keyframes. Times are timeline seconds (usually the playhead); keyframes are stored in source
// time so they stay on the same picture when a clip is trimmed (see @rec-it/core).

const TRANSFORM_KEYS = ['x', 'y', 'scale', 'rotation'] as const;

/** Keyframe of `property` at timeline time `at`, if there is one (within half a frame). */
export function keyframeAt(
  seq: Sequence,
  item: TimelineItem,
  property: KeyframeProperty,
  at: number,
): Keyframe | undefined {
  const t = sourceTimeAt(item, toFlicks(at));
  const half = (FLICKS_PER_SECOND * seq.fps.den) / seq.fps.num / 2;
  return item.keyframes?.[property]?.find((k) => Math.abs(k.t - t) <= half);
}

/**
 * Commits a transform change made at timeline time `at` as one undo step: animated properties
 * get a keyframe there, the others change their static value.
 */
export async function commitTransform(
  seq: Sequence,
  item: TimelineItem,
  next: Partial<Transform>,
  at: number,
): Promise<boolean> {
  const current = transformAt(item, toFlicks(at));
  const t = sourceTimeAt(item, toFlicks(at));
  const commands: CommandInput[] = [];
  const statics: Partial<Transform> = {};
  if (next.fit !== undefined && next.fit !== item.transform.fit) statics.fit = next.fit;
  for (const p of TRANSFORM_KEYS) {
    const v = next[p];
    if (v === undefined || Math.abs(v - current[p]) < 1e-9) continue;
    if (hasKeyframes(item, p))
      commands.push({
        type: 'keyframe.set',
        sequenceId: seq.id,
        itemId: item.id,
        property: p,
        t,
        value: v,
      });
    else statics[p] = v;
  }
  if (Object.keys(statics).length)
    commands.push({ type: 'item.update', sequenceId: seq.id, itemId: item.id, transform: statics });
  if (!commands.length) return true;
  return edit(commands.length === 1 ? commands[0]! : ({ type: 'batch', commands } as CommandInput));
}

/** Sets the volume at `at`: a keyframe when volume is animated, otherwise the clip volume. */
export async function commitVolume(
  seq: Sequence,
  item: TimelineItem,
  value: number,
  at: number,
): Promise<boolean> {
  if (Math.abs(value - volumeAt(item, toFlicks(at))) < 1e-9) return true;
  return hasKeyframes(item, 'volume')
    ? edit({
        type: 'keyframe.set',
        sequenceId: seq.id,
        itemId: item.id,
        property: 'volume',
        t: sourceTimeAt(item, toFlicks(at)),
        value,
      })
    : edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, volume: value });
}

/** The keyframe button: adds a keyframe at `at` with the current value, or removes the one there. */
export async function toggleKeyframe(
  seq: Sequence,
  item: TimelineItem,
  property: KeyframeProperty,
  at: number,
): Promise<void> {
  const existing = keyframeAt(seq, item, property, at);
  if (existing) {
    await edit({
      type: 'keyframe.remove',
      sequenceId: seq.id,
      itemId: item.id,
      property,
      t: existing.t,
    });
    return;
  }
  const value =
    property === 'volume'
      ? volumeAt(item, toFlicks(at))
      : transformAt(item, toFlicks(at))[property];
  await edit({
    type: 'keyframe.set',
    sequenceId: seq.id,
    itemId: item.id,
    property,
    t: sourceTimeAt(item, toFlicks(at)),
    value,
  });
}

/** Timeline times (seconds) of an item's keyframes, optionally for one property. */
export function keyframeTimes(item: TimelineItem, property?: KeyframeProperty): number[] {
  const lists = property
    ? [item.keyframes?.[property] ?? []]
    : Object.values(item.keyframes ?? {}).map((k) => k ?? []);
  const times = new Set<number>();
  for (const keys of lists)
    for (const k of keys) times.add(toSeconds(item.start + (k.t - item.sourceIn)));
  return [...times].sort((a, b) => a - b);
}

/** Moves the playhead to the previous or next keyframe of the item inside the clip. */
export function jumpToKeyframe(item: TimelineItem, dir: -1 | 1, property?: KeyframeProperty): void {
  const { playhead, setPlayhead, setPlaying } = useApp.getState();
  const inside = keyframeTimes(item, property).filter(
    (t) => t >= toSeconds(item.start) - 1e-6 && t < itemEndSec(item),
  );
  const target =
    dir < 0
      ? inside.filter((t) => t < playhead - 1e-4).at(-1)
      : inside.find((t) => t > playhead + 1e-4);
  if (target !== undefined) {
    setPlaying(false);
    setPlayhead(target);
  }
}

// ---------------------------------------------------------------------------------------------
// Reframing (ADR-034).

/** Height of the facecam panel in the facecam + gameplay layout, as a share of the frame. */
export const FACECAM_SHARE = 0.35;

/**
 * Crop (fractions) that gives a picture of `aspect` (width / height) out of a source of
 * `srcAspect`, at most `maxHeight` of the source tall, placed at (`x`, `y`) in 0..1 of the room
 * left over.
 */
export function cropForAspect(
  srcAspect: number,
  aspect: number,
  maxHeight: number,
  x: number,
  y: number,
): Crop {
  let h = maxHeight;
  let w = (h * aspect) / srcAspect;
  if (w > 1) {
    w = 1;
    h = (w * srcAspect) / aspect;
  }
  const left = (1 - w) * x;
  const top = (1 - h) * y;
  return { left, top, right: 1 - w - left, bottom: 1 - h - top };
}

/**
 * Facecam + gameplay: the clip becomes the gameplay panel (bottom), and a muted, linked copy on
 * the video track above becomes the facecam panel (top). Both are cropped to their panel's shape;
 * the crop window then opens on the facecam so it can be placed over the camera.
 */
export async function facecamLayout(itemId: string): Promise<void> {
  const state = useApp.getState();
  const seq = activeSequence(state);
  const found = findItem(seq, itemId);
  if (!seq || !found || found.track.kind !== 'video') return;
  const { item, track } = found;
  const asset = state.assets.find((a) => a.id === item.assetId);
  const v = asset?.probe?.video;
  if (!v || asset?.kind !== 'video') {
    notify('The facecam layout needs a video clip.', 'warn');
    return;
  }
  const srcAspect = v.displayWidth / v.displayHeight;
  const W = seq.width;
  const H = seq.height;
  const camH = Math.round((H * FACECAM_SHARE) / 2) * 2;
  const camAspect = W / camH;
  const gameAspect = W / (H - camH);
  // A free video track above this one for the facecam (or a new one at the top).
  const videoTracks = seq.tracks.filter((t) => t.kind === 'video');
  const above = videoTracks
    .slice(0, videoTracks.indexOf(track))
    .reverse()
    .find(
      (t) =>
        !t.locked &&
        !t.items.some(
          (i) => i.start < item.start + item.duration && i.start + i.duration > item.start,
        ),
    );
  const camTrackId = above?.id ?? `track_${crypto.randomUUID()}`;
  const camId = `item_${crypto.randomUUID()}`;
  const ok = await edit({
    type: 'batch',
    commands: [
      ...(above
        ? []
        : [
            {
              type: 'track.add' as const,
              sequenceId: seq.id,
              kind: 'video' as const,
              id: camTrackId,
            },
          ]),
      {
        type: 'item.add',
        sequenceId: seq.id,
        trackId: camTrackId,
        assetId: item.assetId,
        id: camId,
        start: item.start,
        sourceIn: item.sourceIn,
        duration: item.duration,
        muted: true,
        volume: item.volume,
        transform: {
          fit: 'fit',
          scale: 1,
          x: 0,
          y: (camH / 2 - H / 2) / H,
          rotation: 0,
          crop: cropForAspect(srcAspect, camAspect, 0.4, 0, 0),
        },
      },
      {
        type: 'item.update',
        sequenceId: seq.id,
        itemId: item.id,
        transform: {
          fit: 'fit',
          scale: 1,
          x: 0,
          y: (camH + (H - camH) / 2 - H / 2) / H,
          rotation: 0,
          crop: cropForAspect(srcAspect, gameAspect, 1, 0.5, 0.5),
        },
      },
      {
        type: 'item.link',
        sequenceId: seq.id,
        itemIds: [item.id, camId],
        ...(item.linkId ? { linkId: item.linkId } : {}),
      },
    ],
  });
  if (ok) {
    useApp.setState({ selectedItemIds: [camId], focus: 'timeline', cropItemId: camId });
    notify('Drag the box over your camera, then press Apply.', 'info');
  }
}

/**
 * Automatic reframing (ADR-035): slides the clip sideways to follow faces, as keyframes on its
 * x position (replacing any it had). Analyses the media first if needed, then applies itself.
 */
export async function autoReframeClip(itemId: string): Promise<void> {
  const state = useApp.getState();
  const seq = activeSequence(state);
  const found = findItem(seq, itemId);
  if (!seq || !found) return;
  const { item } = found;
  const faces = state.faces;
  if (faces?.analysed.includes(item.assetId)) {
    await applyReframe(itemId);
    return;
  }
  if (!faces?.available) {
    notify('Install face detection first (Inspector → Auto reframe).', 'warn');
    return;
  }
  useApp.setState((s) => ({
    pendingReframe: {
      ...s.pendingReframe,
      [item.assetId]: [...new Set([...(s.pendingReframe[item.assetId] ?? []), itemId])],
    },
  }));
  try {
    await backend.invoke('faces.start', { assetId: item.assetId });
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'warn');
  }
}

async function applyReframe(itemId: string): Promise<void> {
  const seq = activeSequence(useApp.getState());
  const found = findItem(seq, itemId);
  if (!seq || !found) return;
  const { item } = found;
  const asset = useApp.getState().assets.find((a) => a.id === item.assetId);
  const v = asset?.probe?.video;
  const track = await backend.invoke('faces.get', { assetId: item.assetId }).catch(() => null);
  if (!v || !track) return;
  const result = autoReframe(
    item,
    { width: v.displayWidth, height: v.displayHeight },
    { width: seq.width, height: seq.height },
    track,
  );
  if (!result.ok) {
    notify(
      result.reason === 'no-faces'
        ? 'No faces were found in this clip, so it was left as it is.'
        : 'This clip already shows its full width. Use Fill frame or zoom in, then reframe again.',
      'warn',
    );
    return;
  }
  const ok = await edit({
    type: 'batch',
    commands: [
      { type: 'keyframe.clear', sequenceId: seq.id, itemId, property: 'x', t: item.sourceIn },
      ...result.keyframes.map((k) => ({
        type: 'keyframe.set' as const,
        sequenceId: seq.id,
        itemId,
        property: 'x' as const,
        t: k.t,
        value: k.v,
        easing: k.e,
      })),
    ],
  });
  if (ok)
    notify(
      `Reframed to follow faces (${result.keyframes.length} keyframes). Ctrl+Z undoes it.`,
      'info',
    );
}

setOnFacesReady((assetId) => {
  const ids = useApp.getState().pendingReframe[assetId] ?? [];
  useApp.setState((s) => {
    const { [assetId]: _done, ...rest } = s.pendingReframe;
    return { pendingReframe: rest };
  });
  for (const id of ids) void applyReframe(id);
});

/**
 * Sets a clip's fade-in or fade-out length (seconds), on its linked partners too so picture and
 * sound fade together (ADR-036).
 */
export async function setFade(
  seq: Sequence,
  item: TimelineItem,
  side: 'in' | 'out',
  seconds: number,
): Promise<void> {
  const ids = [item.id, ...linkedPartners(seq, [item.id])];
  await edit({
    type: 'batch',
    commands: ids.map((itemId) => ({
      type: 'item.update' as const,
      sequenceId: seq.id,
      itemId,
      fade: { [side]: toFlicks(Math.max(0, seconds)) },
    })),
  });
}

/** Transitions offered in menus and the Inspector (ADR-037). */
export const TRANSITION_LABELS: Record<TransitionKind, string> = {
  dissolve: 'Cross dissolve',
  dipBlack: 'Dip to black',
  dipWhite: 'Dip to white',
};
/** Length of a new transition, in seconds. */
export const DEFAULT_TRANSITION_SECONDS = 0.5;

/** The clip that ends where `item` starts on the same track (the other side of its cut). */
export function clipBefore(track: Track, item: TimelineItem): TimelineItem | undefined {
  return track.items.find((i) => i !== item && i.start + i.duration === item.start);
}

/**
 * Puts a transition on the cut before `itemId` (null removes it); linked partners get the same
 * where they have a cut too.
 */
export async function setTransition(
  seq: Sequence,
  itemId: string,
  kind: TransitionKind | null,
  seconds?: number,
): Promise<boolean> {
  if (!kind) return edit({ type: 'transition.remove', sequenceId: seq.id, itemId });
  const current = findItem(seq, itemId)?.item.transitionIn;
  return edit({
    type: 'transition.set',
    sequenceId: seq.id,
    itemId,
    kind,
    duration: toFlicks(
      seconds ?? (current ? current.duration / FLICKS_PER_SECOND : DEFAULT_TRANSITION_SECONDS),
    ),
  });
}

/** Media lengths for transitions (ADR-037): probed duration, or unlimited for stills. */
export function mediaLength(byId: Map<string, MediaAsset>) {
  return (id: string): number | null | undefined => {
    const a = byId.get(id);
    if (!a) return undefined;
    if (a.kind === 'image') return null;
    const d = a.probe?.durationSec;
    return d === undefined ? undefined : Math.round(d * FLICKS_PER_SECOND);
  };
}
