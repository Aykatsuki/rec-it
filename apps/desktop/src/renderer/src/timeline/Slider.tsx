import { useEffect, useRef, useState, type ReactNode } from 'react';

/** A slider that previews locally and commits one undoable edit when released. */
export function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  onPreview,
  extra,
  disabled,
}: {
  disabled?: boolean;
  /** Shown after the value (keyframe buttons). */
  extra?: ReactNode;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onCommit: (v: number) => unknown;
  /** Called while dragging, so the preview can update live. */
  onPreview?: (v: number) => void;
}) {
  const [local, setLocal] = useState<number | null>(null);
  // While an edit is being committed the slider keeps showing its value until the document
  // catches up, so a quick second change (arrow keys) starts from it, not from the old `value`.
  const committing = useRef<number | null>(null);
  const shown = local ?? value;
  const close = (a: number, b: number) => Math.abs(a - b) < step / 2;
  useEffect(() => {
    if (committing.current === null && local !== null && close(local, value)) setLocal(null);
    // Only when the document value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  });
  const commit = () => {
    // Compare with nothing: while dragging, the live preview already shows `local` as `value`.
    // Committing an unchanged value is a no-op in the edit helpers.
    if (local === null) return;
    const v = local;
    committing.current = v;
    void Promise.resolve(onCommit(v)).then((ok) => {
      if (committing.current !== v) return;
      committing.current = null;
      // Refused edits (false) and documents already up to date show the real value again;
      // otherwise the effect above lets go once the new value arrives (or after a second).
      const done = () => setLocal((now) => (now === v ? null : now));
      if (ok === false || close(latest.current, v)) done();
      else setTimeout(done, 1000);
    });
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
        disabled={disabled}
        onChange={(e) => {
          setLocal(Number(e.target.value));
          onPreview?.(Number(e.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="slider__value">{format(shown)}</span>
      {extra}
    </label>
  );
}
