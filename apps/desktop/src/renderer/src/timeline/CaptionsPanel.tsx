import { useEffect, useState } from 'react';
import { Captions } from 'lucide-react';
import { CAPTION_STYLE_DEFS } from '@rec-it/captions';
import {
  CAPTION_STYLES,
  DEFAULT_CAPTIONS,
  type CaptionSettings,
  type Sequence,
} from '@rec-it/core';
import { EmptyState } from '@rec-it/ui';
import { ensureCaptionFonts } from '../engine/caption-geometry';
import { CaptionsGenerate } from './CaptionsGenerate';
import { edit } from '../edit';
import { useSequence } from '../store';

const update = (seq: Sequence, captions: Partial<CaptionSettings>) =>
  edit({ type: 'captions.update', sequenceId: seq.id, captions });

export function CaptionsPanel() {
  const seq = useSequence();
  useEffect(ensureCaptionFonts, []);
  if (!seq)
    return (
      <EmptyState icon={<Captions size={20} />} title="Captions">
        Put a clip on the timeline first.
      </EmptyState>
    );
  return <CaptionsSettings seq={seq} />;
}

function CaptionsSettings({ seq }: { seq: Sequence }) {
  const settings = seq.captions ?? DEFAULT_CAPTIONS;
  const style = CAPTION_STYLE_DEFS[settings.style];
  const usesHighlight = style.animation !== 'none';

  return (
    <div className="captions" data-testid="captions-panel">
      <CaptionsGenerate seq={seq} />
      <p className="transcript__hint">
        The look below applies to every caption. Move, resize or turn a caption by dragging it in
        the preview; edit its words in the Inspector; trim, split or delete it on the timeline.
      </p>

      <fieldset className="captions__styles">
        <legend>Style</legend>
        {CAPTION_STYLES.map((id) => {
          const def = CAPTION_STYLE_DEFS[id];
          return (
            <button
              key={id}
              type="button"
              className="captions__style"
              aria-pressed={settings.style === id}
              onClick={() => void update(seq, { style: id })}
              style={{
                fontFamily: `'Caption ${def.font}', var(--font-ui)`,
                fontWeight: def.bold ? 700 : 400,
                textTransform: def.uppercase ? 'uppercase' : undefined,
                letterSpacing: def.spacing ? `${def.spacing / 2}px` : undefined,
              }}
            >
              <span
                className={def.box ? 'captions__sample captions__sample--box' : 'captions__sample'}
              >
                {def.animation === 'none' ? (
                  'Aa words'
                ) : (
                  <>
                    Aa <span style={{ color: settings.highlight }}>words</span>
                  </>
                )}
              </span>
              <span className="captions__style-name">{def.name}</span>
            </button>
          );
        })}
      </fieldset>

      <fieldset className="captions__fields">
        <CommitSlider
          label="Size"
          value={settings.size}
          min={0.5}
          max={2}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(size) => update(seq, { size })}
        />
        <CommitSlider
          label="Position"
          value={settings.position}
          min={0.1}
          max={0.9}
          step={0.01}
          format={(v) => `${Math.round(v * 100)}% down`}
          onCommit={(position) => update(seq, { position })}
        />
        {style.animation !== 'pop' && (
          <CommitSlider
            label="Words per line"
            value={settings.wordsPerLine}
            min={1}
            max={8}
            step={1}
            format={(v) => String(v)}
            onCommit={(wordsPerLine) => update(seq, { wordsPerLine })}
          />
        )}
        {style.animation !== 'pop' && (
          <div className="captions__row">
            <span>Lines</span>
            <div className="captions__segmented" role="group" aria-label="Lines">
              {([1, 2] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-pressed={settings.lines === n}
                  onClick={() => void update(seq, { lines: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="captions__row">
          <span>Capitals</span>
          <input
            type="checkbox"
            checked={settings.uppercase || !!style.uppercase}
            disabled={!!style.uppercase}
            onChange={(e) => void update(seq, { uppercase: e.target.checked })}
          />
        </label>
        {usesHighlight && (
          <label className="captions__row">
            <span>Spoken word colour</span>
            <input
              type="color"
              aria-label="Spoken word colour"
              value={settings.highlight.toLowerCase()}
              onChange={(e) => void update(seq, { highlight: e.target.value.toUpperCase() })}
            />
          </label>
        )}
      </fieldset>
    </div>
  );
}

/** A slider that shows its value while dragging and saves one undoable edit on release. */
export function CommitSlider({
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
  onCommit: (v: number) => unknown;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft !== null && draft !== value) void onCommit(draft);
    setDraft(null);
  };
  return (
    <label className="captions__row">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setDraft(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="captions__value">{format(shown)}</span>
    </label>
  );
}
