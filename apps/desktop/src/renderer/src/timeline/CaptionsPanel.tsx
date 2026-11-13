import { useEffect, useState } from 'react';
import { Captions } from 'lucide-react';
import { CAPTION_STYLE_DEFS, FONT_FILES } from '@rec-it/captions';
import {
  CAPTION_STYLES,
  DEFAULT_CAPTIONS,
  type CaptionSettings,
  type Sequence,
} from '@rec-it/core';
import { EmptyState } from '@rec-it/ui';
import { useCaptionsAss } from '../engine/captions-layer';
import { edit } from '../edit';
import { useApp, useSequence } from '../store';

// Load the caption fonts into the page so each style button shows its own lettering.
const fontUrls = import.meta.glob('../../../../../../resources/fonts/*.ttf', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
let fontsLoaded = false;
function loadFonts(): void {
  if (fontsLoaded || typeof FontFace === 'undefined') return;
  fontsLoaded = true;
  for (const [family, file] of Object.entries(FONT_FILES)) {
    const url = Object.entries(fontUrls).find(([p]) => p.endsWith(`/${file}`))?.[1];
    if (!url) continue;
    const face = new FontFace(`Caption ${family}`, `url(${url})`);
    document.fonts.add(face);
    void face.load().catch(() => {});
  }
}

const update = (seq: Sequence, captions: Partial<CaptionSettings>) =>
  edit({ type: 'captions.update', sequenceId: seq.id, captions });

export function CaptionsPanel() {
  const seq = useSequence();
  useEffect(loadFonts, []);
  if (!seq)
    return (
      <EmptyState icon={<Captions size={20} />} title="Captions">
        Put a clip on the timeline first.
      </EmptyState>
    );
  return <CaptionsSettings seq={seq} />;
}

function CaptionsSettings({ seq }: { seq: Sequence }) {
  const settings = seq.captions ?? { ...DEFAULT_CAPTIONS, enabled: false };
  const ass = useCaptionsAss({ ...seq, captions: { ...settings, enabled: true } });
  const transcribed = useApp((s) => s.transcription?.transcribed.length ?? 0);
  const style = CAPTION_STYLE_DEFS[settings.style];
  const usesHighlight = style.animation !== 'none';
  const off = !settings.enabled;

  return (
    <div className="captions" data-testid="captions-panel">
      <label className="captions__switch">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(e) => void update(seq, { enabled: e.target.checked })}
        />
        <span>Show captions</span>
      </label>
      {!ass && (
        <p className="transcript__hint">
          {transcribed
            ? 'None of the clips on the timeline has a transcript yet. Transcribe them in the Transcript tab.'
            : 'Captions come from the transcript. Transcribe your clips in the Transcript tab first.'}
        </p>
      )}
      <p className="transcript__hint">
        Captions follow the spoken words automatically, including your corrections and cuts.
      </p>

      <fieldset className="captions__styles" disabled={off}>
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

      <fieldset className="captions__fields" disabled={off}>
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
function CommitSlider({
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
