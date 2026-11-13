import { useState } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { captionClipWords } from '@rec-it/captions';
import type { Sequence, TimelineItem, Track, Transform } from '@rec-it/core';
import { Button } from '@rec-it/ui';
import { deleteSelected, edit, toSeconds } from '../edit';
import { formatDuration } from '../format';
import { CommitSlider } from './CaptionsPanel';

/** Inspector for a caption clip (ADR-033): its words, and where it sits in the frame. */
export function CaptionInspector({
  seq,
  track,
  item,
}: {
  seq: Sequence;
  track: Track;
  item: TimelineItem;
}) {
  const text = captionClipWords(item)
    .map((w) => w.text)
    .join(' ');
  const t = item.transform;
  const set = (patch: Partial<Transform>) =>
    edit({ type: 'item.update', sequenceId: seq.id, itemId: item.id, transform: patch });
  const locked = track.locked;
  return (
    <div className="captions" data-testid="caption-inspector">
      <div className="inspector__title">
        <strong>Caption</strong>
        <span className="transcript__hint">
          {formatDuration(toSeconds(item.start))} · {formatDuration(toSeconds(item.duration))} long
        </span>
      </div>
      {/* Remount when the clip or its words change, so the box shows the saved text. */}
      <CaptionText
        key={`${item.id}:${text}`}
        initial={text}
        disabled={locked}
        onCommit={(value) =>
          edit({ type: 'caption.edit', sequenceId: seq.id, itemId: item.id, text: value })
        }
      />
      <p className="transcript__hint">
        Word timing is kept when you only fix spelling; with a different number of words, the
        caption's time is shared out between them.
      </p>
      <fieldset className="captions__fields" disabled={locked}>
        <CommitSlider
          label="Left / right"
          value={t.x}
          min={-0.5}
          max={0.5}
          step={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(x) => set({ x })}
        />
        <CommitSlider
          label="Up / down"
          value={t.y}
          min={-0.6}
          max={0.6}
          step={0.005}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(y) => set({ y })}
        />
        <CommitSlider
          label="Size"
          value={t.scale}
          min={0.25}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onCommit={(scale) => set({ scale })}
        />
        <CommitSlider
          label="Rotation"
          value={t.rotation}
          min={-180}
          max={180}
          step={1}
          format={(v) => `${Math.round(v)}°`}
          onCommit={(rotation) => set({ rotation })}
        />
      </fieldset>
      <div className="captions__buttons">
        <Button
          size="sm"
          icon={<RotateCcw size={14} />}
          disabled={locked}
          onClick={() => void set({ x: 0, y: 0, scale: 1, rotation: 0 })}
        >
          Reset position
        </Button>
        <Button
          size="sm"
          icon={<Trash2 size={14} />}
          disabled={locked}
          onClick={() => void deleteSelected(false)}
        >
          Delete caption
        </Button>
      </div>
    </div>
  );
}

function CaptionText({
  initial,
  disabled,
  onCommit,
}: {
  initial: string;
  disabled: boolean;
  onCommit: (text: string) => unknown;
}) {
  const [value, setValue] = useState(initial);
  const commit = () => {
    const clean = value.replace(/\s+/g, ' ').trim();
    if (clean && clean !== initial) void onCommit(clean);
    else setValue(initial);
  };
  return (
    <textarea
      className="ui-input captions__text"
      aria-label="Caption text"
      data-testid="caption-text"
      rows={3}
      value={value}
      disabled={disabled}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        } else if (e.key === 'Escape') {
          setValue(initial);
        }
      }}
    />
  );
}
