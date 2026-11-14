import {
  ChevronLeft,
  ChevronRight,
  Diamond,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
  Crop as CropIcon,
  LayoutPanelTop,
  Layers,
} from 'lucide-react';
import type { Sequence, TimelineItem, Track, Transform } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { Button } from '@rec-it/ui';
import {
  DEFAULT_TRANSFORM,
  KEYFRAME_PROPERTIES,
  hasKeyframes,
  normalizeAngle,
  volumeAt,
  type Easing,
  type KeyframeProperty,
} from '@rec-it/core';
import {
  blurredBackground,
  commitTransform,
  commitVolume,
  edit,
  facecamLayout,
  jumpToKeyframe,
  keyframeAt,
  keyframeTimes,
  toFlicks,
  toggleKeyframe as toggleKeyframeAt,
  toSeconds,
} from '../edit';
import { formatDuration } from '../format';
import { useApp } from '../store';
import { transformFor } from './TransformOverlay';
import { AutoReframe } from './AutoReframe';
import { ColourSection, FadesSection, TransitionSection } from './EffectsInspector';
import { Slider } from './Slider';

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
  const playhead = useApp((s) => s.playhead);
  const current = transformFor(item, draft, playhead);
  const setTransform = async (t: Partial<Transform>) => {
    const pending = useApp.getState().draftTransform;
    await commitTransform(seq, item, t, useApp.getState().playhead);
    if (useApp.getState().draftTransform === pending) useApp.getState().setDraftTransform(null);
  };
  const preview = (t: Partial<Transform>) =>
    useApp.getState().setDraftTransform({ itemId: item.id, transform: { ...current, ...t } });
  const keys = (property: KeyframeProperty) => (
    <KeyframeButtons seq={seq} item={item} property={property} playhead={playhead} />
  );
  const transformSlider = (key: 'scale' | 'x' | 'y' | 'rotation') => ({
    value: current[key],
    onPreview: (v: number) => preview({ [key]: v }),
    onCommit: (v: number) => setTransform({ [key]: v }),
    extra: keys(key),
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
          <div className="inspector__crop">
            <Button
              size="sm"
              icon={<CropIcon size={14} />}
              disabled={track.locked}
              onClick={() => useApp.setState({ cropItemId: item.id })}
              data-testid="open-crop"
            >
              {item.transform.crop ? 'Edit crop…' : 'Crop…'}
            </Button>
            {item.transform.crop && (
              <Button
                size="sm"
                disabled={track.locked}
                onClick={() =>
                  void setTransform({ crop: { left: 0, top: 0, right: 0, bottom: 0 } })
                }
              >
                Remove crop
              </Button>
            )}
            <Button
              size="sm"
              icon={<Layers size={14} />}
              disabled={track.locked}
              onClick={() => void blurredBackground(item.id)}
              title="Show the whole picture, with a blurred copy filling the frame behind it"
              data-testid="blurred-background"
            >
              Blurred background
            </Button>
            {asset?.kind === 'video' && (
              <Button
                size="sm"
                icon={<LayoutPanelTop size={14} />}
                disabled={track.locked}
                onClick={() => void facecamLayout(item.id)}
                title="Facecam on top, gameplay below, from this one clip"
              >
                Facecam + gameplay
              </Button>
            )}
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
              title="Back to fill, 100%, centred, not rotated (removes position, size and rotation animation)"
              onClick={() =>
                void edit({
                  type: 'item.update',
                  sequenceId: seq.id,
                  itemId: item.id,
                  transform: { ...DEFAULT_TRANSFORM },
                })
              }
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
      {visual && asset?.kind === 'video' && (
        <AutoReframe seq={seq} track={track} item={item} asset={asset} />
      )}
      {visual && asset && <ColourSection seq={seq} item={item} track={track} />}
      {(visual || hasAudio || track.kind === 'audio') && (
        <FadesSection seq={seq} item={item} track={track} />
      )}
      <TransitionSection seq={seq} item={item} track={track} />
      {hasKeyframes(item) && <KeyframeSection seq={seq} item={item} playhead={playhead} />}
      {(hasAudio || track.kind === 'audio') && (
        <section>
          <h4>Audio</h4>
          <Slider
            label="Volume"
            value={volumeAt(item, toFlicks(playhead))}
            extra={keys('volume')}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            onCommit={(v) => commitVolume(seq, item, v, useApp.getState().playhead)}
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

const LABELS: Record<KeyframeProperty, string> = {
  x: 'left / right',
  y: 'up / down',
  scale: 'scale',
  rotation: 'rotation',
  volume: 'volume',
};

/** ◆ next to a slider: add or remove the keyframe at the playhead (filled when there is one). */
function KeyframeButtons({
  seq,
  item,
  property,
  playhead,
}: {
  seq: Sequence;
  item: TimelineItem;
  property: KeyframeProperty;
  playhead: number;
}) {
  const animated = hasKeyframes(item, property);
  const here = !!keyframeAt(seq, item, property, playhead);
  const inside =
    playhead >= toSeconds(item.start) && playhead < toSeconds(item.start + item.duration);
  return (
    <span className="kf" data-animated={animated}>
      <button
        type="button"
        className="kf__toggle"
        aria-pressed={here}
        disabled={!inside}
        data-testid={`keyframe-${property}`}
        aria-label={
          here ? `Remove ${LABELS[property]} keyframe` : `Add ${LABELS[property]} keyframe`
        }
        title={
          !inside
            ? 'Move the playhead over this clip to add keyframes'
            : here
              ? 'Remove the keyframe at the playhead'
              : animated
                ? 'Add a keyframe at the playhead'
                : 'Animate: add a keyframe at the playhead, then move the playhead and change the value'
        }
        onClick={() => void toggleKeyframeAt(seq, item, property, playhead)}
      >
        <Diamond size={11} />
      </button>
    </span>
  );
}

/** Keyframe summary: easing of the keyframes at the playhead and quick navigation. */
function KeyframeSection({
  seq,
  item,
  playhead,
}: {
  seq: Sequence;
  item: TimelineItem;
  playhead: number;
}) {
  const here = KEYFRAME_PROPERTIES.map((p) => ({
    p,
    k: keyframeAt(seq, item, p, playhead),
  })).filter((x) => x.k);
  const easing = here[0]?.k?.e;
  const setEasing = (e: Easing) =>
    void edit({
      type: 'batch',
      commands: here.map(({ p, k }) => ({
        type: 'keyframe.set' as const,
        sequenceId: seq.id,
        itemId: item.id,
        property: p,
        t: k!.t,
        value: k!.v,
        easing: e,
      })),
    });
  return (
    <section data-testid="keyframes">
      <h4>Keyframes</h4>
      <div className="details__actions">
        <Button size="sm" variant="ghost" onClick={() => jumpToKeyframe(item, -1)}>
          <ChevronLeft size={13} /> Previous
        </Button>
        <span className="form__hint">{keyframeTimes(item).length} on this clip</span>
        <Button size="sm" variant="ghost" onClick={() => jumpToKeyframe(item, 1)}>
          Next <ChevronRight size={13} />
        </Button>
      </div>
      {here.length > 0 && (
        <label className="form__row">
          <span>From here</span>
          <select
            className="ui-input"
            aria-label="Keyframe easing"
            value={easing}
            onChange={(e) => setEasing(e.target.value as Easing)}
          >
            <option value="linear">Linear — steady change</option>
            <option value="ease">Ease — slow in and out</option>
            <option value="hold">Hold — jump at the next keyframe</option>
          </select>
        </label>
      )}
    </section>
  );
}
