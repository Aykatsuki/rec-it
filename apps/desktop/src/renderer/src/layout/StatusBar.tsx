import { StatusDot, type DotState } from '@rec-it/ui';
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
      <span className="statusbar__item statusbar__item--muted">Phase 0 · foundations</span>
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
