import { useState } from 'react';
import { RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react';
import type { Sequence, TimelineItem, Track, Transform } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { Button } from '@rec-it/ui';
import { DEFAULT_TRANSFORM, normalizeAngle } from '@rec-it/core';
import { edit, toSeconds } from '../edit';
import { formatDuration } from '../format';
import { useApp } from '../store';
import { transformFor } from './TransformOverlay';

/** A slider that previews locally and commits one undoable edit when released. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  onPreview,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void | Promise<void>;
  /** Called while dragging, so the preview can update live. */
  onPreview?: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = () => {
    if (local !== null && local !== value) void onCommit(local);
    setLocal(null);
  };
  return (
    <label className="slider">
      <span className="slider__label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        aria-label={label}
        onChange={(e) => {
          setLocal(Number(e.target.value));
          onPreview?.(Number(e.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="slider__value">{format(shown)}</span>
    </label>
  );
}

export function ClipInspector({
  seq,
  track,
  item,
  asset,
}: {
  seq: Sequence;
  track: Track;
  item: TimelineItem;
  asset?: MediaAsset;
}) {
  const draft = useApp((s) => s.draftTransform);
  const current = transformFor(item, draft);
  const setTransform = async (t: Partial<Transform>) => {
    const pending = useApp.getState().draftTransform;
    await edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, transform: t });
    if (useApp.getState().draftTransform === pending) useApp.getState().setDraftTransform(null);
  };
  const preview = (t: Partial<Transform>) =>
    useApp
      .getState()
      .setDraftTransform({ itemId: item.id, transform: { ...item.transform, ...t } });
  const transformSlider = (key: 'scale' | 'x' | 'y' | 'rotation') => ({
    value: current[key],
    onPreview: (v: number) => preview({ [key]: v }),
    onCommit: (v: number) => setTransform({ [key]: v }),
  });
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const visual = track.kind === 'video';
  const hasAudio = !!asset?.probe?.audio;

  return (
    <div className="details" data-testid="clip-inspector">
      <h3 className="details__title" title={asset?.name}>
        {asset?.name ?? 'Missing media'}
      </h3>
      <section>
        <h4>Timing</h4>
        <dl>
          <div className="details__row">
            <dt>Starts at</dt>
            <dd>{formatDuration(toSeconds(item.start))}</dd>
          </div>
          <div className="details__row">
            <dt>Length</dt>
            <dd>{toSeconds(item.duration).toFixed(2)} s</dd>
          </div>
          <div className="details__row">
            <dt>From source</dt>
            <dd>
              {toSeconds(item.sourceIn).toFixed(2)} s –{' '}
              {(toSeconds(item.sourceIn) + toSeconds(item.duration)).toFixed(2)} s
            </dd>
          </div>
        </dl>
      </section>
      {visual && (
        <section>
          <h4>Framing</h4>
          <div className="segmented segmented--wide" role="radiogroup" aria-label="Fit">
            {(['fill', 'fit'] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={current.fit === f}
                onClick={() => void setTransform({ fit: f })}
              >
                {f === 'fill' ? 'Fill frame (crop)' : 'Fit whole picture'}
              </button>
            ))}
          </div>
          <Slider
            label="Scale"
            {...transformSlider('scale')}
            min={0.1}
            max={3}
            step={0.01}
            format={pct}
          />
          <Slider
            label="Left / right"
            {...transformSlider('x')}
            min={-1}
            max={1}
            step={0.005}
            format={pct}
          />
          <Slider
            label="Up / down"
            {...transformSlider('y')}
            min={-1}
            max={1}
            step={0.005}
            format={pct}
          />
          <Slider
            label="Rotation"
            {...transformSlider('rotation')}
            min={-180}
            max={180}
            step={1}
            format={(v) => `${Math.round(v)}°`}
          />
          <div className="details__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} />}
              aria-label="Rotate 90° anticlockwise"
              onClick={() => void setTransform({ rotation: normalizeAngle(current.rotation - 90) })}
            >
              90°
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCw size={13} />}
              aria-label="Rotate 90° clockwise"
              onClick={() => void setTransform({ rotation: normalizeAngle(current.rotation + 90) })}
            >
              90°
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void setTransform({ ...DEFAULT_TRANSFORM })}
            >
              Reset
            </Button>
          </div>
          <p className="details__hint">
            Tip: drag the clip in the preview to move it, drag a corner to resize, and drag the
            round handle to rotate. Hold Shift to constrain, Alt to turn snapping off.
          </p>
        </section>
      )}
      {(hasAudio || track.kind === 'audio') && (
        <section>
          <h4>Audio</h4>
          <Slider
            label="Volume"
            value={item.volume}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            onCommit={(v) =>
              void edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, volume: v })
            }
          />
          <div className="details__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={item.muted ? <VolumeX size={13} /> : <Volume2 size={13} />}
              onClick={() =>
                void edit({
                  type: 'item.update',
                  sequenceId: seq.id,
                  itemId: item.id,
                  muted: !item.muted,
                })
              }
            >
              {item.muted ? 'Unmute clip' : 'Mute clip'}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
