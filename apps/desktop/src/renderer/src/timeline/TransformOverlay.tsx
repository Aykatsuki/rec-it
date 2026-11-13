import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  computeLayout,
  normalizeAngle,
  transformAt,
  type Sequence,
  type TimelineItem,
  type Track,
  type Layout,
  type Transform,
} from '@rec-it/core';
import { captionBox } from '../engine/caption-geometry';
import { commitTransform, primaryClip, toFlicks } from '../edit';
import { useApp } from '../store';

/** A clip that is on screen at the playhead. */
export interface VisibleLayer {
  item: TimelineItem;
  track: Track;
  srcW: number;
  srcH: number;
  /** Stacking order, higher is on top. */
  layer: number;
  /** Caption clips are boxed around their text instead of a picture (ADR-033). */
  caption?: boolean;
}

/** Where a layer sits in the frame with transform `t`. */
function layoutOf(layer: VisibleLayer, seq: Sequence, t: Transform): Layout {
  if (layer.caption) {
    const box = captionBox(seq, layer.item, t);
    if (box) return box;
  }
  return computeLayout(layer.srcW, layer.srcH, seq.width, seq.height, t);
}

type Corner = 'nw' | 'ne' | 'se' | 'sw';
type Mode = 'move' | 'scale' | 'rotate';

interface Drag {
  mode: Mode;
  pointerId: number;
  layer: VisibleLayer;
  start: { x: number; y: number };
  t0: Transform;
  /** Centre of the clip in sequence pixels when the drag started. */
  c0: { x: number; y: number };
  changed: boolean;
}

/** Snap distance in screen pixels. */
const SNAP_PX = 6;

/** What a clip looks like now: the transform being dragged, else its (keyframed) transform at `at` seconds. */
export const transformFor = (
  item: TimelineItem,
  draft: { itemId: string; transform: Transform } | null,
  at: number = useApp.getState().playhead,
): Transform => (draft?.itemId === item.id ? draft.transform : transformAt(item, toFlicks(at)));

function centreOf(layer: VisibleLayer, seq: Sequence, t: Transform) {
  const l = layoutOf(layer, seq, t);
  return { l, x: l.left + l.width / 2, y: l.top + l.height / 2 };
}

/** True when `p` (sequence pixels) is inside the clip's rotated rectangle. */
function hits(layer: VisibleLayer, seq: Sequence, t: Transform, p: { x: number; y: number }) {
  const { l, x, y } = centreOf(layer, seq, t);
  const r = (-l.rotation * Math.PI) / 180;
  const dx = p.x - x;
  const dy = p.y - y;
  const rx = dx * Math.cos(r) - dy * Math.sin(r);
  const ry = dx * Math.sin(r) + dy * Math.cos(r);
  return Math.abs(rx) <= l.width / 2 && Math.abs(ry) <= l.height / 2;
}

/**
 * Direct manipulation in the program monitor: click a clip to select it, drag to move, drag a
 * corner to resize, drag the round handle to rotate. Shift constrains (axis, 15° steps); Alt
 * turns snapping off; Escape cancels. Changes preview live and become one undoable edit on release.
 */
