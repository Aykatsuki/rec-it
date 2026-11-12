import { openContextMenu } from '../ui/ContextMenu';
import { assetMenu } from '../timeline/menus';
import { useEffect, useState, type MouseEvent } from 'react';
import {
  AlertTriangle,
  AudioLines,
  FileQuestion,
  Image as ImageIcon,
  Loader2,
  RotateCcw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { backend } from '../api';
import { locateAsset } from '../actions';
import { ASSET_MIME, addToTimeline } from '../edit';
import { formatDuration, JOB_LABELS, resolutionLabel } from '../format';

/** The job currently holding the asset up, for the progress bar. */
export function activeJob(asset: MediaAsset) {
  const order = ['probe', 'proxy', 'thumbnails', 'waveform'] as const;
  return order
    .map((k) => ({ kind: k, ...asset.jobs[k] }))
    .find((j) => j.state === 'running' || j.state === 'pending');
}

export function failedJob(asset: MediaAsset) {
  const order = ['probe', 'proxy', 'thumbnails', 'waveform'] as const;
  return order.map((k) => ({ kind: k, ...asset.jobs[k] })).find((j) => j.state === 'failed');
}

export function AssetBadges({ asset }: { asset: MediaAsset }) {
  const v = asset.probe?.video;
  const res = resolutionLabel(asset);
  return (
    <>
      {res && <span className="chip">{res}</span>}
      {v && asset.kind === 'video' && (
        <span className="chip">
          {v.codec === 'hevc' ? 'HEVC' : v.codec === 'h264' ? 'H.264' : v.codec.toUpperCase()}
        </span>
      )}
      {v?.hdr && <span className="chip chip--hdr">HDR</span>}
      {v?.isVfr && (
        <span
          className="chip"
          title="Variable frame rate (common on phones). The preview copy is converted to a constant rate."
        >
          VFR
        </span>
      )}
      {asset.rights.source === 'unknown' && (
        <span className="chip chip--warn" title="Usage rights not confirmed">
          Rights?
        </span>
      )}
    </>
  );
}

export function AssetCard({
  asset,
  selected,
  onSelect,
}: {
  asset: MediaAsset;
  selected: boolean;
  onSelect: () => void;
}) {
  const [scrub, setScrub] = useState<number | null>(null);
  const sprite = asset.urls.sprite;
  const job = activeJob(asset);
  const failed = failedJob(asset);
  const duration = asset.probe?.durationSec ?? 0;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!sprite) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setScrub(
      Math.min(
        sprite.count - 1,
        Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * sprite.count)),
      ),
    );
  };

  // Sprite tiles keep the clip's own aspect ratio, so draw them in a box of that shape.
  const v = asset.probe?.video;
  const tileAspect = v ? v.displayWidth / v.displayHeight : 16 / 9;
  const scrubStyle =
    scrub !== null && sprite
      ? {
          aspectRatio: String(tileAspect),
          backgroundImage: `url("${sprite.url}")`,
          backgroundSize: `${sprite.columns * 100}% ${sprite.rows * 100}%`,
          backgroundPosition: `${sprite.columns > 1 ? ((scrub % sprite.columns) / (sprite.columns - 1)) * 100 : 0}% ${
            sprite.rows > 1 ? (Math.floor(scrub / sprite.columns) / (sprite.rows - 1)) * 100 : 0
          }%`,
        }
      : undefined;

  return (
    <div
      className="asset-card"
      data-selected={selected}
      data-status={asset.status}
      data-testid="asset-card"
      data-name={asset.name}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={() => void addToTimeline(asset)}
      onContextMenu={(e) => {
        onSelect();
        openContextMenu(e, assetMenu(asset));
      }}
      draggable={asset.status === 'ready'}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      title={
        asset.status === 'ready'
          ? 'Drag onto the timeline, or double-click to add it at the end'
          : undefined
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect();
      }}
    >
      <div className="asset-card__thumb" onMouseMove={onMove} onMouseLeave={() => setScrub(null)}>
        {scrubStyle && (
          <div
            className="asset-card__scrub"
            style={scrubStyle}
            data-portrait={tileAspect < 16 / 9}
          />
        )}
        {scrub === null &&
          (asset.urls.poster ? (
            <img src={asset.urls.poster} alt="" draggable={false} />
          ) : (
            <div className="asset-card__placeholder">
              {asset.kind === 'audio' ? (
                <AudioLines size={26} />
              ) : asset.kind === 'image' ? (
                <ImageIcon size={26} />
              ) : asset.status === 'failed' ? (
                <FileQuestion size={26} />
              ) : (
                <Loader2 size={22} className="spin" />
              )}
            </div>
          ))}
        {asset.kind === 'audio' && asset.urls.waveform && (
          <WaveformStrip url={asset.urls.waveform} />
        )}
        {duration > 0 && <span className="asset-card__duration">{formatDuration(duration)}</span>}
        {scrub !== null && sprite && (
          <span className="asset-card__scrubtime">{formatDuration(scrub * sprite.interval)}</span>
        )}

        {asset.status === 'missing' && (
          <div className="asset-card__overlay asset-card__overlay--missing">
            <AlertTriangle size={18} />
            <span>File moved or deleted</span>
            <button
              type="button"
              className="ui-btn ui-btn--sm"
              onClick={(e) => (e.stopPropagation(), void locateAsset(asset.id, asset.name))}
            >
              <Search size={13} /> Locate
            </button>
          </div>
        )}
        {asset.status === 'failed' && failed && (
          <div className="asset-card__overlay asset-card__overlay--failed" title={failed.error}>
            <AlertTriangle size={18} />
            <span>
              {failed.kind === 'probe'
                ? 'Not a readable media file'
                : `${JOB_LABELS[failed.kind]} failed`}
            </span>
            {failed.kind !== 'probe' && (
              <button
                type="button"
                className="ui-btn ui-btn--sm"
                onClick={(e) => (
                  e.stopPropagation(),
                  void backend.invoke('media.retry', { assetId: asset.id })
                )}
              >
                <RotateCcw size={13} /> Retry
              </button>
            )}
          </div>
        )}
        {asset.status === 'processing' && (
          <div className="asset-card__progress" title={job ? `${JOB_LABELS[job.kind]}…` : 'Paused'}>
            <div className="progress">
              <div
                className="progress__bar"
                style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }}
              />
            </div>
            {job ? (
              <button
                type="button"
                aria-label="Cancel processing"
                title="Cancel"
                onClick={(e) => (
                  e.stopPropagation(),
                  void backend.invoke('media.cancel', { assetIds: [asset.id] })
                )}
              >
                <X size={12} />
              </button>
            ) : (
              <button
                type="button"
                aria-label="Resume processing"
                title="Resume"
                onClick={(e) => (
                  e.stopPropagation(),
                  void backend.invoke('media.retry', { assetId: asset.id })
                )}
              >
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        )}
        <button
          type="button"
          className="asset-card__remove"
          aria-label={`Remove ${asset.name} from project`}
          title="Remove from project (the original file is kept)"
          onClick={(e) => {
            e.stopPropagation();
            void backend.invoke('media.remove', { assetIds: [asset.id] });
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="asset-card__meta">
        <span className="asset-card__name" title={asset.name}>
          {asset.name}
        </span>
        <span className="asset-card__chips">
          <AssetBadges asset={asset} />
        </span>
      </div>
    </div>
  );
}

