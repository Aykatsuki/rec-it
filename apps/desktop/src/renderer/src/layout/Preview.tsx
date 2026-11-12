import { useState } from 'react';
import { Maximize2, Play, SkipBack, SkipForward } from 'lucide-react';
import { IconButton } from '@rec-it/ui';

type Aspect = '9:16' | '16:9';

export function Preview() {
  const [aspect, setAspect] = useState<Aspect>('9:16');
  return (
    <section className="panel preview" data-region="preview" aria-label="Preview">
      <header className="panel__header">
        <h2 className="panel__title">Preview</h2>
        <div className="segmented" role="radiogroup" aria-label="Frame">
          {(['9:16', '16:9'] as const).map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={aspect === a}
              onClick={() => setAspect(a)}
            >
              {a}
            </button>
          ))}
        </div>
      </header>
      <div className="preview__well">
        <div className="preview__frame" data-aspect={aspect}>
          {aspect === '9:16' && (
            <div className="preview__safe" aria-hidden title="Shorts UI safe area" />
          )}
          <span className="preview__placeholder">No sequence open</span>
        </div>
      </div>
      <footer className="transport">
        <span className="transport__time">
          <span className="transport__now">00:00.000</span>
          <span className="transport__sep">/</span>
          00:00.000
        </span>
        <div className="transport__controls">
          <IconButton label="Previous frame" size="sm" disabled>
            <SkipBack size={15} />
          </IconButton>
          <IconButton label="Play (Space)" disabled>
            <Play size={18} />
          </IconButton>
          <IconButton label="Next frame" size="sm" disabled>
            <SkipForward size={15} />
          </IconButton>
        </div>
        <IconButton label="Full screen preview" size="sm" disabled>
          <Maximize2 size={14} />
        </IconButton>
      </footer>
    </section>
  );
}