export function TransformOverlay({
  seq,
  box,
  layers,
  onContextMenu,
}: {
  seq: Sequence;
  box: { w: number; h: number };
  layers: VisibleLayer[];
  onContextMenu?: (e: React.MouseEvent, itemId: string | null) => void;
}) {
  const selected = useApp((s) => s.selectedItemIds);
  const draft = useApp((s) => s.draftTransform);
  const snapping = useApp((s) => s.snapping);
  // Keyframed clips change shape as the playhead moves.
  const playhead = useApp((s) => s.playhead);
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [label, setLabel] = useState<string | null>(null);
  const k = box.w / seq.width || 1;

  const primary = primaryClip(seq, selected);
  const target = primary ? layers.find((l) => l.item.id === primary.item.id) : undefined;

  const toSeq = (e: { clientX: number; clientY: number }) => {
    const rect = surface.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k };
  };

  const topmostAt = (p: { x: number; y: number }) =>
    [...layers]
      .sort((a, b) => b.layer - a.layer)
      .find((l) => hits(l, seq, transformFor(l.item, draft, playhead), p));

  const cancel = () => {
    drag.current = null;
    useApp.getState().setDraftTransform(null);
    setGuides({ v: false, h: false });
    setLabel(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag.current) {
        e.stopPropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const begin = (e: ReactPointerEvent, mode: Mode, layer: VisibleLayer) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const state = useApp.getState();
    state.selectItems([layer.item.id]);
    useApp.setState({ focus: 'timeline', playing: false });
    if (layer.track.locked) return;
    const t0 = transformFor(layer.item, state.draftTransform);
    const { x, y } = centreOf(layer, seq, t0);
    surface.current?.setPointerCapture(e.pointerId);
    drag.current = {
      mode,
      pointerId: e.pointerId,
      layer,
      start: toSeq(e),
      t0,
      c0: { x, y },
      changed: false,
    };
  };

  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const mode = (e.target as HTMLElement).dataset.xfMode as Mode | undefined;
    if (mode && target) {
      begin(e, mode, target);
      return;
    }
    const hit = topmostAt(toSeq(e));
    if (hit) begin(e, 'move', hit);
    else useApp.getState().selectItems([]);
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = toSeq(e);
    const snap = snapping !== e.altKey;
    const th = SNAP_PX / k;
    let t: Transform;
    const g = { v: false, h: false };

    if (d.mode === 'move') {
      let dx = p.x - d.start.x;
      let dy = p.y - d.start.y;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      let cx = d.c0.x + dx;
      let cy = d.c0.y + dy;
      if (snap) {
        const { bounds } = layoutOf(d.layer, seq, d.t0);
        const snapAxis = (c: number, size: number, frame: number) => {
          const targets = [frame / 2, size / 2, frame - size / 2];
          for (const target of targets) if (Math.abs(c - target) < th) return target;
          return null;
        };
        const sx = snapAxis(cx, bounds.width, seq.width);
        const sy = snapAxis(cy, bounds.height, seq.height);
        if (sx !== null) {
          cx = sx;
          g.v = sx === seq.width / 2;
        }
        if (sy !== null) {
          cy = sy;
          g.h = sy === seq.height / 2;
        }
      }
      t = {
        ...d.t0,
        x: Math.min(2, Math.max(-2, d.t0.x + (cx - d.c0.x) / seq.width)),
        y: Math.min(2, Math.max(-2, d.t0.y + (cy - d.c0.y) / seq.height)),
      };
      setLabel(null);
    } else if (d.mode === 'scale') {
      const d0 = Math.hypot(d.start.x - d.c0.x, d.start.y - d.c0.y) || 1;
      const d1 = Math.hypot(p.x - d.c0.x, p.y - d.c0.y);
      let scale = Math.min(10, Math.max(0.05, (d.t0.scale * d1) / d0));
      if (e.shiftKey) scale = Math.round(scale * 20) / 20;
      else if (snap && Math.abs(scale - 1) < 0.03) scale = 1;
      t = { ...d.t0, scale };
      setLabel(`${Math.round(scale * 100)}%`);
    } else {
      const a0 = Math.atan2(d.start.y - d.c0.y, d.start.x - d.c0.x);
      const a1 = Math.atan2(p.y - d.c0.y, p.x - d.c0.x);
      let rotation = d.t0.rotation + ((a1 - a0) * 180) / Math.PI;
      if (e.shiftKey) rotation = Math.round(rotation / 15) * 15;
      else if (snap) {
        const nearest = Math.round(rotation / 90) * 90;
        if (Math.abs(rotation - nearest) < 4) rotation = nearest;
      }
      rotation = Math.round(normalizeAngle(rotation) * 10) / 10;
      t = { ...d.t0, rotation };
      setLabel(`${rotation}°`);
    }
    d.changed = true;
    setGuides(g);
    useApp.getState().setDraftTransform({ itemId: d.layer.item.id, transform: t });
  };

  const onPointerUp = async (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    setGuides({ v: false, h: false });
    setLabel(null);
    const draftNow = useApp.getState().draftTransform;
    if (d.changed && draftNow?.itemId === d.layer.item.id) {
      // Animated properties get a keyframe at the playhead; others change their fixed value.
      await commitTransform(seq, d.layer.item, draftNow.transform, useApp.getState().playhead);
    }
    // Keep the draft until the edited document has arrived, so the clip does not jump back.
    if (useApp.getState().draftTransform === draftNow) useApp.getState().setDraftTransform(null);
  };

  let frame = null;
  if (target) {
    const t = transformFor(target.item, draft, playhead);
    const l = layoutOf(target, seq, t);
    const corners: Corner[] = ['nw', 'ne', 'se', 'sw'];
    frame = (
      <div
        className={`xf${target.track.locked ? ' xf--locked' : ''}`}
        data-testid="transform-box"
        style={{
          left: l.left * k,
          top: l.top * k,
          width: l.width * k,
          height: l.height * k,
          transform: `rotate(${l.rotation}deg)`,
        }}
      >
        {!target.track.locked &&
          corners.map((c) => (
            <span
              key={c}
              className={`xf__handle xf__handle--${c}`}
              data-testid={`transform-${c}`}
              data-xf-mode="scale"
            />
          ))}
        {!target.track.locked && (
          <span
            className="xf__rotate"
            data-testid="transform-rotate"
            title="Drag to rotate (Shift: 15° steps)"
            data-xf-mode="rotate"
          />
        )}
        {label && <span className="xf__label">{label}</span>}
      </div>
    );
  }

  return (
    <div
      ref={surface}
      className="xf-surface"
      data-testid="transform-surface"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => void onPointerUp(e)}
      onPointerCancel={cancel}
      onContextMenu={(e) => {
        e.preventDefault();
        const hit = topmostAt(toSeq(e));
        if (hit) {
          useApp.getState().selectItems([hit.item.id]);
          useApp.setState({ focus: 'timeline' });
        }
        onContextMenu?.(e, hit?.item.id ?? null);
      }}
    >
      {guides.v && <div className="xf-guide xf-guide--v" />}
      {guides.h && <div className="xf-guide xf-guide--h" />}
      {frame}
    </div>
  );
}
