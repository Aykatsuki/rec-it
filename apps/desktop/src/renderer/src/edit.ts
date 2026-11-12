// Timeline editing helpers used by the timeline, inspector and shortcuts.
import {
  FLICKS_PER_SECOND,
  normalizeAngle,
  sequenceDuration,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
  type Transform,
} from '@rec-it/core';
import type { CommandInput, MediaAsset } from '@rec-it/ipc-contract';
import { backend } from './api';
import { notify } from './notifications';
import { activeSequence, useApp, type ClipboardClip } from './store';

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
  }
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
