import { secondsToFlicks, type Flicks, type Rational } from '@rec-it/core';
import { runTool } from './run';

export type MediaKind = 'video' | 'audio' | 'image';

export interface VideoStreamInfo {
  codec: string;
  profile?: string;
  /** Coded size as stored in the file. */
  width: number;
  height: number;
  /** Size as it should be displayed (after rotation). */
  displayWidth: number;
  displayHeight: number;
  /** Counter-clockwise display rotation stored as metadata (phones). */
  rotation: 0 | 90 | 180 | 270;
  /** Nominal rate (r_frame_rate). */
  fps: Rational;
  /** Average rate over the file (avg_frame_rate). */
  avgFps: Rational;
  isVfr: boolean;
  pixFmt: string;
  bitDepth: number;
  colorTransfer?: string;
  colorPrimaries?: string;
  hdr: boolean;
  frameCount?: number;
}

export interface AudioStreamInfo {
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface ProbeInfo {
  kind: MediaKind;
  container: string;
  durationFlicks: Flicks;
  durationSec: number;
  bitRate?: number;
  video?: VideoStreamInfo;
  audio?: AudioStreamInfo;
  /** Number of audio streams (some cameras record several). */
  audioStreamCount: number;
}

export class ProbeError extends Error {
  override name = 'ProbeError';
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  color_transfer?: string;
  color_primaries?: string;
  nb_frames?: string;
  duration?: string;
  sample_rate?: string;
  channels?: number;
  disposition?: { attached_pic?: number };
  side_data_list?: { side_data_type?: string; rotation?: number }[];
  tags?: Record<string, string>;
}

interface RawProbe {
  streams?: RawStream[];
  format?: { format_name?: string; duration?: string; bit_rate?: string };
}

const STILL_IMAGE_FORMATS = new Set([
  'png_pipe',
  'image2',
  'jpeg_pipe',
  'webp_pipe',
  'bmp_pipe',
  'tiff_pipe',
  'gif',
  'heif',
]);
const HDR_TRANSFERS = new Set(['smpte2084', 'arib-std-b67']);

export function parseRational(value: string | undefined): Rational | null {
  if (!value) return null;
  const [n, d = '1'] = value.split('/');
  const num = Number(n);
  const den = Number(d);
  if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return null;
  return { num: Math.round(num), den: Math.round(den) };
}

function rationalValue(r: Rational): number {
  return r.num / r.den;
}

function normaliseRotation(stream: RawStream): VideoStreamInfo['rotation'] {
  const fromSide = stream.side_data_list?.find((s) => typeof s.rotation === 'number')?.rotation;
  const fromTag = stream.tags?.rotate !== undefined ? -Number(stream.tags.rotate) : undefined;
  const raw = fromSide ?? fromTag ?? 0;
  const deg = (((Math.round(raw / 90) * 90) % 360) + 360) % 360;
  return deg as VideoStreamInfo['rotation'];
}

function bitDepthOf(stream: RawStream): number {
  const fromRaw = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(fromRaw) && fromRaw > 0) return fromRaw;
  const m = stream.pix_fmt?.match(/p(\d{2})(le|be)$/);
  return m ? Number(m[1]) : 8;
}

/** Turns `ffprobe -show_format -show_streams -of json` output into ProbeInfo. Pure; unit-tested. */
export function parseProbe(json: string | RawProbe): ProbeInfo {
  const data: RawProbe = typeof json === 'string' ? (JSON.parse(json) as RawProbe) : json;
  const streams = data.streams ?? [];
  const format = data.format ?? {};
  const container = format.format_name ?? 'unknown';

  const videoStream = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audioStreams = streams.filter((s) => s.codec_type === 'audio');
  const audioStream = audioStreams[0];

  if (!videoStream && !audioStream)
    throw new ProbeError('The file contains no video or audio streams.');

  const durationSec =
    Number(format.duration) || Number(videoStream?.duration) || Number(audioStream?.duration) || 0;

  const isImage =
    !!videoStream &&
    !audioStream &&
    (STILL_IMAGE_FORMATS.has(container) ||
      (durationSec === 0 && Number(videoStream.nb_frames ?? 1) <= 1));

  let video: VideoStreamInfo | undefined;
  if (videoStream) {
    const width = videoStream.width ?? 0;
    const height = videoStream.height ?? 0;
    if (!width || !height) throw new ProbeError('The video stream has no frame size.');
    const rotation = normaliseRotation(videoStream);
    const fps = parseRational(videoStream.r_frame_rate) ?? { num: 30, den: 1 };
    const avgFps = parseRational(videoStream.avg_frame_rate) ?? fps;
    // A file is variable-frame-rate when its average rate differs from its nominal rate by >0.5%.
    const isVfr =
      !isImage && Math.abs(rationalValue(fps) - rationalValue(avgFps)) / rationalValue(fps) > 0.005;
    const colorTransfer = videoStream.color_transfer;
    const swap = rotation === 90 || rotation === 270;
    const frameCount = Number(videoStream.nb_frames);
    video = {
      codec: videoStream.codec_name ?? 'unknown',
      ...(videoStream.profile ? { profile: videoStream.profile } : {}),
      width,
      height,
      displayWidth: swap ? height : width,
      displayHeight: swap ? width : height,
      rotation,
      fps,
      avgFps,
      isVfr,
      pixFmt: videoStream.pix_fmt ?? 'unknown',
      bitDepth: bitDepthOf(videoStream),
      ...(colorTransfer ? { colorTransfer } : {}),
      ...(videoStream.color_primaries ? { colorPrimaries: videoStream.color_primaries } : {}),
      hdr: colorTransfer ? HDR_TRANSFERS.has(colorTransfer) : false,
      ...(Number.isFinite(frameCount) && frameCount > 0 ? { frameCount } : {}),
    };
  }

  const audio: AudioStreamInfo | undefined = audioStream
    ? {
        codec: audioStream.codec_name ?? 'unknown',
        sampleRate: Number(audioStream.sample_rate) || 48_000,
        channels: audioStream.channels ?? 2,
      }
    : undefined;

  const kind: MediaKind = isImage ? 'image' : video ? 'video' : 'audio';
  if (kind !== 'image' && durationSec <= 0)
    throw new ProbeError('Could not determine the duration.');
  const bitRate = Number(format.bit_rate);

  return {
    kind,
    container,
    durationSec: kind === 'image' ? 0 : durationSec,
    durationFlicks: secondsToFlicks(kind === 'image' ? 0 : durationSec),
    ...(Number.isFinite(bitRate) && bitRate > 0 ? { bitRate } : {}),
    ...(video ? { video } : {}),
    ...(audio ? { audio } : {}),
    audioStreamCount: audioStreams.length,
  };
}

/** Runs ffprobe on a file and parses the result. */
export async function probeFile(
  ffprobe: string,
  path: string,
  timeoutMs = 30_000,
): Promise<ProbeInfo> {
  const result = await runTool(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', path],
    { timeoutMs },
  );
  if (result.code !== 0) {
    const reason = result.stderr.trim().split(/\r?\n/).pop() ?? 'unknown error';
    throw new ProbeError(`This file could not be read as media (${reason}).`);
  }
  return parseProbe(result.stdout);
}
