import { Magnet, MousePointer2, Scissors, ZoomIn, ZoomOut } from 'lucide-react';
import { IconButton } from '@rec-it/ui';

const TRACKS = [
  { id: 'C1', kind: 'caption', name: 'Captions' },
  { id: 'V2', kind: 'video', name: 'Video 2' },
  { id: 'V1', kind: 'video', name: 'Video 1' },
  { id: 'A1', kind: 'audio', name: 'Audio 1' },
  { id: 'A2', kind: 'audio', name: 'Music' },
] as const;

const SECONDS = Array.from({ length: 31 }, (_, i) => i);

export function Timeline() {
  return (
    <section className="panel timeline" data-region="timeline" aria-label="Timeline">
      <header className="panel__header timeline__toolbar">
        <div className="toolgroup" role="toolbar" aria-label="Timeline tools">
          <IconButton label="Select (V)" size="sm" aria-pressed>
            <MousePointer2 size={15} />
          </IconButton>
          <IconButton label="Blade (B)" size="sm" disabled>
            <Scissors size={15} />
          </IconButton>
          <IconButton label="Snapping (N)" size="sm" aria-pressed disabled>
            <Magnet size={15} />
          </IconButton>
        </div>
        <span className="timeline__hint">The editable timeline arrives in Phase 2</span>
        <div className="toolgroup">
          <IconButton label="Zoom out (-)" size="sm" disabled>
            <ZoomOut size={15} />
          </IconButton>
          <IconButton label="Zoom in (+)" size="sm" disabled>
            <ZoomIn size={15} />
          </IconButton>
        </div>
      </header>
      <div className="timeline__grid">
        <div className="timeline__corner" />
        <div className="timeline__ruler" aria-hidden>
          {SECONDS.map((s) => (
            <span key={s} className="timeline__tick" style={{ left: `${s * 80}px` }}>
              {s % 5 === 0 ? `00:${String(s).padStart(2, '0')}` : ''}
            </span>
          ))}
          <span className="timeline__playhead" />
        </div>
        {TRACKS.map((track) => (
          <div key={track.id} className="timeline__row" data-kind={track.kind}>
            <div className="track-header">
              <span className="track-header__chip">{track.id}</span>
              <span className="track-header__name">{track.name}</span>
            </div>
            <div className="track-lane" />
          </div>
        ))}
        <div className="timeline__drop" aria-hidden>
          Drag media here to start a sequence
        </div>
      </div>
    </section>
  );
}
