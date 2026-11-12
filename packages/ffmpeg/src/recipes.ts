// Argument builders for the media pipeline (ARCHITECTURE §8, ADR-006). Pure and snapshot-tested.
import type { Rational } from '@rec-it/core';
import type { ProbeInfo } from './probe';

export const PROXY_LONG_EDGE = 1280;
export const PROXY_GOP = 12;
const STANDARD_RATES: Rational[] = [
  { num: 24000, den: 1001 },
  { num: 24, den: 1 },
  { num: 25, den: 1 },
  { num: 30000, den: 1001 },
  { num: 30, den: 1 },
  { num: 50, den: 1 },
  { num: 60000, den: 1001 },
  { num: 60, den: 1 },
];

/**
 * Constant frame rate for the proxy: the source's average rate snapped to the nearest
 * standard rate (within 1%), otherwise rounded, capped at 60.
 */
export function proxyFrameRate(probe: ProbeInfo): Rational {
  const v = probe.video;
  if (!v) return { num: 30, den: 1 };
  const avg = v.avgFps.num / v.avgFps.den;
  const nominal = v.fps.num / v.fps.den;
  const target = v.isVfr ? avg : nominal;
  for (const rate of STANDARD_RATES) {
    const value = rate.num / rate.den;
    if (Math.abs(value - target) / value < 0.01) return rate;
  }
  return { num: Math.max(1, Math.min(60, Math.round(target))), den: 1 };
}

export type H264Encoder = 'h264_nvenc' | 'libx264' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox';

function encoderArgs(encoder: H264Encoder): string[] {
  switch (encoder) {
    case 'h264_nvenc':
      return [
        '-c:v',
        'h264_nvenc',
        '-preset',
        'p4',
        '-rc',
        'vbr',
        '-cq',
        '23',
        '-b:v',
        '0',
        '-bf',
        '0',
      ];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'fast', '-global_quality', '23', '-bf', '0'];
    case 'h264_amf':
      return [
        '-c:v',
        'h264_amf',
        '-quality',
        'speed',
        '-rc',
        'cqp',
        '-qp_i',
        '23',
        '-qp_p',
        '23',
        '-bf',
        '0',
      ];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', '60', '-bf', '0'];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-bf', '0'];
  }
}

/** HDR (PQ/HLG) → SDR BT.709 for viewing, using zimg. Export uses the originals. */
const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

export interface ProxyOptions {
  /** Tone-map HDR to SDR (needs FFmpeg built with zimg). Without it HDR proxies look washed out. */
  tonemap?: boolean;
}

export function proxyArgs(
  input: string,
  output: string,
  probe: ProbeInfo,
  encoder: H264Encoder,
  options: ProxyOptions = { tonemap: true },
): string[] {
  const rate = proxyFrameRate(probe);
  const filters: string[] = [];
  if (probe.video?.hdr && options.tonemap) filters.push(TONEMAP);
  // FFmpeg auto-rotates phone footage, so the proxy is stored upright.
  filters.push(
    `scale=w='min(${PROXY_LONG_EDGE},iw)':h='min(${PROXY_LONG_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:out_color_matrix=bt709:out_range=tv`,
    'format=yuv420p',
    // Tagged BT.709 so the browser shows the same colours as the export (ADR-027).
    'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  );
  const audio = probe.audio
    ? ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']
    : ['-an'];
  return [
    '-i',
    input,
    '-map',
    '0:v:0',
    ...audio,
    '-vf',
    filters.join(','),
    '-fps_mode',
    'cfr',
    '-r',
    `${rate.num}/${rate.den}`,
    ...encoderArgs(encoder),
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-g',
    String(PROXY_GOP),
    '-keyint_min',
    String(PROXY_GOP),
    '-sn',
    '-dn',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

/** Audio-only preview copy: AAC in MP4, 48 kHz stereo, playable by the preview. */
export function audioProxyArgs(input: string, output: string): string[] {
  return [
    '-i',
    input,
    '-map',
    '0:a:0',
    '-vn',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-ar',
    '48000',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ];
}

/** Preview copy of a still image: JPEG, at most 1920 px on the long edge. */
export function stillArgs(input: string, output: string): string[] {
  return [
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
    '-c:v',
    'mjpeg',
    '-q:v',
    '2',
    '-update',
    '1',
    '-f',
    'image2',
    output,
  ];
}

export interface SpriteLayout {
  /** Seconds between thumbnails. */
  interval: number;
  count: number;
  columns: number;
  rows: number;
  tileHeight: number;
}

/** At most 100 thumbnails (one every ≥1 s) in a 10-wide grid, each 90 px high. */
export function spriteLayout(durationSec: number): SpriteLayout {
  const interval = Math.max(1, durationSec / 100);
  const count = Math.max(1, Math.min(100, Math.floor(durationSec / interval)));
  const columns = Math.min(10, count);
  return { interval, count, columns, rows: Math.ceil(count / columns), tileHeight: 90 };
}

export function spriteArgs(input: string, output: string, layout: SpriteLayout): string[] {
  return [
    '-i',
    input,
    '-map',
    '0:v:0',
    '-vf',
    `fps=1/${layout.interval.toFixed(4)},scale=-2:${layout.tileHeight},tile=${layout.columns}x${layout.rows}`,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    '4',
    '-update',
    '1',
    '-f',
    'image2',
    output,
  ];
}

/** A single poster frame, 360 px high, taken 10% in (or the first frame for stills). */
export function posterArgs(input: string, output: string, probe: ProbeInfo): string[] {
  const at = probe.kind === 'video' ? Math.min(probe.durationSec * 0.1, 10) : 0;
  return [
    ...(at > 0 ? ['-ss', at.toFixed(3)] : []),
    '-i',
    input,
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    'scale=-2:360',
    '-c:v',
    'mjpeg',
    '-q:v',
    '3',
    '-update',
    '1',
    '-f',
    'image2',
    output,
  ];
}

export const WAVEFORM_SAMPLE_RATE = 8000;
/** Peaks per second stored for the waveform (one byte each). */
export const WAVEFORM_PEAKS_PER_SECOND = 100;

/** Decodes the first audio stream to mono 16-bit PCM on stdout. */
export function waveformPcmArgs(input: string): string[] {
  return [
    '-i',
    input,
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    String(WAVEFORM_SAMPLE_RATE),
    '-f',
    's16le',
    'pipe:1',
  ];
}

/**
 * Accumulates PCM into peaks (max |sample| per bucket, scaled to 0..255).
 * Handles chunks that split a sample across boundaries.
 */
export class PeakBuilder {
  private readonly samplesPerPeak = WAVEFORM_SAMPLE_RATE / WAVEFORM_PEAKS_PER_SECOND;
  private readonly peaks: number[] = [];
  private current = 0;
  private count = 0;
  private carry: Buffer | null = null;

  push(chunk: Buffer): void {
    let data = this.carry ? Buffer.concat([this.carry, chunk]) : chunk;
    const usable = data.length - (data.length % 2);
    this.carry = usable < data.length ? data.subarray(usable) : null;
    data = data.subarray(0, usable);
    for (let i = 0; i < data.length; i += 2) {
      const v = Math.abs(data.readInt16LE(i));
      if (v > this.current) this.current = v;
      if (++this.count === this.samplesPerPeak) this.flush();
    }
  }

  finish(): Uint8Array {
    if (this.count > 0) this.flush();
    return Uint8Array.from(this.peaks);
  }

  private flush(): void {
    this.peaks.push(Math.min(255, Math.round((this.current / 32768) * 255)));
    this.current = 0;
    this.count = 0;
  }
}
