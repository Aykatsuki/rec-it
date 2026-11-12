import { useEffect, useRef, useState } from 'react';
import { AudioLines, Loader2, Maximize2, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { IconButton } from '@rec-it/ui';
import { formatDuration } from '../format';
import { WaveformStrip } from '../media/AssetCard';
import { useSelectedAsset } from '../store';

type Aspect = '9:16' | '16:9';

function timecode(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000);
  const s = Math.floor(seconds) % 60;
  const m = Math.floor(seconds / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function Preview() {
  const asset = useSelectedAsset();
  const [aspect, setAspect] = useState<Aspect>('9:16');
  return (
    <section className="panel preview" data-region="preview" aria-label="Preview">
      <header className="panel__header">
        <h2 className="panel__title">{asset ? `Source · ${asset.name}` : 'Preview'}</h2>
        {!asset && (
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
        )}
      </header>
      {asset ? <SourceMonitor key={asset.id} asset={asset} /> : <EmptyFrame aspect={aspect} />}
    </section>
  );
}

function EmptyFrame({ aspect }: { aspect: Aspect }) {
  return (
    <>
      <div className="preview__well">
        <div className="preview__frame" data-aspect={aspect}>
          {aspect === '9:16' && (
            <div className="preview__safe" aria-hidden title="Shorts UI safe area" />
          )}
          <span className="preview__placeholder">Select a clip in Media to preview it</span>
        </div>
      </div>
      <footer className="transport">
        <span className="transport__time">
          <span className="transport__now">00:00.000</span>
          <span className="transport__sep">/</span>00:00.000
        </span>
        <div className="transport__controls">
          <IconButton label="Play (Space)" disabled>
            <Play size={18} />
          </IconButton>
        </div>
        <span />
      </footer>
    </>
  );
}

/** Plays the selected asset's proxy (video) or shows its poster/waveform (stills and audio). */
function SourceMonitor({ asset }: { asset: MediaAsset }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const duration = asset.probe?.durationSec ?? 0;
  const fps = asset.probe?.video ? asset.probe.video.fps.num / asset.probe.video.fps.den : 30;
  const canPlay = asset.kind === 'video' && !!asset.urls.proxy;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!canPlay || (e.target as HTMLElement).closest('input, textarea, select')) return;
      const v = video.current;
      if (!v) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (v.paused) void v.play();
        else v.pause();
      } else if (e.key === 'ArrowLeft') {
        v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 1 : 1 / fps));
      } else if (e.key === 'ArrowRight') {
        v.currentTime = Math.min(duration, v.currentTime + (e.shiftKey ? 1 : 1 / fps));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canPlay, fps, duration]);

  const step = (delta: number) => {
    const v = video.current;
    if (v) v.currentTime = Math.min(duration, Math.max(0, v.currentTime + delta));
  };

  return (
    <>
      <div className="preview__well">
        {canPlay ? (
          <video
            ref={video}
            className="preview__video"
            src={asset.urls.proxy}
            preload="auto"
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onSeeked={(e) => setTime(e.currentTarget.currentTime)}
            onClick={(e) =>
              e.currentTarget.paused ? void e.currentTarget.play() : e.currentTarget.pause()
            }
            data-testid="source-video"
          />
        ) : asset.kind === 'image' && asset.urls.poster ? (
          <img className="preview__image" src={asset.urls.poster} alt={asset.name} />
        ) : asset.kind === 'audio' ? (
          <div className="preview__audio">
            <AudioLines size={28} />
            {asset.urls.waveform && (
              <WaveformStrip url={asset.urls.waveform} className="preview__waveform" />
            )}
            <span>Audio playback arrives with the timeline in Phase 2</span>
          </div>
        ) : (
          <div className="preview__pending">
            <Loader2 size={22} className="spin" />
            <span>
              {asset.status === 'processing' ? 'Making a preview copy…' : 'No preview available'}
            </span>
          </div>
        )}
      </div>
      {canPlay && (
        <input
          className="scrubber"
          type="range"
          min={0}
          max={duration}
          step={1 / fps}
          value={time}
          aria-label="Position"
          onChange={(e) => {
            const v = video.current;
            if (v) v.currentTime = Number(e.target.value);
          }}
          style={{ ['--pct' as string]: `${duration ? (time / duration) * 100 : 0}%` }}
        />
      )}
      <footer className="transport">
        <span className="transport__time">
          <span className="transport__now">{timecode(time)}</span>
          <span className="transport__sep">/</span>
          {duration ? formatDuration(duration) : '0:00'}
        </span>
        <div className="transport__controls">
          <IconButton
            label="Back one frame (←)"
            size="sm"
            disabled={!canPlay}
            onClick={() => step(-1 / fps)}
          >
            <SkipBack size={15} />
          </IconButton>
          <IconButton
            label={playing ? 'Pause (Space)' : 'Play (Space)'}
            disabled={!canPlay}
            onClick={() => {
              const v = video.current;
              if (v) void (v.paused ? v.play() : v.pause());
            }}
          >
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </IconButton>
          <IconButton
            label="Forward one frame (→)"
            size="sm"
            disabled={!canPlay}
            onClick={() => step(1 / fps)}
          >
            <SkipForward size={15} />
          </IconButton>
        </div>
        <IconButton
          label="Full screen"
          size="sm"
          disabled={!canPlay}
          onClick={() => void video.current?.requestFullscreen()}
        >
          <Maximize2 size={14} />
        </IconButton>
      </footer>
    </>
  );
}
