import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { StatusDot, type DotState } from '@rec-it/ui';
import { backend } from '../api';
import { JOB_LABELS } from '../format';
import { useApp } from '../store';
import { useBackendConnection, useBackendLatency, useSystemStatus } from '../hooks';
import type { SettingsTab } from '../settings/SettingsDialog';

export function StatusBar({ onOpenSettings }: { onOpenSettings: (tab: SettingsTab) => void }) {
  const connected = useBackendConnection();
  const latency = useBackendLatency();
  const { status } = useSystemStatus();
  const ffmpeg = status?.ffmpeg;
  const sidecar = status?.sidecar;
  const gpu = sidecar?.gpus[0];

  const ffmpegState: DotState = !ffmpeg
    ? 'checking'
    : ffmpeg.state === 'ok' && ffmpeg.message
      ? 'warn'
      : ffmpeg.state;
  const nvenc =
    ffmpeg?.nvencUsable === true ? 'NVENC' : ffmpeg?.nvencUsable === false ? 'no NVENC' : null;

  return (
    <footer className="statusbar" data-region="statusbar">
      <button
        type="button"
        className="statusbar__item"
        onClick={() => onOpenSettings('system')}
        data-testid="status-backend"
      >
        <StatusDot state={connected ? 'ok' : 'checking'} />
        {connected
          ? `Backend${latency !== null ? ` · ${latency.toFixed(1)} ms` : ''}`
          : 'Connecting…'}
      </button>
      <button
        type="button"
        className="statusbar__item"
        onClick={() => onOpenSettings('system')}
        data-testid="status-ffmpeg"
      >
        <StatusDot state={ffmpegState} />
        {ffmpeg?.state === 'ok'
          ? `FFmpeg ${shortVersion(ffmpeg.version)}${nvenc ? ` · ${nvenc}` : ''}`
          : ffmpegLabel(ffmpeg?.state)}
      </button>
      <button
        type="button"
        className="statusbar__item"
        onClick={() => onOpenSettings('system')}
        data-testid="status-sidecar"
      >
        <StatusDot state={sidecar?.state ?? 'checking'} />
        {sidecar?.state === 'ok'
          ? `Media AI ${gpu ? `· ${gpu.name.replace(/^NVIDIA (GeForce )?/, '')}` : '· CPU'}`
          : sidecarLabel(sidecar?.state)}
      </button>
      <span className="statusbar__spacer" />
      <JobsIndicator />
    </footer>
  );
}

function shortVersion(v?: string) {
  return v?.replace(/^n/, '').split('-')[0] ?? '';
}
function ffmpegLabel(state?: string) {
  return state === 'missing'
    ? 'FFmpeg not found'
    : state === 'error'
      ? 'FFmpeg error'
      : 'Checking FFmpeg…';
}
function sidecarLabel(state?: string) {
  return state === 'missing'
    ? 'Media AI unavailable'
    : state === 'error'
      ? 'Media AI error'
      : 'Starting media AI…';
}

function JobsIndicator() {
  const jobs = useApp((s) => s.jobs);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const running = jobs.filter((j) => j.state === 'running');
  if (!jobs.length)
    return <span className="statusbar__item statusbar__item--muted">No background jobs</span>;
  return (
    <div className="jobs" ref={ref}>
      <button
        type="button"
        className="statusbar__item"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="status-jobs"
      >
        <StatusDot state="checking" />
        {running.length} running · {jobs.length - running.length} queued
      </button>
      {open && (
        <div className="jobs__popover" role="dialog" aria-label="Background jobs">
          <header>Background jobs</header>
          <ul>
            {jobs.map((j) => (
              <li key={`${j.assetId}:${j.kind}`}>
                <div className="jobs__text">
                  <span className="jobs__name" title={j.assetName}>
                    {j.assetName}
                  </span>
                  <span className="jobs__kind">
                    {JOB_LABELS[j.kind]} ·{' '}
                    {j.state === 'running' ? `${Math.round(j.progress * 100)}%` : 'queued'}
                  </span>
                  <div className="progress">
                    <div
                      className="progress__bar"
                      style={{ width: `${Math.round(j.progress * 100)}%` }}
                    />
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Cancel ${j.assetName}`}
                  onClick={() => void backend.invoke('media.cancel', { assetIds: [j.assetId] })}
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
