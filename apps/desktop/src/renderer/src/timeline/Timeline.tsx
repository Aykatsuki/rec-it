import { captionClipWords } from '@rec-it/captions';
import {
  memo,
  useEffect,
  useLayoutEffect,
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
  Link2,
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
import {
  FLICKS_PER_SECOND,
  sourceTimeAt,
  type KeyframeProperty,
  type Sequence,
  type TimelineItem,
  type Track,
} from '@rec-it/core';
import type { CommandInput, MediaAsset } from '@rec-it/ipc-contract';
import { EmptyState, IconButton } from '@rec-it/ui';
import {
  ASSET_MIME,
  addToTimeline,
  deleteSelected,
  edit,
  isLinked,
  itemEndSec,
  keyframeTimes,
  linkedPartners,
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
import { openContextMenu } from '../ui/ContextMenu';
import { clipMenu, laneMenu, trackMenu } from './menus';
import { openSequenceSettings } from './SequenceSettings';

const HEADER = 156;
const SNAP_PX = 8;

type Drag =
  | {
      kind: 'move';
      /** The clip under the pointer; the others in `group` move by the same amount. */
      item: TimelineItem;
      fromTrack: Track;
      group: { item: TimelineItem; track: Track }[];
      startX: number;
      /** New start of `item`, in seconds. */
      start: number;
      /** How many tracks (of the same kind) the group moves down (+) or up (-). */
      trackShift: number;
      moved: boolean;
    }
  | { kind: 'trim'; item: TimelineItem; edge: 'start' | 'end'; startX: number; time: number }
  | {
      kind: 'marquee';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      additive: boolean;
      base: string[];
      moved: boolean;
    };

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
  const [view, setView] = useState({ left: 0, width: 2000 });
  const inner = useRef<HTMLDivElement>(null);

  // Visible range, so filmstrips only draw the frames on screen.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() =>
        setView({ left: el.scrollLeft, width: el.clientWidth - HEADER }),
      );
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

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

  const snapTargets = (exclude?: string | Set<string>) => {
    const targets = [0, useApp.getState().playhead];
    const skip = (id: string) =>
      typeof exclude === 'string' ? id === exclude : !!exclude?.has(id);
    for (const t of seq.tracks)
      for (const i of t.items) if (!skip(i.id)) targets.push(toSeconds(i.start), itemEndSec(i));
    return targets;
  };
  const snap = (time: number, excludeId?: string | Set<string>, length = 0): number => {
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

  /** Empty lane: click moves the playhead and clears the selection; drag draws a selection box. */
  const laneDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const r = inner.current!.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    setDrag({
      kind: 'marquee',
      x0: x,
      y0: y,
      x1: x,
      y1: y,
      additive,
      base: additive ? useApp.getState().selectedItemIds : [],
      moved: false,
    });
    useApp.getState().setPlaying(false);
  };

  const marqueeSelect = (d: Extract<Drag, { kind: 'marquee' }>) => {
    const root = inner.current!;
    const r = root.getBoundingClientRect();
    const [ax, bx] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
    const [ay, by] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
    const ids = new Set(d.base);
    root.querySelectorAll<HTMLElement>('[data-item-id]').forEach((el) => {
      const b = el.getBoundingClientRect();
      const [l, t] = [b.left - r.left, b.top - r.top];
      if (l < bx && l + b.width > ax && t < by && t + b.height > ay) ids.add(el.dataset.itemId!);
    });
    useApp.getState().selectItems([...ids, ...linkedPartners(seq, [...ids])]);
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
    // Clicking a linked clip selects its partner too; Alt-click selects just the one clip.
    const withPartners = e.altKey ? [item.id] : [item.id, ...linkedPartners(seq, [item.id])];
    if (e.shiftKey || e.ctrlKey) {
      selectItems(
        selectedItemIds.includes(item.id)
          ? selectedItemIds.filter((i) => !withPartners.includes(i))
          : [...new Set([...selectedItemIds, ...withPartners])],
      );
    } else if (!selectedItemIds.includes(item.id)) {
      selectItems(withPartners);
    }
    useApp.getState().setPlaying(false);
    const start = toSeconds(item.start);
    const ids = new Set(useApp.getState().selectedItemIds);
    ids.add(item.id);
    const group = seq.tracks.flatMap((t) =>
      t.items.filter((i) => ids.has(i.id)).map((i) => ({ item: i, track: t })),
    );
    if (mode === 'move' && group.some((g) => g.track.locked)) return;
    setDrag(
      mode === 'move'
        ? {
            kind: 'move',
            item,
            fromTrack: track,
            group,
            startX: e.clientX,
            start,
            trackShift: 0,
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
    if (drag.kind === 'marquee') {
      const r = inner.current!.getBoundingClientRect();
      const next = {
        ...drag,
        x1: e.clientX - r.left,
        y1: e.clientY - r.top,
        moved:
          drag.moved || Math.hypot(e.clientX - r.left - drag.x0, e.clientY - r.top - drag.y0) > 4,
      };
      setDrag(next);
      if (next.moved) marqueeSelect(next);
      return;
    }
    const dx = (e.clientX - drag.startX) / zoom;
    if (drag.kind === 'move') {
      const lane = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-track-id]');
      const target = seq.tracks.find((t) => t.id === lane?.dataset.trackId);
      let trackShift = drag.trackShift;
      if (target && target.kind === drag.fromTrack.kind) {
        const same = seq.tracks.filter((t) => t.kind === target.kind);
        const shift = same.indexOf(target) - same.indexOf(drag.fromTrack);
        // Only allow a shift that keeps every clip of that kind on an existing track.
        const ok = drag.group.every((g) => {
          if (g.track.kind !== target.kind) return true;
          const to = same[same.indexOf(g.track) + shift];
          return !!to && !to.locked;
        });
        if (ok) trackShift = shift;
      }
      const ids = new Set(drag.group.map((g) => g.item.id));
      const length = toSeconds(drag.item.duration);
      // The whole group cannot start before 0.
      const earliest = Math.min(...drag.group.map((g) => toSeconds(g.item.start)));
      const minStart = toSeconds(drag.item.start) - earliest;
      setDrag({
        ...drag,
        start: Math.max(minStart, snap(toSeconds(drag.item.start) + dx, ids, length)),
        trackShift,
        moved: drag.moved || Math.abs(e.clientX - drag.startX) > 3,
      });
    } else {
      const base = drag.edge === 'start' ? toSeconds(drag.item.start) : itemEndSec(drag.item);
      setDrag({ ...drag, time: snap(base + dx, drag.item.id) });
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.kind === 'marquee') {
      if (!d.moved) {
        // A plain click on empty space: move the playhead there and clear the selection.
        useApp.getState().setPlayhead(snapping ? snap(timeAt(e.clientX)) : timeAt(e.clientX));
        if (!d.additive) useApp.getState().selectItems([]);
      }
      return;
    }
    if (d.kind === 'move' && d.moved) {
      const delta = toFlicks(d.start) - d.item.start;
      void edit({
        type: 'item.moveMany',
        sequenceId: seq.id,
        moves: groupTargets(d).map(({ item, trackId }) => ({
          itemId: item.id,
          trackId,
          start: Math.max(0, item.start + delta),
        })),
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

  const latest = useRef({ beginItemDrag, seq });
  useLayoutEffect(() => {
    latest.current = { beginItemDrag, seq };
  });

  /**
   * Only clips near the visible part of the timeline are rendered, so long timelines (1,000+
   * clips) stay smooth. Selected and dragged clips are always rendered.
   */
  const margin = 400;
  const onScreen = (item: TimelineItem) => {
    const left = toSeconds(item.start) * zoom;
    const right = left + toSeconds(item.duration) * zoom;
    return (
      (right >= view.left - margin && left <= view.left + view.width + margin) ||
      selected.includes(item.id) ||
      (drag?.kind === 'move' && drag.group.some((g) => g.item.id === item.id))
    );
  };

  /** Where each clip of a moving group ends up. */
  const groupTargets = (d: Extract<Drag, { kind: 'move' }>) =>
    d.group.map(({ item, track }) => {
      if (track.kind !== d.fromTrack.kind) return { item, trackId: track.id };
      const same = seq.tracks.filter((t) => t.kind === track.kind);
      return { item, trackId: (same[same.indexOf(track) + d.trackShift] ?? track).id };
    });

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
      <div className="tl__inner" ref={inner} style={{ width: width + HEADER }}>
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
              onPointerDown={laneDown}
              onContextMenu={(e) => openContextMenu(e, laneMenu(seq, track, timeAt(e.clientX)))}
              onDragOver={(e) => onLaneDragOver(e, track)}
              onDragLeave={() => setDropHint(null)}
              onDrop={(e) => onLaneDrop(e, track)}
            >
              {track.items
                .filter((item) => onScreen(item))
                .map((item) => {
                  const dimmed =
                    (drag?.kind === 'trim' && drag.item.id === item.id) ||
                    (drag?.kind === 'move' &&
                      drag.moved &&
                      drag.group.some((g) => g.item.id === item.id));
                  return (
                    <ItemView
                      key={item.id}
                      item={item}
                      track={track}
                      asset={byId.get(item.assetId)}
                      zoom={zoom}
                      view={view}
                      linked={isLinked(seq, item)}
                      selected={selected.includes(item.id)}
                      dimmed={dimmed}
                      // Through a ref: memoised clips keep these handlers, which must see the
                      // latest timeline.
                      onPointerDown={(e, mode) =>
                        latest.current.beginItemDrag(e, track, item, mode)
                      }
                      onContextMenu={(e) =>
                        openContextMenu(e, clipMenu(latest.current.seq, [item.id]))
                      }
                    />
                  );
                })}
              {drag?.kind === 'move' &&
                drag.moved &&
                groupTargets(drag)
                  .filter((g) => g.trackId === track.id)
                  .map(({ item }) => (
                    <div
                      key={item.id}
                      className="tl__ghost"
                      style={{
                        left:
                          Math.max(
                            0,
                            toSeconds(item.start) + drag.start - toSeconds(drag.item.start),
                          ) * zoom,
                        width: toSeconds(item.duration) * zoom,
                      }}
                    />
                  ))}
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
        {drag?.kind === 'marquee' && drag.moved && (
          <div
            className="tl__marquee"
            data-testid="marquee"
            style={{
              left: Math.min(drag.x0, drag.x1),
              top: Math.min(drag.y0, drag.y1),
              width: Math.abs(drag.x1 - drag.x0),
              height: Math.abs(drag.y1 - drag.y0),
            }}
          />
        )}
      </div>
    </div>
  );
}

function TrackHeader({ seq, track }: { seq: Sequence; track: Track }) {
  const update = (patch: { muted?: boolean; hidden?: boolean; locked?: boolean }) =>
    void edit({ type: 'track.update', sequenceId: seq.id, trackId: track.id, ...patch });
  return (
    <div
      className="tl__header"
      data-kind={track.kind}
      onContextMenu={(e) => openContextMenu(e, trackMenu(seq, track))}
    >
      <span className="track-header__chip">{track.name}</span>
      <span className="tl__header-buttons">
        {track.kind !== 'audio' ? (
          <IconButton
            label={track.hidden ? 'Show track' : 'Hide track'}
            size="sm"
            aria-pressed={track.hidden}
            onClick={() => update({ hidden: !track.hidden })}
          >
            {track.hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
        ) : null}
        {track.kind !== 'caption' && (
          <IconButton
            label={track.muted ? 'Unmute track' : 'Mute track'}
            size="sm"
            aria-pressed={track.muted}
            onClick={() => update({ muted: !track.muted })}
          >
            {track.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </IconButton>
        )}
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

/** Clips narrower than this are drawn as plain blocks (no filmstrip, waveform or label). */
const DETAIL_MIN_PX = 24;

/**
 * A clip only re-renders when something about it changes (not on every playhead move); the
 * scroll position matters only to filmstrips.
 */
const ItemView = memo(
  ItemViewInner,
  (a, b) =>
    a.item === b.item &&
    a.track === b.track &&
    a.asset === b.asset &&
    a.zoom === b.zoom &&
    a.linked === b.linked &&
    a.selected === b.selected &&
    a.dimmed === b.dimmed &&
    (a.view === b.view || !a.asset?.urls.sprite || a.track.kind !== 'video'),
);

function ItemViewInner({
  item,
  track,
  asset,
  zoom,
  view,
  linked,
  selected,
  dimmed,
  onPointerDown,
  onContextMenu,
}: {
  linked: boolean;
  item: TimelineItem;
  track: Track;
  asset: MediaAsset | undefined;
  zoom: number;
  view: { left: number; width: number };
  selected: boolean;
  dimmed: boolean;
  onPointerDown: (e: ReactPointerEvent, mode: 'move' | 'start' | 'end') => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const left = toSeconds(item.start) * zoom;
  const width = Math.max(4, toSeconds(item.duration) * zoom);
  const assetSeconds = asset?.probe?.durationSec ?? 0;
  const hasWave = !!asset?.urls.waveform && assetSeconds > 0;
  const showWave = hasWave && (track.kind === 'audio' || !!asset?.probe?.audio);
  const poster = track.kind === 'video' ? (asset?.urls.still ?? asset?.urls.poster) : undefined;
  const sprite = track.kind === 'video' && asset?.kind === 'video' ? asset.urls.sprite : undefined;
  const v = asset?.probe?.video;
  const detailed = width >= DETAIL_MIN_PX;
  return (
    <div
      className="tl__item"
      data-kind={track.kind}
      data-selected={selected}
      data-dimmed={dimmed}
      data-testid="timeline-item"
      data-item-id={item.id}
      data-asset-name={asset?.name}
      data-has-wave={showWave && track.kind === 'video'}
      style={{ left, width }}
      onPointerDown={(e) => onPointerDown(e, 'move')}
      onContextMenu={onContextMenu}
      title={item.caption ? captionText(item) : asset?.name}
    >
      {!detailed ? null : sprite && v ? (
        <Filmstrip
          sprite={sprite}
          aspect={v.displayWidth / v.displayHeight}
          item={item}
          zoom={zoom}
          // Visible part of this clip, relative to its left edge.
          from={view.left - left}
          to={view.left + view.width - left}
          width={width}
        />
      ) : (
        poster && <div className="tl__film" style={{ backgroundImage: `url("${poster}")` }} />
      )}
      {detailed && showWave && (
        <div
          className={`tl__wave${track.kind === 'video' ? ' tl__wave--under' : ''}`}
          style={{ left: -toSeconds(item.sourceIn) * zoom, width: assetSeconds * zoom }}
        >
          <WaveformStrip url={asset!.urls.waveform!} className="tl__wave-svg" />
        </div>
      )}
      {item.caption ? (
        <span className="tl__item-label tl__item-label--caption">{captionText(item)}</span>
      ) : (
        <span className="tl__item-label">
          {linked && <Link2 size={11} aria-label="Linked" />}
          {item.muted && <VolumeX size={11} />} {asset?.name ?? 'Missing media'}
        </span>
      )}
      {item.keyframes &&
        keyframeTimes(item)
          .filter((t) => t >= toSeconds(item.start) && t <= itemEndSec(item))
          .map((t) => <KeyframeMarker key={t} item={item} time={t} zoom={zoom} />)}
      <span
        className="tl__handle tl__handle--start"
        onPointerDown={(e) => onPointerDown(e, 'start')}
      />
      <span className="tl__handle tl__handle--end" onPointerDown={(e) => onPointerDown(e, 'end')} />
    </div>
  );
}

/** The words a caption clip shows. */
function captionText(item: TimelineItem): string {
  return captionClipWords(item)
    .map((w) => w.text)
    .join(' ');
}

/** Thumbnails from the asset's sprite sheet along a video clip; only the visible ones are drawn. */
function Filmstrip({
  sprite,
  aspect,
  item,
  zoom,
  from,
  to,
  width,
}: {
  sprite: NonNullable<MediaAsset['urls']['sprite']>;
  aspect: number;
  item: TimelineItem;
  zoom: number;
  from: number;
  to: number;
  width: number;
}) {
  const tileW = Math.max(16, Math.round(48 * (aspect || 16 / 9)));
  const first = Math.max(0, Math.floor(from / tileW));
  const last = Math.min(Math.ceil(width / tileW), Math.ceil(to / tileW) + 1);
  const tiles = [];
  for (let i = first; i < last && tiles.length < 400; i++) {
    const x = i * tileW;
    const t = toSeconds(item.sourceIn) + (x + tileW / 2) / zoom;
    const frame = Math.min(sprite.count - 1, Math.max(0, Math.floor(t / sprite.interval)));
    const col = frame % sprite.columns;
    const row = Math.floor(frame / sprite.columns);
    tiles.push(
      <span
        key={i}
        className="tl__tile"
        style={{
          left: x,
          width: tileW,
          backgroundImage: `url("${sprite.url}")`,
          backgroundSize: `${sprite.columns * 100}% ${sprite.rows * 100}%`,
          backgroundPosition: `${sprite.columns > 1 ? (col / (sprite.columns - 1)) * 100 : 0}% ${
            sprite.rows > 1 ? (row / (sprite.rows - 1)) * 100 : 0
          }%`,
        }}
      />,
    );
  }
  return (
    <div className="tl__filmstrip" data-testid="filmstrip">
      {tiles}
    </div>
  );
}

/**
 * A keyframe diamond on a clip. Click: move the playhead there. Drag: move every keyframe at
 * that time (all properties) to a new frame inside the clip, as one undo step.
 */
function KeyframeMarker({ item, time, zoom }: { item: TimelineItem; time: number; zoom: number }) {
  const [drag, setDrag] = useState<{ x0: number; t: number } | null>(null);
  const seq = useSequence();
  const frame = seq ? seq.fps.den / seq.fps.num : 1 / 30;
  const start = toSeconds(item.start);
  const end = itemEndSec(item);
  const target = (clientX: number, x0: number) => {
    const t = time + (clientX - x0) / zoom;
    const snapped = start + Math.round((t - start) / frame) * frame;
    return Math.min(end - frame, Math.max(start, snapped));
  };
  const shown = drag ? drag.t : time;
  return (
    <span
      className="tl__kf"
      data-testid="timeline-keyframe"
      data-dragging={!!drag}
      title={`Keyframe at ${shown.toFixed(2)} s — drag to move`}
      style={{ left: (shown - start) * zoom }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ x0: e.clientX, t: time });
      }}
      onPointerMove={(e) => {
        if (drag) setDrag({ ...drag, t: target(e.clientX, drag.x0) });
      }}
      onPointerUp={async (e) => {
        if (!drag) return;
        const to = target(e.clientX, drag.x0);
        setDrag(null);
        const state = useApp.getState();
        if (Math.abs(to - time) < frame / 2) {
          // A click: go to the keyframe.
          state.setPlaying(false);
          state.setPlayhead(time);
          return;
        }
        if (!seq) return;
        const from = sourceTimeAt(item, toFlicks(time));
        const dest = sourceTimeAt(item, toFlicks(to));
        const half = (FLICKS_PER_SECOND * frame) / 2;
        const commands: CommandInput[] = [];
        for (const [property, keys] of Object.entries(item.keyframes ?? {})) {
          const k = keys?.find((x) => Math.abs(x.t - from) <= half);
          if (!k) continue;
          const p = property as KeyframeProperty;
          commands.push(
            { type: 'keyframe.remove', sequenceId: seq.id, itemId: item.id, property: p, t: k.t },
            {
              type: 'keyframe.set',
              sequenceId: seq.id,
              itemId: item.id,
              property: p,
              t: dest,
              value: k.v,
              easing: k.e,
            },
          );
        }
        if (commands.length && (await edit({ type: 'batch', commands } as CommandInput)))
          state.setPlayhead(to);
      }}
      onPointerCancel={() => setDrag(null)}
    />
  );
}
