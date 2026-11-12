// Timeline editing helpers used by the timeline, inspector and shortcuts.
import {
  FLICKS_PER_SECOND,
  sequenceDuration,
  type Rational,
  type Sequence,
  type TimelineItem,
  type Track,
} from '@rec-it/core';
import type { CommandInput, MediaAsset } from '@rec-it/ipc-contract';
import { backend } from './api';
import { notify } from './notifications';
import { activeSequence, useApp } from './store';

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
