import { useState } from 'react';
import { create } from 'zustand';
import { X } from 'lucide-react';
import type { Rational, Sequence } from '@rec-it/core';
import { Button, Dialog, TextField } from '@rec-it/ui';
import { edit, STANDARD_RATES } from '../edit';

const useDialog = create<{ open: boolean; seq: Sequence | null }>(() => ({
  open: false,
  seq: null,
}));

export function openSequenceSettings(seq: Sequence | null): void {
  useDialog.setState({ open: true, seq });
}

const PRESETS = [
  { id: 'short', label: 'YouTube Shorts / TikTok / Reels — 1080×1920 (9:16)', w: 1080, h: 1920 },
  { id: 'short720', label: 'Vertical draft — 720×1280 (9:16)', w: 720, h: 1280 },
  { id: 'square', label: 'Square — 1080×1080 (1:1)', w: 1080, h: 1080 },
  { id: 'portrait45', label: 'Portrait — 1080×1350 (4:5)', w: 1080, h: 1350 },
  { id: 'landscape', label: 'Landscape HD — 1920×1080 (16:9)', w: 1920, h: 1080 },
  { id: 'landscape4k', label: 'Landscape 4K — 3840×2160 (16:9)', w: 3840, h: 2160 },
  { id: 'vertical4k', label: 'Vertical 4K — 2160×3840 (9:16)', w: 2160, h: 3840 },
] as const;

const rateKey = (r: Rational) => `${r.num}/${r.den}`;

export function SequenceSettingsHost() {
  const { open, seq } = useDialog();
  if (!open) return null;
  return (
    <SequenceForm
      key={seq?.id ?? 'new'}
      seq={seq}
      onClose={() => useDialog.setState({ open: false })}
    />
  );
}

function SequenceForm({ seq, onClose }: { seq: Sequence | null; onClose: () => void }) {
  const [name, setName] = useState(seq?.name ?? 'Short 1');
  const [width, setWidth] = useState(seq?.width ?? 1080);
  const [height, setHeight] = useState(seq?.height ?? 1920);
  const [fps, setFps] = useState(rateKey(seq?.fps ?? { num: 30, den: 1 }));
  const preset = PRESETS.find((p) => p.w === width && p.h === height)?.id ?? 'custom';
  const valid = [width, height].every(
    (n) => Number.isInteger(n) && n >= 16 && n <= 7680 && n % 2 === 0,
  );

  const save = async () => {
    const rate = STANDARD_RATES.find((r) => rateKey(r.rate) === fps)!.rate;
    const ok = seq
      ? await edit({ type: 'sequence.update', sequenceId: seq.id, name, width, height, fps: rate })
      : await edit({ type: 'sequence.create', name, width, height, fps: rate });
    if (ok) onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={seq ? 'Sequence settings' : 'New sequence'}
      closeIcon={<X size={16} />}
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save();
        }}
      >
        <label className="form__row">
          <span>Name</span>
          <TextField value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
        </label>
        <label className="form__row">
          <span>Format</span>
          <select
            className="ui-input"
            value={preset}
            aria-label="Format"
            onChange={(e) => {
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) {
                setWidth(p.w);
                setHeight(p.h);
              }
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            <option value="custom">Custom size</option>
          </select>
        </label>
        <div className="form__row">
          <span>Resolution</span>
          <div className="form__pair">
            <TextField
              type="number"
              min={16}
              max={7680}
              step={2}
              value={width}
              onChange={(e) => setWidth(Number(e.target.value))}
              aria-label="Width"
            />
            <span>×</span>
            <TextField
              type="number"
              min={16}
              max={7680}
              step={2}
              value={height}
              onChange={(e) => setHeight(Number(e.target.value))}
              aria-label="Height"
            />
          </div>
        </div>
        <label className="form__row">
          <span>Frame rate</span>
          <select
            className="ui-input"
            value={fps}
            onChange={(e) => setFps(e.target.value)}
            aria-label="Frame rate"
          >
            {STANDARD_RATES.map((r) => (
              <option key={r.label} value={rateKey(r.rate)}>
                {r.label} fps
              </option>
            ))}
          </select>
        </label>
        {!valid && (
          <p className="form__error">Width and height must be even numbers between 16 and 7680.</p>
        )}
        {seq && (
          <p className="form__hint">
            Changing the frame rate re-aligns every clip to the new frames. You can undo it.
          </p>
        )}
        <div className="dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {seq ? 'Save' : 'Create'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
