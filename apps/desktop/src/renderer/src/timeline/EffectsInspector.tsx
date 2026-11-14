// Fades, opacity and colour effects for one clip (ADR-036).
import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import {
  TRANSITION_KINDS,
  transitionSpans,
  type ColorEffect,
  type Sequence,
  type TimelineItem,
  type Track,
} from '@rec-it/core';
import { Button } from '@rec-it/ui';
import {
  clipBefore,
  edit,
  mediaLength,
  setFade,
  setTransition,
  toSeconds,
  TRANSITION_LABELS,
} from '../edit';
import { useApp } from '../store';
import { Slider } from './Slider';

const pct = (v: number) => `${Math.round(v * 100)}%`;
const secs = (v: number) => (v ? `${v.toFixed(1)} s` : 'Off');

export function FadesSection({
  seq,
  item,
  track,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
}) {
  const length = toSeconds(item.duration);
  const max = Math.max(0.1, Math.min(5, length));
  const fadeIn = toSeconds(item.fade?.in ?? 0);
  const fadeOut = toSeconds(item.fade?.out ?? 0);
  const visual = track.kind === 'video';
  return (
    <section data-testid="fades">
      <h4>{visual ? 'Fades and opacity' : 'Fades'}</h4>
      <Slider
        label="Fade in"
        value={fadeIn}
        min={0}
        max={max}
        step={0.1}
        format={secs}
        disabled={track.locked}
        onCommit={(v) => setFade(seq, item, 'in', v)}
      />
      <Slider
        label="Fade out"
        value={fadeOut}
        min={0}
        max={max}
        step={0.1}
        format={secs}
        disabled={track.locked}
        onCommit={(v) => setFade(seq, item, 'out', v)}
      />
      {visual && (
        <Slider
          label="Opacity"
          value={item.opacity ?? 1}
          min={0}
          max={1}
          step={0.01}
          format={pct}
          disabled={track.locked}
          onCommit={(v) =>
            edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, opacity: v })
          }
        />
      )}
      <p className="details__hint">
        {visual
          ? 'Fades go to and from black; linked sound fades with the picture. You can also drag the small handles at the top corners of a clip.'
          : 'You can also drag the small handles at the top corners of a clip.'}
      </p>
    </section>
  );
}

export function ColourSection({
  seq,
  item,
  track,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
}) {
  const effects = (item.effects ?? []).filter((e): e is ColorEffect => e.kind === 'color');
  const update = (e: ColorEffect, change: { enabled?: boolean; params?: Partial<ColorEffect> }) =>
    edit({
      type: 'effect.update',
      sequenceId: seq.id,
      itemId: item.id,
      effectId: e.id,
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.params
        ? {
            params: {
              ...(change.params.brightness !== undefined
                ? { brightness: change.params.brightness }
                : {}),
              ...(change.params.contrast !== undefined ? { contrast: change.params.contrast } : {}),
              ...(change.params.saturation !== undefined
                ? { saturation: change.params.saturation }
                : {}),
            },
          }
        : {}),
    });
  return (
    <section data-testid="colour">
      <h4>Colour</h4>
      {effects.map((e, i) => (
        <div key={e.id} className="effect" data-testid="colour-effect">
          <div className="effect__head">
            <span className="effect__name">
              Colour{effects.length > 1 ? ` ${i + 1}` : ''}
              {!e.enabled && ' (off)'}
            </span>
            <Button
              size="sm"
              variant="ghost"
              icon={e.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              aria-label={e.enabled ? 'Turn effect off' : 'Turn effect on'}
              title={e.enabled ? 'Turn off (compare with the original)' : 'Turn on'}
              disabled={track.locked}
              onClick={() => void update(e, { enabled: !e.enabled })}
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 size={13} />}
              aria-label="Remove effect"
              disabled={track.locked}
              onClick={() =>
                void edit({
                  type: 'effect.remove',
                  sequenceId: seq.id,
                  itemId: item.id,
                  effectId: e.id,
                })
              }
            />
          </div>
          <Slider
            label="Brightness"
            value={e.brightness}
            min={-0.5}
            max={0.5}
            step={0.01}
            format={(v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`}
            disabled={track.locked}
            onCommit={(v) => update(e, { params: { brightness: v } })}
          />
          <Slider
            label="Contrast"
            value={e.contrast}
            min={0}
            max={2}
            step={0.01}
            format={pct}
            disabled={track.locked}
            onCommit={(v) => update(e, { params: { contrast: v } })}
          />
          <Slider
            label="Saturation"
            value={e.saturation}
            min={0}
            max={3}
            step={0.01}
            format={pct}
            disabled={track.locked}
            onCommit={(v) => update(e, { params: { saturation: v } })}
          />
        </div>
      ))}
      <Button
        size="sm"
        icon={<Plus size={13} />}
        disabled={track.locked || effects.length >= 16}
        data-testid="add-colour"
        onClick={() =>
          void edit({ type: 'effect.add', sequenceId: seq.id, itemId: item.id, kind: 'color' })
        }
      >
        {effects.length ? 'Add another colour effect' : 'Add colour effect'}
      </Button>
    </section>
  );
}

const SHORT = { dissolve: 'Dissolve', dipBlack: 'Black', dipWhite: 'White' } as const;

/** The transition on the cut before this clip (ADR-037). */
export function TransitionSection({
  seq,
  item,
  track,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
}) {
  const assets = useApp((s) => s.assets);
  const before = clipBefore(track, item);
  if (!before || track.kind === 'caption') return null;
  const t = item.transitionIn;
  const max = Math.max(0.1, Math.min(5, toSeconds(before.duration), toSeconds(item.duration)));
  const span = t
    ? transitionSpans(track, mediaLength(new Map(assets.map((a) => [a.id, a])))).find(
        (s) => s.toId === item.id,
      )
    : undefined;
  const shown = span ? toSeconds(span.end - span.start) : 0;
  return (
    <section data-testid="transition">
      <h4>Transition from previous clip</h4>
      <div className="segmented segmented--wide" role="radiogroup" aria-label="Transition">
        {[null, ...TRANSITION_KINDS].map((kind) => (
          <button
            key={kind ?? 'none'}
            type="button"
            role="radio"
            aria-checked={(t?.kind ?? null) === kind}
            title={kind ? TRANSITION_LABELS[kind] : 'No transition'}
            disabled={track.locked}
            onClick={() => void setTransition(seq, item.id, kind)}
          >
            {kind ? SHORT[kind] : 'None'}
          </button>
        ))}
      </div>
      {t && (
        <Slider
          label="Transition length"
          value={toSeconds(t.duration)}
          min={0.1}
          max={max}
          step={0.1}
          format={(v) => `${v.toFixed(1)} s`}
          disabled={track.locked}
          onCommit={(v) => setTransition(seq, item.id, t.kind, v)}
        />
      )}
      {t && t.kind === 'dissolve' && shown + 1e-3 < Math.min(toSeconds(t.duration), max) && (
        <p className="details__hint" data-testid="transition-short">
          {shown > 0
            ? `Only ${shown.toFixed(2)} s is shown: a dissolve uses footage from after the first clip and before this one, and there is not more of it. Trim the clips to leave more.`
            : 'Not shown: a dissolve needs footage from after the first clip or before this one. Trim one of the clips to leave some.'}
        </p>
      )}
    </section>
  );
}
