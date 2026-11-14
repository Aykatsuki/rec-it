// Fades, opacity and colour effects for one clip (ADR-036).
import { AudioLines, Eye, EyeOff, Mic, Pause, Pipette, Plus, Repeat, Trash2 } from 'lucide-react';
import {
  TRANSITION_KINDS,
  transitionSpans,
  type Effect,
  type AudioEffect,
  type Sequence,
  type TimelineItem,
  type Track,
} from '@rec-it/core';
import type { CommandInput } from '@rec-it/ipc-contract';
import { Button } from '@rec-it/ui';
import {
  addLut,
  duckUnderVoices,
  voicePreset,
  importLut,
  clipBefore,
  edit,
  freezeFrame,
  setSpeed,
  SPEED_PRESETS,
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
  const all = item.effects ?? [];
  const effects = all.filter(
    (e): e is Exclude<Effect, AudioEffect> => e.kind !== 'eq' && e.kind !== 'compressor',
  );
  const luts = useApp((s) => s.luts);
  const update = effectUpdater(seq, item);
  const count = (kind: Effect['kind']) => effects.filter((e) => e.kind === kind).length;
  const add = (kind: Effect['kind']) =>
    void edit({ type: 'effect.add', sequenceId: seq.id, itemId: item.id, kind });
  return (
    <section data-testid="colour">
      <h4>Effects</h4>
      {effects.map((e) => {
        const same = effects.filter((x) => x.kind === e.kind);
        const name =
          ({ color: 'Colour', blur: 'Blur', lut: 'LUT', chromaKey: 'Green screen' } as const)[
            e.kind
          ] + (same.length > 1 ? ` ${same.indexOf(e) + 1}` : '');
        return (
          <div
            key={e.id}
            className="effect"
            data-testid={`${e.kind === 'color' ? 'colour' : e.kind === 'chromaKey' ? 'key' : e.kind}-effect`}
          >
            <div className="effect__head">
              <span className="effect__name">
                {name}
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
            {e.kind === 'chromaKey' ? (
              <>
                <div className="slider">
                  <span className="slider__label">Key colour</span>
                  <input
                    type="color"
                    aria-label="Key colour"
                    value={e.color.toLowerCase()}
                    disabled={track.locked}
                    onChange={(ev) => void update(e, { color: ev.target.value.toUpperCase() })}
                  />
                  {KEY_PRESETS.map(([label, color]) => (
                    <Button
                      key={color}
                      size="sm"
                      variant="ghost"
                      disabled={track.locked}
                      onClick={() => void update(e, { color })}
                    >
                      {label}
                    </Button>
                  ))}
                  {'EyeDropper' in window && (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Pipette size={13} />}
                      aria-label="Pick the key colour from the screen"
                      title="Pick the key colour from the preview"
                      disabled={track.locked}
                      onClick={async () => {
                        try {
                          const Picker = (
                            window as unknown as {
                              EyeDropper: new () => { open(): Promise<{ sRGBHex: string }> };
                            }
                          ).EyeDropper;
                          const { sRGBHex } = await new Picker().open();
                          if (/^#[0-9a-f]{6}$/i.test(sRGBHex))
                            void update(e, { color: sRGBHex.toUpperCase() });
                        } catch {
                          // Picking was cancelled.
                        }
                      }}
                    />
                  )}
                </div>
                <Slider
                  label="Similarity"
                  value={e.similarity}
                  min={0.01}
                  max={0.5}
                  step={0.005}
                  format={pct}
                  disabled={track.locked}
                  onCommit={(v) => update(e, { params: { similarity: v } })}
                />
                <Slider
                  label="Edge softness"
                  value={e.blend}
                  min={0}
                  max={0.3}
                  step={0.005}
                  format={pct}
                  disabled={track.locked}
                  onCommit={(v) => update(e, { params: { blend: v } })}
                />
              </>
            ) : e.kind === 'lut' ? (
              <>
                <label className="slider">
                  <span className="slider__label">Look</span>
                  <select
                    className="effect__select"
                    aria-label="LUT"
                    value={e.lutId}
                    disabled={track.locked}
                    onChange={async (ev) => {
                      let lutId = ev.target.value;
                      if (lutId === IMPORT) {
                        const lut = await importLut();
                        if (!lut) return;
                        lutId = lut.id;
                      }
                      void update(e, { lutId });
                    }}
                  >
                    {!luts.some((l) => l.id === e.lutId) && (
                      <option value={e.lutId}>Missing LUT</option>
                    )}
                    {luts.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                    <option value={IMPORT}>Import a .cube file…</option>
                  </select>
                </label>
                <Slider
                  label="Strength"
                  value={e.strength}
                  min={0}
                  max={1}
                  step={0.01}
                  format={pct}
                  disabled={track.locked}
                  onCommit={(v) => update(e, { params: { strength: v } })}
                />
              </>
            ) : e.kind === 'blur' ? (
              <Slider
                label="Blur amount"
                value={e.size}
                min={0}
                max={0.1}
                step={0.001}
                format={(v) => `${(v * 1000).toFixed(0)}`}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { size: v } })}
              />
            ) : (
              <>
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
              </>
            )}
          </div>
        );
      })}
      <div className="details__actions">
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16}
          data-testid="add-colour"
          onClick={() => add('color')}
        >
          {count('color') ? 'Another colour' : 'Colour'}
        </Button>
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16}
          data-testid="add-blur"
          onClick={() => add('blur')}
        >
          {count('blur') ? 'Another blur' : 'Blur'}
        </Button>
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16 || count('chromaKey') > 0}
          data-testid="add-key"
          title="Make a green or blue background transparent"
          onClick={() => add('chromaKey')}
        >
          Green screen
        </Button>
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16 || count('lut') > 0}
          data-testid="add-lut"
          title="A colour look from a .cube file"
          onClick={() => void addLut(seq, item.id)}
        >
          LUT
        </Button>
      </div>
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

