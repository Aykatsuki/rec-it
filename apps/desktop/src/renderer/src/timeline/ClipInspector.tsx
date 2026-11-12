import { useState } from 'react';
import { RotateCcw, Volume2, VolumeX } from 'lucide-react';
import type { Sequence, TimelineItem, Track, Transform } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { Button } from '@rec-it/ui';
import { edit, toSeconds } from '../edit';
import { formatDuration } from '../format';

/** A slider that previews locally and commits one undoable edit when released. */
function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  const shown = local ?? value;
  const commit = () => {
    if (local !== null && local !== value) onCommit(local);
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
        onChange={(e) => setLocal(Number(e.target.value))}
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
  const setTransform = (t: Partial<Transform>) =>
    void edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, transform: t });
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
                aria-checked={item.transform.fit === f}
                onClick={() => setTransform({ fit: f })}
              >
                {f === 'fill' ? 'Fill frame (crop)' : 'Fit whole picture'}
              </button>
            ))}
          </div>
          <Slider
            label="Scale"
            value={item.transform.scale}
            min={0.1}
            max={3}
            step={0.01}
            format={pct}
            onCommit={(v) => setTransform({ scale: v })}
          />
          <Slider
            label="Left / right"
            value={item.transform.x}
            min={-1}
            max={1}
            step={0.005}
            format={pct}
            onCommit={(v) => setTransform({ x: v })}
          />
          <Slider
            label="Up / down"
            value={item.transform.y}
            min={-1}
            max={1}
            step={0.005}
            format={pct}
            onCommit={(v) => setTransform({ y: v })}
          />
          <div className="details__actions">
            <Button
              size="sm"
              variant="ghost"
              icon={<RotateCcw size={13} />}
              onClick={() => setTransform({ fit: 'fill', scale: 1, x: 0, y: 0 })}
            >
              Reset framing
            </Button>
          </div>
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
