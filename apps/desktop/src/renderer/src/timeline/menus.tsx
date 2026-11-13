// Right-click menus for the timeline, the program monitor and the media bin.
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Crop,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  ImageDown,
  Link2,
  Lock,
  Maximize,
  Minimize,
  MonitorPlay,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Scissors,
  Settings2,
  Trash2,
  Unlink,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { DEFAULT_TRANSFORM, type Sequence, type Track } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { backend, shell } from '../api';
import {
  addToTimeline,
  clipsAtPlayhead,
  copySelected,
  cutSelected,
  deleteSelected,
  detachAudio,
  duplicateSelected,
  edit,
  isLinked,
  linkSelected,
  linkedPartners,
  moveSelectedToTrack,
  paste,
  rotateSelected,
  selectAll,
  selectedClips,
  sequenceSeconds,
  splitAtPlayhead,
  updateSelected,
} from '../edit';
import { notify } from '../notifications';
import { activeSequence, useApp } from '../store';
import type { MenuEntry } from '../ui/ContextMenu';
import { exportFrame, openExportDialog } from './ExportDialog';
import { togglePlay } from './ProgramMonitor';
import { openSequenceSettings } from './SequenceSettings';

const sep = { separator: true } as const;
const I = 14;

function clipboardEntries(at?: number, trackId?: string): MenuEntry[] {
  const empty = !useApp.getState().clipboard.length;
  return [
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      icon: <ClipboardPaste size={I} />,
      disabled: empty,
      onSelect: () => void paste(at, trackId),
    },
  ];
}

/** Menu for one or more selected clips. `ids` become the selection if they are not part of it. */
export function clipMenu(seq: Sequence, ids: string[]): MenuEntry[] {
  const state = useApp.getState();
  if (!ids.every((id) => state.selectedItemIds.includes(id)))
    state.selectItems([...ids, ...linkedPartners(seq, ids)]);
  const clips = selectedClips(seq);
  if (!clips.length) return [];
  const one = clips.length === 1 ? clips[0]! : null;
  const visual = clips.filter((c) => c.track.kind === 'video');
  const asset = one ? state.assets.find((a) => a.id === one.item.assetId) : undefined;
  const allMuted = clips.every((c) => c.item.muted);
  const underPlayhead = new Set(clipsAtPlayhead(seq));
  const canSplit = clips.some((c) => underPlayhead.has(c.item.id));
  const kinds = new Set(clips.map((c) => c.track.kind));
  const sameKindTracks =
    kinds.size === 1 ? seq.tracks.filter((t) => t.kind === clips[0]!.track.kind) : [];
  const currentTracks = new Set(clips.map((c) => c.track.id));
  const anyCaption = clips.some((c) => c.item.caption);

  return [
    {
      label: 'Split at playhead',
      shortcut: 'S',
      icon: <Scissors size={I} />,
      disabled: !canSplit,
      onSelect: () => void splitAtPlayhead(),
    },
    sep,
    { label: 'Cut', shortcut: 'Ctrl+X', onSelect: () => void cutSelected() },
    { label: 'Copy', shortcut: 'Ctrl+C', icon: <Copy size={I} />, onSelect: () => copySelected() },
    ...clipboardEntries(),
    {
      label: 'Duplicate',
      shortcut: 'Ctrl+D',
      icon: <CopyPlus size={I} />,
      onSelect: () => void duplicateSelected(),
    },
    sep,
    visual.length > 0 && {
      label: 'Framing',
      icon: <Crop size={I} />,
      submenu: [
        {
          label: 'Fill frame',
          icon: <Maximize size={I} />,
          checked: visual.every((c) => c.item.transform.fit === 'fill'),
          onSelect: () => void updateSelected({ transform: { fit: 'fill' } }),
        },
        {
          label: 'Fit in frame',
          icon: <Minimize size={I} />,
          checked: visual.every((c) => c.item.transform.fit === 'fit'),
          onSelect: () => void updateSelected({ transform: { fit: 'fit' } }),
        },
        sep,
        {
          label: 'Centre',
          onSelect: () => void updateSelected({ transform: { x: 0, y: 0 } }),
        },
        {
          label: 'Rotate 90° clockwise',
          icon: <RotateCw size={I} />,
          onSelect: () => void rotateSelected(90),
        },
        {
          label: 'Rotate 90° anticlockwise',
          icon: <RotateCcw size={I} />,
          onSelect: () => void rotateSelected(-90),
        },
        sep,
        {
          label: 'Reset transform',
          onSelect: () => void updateSelected({ transform: { ...DEFAULT_TRANSFORM } }),
        },
      ],
    },
    !anyCaption && {
      label: allMuted ? 'Unmute clip' : 'Mute clip',
      icon: allMuted ? <Volume2 size={I} /> : <VolumeX size={I} />,
      onSelect: () => void updateSelected({ muted: !allMuted }),
    },
    one?.track.kind === 'video' &&
      asset?.probe?.audio && {
        label: 'Detach audio',
        icon: <Unlink size={I} />,
        disabled: one.item.muted,
        onSelect: () => void detachAudio(one.item.id),
      },
    clips.some((c) => isLinked(seq, c.item))
      ? {
          label: 'Unlink',
          icon: <Unlink size={I} />,
          onSelect: () => void linkSelected(false),
        }
      : clips.length > 1 &&
        !anyCaption && {
          label: 'Link clips',
          icon: <Link2 size={I} />,
          onSelect: () => void linkSelected(true),
        },
    sameKindTracks.length > 1 && {
      label: 'Move to track',
      submenu: sameKindTracks.map((t) => ({
        label: t.name,
        checked: currentTracks.size === 1 && currentTracks.has(t.id),
        disabled: t.locked,
        onSelect: () => void moveSelectedToTrack(t.id),
      })),
    },
    sep,
    one &&
      !one.item.caption && {
        label: 'Select in media bin',
        onSelect: () => useApp.getState().select(one.item.assetId),
      },
    asset && {
      label: 'Show file in folder',
      icon: <FolderOpen size={I} />,
      onSelect: () => void shell.invoke('shell.showItemInFolder', { path: asset.originalPath }),
    },
    sep,
    {
      label: 'Delete',
      shortcut: 'Del',
      icon: <Trash2 size={I} />,
      danger: true,
      onSelect: () => void deleteSelected(false),
    },
    {
      label: 'Ripple delete',
      shortcut: 'Shift+Del',
      danger: true,
      onSelect: () => void deleteSelected(true),
    },
  ];
}

