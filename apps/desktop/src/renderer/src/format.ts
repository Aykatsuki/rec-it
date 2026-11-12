import type { MediaAsset } from '@rec-it/ipc-contract';

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0:00';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatFps(rate: { num: number; den: number }): string {
  const v = rate.num / rate.den;
  return Number.isInteger(v) ? String(v) : v.toFixed(3).replace(/0+$/, '');
}

/** Short quality label such as "4K", "1080p" or "720p" (by the shorter side of the displayed frame). */
export function resolutionLabel(asset: MediaAsset): string | null {
  const v = asset.probe?.video;
  if (!v || asset.kind !== 'video') return null;
  const short = Math.min(v.displayWidth, v.displayHeight);
  if (short >= 2000) return '4K';
  if (short >= 1400) return '1440p';
  if (short >= 1000) return '1080p';
  if (short >= 700) return '720p';
  return `${short}p`;
}

export const RIGHTS_LABELS: Record<MediaAsset['rights']['source'], string> = {
  'own-recording': 'My own recording',
  'own-youtube-upload': 'My own YouTube upload',
  'creative-commons': 'Creative Commons',
  'licensed-stock': 'Licensed stock footage',
  'licensed-other': 'Licensed from someone else',
  unknown: 'Not sure',
};

export const JOB_LABELS = {
  probe: 'Reading',
  proxy: 'Preview copy',
  thumbnails: 'Thumbnails',
  waveform: 'Waveform',
} as const;