/** Draws peaks from waveform.bin (one byte per 10 ms) as a filled mirrored shape. */
// Waveforms are fetched once per file and shared by every card and timeline clip that shows it.
const waveforms = new Map<string, Promise<string>>();
const readyPaths = new Map<string, string>();
function waveformFor(url: string): Promise<string> {
  let p = waveforms.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const path = waveformPath(new Uint8Array(buf));
        readyPaths.set(url, path);
        return path;
      })
      .catch(() => {
        waveforms.delete(url);
        return '';
      });
    waveforms.set(url, p);
    if (waveforms.size > 200) {
      const oldest = waveforms.keys().next().value!;
      waveforms.delete(oldest);
      readyPaths.delete(oldest);
    }
  }
  return p;
}

export function WaveformStrip({
  url,
  className = 'waveform-strip',
}: {
  url: string;
  className?: string;
}) {
  const [path, setPath] = useState(() => readyPaths.get(url) ?? '');
  useEffect(() => {
    let cancelled = false;
    void waveformFor(url).then((p) => {
      if (!cancelled) setPath(p);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return (
    <svg className={className} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {path && <path d={path} />}
    </svg>
  );
}

export function waveformPath(peaks: Uint8Array, bins = 160): string {
  if (!peaks.length) return '';
  const per = Math.max(1, peaks.length / bins);
  const tops: [number, number][] = [];
  for (let i = 0; i < bins; i++) {
    let max = 0;
    for (let j = Math.floor(i * per); j < Math.min(peaks.length, Math.floor((i + 1) * per)); j++)
      max = Math.max(max, peaks[j]!);
    tops.push([(i / (bins - 1)) * 100, 50 - Math.max(0.8, (max / 255) * 48)]);
  }
  const top = tops.map(([x, y]) => `L${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
  const bottom = [...tops]
    .reverse()
    .map(([x, y]) => `L${x.toFixed(2)} ${(100 - y).toFixed(2)}`)
    .join(' ');
  return `M0 50 ${top} ${bottom} Z`;
}