/** Menu for an empty spot on a track. `at` is the time under the pointer in seconds. */
export function laneMenu(seq: Sequence, track: Track, at: number): MenuEntry[] {
  const kindCount = seq.tracks.filter((t) => t.kind === track.kind).length;
  return [
    ...clipboardEntries(at, track.id),
    sep,
    { label: `Select all on ${track.name}`, onSelect: () => selectAll(track.id) },
    { label: 'Select all from here', onSelect: () => selectAll(undefined, at) },
    { label: 'Select all', shortcut: 'Ctrl+A', onSelect: () => selectAll() },
    sep,
    ...trackEntries(seq, track, kindCount),
  ];
}

/** Menu for a track header. */
export function trackMenu(seq: Sequence, track: Track): MenuEntry[] {
  const kindCount = seq.tracks.filter((t) => t.kind === track.kind).length;
  return [
    { label: `Select all on ${track.name}`, onSelect: () => selectAll(track.id) },
    sep,
    ...trackEntries(seq, track, kindCount),
  ];
}

function trackEntries(seq: Sequence, track: Track, kindCount: number): MenuEntry[] {
  const update = (patch: { muted?: boolean; hidden?: boolean; locked?: boolean }) =>
    void edit({ type: 'track.update', sequenceId: seq.id, trackId: track.id, ...patch });
  return [
    track.kind === 'video'
      ? {
          label: track.hidden ? 'Show track' : 'Hide track',
          icon: track.hidden ? <Eye size={I} /> : <EyeOff size={I} />,
          onSelect: () => update({ hidden: !track.hidden }),
        }
      : {
          label: track.muted ? 'Unmute track' : 'Mute track',
          icon: track.muted ? <Volume2 size={I} /> : <VolumeX size={I} />,
          onSelect: () => update({ muted: !track.muted }),
        },
    {
      label: track.locked ? 'Unlock track' : 'Lock track',
      icon: <Lock size={I} />,
      onSelect: () => update({ locked: !track.locked }),
    },
    sep,
    {
      label: 'Add video track',
      icon: <Plus size={I} />,
      onSelect: () => void edit({ type: 'track.add', sequenceId: seq.id, kind: 'video' }),
    },
    {
      label: 'Add audio track',
      icon: <Plus size={I} />,
      onSelect: () => void edit({ type: 'track.add', sequenceId: seq.id, kind: 'audio' }),
    },
    {
      label: `Delete track ${track.name}`,
      icon: <Trash2 size={I} />,
      danger: true,
      disabled: kindCount <= 1 || track.locked,
      onSelect: () => void edit({ type: 'track.remove', sequenceId: seq.id, trackId: track.id }),
    },
  ];
}

