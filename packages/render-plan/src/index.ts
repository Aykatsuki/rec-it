// Sequence → FFmpeg export command (ARCHITECTURE §10). Pure: no I/O, so it is unit-tested,
// and the integration tests render real files from it.
import {
  computeLayout,
  flicksToSeconds,
  sequenceDuration,
  type Sequence,
  type TimelineItem,
} from '@rec-it/core';

export interface ExportAsset {
  path: string;
  kind: 'video' | 'audio' | 'image';
  /** Size as displayed (after rotation). */
  width?: number;
  height?: number;
  hasAudio: boolean;
  hdr?: boolean;
}

export type ExportEncoder = 'h264_nvenc' | 'libx264' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox';
export type ExportQuality = 'draft' | 'standard' | 'high';

export interface ExportOptions {
  encoder: ExportEncoder;
  quality: ExportQuality;
  /** Tone-map HDR sources to SDR (needs zimg). */
  tonemap: boolean;
  /** Integrated loudness target for YouTube; null disables normalisation. */
  loudnessLufs?: number | null;
}

export interface ExportPlan {
  /** Arguments for FFmpeg, excluding the output path (append `-f mp4 <path>`). */
  inputArgs: string[];
  /** filter_complex graph; pass with `-/filter_complex <file>` to avoid command-line limits. */
  filterGraph: string;
  outputArgs: string[];
  durationSec: number;
}

export class ExportPlanError extends Error {
  override name = 'ExportPlanError';
}

const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

const sec = (n: number) => n.toFixed(6).replace(/\.?0+$/, '') || '0';

function videoEncoderArgs(encoder: ExportEncoder, quality: ExportQuality): string[] {
  const q = { draft: 0, standard: 1, high: 2 }[quality];
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', ['p2', 'p5', 'p7'][q]!, '-tune', 'hq', '-rc', 'vbr',
        '-cq', ['28', '20', '17'][q]!, '-b:v', '0', '-maxrate', ['8M', '20M', '35M'][q]!, '-bufsize', '40M',
        '-profile:v', 'high', '-spatial-aq', '1'];
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', ['veryfast', 'medium', 'slow'][q]!, '-crf', ['26', '19', '16'][q]!,
        '-profile:v', 'high'];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', ['veryfast', 'medium', 'slow'][q]!, '-global_quality', ['28', '21', '18'][q]!];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-quality', ['speed', 'balanced', 'quality'][q]!, '-rc', 'cqp',
        '-qp_i', ['28', '20', '17'][q]!, '-qp_p', ['30', '22', '19'][q]!];
    case 'h264_videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', ['50', '65', '75'][q]!];
  }
}

/** Layers from bottom to top: video tracks are stored top first, so walk them in reverse. */
function visualItems(seq: Sequence): TimelineItem[] {
  return seq.tracks
    .filter((t) => t.kind === 'video' && !t.hidden)
    .reverse()
    .flatMap((t) => t.items);
}

function audibleItems(seq: Sequence, assets: (id: string) => ExportAsset | undefined): TimelineItem[] {
  return seq.tracks
    .filter((t) => !t.muted)
    .flatMap((t) => t.items)
    .filter((i) => !i.muted && i.volume > 0 && assets(i.assetId)?.hasAudio);
}

/** Builds the FFmpeg command for exporting a sequence. */
export function planExport(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
  options: ExportOptions,
): ExportPlan {
  const total = flicksToSeconds(sequenceDuration(seq));
  if (total <= 0) throw new ExportPlanError('The timeline is empty. Add some clips before exporting.');
  const fps = `${seq.fps.num}/${seq.fps.den}`;
  const W = seq.width;
  const H = seq.height;

  const inputArgs: string[] = [];
  const graph: string[] = [];
  let inputIndex = 0;
  const need = (id: string) => assets(id) ?? (() => {
    throw new ExportPlanError('A clip on the timeline refers to media that is no longer in the project.');
  })();

  // One input per use, trimmed with an accurate input seek (-ss before -i).
  const addInput = (item: TimelineItem, asset: ExportAsset): number => {
    const dur = sec(flicksToSeconds(item.duration));
    if (asset.kind === 'image') inputArgs.push('-loop', '1', '-framerate', fps, '-t', dur, '-i', asset.path);
    else inputArgs.push('-ss', sec(flicksToSeconds(item.sourceIn)), '-t', dur, '-i', asset.path);
    return inputIndex++;
  };

  graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(total)},format=yuv420p[base]`);
  let last = 'base';
  visualItems(seq).forEach((item, n) => {
    const asset = need(item.assetId);
    if (asset.kind === 'audio') return;
    if (!asset.width || !asset.height) throw new ExportPlanError('Some media has no frame size; it may still be processing.');
    const k = addInput(item, asset);
    const { width, height, left, top } = computeLayout(asset.width, asset.height, W, H, item.transform);
    const start = sec(flicksToSeconds(item.start));
    const chain = [
      ...(asset.hdr && options.tonemap ? [TONEMAP] : []),
      `fps=${fps}`,
      `scale=${width}:${height}:flags=bicubic`,
      'setsar=1',
      'format=yuva420p',
      `setpts=PTS-STARTPTS+${start}/TB`,
    ];
    graph.push(`[${k}:v]${chain.join(',')}[v${n}]`);
    graph.push(`[${last}][v${n}]overlay=x=${left}:y=${top}:eof_action=pass:repeatlast=0[o${n}]`);
    last = `o${n}`;
  });
  graph.push(`[${last}]format=yuv420p[vout]`);

  // Audio: each clip delayed to its position, mixed without automatic level changes.
  const audioLabels: string[] = [];
  audibleItems(seq, assets).forEach((item, n) => {
    const asset = need(item.assetId);
    const k = addInput(item, asset);
    const delayMs = Math.round(flicksToSeconds(item.start) * 1000);
    graph.push(
      `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume=${item.volume.toFixed(3)},adelay=${delayMs}:all=1[a${n}]`,
    );
    audioLabels.push(`[a${n}]`);
  });
  const loud = options.loudnessLufs === undefined ? -14 : options.loudnessLufs;
  const finish = `apad=whole_dur=${sec(total)},atrim=0:${sec(total)}${loud === null ? '' : `,loudnorm=I=${loud}:TP=-1.5:LRA=11`},aresample=48000`;
  if (audioLabels.length) {
    graph.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,${finish}[aout]`);
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${sec(total)}[aout]`);
  }

  const outputArgs = [
    '-map', '[vout]',
    '-map', '[aout]',
    ...videoEncoderArgs(options.encoder, options.quality),
    '-pix_fmt', 'yuv420p',
    '-r', fps,
    '-c:a', 'aac',
    '-b:a', options.quality === 'draft' ? '128k' : '192k',
    '-ar', '48000',
    '-t', sec(total),
    '-movflags', '+faststart',
  ];
  return { inputArgs, filterGraph: graph.join(';\n'), outputArgs, durationSec: total };
}
