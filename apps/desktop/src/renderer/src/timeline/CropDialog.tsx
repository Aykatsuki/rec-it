import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { cropRect, sourceTimeAt, type Crop } from '@rec-it/core';
import { Button, Dialog } from '@rec-it/ui';
import { edit, findItem, toFlicks, toSeconds } from '../edit';
import { activeSequence, useApp } from '../store';

type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
/** Kept area in source fractions: x, y, width, height. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN = 0.05;
const toRect = (c: Crop | undefined): Rect =>
  c
    ? { x: c.left, y: c.top, w: 1 - c.left - c.right, h: 1 - c.top - c.bottom }
    : { x: 0, y: 0, w: 1, h: 1 };
const toCrop = (r: Rect): Crop => ({
  left: r.x,
  top: r.y,
  right: Math.max(0, 1 - r.x - r.w),
  bottom: Math.max(0, 1 - r.y - r.h),
});

/**
 * The crop window (ADR-034): the clip's whole picture at the playhead with the kept part marked.
 * Drag inside the box to move it, its corners (and edges, when the shape is free) to resize it.
 * "Keep shape" holds the box's proportions so the clip keeps its size on screen.
 */
export function CropDialog() {
  const itemId = useApp((s) => s.cropItemId);
  const seq = useApp((s) => activeSequence(s));
  const assets = useApp((s) => s.assets);
  const found = itemId ? findItem(seq, itemId) : null;
  const asset = found ? assets.find((a) => a.id === found.item.assetId) : undefined;
  const close = () => useApp.setState({ cropItemId: null });
  const v = asset?.probe?.video;
  return (
    <Dialog open={!!(found && v)} onClose={close} title="Crop">
      {found && asset && v && (
        <CropEditor
          key={found.item.id}
          seqId={seq!.id}
          itemId={found.item.id}
          crop={found.item.transform.crop}
          srcW={v.displayWidth}
          srcH={v.displayHeight}
          videoUrl={asset.kind === 'video' ? asset.urls.proxy : undefined}
          imageUrl={asset.kind === 'image' ? (asset.urls.still ?? asset.urls.poster) : undefined}
          time={toSeconds(
            sourceTimeAt(
              found.item,
              Math.min(
                Math.max(toFlicks(useApp.getState().playhead), found.item.start),
                found.item.start + found.item.duration - 1,
              ),
            ),
          )}
          onClose={close}
        />
      )}
    </Dialog>
  );
}

function CropEditor({
  seqId,
  itemId,
  crop,
  srcW,
  srcH,
  videoUrl,
  imageUrl,
  time,
  onClose,
}: {
  seqId: string;
  itemId: string;
  crop: Crop | undefined;
  srcW: number;
  srcH: number;
  videoUrl: string | undefined;
  imageUrl: string | undefined;
  time: number;
  onClose: () => void;
}) {
  const [rect, setRect] = useState<Rect>(() => toRect(crop));
  const [keepShape, setKeepShape] = useState(true);
  const area = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ handle: Handle; start: { x: number; y: number }; r0: Rect } | null>(null);
  // Shape of the kept part in source pixels (what "Keep shape" holds).
  const aspect = (rect.w * srcW) / (rect.h * srcH);
  const [lockedAspect, setLockedAspect] = useState(aspect);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const seek = () => {
      el.currentTime = time + 0.001;
    };
    if (el.readyState >= 1) seek();
    else el.addEventListener('loadedmetadata', seek, { once: true });
  }, [time]);

  // Fit the picture into the window.
  const maxW = 720;
  const maxH = 440;
  const k = Math.min(maxW / srcW, maxH / srcH);
  const boxW = Math.round(srcW * k);
  const boxH = Math.round(srcH * k);

  const point = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };

  const onDown = (e: ReactPointerEvent, handle: Handle) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    area.current?.setPointerCapture(e.pointerId);
    drag.current = { handle, start: point(e), r0: rect };
  };

  const onMove = (e: ReactPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    const r0 = d.r0;
    if (d.handle === 'move') {
      setRect({
        ...r0,
        x: Math.min(Math.max(0, r0.x + dx), 1 - r0.w),
        y: Math.min(Math.max(0, r0.y + dy), 1 - r0.h),
      });
      return;
    }
    // Edges that move with this handle; the opposite ones stay put.
    const hd = d.handle;
    let left = r0.x;
    let top = r0.y;
    let right = r0.x + r0.w;
    let bottom = r0.y + r0.h;
    if (hd.includes('w')) left = Math.min(Math.max(0, r0.x + dx), right - MIN);
    if (hd.includes('e')) right = Math.max(Math.min(1, right + dx), left + MIN);
    if (hd.includes('n')) top = Math.min(Math.max(0, r0.y + dy), bottom - MIN);
    if (hd.includes('s')) bottom = Math.max(Math.min(1, bottom + dy), top + MIN);
    if (keepShape) {
      // Width leads; height follows the locked proportions (in source pixels).
      const a = lockedAspect * (srcH / srcW);
      let w = right - left;
      let h = w / a;
      const maxH = hd.includes('n') ? r0.y + r0.h : 1 - r0.y;
      if (h > maxH) {
        h = maxH;
        w = h * a;
      }
      if (hd.includes('w')) left = right - w;
      else right = left + w;
      if (hd.includes('n')) top = bottom - h;
      else bottom = top + h;
    }
    setRect({ x: left, y: top, w: right - left, h: bottom - top });
  };

  const onUp = () => {
    drag.current = null;
  };

  const kept = cropRect(srcW, srcH, toCrop(rect));
  const apply = async () => {
    const ok = await edit({
      type: 'item.update',
      sequenceId: seqId,
      itemId,
      transform: { crop: toCrop(rect) },
    });
    if (ok) onClose();
  };
  const handles: Handle[] = keepShape
    ? ['nw', 'ne', 'se', 'sw']
    : ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  return (
    <div className="crop" data-testid="crop-dialog">
      <div
        ref={area}
        className="crop__area"
        style={{ width: boxW, height: boxH }}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        {videoUrl ? (
          <video ref={video} className="crop__picture" src={videoUrl} muted preload="auto" />
        ) : (
          imageUrl && <img className="crop__picture" src={imageUrl} alt="" />
        )}
        <div
          className="crop__box"
          data-testid="crop-box"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.w * 100}%`,
            height: `${rect.h * 100}%`,
          }}
          onPointerDown={(e) => onDown(e, 'move')}
        >
          {handles.map((h) => (
            <span
              key={h}
              className={`crop__handle crop__handle--${h}`}
              data-testid={`crop-${h}`}
              onPointerDown={(e) => onDown(e, h)}
            />
          ))}
        </div>
      </div>
      <div className="crop__footer">
        <label className="crop__lock">
          <input
            type="checkbox"
            checked={keepShape}
            onChange={(e) => {
              setKeepShape(e.target.checked);
              setLockedAspect(aspect);
            }}
          />
          Keep shape
        </label>
        <span className="crop__size" data-testid="crop-size">
          {kept.w} × {kept.h} px
        </span>
        <span className="crop__spacer" />
        <Button
          size="sm"
          onClick={() => {
            setRect({ x: 0, y: 0, w: 1, h: 1 });
            setKeepShape(false);
          }}
        >
          Whole picture
        </Button>
        <Button size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={() => void apply()}>
          Apply
        </Button>
      </div>
    </div>
  );
}