/** Menu for the program monitor background (no clip under the pointer). */
export function programMenu(seq: Sequence): MenuEntry[] {
  const { playing, snapping } = useApp.getState();
  const hasContent = sequenceSeconds(seq) > 0;
  return [
    {
      label: playing ? 'Pause' : 'Play',
      shortcut: 'Space',
      icon: playing ? <Pause size={I} /> : <Play size={I} />,
      disabled: !hasContent,
      onSelect: () => togglePlay(seq),
    },
    {
      label: 'Split at playhead',
      shortcut: 'S',
      icon: <Scissors size={I} />,
      disabled: !clipsAtPlayhead(seq).length,
      onSelect: () => void splitAtPlayhead(),
    },
    ...clipboardEntries(),
    sep,
    {
      label: 'Snapping',
      shortcut: 'N',
      checked: snapping,
      onSelect: () => useApp.setState({ snapping: !snapping }),
    },
    {
      label: 'Preview engine',
      icon: <MonitorPlay size={I} />,
      submenu: [
        {
          label: 'GPU — frame-accurate',
          checked: useApp.getState().previewEngine === 'gpu',
          onSelect: () => useApp.getState().setPreviewEngine('gpu'),
        },
        {
          label: 'Compatible',
          checked: useApp.getState().previewEngine === 'compatible',
          onSelect: () => useApp.getState().setPreviewEngine('compatible'),
        },
      ],
    },
    {
      label: 'Sequence settings…',
      icon: <Settings2 size={I} />,
      onSelect: () => openSequenceSettings(seq),
    },
    {
      label: 'Export…',
      shortcut: 'Ctrl+E',
      icon: <Download size={I} />,
      disabled: !hasContent,
      onSelect: () => openExportDialog(),
    },
    {
      label: 'Save frame as image…',
      icon: <ImageDown size={I} />,
      disabled: !hasContent,
      onSelect: () => void exportFrame(seq),
    },
  ];
}

/** Menu for a media bin item. */
export function assetMenu(asset: MediaAsset): MenuEntry[] {
  const ready = asset.status === 'ready';
  const seq = activeSequence(useApp.getState());
  return [
    {
      label: 'Add to end of timeline',
      icon: <Plus size={I} />,
      disabled: !ready,
      onSelect: () => void addToTimeline(asset),
    },
    {
      label: 'Insert at playhead',
      disabled: !ready || !seq,
      onSelect: () => void addToTimeline(asset, { start: useApp.getState().playhead }),
    },
    {
      label: 'Open in source monitor',
      onSelect: () => useApp.getState().select(asset.id),
    },
    sep,
    {
      label: 'Show file in folder',
      icon: <FolderOpen size={I} />,
      onSelect: () => void shell.invoke('shell.showItemInFolder', { path: asset.originalPath }),
    },
    (asset.status === 'failed' || asset.status === 'processing') && {
      label: 'Retry processing',
      icon: <RotateCcw size={I} />,
      onSelect: () => void backend.invoke('media.retry', { assetId: asset.id }),
    },
    sep,
    {
      label: 'Remove from project',
      icon: <Trash2 size={I} />,
      danger: true,
      onSelect: () =>
        void backend
          .invoke('media.remove', { assetIds: [asset.id] })
          .catch((err: unknown) => notify(String((err as Error).message ?? err), 'warn')),
    },
  ];
}
