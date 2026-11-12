import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Eye,
  EyeOff,
  Film,
  Lock,
  LockOpen,
  Magnet,
  Music,
  Plus,
  Redo2,
  Scissors,
  Settings2,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { Sequence, TimelineItem, Track } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { EmptyState, IconButton } from '@rec-it/ui';
import {
  ASSET_MIME,
  addToTimeline,
  deleteSelected,
  edit,
  itemEndSec,
  redo,
  sequenceSeconds,
  splitAtPlayhead,
  toFlicks,
  toSeconds,
  undo,
} from '../edit';
import { formatFps } from '../format';
import { WaveformStrip } from '../media/AssetCard';
import { useApp, useSequence } from '../store';
import { openSequenceSettings } from './SequenceSettings';

const HEADER = 156;
const SNAP_PX = 8;

type Drag =
  | {
      kind: 'move';
      item: TimelineItem;
      fromTrack: Track;
      startX: number;
      start: number;
      trackId: string;
      moved: boolean;
    }
  | { kind: 'trim'; item: TimelineItem; edge: 'start' | 'end'; startX: number; time: number };

function timecode(seconds: number, fine = false): string {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return fine
    ? `${m}:${s.toFixed(1).padStart(4, '0')}`
    : `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}

/** Ruler step: the smallest "nice" interval that is at least 80 px wide at this zoom. */
function rulerStep(zoom: number): number {
  return (
    [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * zoom >= 80) ?? 600
  );
}

export function Timeline() {
  const seq = useSequence();
  const docState = useApp((s) => s.docState);
  const zoom = useApp((s) => s.zoom);
  const setZoom = useApp((s) => s.setZoom);
  const snapping = useApp((s) => s.snapping);
  const selected = useApp((s) => s.selectedItemIds);

  return (
    <section
      className="panel timeline"
      data-region="timeline"
      aria-label="Timeline"
      onPointerDown={() => useApp.setState({ focus: 'timeline' })}
    >
      <header className="panel__header timeline__toolbar">
        <div className="toolgroup" role="toolbar" aria-label="Edit">
          <IconButton
            label="Undo (Ctrl+Z)"
            size="sm"
            disabled={!docState?.canUndo}
            onClick={() => void undo()}
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            label="Redo (Ctrl+Shift+Z)"
            size="sm"
            disabled={!docState?.canRedo}
            onClick={() => void redo()}
          >
            <Redo2 size={15} />
          </IconButton>
          <span className="toolgroup__sep" />
          <IconButton
            label="Split at playhead (S)"
            size="sm"
            disabled={!seq}
            onClick={() => void splitAtPlayhead()}
          >
            <Scissors size={15} />
          </IconButton>
          <IconButton
            label="Delete selected (Delete; Shift+Delete closes the gap)"
            size="sm"
            disabled={!selected.length}
            onClick={() => void deleteSelected(false)}
          >
            <Trash2 size={15} />
          </IconButton>
          <IconButton
            label={snapping ? 'Snapping on (N)' : 'Snapping off (N)'}
            size="sm"
            aria-pressed={snapping}
            onClick={() => useApp.setState({ snapping: !snapping })}
          >
            <Magnet size={15} />
          </IconButton>
        </div>
        {seq ? (
          <button
            type="button"
            className="seq-chip"
            onClick={() => openSequenceSettings(seq)}
            title="Sequence settings: name, resolution and frame rate"
            data-testid="sequence-settings"
          >
            <Settings2 size={13} />
            <strong>{seq.name}</strong>
            <span>
              {seq.width}×{seq.height} · {formatFps(seq.fps)} fps
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="seq-chip"
            onClick={() => openSequenceSettings(null)}
            data-testid="sequence-settings"
          >
            <Plus size={13} /> New sequence…
          </button>
        )}
        <div className="toolgroup">
          {seq && (
            <>
              <IconButton
                label="Add video track"
                size="sm"
                onClick={() => void edit({ type: 'track.add', sequenceId: seq.id, kind: 'video' })}
              >
                <Film size={14} />
              </IconButton>
              <IconButton
                label="Add audio track"
                size="sm"
                onClick={() => void edit({ type: 'track.add', sequenceId: seq.id, kind: 'audio' })}
              >
                <Music size={14} />
              </IconButton>
              <span className="toolgroup__sep" />
            </>
          )}
          <IconButton label="Zoom out (-)" size="sm" onClick={() => setZoom(zoom / 1.5)}>
            <ZoomOut size={15} />
          </IconButton>
          <input
            className="zoom-slider"
            type="range"
            min={Math.log(4)}
            max={Math.log(600)}
            step={0.01}
            value={Math.log(zoom)}
            onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
            aria-label="Zoom"
          />
          <IconButton label="Zoom in (+)" size="sm" onClick={() => setZoom(zoom * 1.5)}>
            <ZoomIn size={15} />
          </IconButton>
        </div>
      </header>
      {seq ? <TimelineBody seq={seq} /> : <EmptyTimeline />}
    </section>
  );
}

function EmptyTimeline() {
  const assets = useApp((s) => s.assets);
  const [over, setOver] = useState(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const asset = assets.find((a) => a.id === e.dataTransfer.getData(ASSET_MIME));
    if (asset) void addToTimeline(asset, { start: 0 });
  };
  return (
    <div
      className="timeline__empty"
      data-over={over}
      data-testid="timeline-drop"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(ASSET_MIME)) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <EmptyState icon={<Film size={20} />} title="Drag a clip here to start">
        Rec-It creates a 1080×1920 vertical Short at your clip's frame rate. Change it any time in
        sequence settings.
      </EmptyState>
    </div>
  );
}

function TimelineBody({ seq }: { seq: Sequence }) {
  const assets = useApp((s) => s.assets);
  const zoom = useApp((s) => s.zoom);
  const playhead = useApp((s) => s.playhead);
  const snapping = useApp((s) => s.snapping);
  const selected = useApp((s) => s.selectedItemIds);
  const scroller = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dropHint, setDropHint] = useState<{ trackId: string; time: number } | null>(null);

  const byId = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);
  const total = sequenceSeconds(seq);
  const width = Math.max((total + 30) * zoom, 2000);

  // Ctrl + wheel zooms around the pointer.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - HEADER + el.scrollLeft;
      const at = x / useApp.getState().zoom;
      const next = useApp.getState().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      useApp.getState().setZoom(next);
      el.scrollLeft = Math.max(0, at * useApp.getState().zoom - (e.clientX - rect.left - HEADER));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const snapTargets = (excludeId?: string) => {
    const targets = [0, useApp.getState().playhead];
    for (const t of seq.tracks)
      for (const i of t.items)
        if (i.id !== excludeId) targets.push(toSeconds(i.start), itemEndSec(i));
    return targets;
  };
  const snap = (time: number, excludeId?: string, length = 0): number => {
    if (!snapping) return Math.max(0, time);
    const threshold = SNAP_PX / zoom;
    let best = time;
    let bestDist = threshold;
    for (const target of snapTargets(excludeId)) {
      for (const [edge, offset] of [
        [time, 0],
        [time + length, length],
      ] as const) {
        const d = Math.abs(edge - target);
        if (d < bestDist) {
          bestDist = d;
          best = target - offset;
        }
      }
    }
    return Math.max(0, best);
  };

  const timeAt = (clientX: number) => {
    const el = scroller.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEADER + el.scrollLeft) / zoom);
  };

  // Playhead: click or drag on the ruler or empty lane space.
  const scrubFrom = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const set = (x: number) =>
      useApp.getState().setPlayhead(snapping ? snap(timeAt(x)) : timeAt(x));
    set(e.clientX);
    const move = (ev: PointerEvent) => set(ev.clientX);
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    useApp.getState().selectItems([]);
    useApp.getState().setPlaying(false);
  };

  const beginItemDrag = (
    e: ReactPointerEvent,
    track: Track,
    item: TimelineItem,
    mode: 'move' | 'start' | 'end',
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (track.locked) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const { selectedItemIds, selectItems } = useApp.getState();
    if (e.shiftKey || e.ctrlKey) {
      selectItems(
        selectedItemIds.includes(item.id)
          ? selectedItemIds.filter((i) => i !== item.id)
          : [...selectedItemIds, item.id],
      );
    } else if (!selectedItemIds.includes(item.id)) {
      selectItems([item.id]);
    }
    useApp.getState().setPlaying(false);
    const start = toSeconds(item.start);
    setDrag(
      mode === 'move'
        ? {
            kind: 'move',
            item,
            fromTrack: track,
            startX: e.clientX,
            start,
            trackId: track.id,
            moved: false,
          }
        : {
            kind: 'trim',
            item,
            edge: mode,
            startX: e.clientX,
            time: mode === 'start' ? start : itemEndSec(item),
          },
    );
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    const dx = (e.clientX - drag.startX) / zoom;
    if (drag.kind === 'move') {
      const lane = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-track-id]');
      const target = seq.tracks.find((t) => t.id === lane?.dataset.trackId);
      const trackId = target && target.kind === drag.fromTrack.kind ? target.id : drag.trackId;
      const length = toSeconds(drag.item.duration);
      setDrag({
        ...drag,
        start: snap(toSeconds(drag.item.start) + dx, drag.item.id, length),
        trackId,
        moved: drag.moved || Math.abs(e.clientX - drag.startX) > 3,
      });
    } else {
      const base = drag.edge === 'start' ? toSeconds(drag.item.start) : itemEndSec(drag.item);
      setDrag({ ...drag, time: snap(base + dx, drag.item.id) });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'move' && d.moved) {
      void edit({
        type: 'item.move',
        sequenceId: seq.id,
        itemId: d.item.id,
        trackId: d.trackId,
        start: toFlicks(d.start),
      });
    } else if (d.kind === 'trim') {
      void edit({
        type: 'item.trim',
        sequenceId: seq.id,
        itemId: d.item.id,
        edge: d.edge,
        time: toFlicks(d.time),
      });
    }
  };

  const onLaneDragOver = (e: DragEvent, track: Track) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropHint({ trackId: track.id, time: snap(timeAt(e.clientX)) });
  };
  const onLaneDrop = (e: DragEvent, track: Track) => {
    e.preventDefault();
    setDropHint(null);
    const asset = byId.get(e.dataTransfer.getData(ASSET_MIME));
    if (asset) void addToTimeline(asset, { trackId: track.id, start: snap(timeAt(e.clientX)) });
  };

  const step = rulerStep(zoom);
  const ticks = Array.from({ length: Math.ceil(width / zoom / step) + 1 }, (_, i) => i * step);

  return (
    <div
      className="tl"
      ref={scroller}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setDrag(null)}
    >
      <div className="tl__inner" style={{ width: width + HEADER }}>
        <div className="tl__ruler-row">
          <div className="tl__corner">{timecode(playhead, true)}</div>
          <div className="tl__ruler" onPointerDown={scrubFrom} data-testid="ruler">
            {ticks.map((t) => (
              <span key={t} className="tl__tick" style={{ left: t * zoom }}>
                {timecode(t, step < 1)}
              </span>
            ))}
            <span className="tl__minor" style={{ backgroundSize: `${(step * zoom) / 5}px 100%` }} />
          </div>
        </div>
        {seq.tracks.map((track) => (
          <div key={track.id} className="tl__row" data-kind={track.kind}>
            <TrackHeader seq={seq} track={track} />
            <div
              className="tl__lane"
              data-track-id={track.id}
              data-locked={track.locked}
              data-hidden={track.hidden}
              onPointerDown={scrubFrom}
              onDragOver={(e) => onLaneDragOver(e, track)}
              onDragLeave={() => setDropHint(null)}
              onDrop={(e) => onLaneDrop(e, track)}
            >
              {track.items.map((item) => {
                const ghost = drag?.item.id === item.id ? drag : null;
                return (
                  <ItemView
                    key={item.id}
                    item={item}
                    track={track}
                    asset={byId.get(item.assetId)}
                    zoom={zoom}
                    selected={selected.includes(item.id)}
                    dimmed={!!ghost && (ghost.kind === 'trim' || ghost.moved)}
                    onPointerDown={(e, mode) => beginItemDrag(e, track, item, mode)}
                  />
                );
              })}
              {drag?.kind === 'move' && drag.moved && drag.trackId === track.id && (
                <div
                  className="tl__ghost"
                  style={{ left: drag.start * zoom, width: toSeconds(drag.item.duration) * zoom }}
                />
              )}
              {drag?.kind === 'trim' &&
                seq.tracks.find((t) => t.items.includes(drag.item))?.id === track.id && (
                  <div
                    className="tl__ghost"
                    style={
                      drag.edge === 'start'
                        ? {
                            left: drag.time * zoom,
                            width: Math.max(2, (itemEndSec(drag.item) - drag.time) * zoom),
                          }
                        : {
                            left: toSeconds(drag.item.start) * zoom,
                            width: Math.max(2, (drag.time - toSeconds(drag.item.start)) * zoom),
                          }
                    }
                  />
                )}
              {dropHint?.trackId === track.id && (
                <div className="tl__drop-marker" style={{ left: dropHint.time * zoom }} />
              )}
            </div>
          </div>
        ))}
        <div
          className="tl__playhead"
          style={{ left: HEADER + playhead * zoom }}
          data-testid="playhead"
        />
      </div>
    </div>
  );
}

function TrackHeader({ seq, track }: { seq: Sequence; track: Track }) {
  const update = (patch: { muted?: boolean; hidden?: boolean; locked?: boolean }) =>
    void edit({ type: 'track.update', sequenceId: seq.id, trackId: track.id, ...patch });
  return (
    <div className="tl__header" data-kind={track.kind}>
      <span className="track-header__chip">{track.name}</span>
      <span className="tl__header-buttons">
        {track.kind === 'video' ? (
          <IconButton
            label={track.hidden ? 'Show track' : 'Hide track'}
            size="sm"
            aria-pressed={track.hidden}
            onClick={() => update({ hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        ) : null}
        <IconButton
          label={track.muted ? 'Unmute track' : 'Mute track'}
          size="sm"
          aria-pressed={track.muted}
          onClick={() => update({ muted: !track.muted })}
        >
          {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
        </IconButton>
        <IconButton
          label={track.locked ? 'Unlock track' : 'Lock track'}
          size="sm"
          aria-pressed={track.locked}
          onClick={() => update({ locked: !track.locked })}
        >
          {track.locked ? <Lock size={13} /> : <LockOpen size={13} />}
        </IconButton>
      </span>
    </div>
  );
}

function ItemView({
  item,
  track,
  asset,
  zoom,
  selected,
  dimmed,
  onPointerDown,
}: {
  item: TimelineItem;
  track: Track;
  asset: MediaAsset | undefined;
  zoom: number;
  selected: boolean;
  dimmed: boolean;
  onPointerDown: (e: ReactPointerEvent, mode: 'move' | 'start' | 'end') => void;
}) {
  const left = toSeconds(item.start) * zoom;
  const width = Math.max(4, toSeconds(item.duration) * zoom);
  const assetSeconds = asset?.probe?.durationSec ?? 0;
  const showWave = track.kind === 'audio' && asset?.urls.waveform && assetSeconds > 0;
  const poster = track.kind === 'video' ? (asset?.urls.still ?? asset?.urls.poster) : undefined;
  return (
    <div
      className="tl__item"
      data-kind={track.kind}
      data-selected={selected}
      data-dimmed={dimmed}
      data-testid="timeline-item"
      data-asset-name={asset?.name}
      style={{ left, width }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      title={asset?.name}
    >
      {poster && <div className="tl__film" style={{ backgroundImage: `url("${poster}")` }} />}
      {showWave && (
        <div
          className="tl__wave"
          style={{ left: -toSeconds(item.sourceIn) * zoom, width: assetSeconds * zoom }}
        >
          <WaveformStrip url={asset!.urls.waveform!} className="tl__wave-svg" />
        </div>
      )}
      <span className="tl__item-label">
        {item.muted && <VolumeX size={11} />} {asset?.name ?? 'Missing media'}
      </span>
      <span
        className="tl__handle tl__handle--start"
        onPointerDown={(e) => onPointerDown(e, 'start')}
      />
      <span className="tl__handle tl__handle--end" onPointerDown={(e) => onPointerDown(e, 'end')} />
    </div>
  );
}