const IMPORT = '__import__';
const KEY_PRESETS = [
  ['Green', '#00B140'],
  ['Blue', '#0047BB'],
] as const;

const speedLabel = (v: number) => `${v}×`;

/** Speed, reverse and freeze frames (ADR-039). */
export function SpeedSection({
  seq,
  item,
  track,
  isVideo,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
  /** The clip shows moving video (freeze frames can be made from it). */
  isVideo: boolean;
}) {
  if (item.caption) return null;
  if (item.freeze)
    return (
      <section data-testid="speed">
        <h4>Freeze frame</h4>
        <p className="details__hint">
          This clip holds one frame. Trim it to change how long it holds; it has no sound.
        </p>
      </section>
    );
  const speed = item.speed ?? 1;
  return (
    <section data-testid="speed">
      <h4>Speed</h4>
      <div className="speed__presets" role="radiogroup" aria-label="Speed">
        {SPEED_PRESETS.map((v) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={speed === v}
            disabled={track.locked}
            onClick={() => void setSpeed(seq, item.id, { speed: v })}
          >
            {speedLabel(v)}
          </button>
        ))}
      </div>
      <Slider
        label="Speed"
        value={speed}
        min={0.25}
        max={4}
        step={0.05}
        format={(v) => `${Math.round(v * 100) / 100}×`}
        disabled={track.locked}
        onCommit={(v) => setSpeed(seq, item.id, { speed: Math.round(v * 100) / 100 })}
      />
      <div className="details__actions">
        <Button
          size="sm"
          variant={item.reverse ? 'primary' : 'secondary'}
          icon={<Repeat size={13} />}
          aria-pressed={!!item.reverse}
          disabled={track.locked}
          data-testid="reverse"
          onClick={() => void setSpeed(seq, item.id, { reverse: !item.reverse })}
        >
          {item.reverse ? 'Reversed' : 'Reverse'}
        </Button>
        {isVideo && (
          <Button
            size="sm"
            icon={<Pause size={13} />}
            disabled={track.locked}
            data-testid="freeze-frame"
            title="Holds the frame under the playhead for 2 seconds; later clips move along"
            onClick={() => void freezeFrame(item.id)}
          >
            Freeze frame
          </Button>
        )}
      </div>
      <p className="details__hint">
        Changing the speed changes the clip's length; clips after it on its track move along. Sound
        keeps its pitch.
      </p>
    </section>
  );
}

type EffectChange = {
  enabled?: boolean;
  params?: Partial<Record<EffectParam, number>>;
  lutId?: string;
  color?: string;
  lowCut?: boolean;
};
type EffectParam =
  NonNullable<Extract<CommandInput, { type: 'effect.update' }>['params']> extends infer P
    ? keyof P
    : never;

/** Sends one effect change as an undoable edit. */
function effectUpdater(seq: Sequence, item: TimelineItem) {
  return (e: Effect, change: EffectChange) =>
    edit({
      type: 'effect.update',
      sequenceId: seq.id,
      itemId: item.id,
      effectId: e.id,
      ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
      ...(change.params ? { params: change.params } : {}),
      ...(change.lutId ? { lutId: change.lutId } : {}),
      ...(change.color ? { color: change.color } : {}),
      ...(change.lowCut !== undefined ? { lowCut: change.lowCut } : {}),
    });
}

/** A card's title row: name, on/off and remove. */
function EffectHead({
  seq,
  item,
  track,
  effect,
  name,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
  effect: Effect;
  name: string;
}) {
  const update = effectUpdater(seq, item);
  return (
    <div className="effect__head">
      <span className="effect__name">
        {name}
        {!effect.enabled && ' (off)'}
      </span>
      <Button
        size="sm"
        variant="ghost"
        icon={effect.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
        aria-label={effect.enabled ? 'Turn effect off' : 'Turn effect on'}
        title={effect.enabled ? 'Turn off (compare with the original)' : 'Turn on'}
        disabled={track.locked}
        onClick={() => void update(effect, { enabled: !effect.enabled })}
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
            effectId: effect.id,
          })
        }
      />
    </div>
  );
}

const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;

/** Sound effects (ADR-042): EQ, compressor and ducking. */
export function SoundSection({
  seq,
  item,
  track,
}: {
  seq: Sequence;
  item: TimelineItem;
  track: Track;
}) {
  const all = item.effects ?? [];
  const effects = all.filter((e): e is AudioEffect => e.kind === 'eq' || e.kind === 'compressor');
  const update = effectUpdater(seq, item);
  const add = (kind: AudioEffect['kind']) =>
    void edit({ type: 'effect.add', sequenceId: seq.id, itemId: item.id, kind });
  return (
    <section data-testid="sound-effects">
      <h4>Sound</h4>
      {effects.map((e) => (
        <div key={e.id} className="effect" data-testid={`${e.kind}-effect`}>
          <EffectHead
            seq={seq}
            item={item}
            track={track}
            effect={e}
            name={e.kind === 'eq' ? 'Equaliser' : 'Compressor'}
          />
          {e.kind === 'eq' ? (
            <>
              <label className="effect__check">
                <input
                  type="checkbox"
                  checked={e.lowCut}
                  disabled={track.locked}
                  onChange={(ev) => void update(e, { lowCut: ev.target.checked })}
                />
                Low cut (removes rumble below 80 Hz)
              </label>
              <Slider
                label="Bass"
                value={e.low}
                min={-12}
                max={12}
                step={0.5}
                format={db}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { low: v } })}
              />
              <Slider
                label="Mid"
                value={e.mid}
                min={-12}
                max={12}
                step={0.5}
                format={db}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { mid: v } })}
              />
              <Slider
                label="Mid frequency"
                value={e.midFreq}
                min={200}
                max={10000}
                step={50}
                format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${v} Hz`)}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { midFreq: v } })}
              />
              <Slider
                label="Treble"
                value={e.high}
                min={-12}
                max={12}
                step={0.5}
                format={db}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { high: v } })}
              />
            </>
          ) : (
            <>
              <Slider
                label="Threshold"
                value={e.threshold}
                min={-60}
                max={0}
                step={1}
                format={(v) => `${v} dB`}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { threshold: v } })}
              />
              <Slider
                label="Ratio"
                value={e.ratio}
                min={1}
                max={20}
                step={0.5}
                format={(v) => `${v}:1`}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { ratio: v } })}
              />
              <Slider
                label="Attack"
                value={e.attack}
                min={1}
                max={200}
                step={1}
                format={(v) => `${v} ms`}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { attack: v } })}
              />
              <Slider
                label="Release"
                value={e.release}
                min={20}
                max={1000}
                step={10}
                format={(v) => `${v} ms`}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { release: v } })}
              />
              <Slider
                label="Make-up gain"
                value={e.makeup}
                min={0}
                max={24}
                step={0.5}
                format={db}
                disabled={track.locked}
                onCommit={(v) => update(e, { params: { makeup: v } })}
              />
            </>
          )}
        </div>
      ))}
      <div className="details__actions">
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16}
          data-testid="add-eq"
          onClick={() => add('eq')}
        >
          EQ
        </Button>
        <Button
          size="sm"
          icon={<Plus size={13} />}
          disabled={track.locked || all.length >= 16}
          data-testid="add-compressor"
          onClick={() => add('compressor')}
        >
          Compressor
        </Button>
        <Button
          size="sm"
          icon={<Mic size={13} />}
          disabled={track.locked}
          data-testid="voice-preset"
          title="Low cut, a little presence and gentle compression"
          onClick={() => void voicePreset(seq, item)}
        >
          Voice preset
        </Button>
        <Button
          size="sm"
          icon={<AudioLines size={13} />}
          disabled={track.locked}
          data-testid="duck"
          title="Turns this clip down while the other clips have speech (as volume keyframes)"
          onClick={() => void duckUnderVoices(item.id)}
        >
          Duck under voices
        </Button>
      </div>
    </section>
  );
}
