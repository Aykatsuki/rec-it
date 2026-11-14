// Sequence → FFmpeg export command (ARCHITECTURE §10). Pure: no I/O, so it is unit-tested,
// and the integration tests render real files from it.
import {
  combinedColor,
  presentSequence,
  secondsToFlicks,
  itemEnd,
  computeLayout,
  cropRect,
  flicksToSeconds,
  hasKeyframes,
  type Keyframe,
  type Transform,
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
  /** Media length (as probed); transitions use the media around a clip (ADR-037). */
  durationSec?: number;
}

export type VideoCodec = 'h264' | 'hevc';
export type ExportEncoder =
  | 'h264_nvenc'
  | 'libx264'
  | 'h264_qsv'
  | 'h264_amf'
  | 'h264_videotoolbox'
  | 'hevc_nvenc'
  | 'libx265'
  | 'hevc_qsv'
  | 'hevc_amf'
  | 'hevc_videotoolbox';
export type ExportQuality = 'draft' | 'standard' | 'high';

/** Encoders per codec, in the order Rec-It prefers them (GPU first, software last). */
export const ENCODERS: Record<VideoCodec, { gpu: ExportEncoder[]; cpu: ExportEncoder }> = {
  h264: { gpu: ['h264_nvenc', 'h264_videotoolbox', 'h264_qsv', 'h264_amf'], cpu: 'libx264' },
  hevc: { gpu: ['hevc_nvenc', 'hevc_videotoolbox', 'hevc_qsv', 'hevc_amf'], cpu: 'libx265' },
};

export const codecOf = (encoder: ExportEncoder): VideoCodec =>
  encoder.startsWith('h264') || encoder === 'libx264' ? 'h264' : 'hevc';
export const isSoftwareEncoder = (encoder: ExportEncoder) =>
  encoder === 'libx264' || encoder === 'libx265';

/** Result of FFmpeg's loudnorm analysis pass (print_format=json). */
export interface LoudnessMeasurement {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

export interface ExportOptions {
  encoder: ExportEncoder;
  quality: ExportQuality;
  /** Tone-map HDR sources to SDR (needs zimg). */
  tonemap: boolean;
  /** Output size as a fraction of the sequence size (1 = full size). Sizes are rounded to even. */
  scale?: number;
  /** AAC bitrate in kbit/s. */
  audioBitrateK?: number;
  /**
   * Loudness normalisation. With `measured` (from planLoudnessAnalysis) the second pass applies a
   * single, linear gain; without it FFmpeg normalises dynamically in one pass. null disables it.
   * Default: one pass to −14 LUFS.
   */
  loudness?: { target: number; measured?: LoudnessMeasurement } | null;
  /** Written into the file's title tag. */
  title?: string;
  /**
   * Burned-in captions: an ASS file and the fonts folder, as plain relative names (run FFmpeg
   * with the folder holding them as its working directory). ADR-032.
   */
  captions?: { file: string; fontsDir: string } | null;
}

export interface ExportPlan {
  /** Arguments for FFmpeg, excluding the output path (append `-f mp4 <path>`). */
  inputArgs: string[];
  /** filter_complex graph; pass with `-/filter_complex <file>` to avoid command-line limits. */
  filterGraph: string;
  outputArgs: string[];
  durationSec: number;
  width: number;
  height: number;
}

export class ExportPlanError extends Error {
  override name = 'ExportPlanError';
}

const TONEMAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

const sec = (n: number) => n.toFixed(6).replace(/\.?0+$/, '') || '0';
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Peak loudness ceiling (dBTP) and loudness range used for every export. */
const TRUE_PEAK = -1.5;
const LRA = 11;

function videoEncoderArgs(encoder: ExportEncoder, quality: ExportQuality): string[] {
  const q = { draft: 0, standard: 1, high: 2 }[quality];
  const pick = (values: string[]) => values[q]!;
  switch (encoder) {
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return [
        '-c:v',
        encoder,
        '-preset',
        pick(['p2', 'p5', 'p7']),
        '-tune',
        'hq',
        '-rc',
        'vbr',
        '-cq',
        encoder === 'h264_nvenc' ? pick(['28', '20', '17']) : pick(['30', '23', '20']),
        '-b:v',
        '0',
        '-maxrate',
        encoder === 'h264_nvenc' ? pick(['8M', '20M', '35M']) : pick(['6M', '15M', '25M']),
        '-bufsize',
        '40M',
        '-profile:v',
        encoder === 'h264_nvenc' ? 'high' : 'main',
        '-spatial-aq',
        '1',
      ];
    case 'libx264':
      return [
        '-c:v',
        'libx264',
        '-preset',
        pick(['veryfast', 'medium', 'slow']),
        '-crf',
        pick(['26', '19', '16']),
        '-profile:v',
        'high',
      ];
    case 'libx265':
      return [
        '-c:v',
        'libx265',
        '-preset',
        pick(['veryfast', 'medium', 'slow']),
        '-crf',
        pick(['28', '22', '19']),
        '-profile:v',
        'main',
        '-x265-params',
        'log-level=error',
      ];
    case 'h264_qsv':
    case 'hevc_qsv':
      return [
        '-c:v',
        encoder,
        '-preset',
        pick(['veryfast', 'medium', 'slow']),
        '-global_quality',
        pick(['28', '21', '18']),
      ];
    case 'h264_amf':
    case 'hevc_amf':
      return [
        '-c:v',
        encoder,
        '-quality',
        pick(['speed', 'balanced', 'quality']),
        '-rc',
        'cqp',
        '-qp_i',
        pick(['28', '20', '17']),
        '-qp_p',
        pick(['30', '22', '19']),
      ];
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      return ['-c:v', encoder, '-q:v', pick(['50', '65', '75'])];
  }
}

/**
 * Output settings that make files play everywhere (QuickTime, Windows, VLC, phones) and follow
 * YouTube's upload recommendations: 4:2:0, BT.709 tags, closed GOP of half the frame rate,
 * two B-frames, `hvc1` tag for HEVC, AAC-LC 48 kHz stereo, moov atom at the front.
 */
function playerSafeArgs(encoder: ExportEncoder, fps: { num: number; den: number }): string[] {
  const gop = Math.max(1, Math.round(fps.num / fps.den / 2));
  const args = [
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-g',
    String(gop),
  ];
  if (!encoder.endsWith('videotoolbox')) args.push('-bf', '2');
  if (codecOf(encoder) === 'hevc') args.push('-tag:v', 'hvc1');
  return args;
}

/** Layers from bottom to top: video tracks are stored top first, so walk them in reverse. */
function visualItems(seq: Sequence): TimelineItem[] {
  return seq.tracks
    .filter((t) => t.kind === 'video' && !t.hidden)
    .reverse()
    .flatMap((t) => t.items);
}

function audibleItems(
  seq: Sequence,
  assets: (id: string) => ExportAsset | undefined,
): TimelineItem[] {
  return seq.tracks
    .filter((t) => !t.muted)
    .flatMap((t) => t.items)
    .filter(
      (i) => !i.muted && (i.volume > 0 || hasKeyframes(i, 'volume')) && assets(i.assetId)?.hasAudio,
    );
}

const num = (n: number) => (Math.abs(n) < 1e-9 ? '0' : n.toFixed(6).replace(/\.?0+$/, ''));

/**
 * FFmpeg expression for a keyframed value as a function of source time `T` (an expression in
 * seconds). Mirrors valueAt() in @rec-it/core: hold before the first and after the last key.
 */
export function keyframeExpr(keys: readonly Keyframe[], T: string): string {
  const k = keys.map((key) => ({ t: flicksToSeconds(key.t), v: key.v, e: key.e }));
  let expr = num(k.at(-1)!.v);
  for (let i = k.length - 2; i >= 0; i--) {
    const a = k[i]!;
    const b = k[i + 1]!;
    const p = `((${T}-${num(a.t)})/${num(b.t - a.t)})`;
    const eased = a.e === 'hold' ? '0' : a.e === 'ease' ? `(${p}*${p}*(3-2*${p}))` : p;
    const seg = a.e === 'hold' ? num(a.v) : `(${num(a.v)}+${num(b.v - a.v)}*${eased})`;
    expr = `if(lt(${T},${num(b.t)}),${seg},${expr})`;
  }
  return `if(lt(${T},${num(k[0]!.t)}),${num(k[0]!.v)},${expr})`;
}

/** A transform property as an expression: its keyframes, or its constant value. */
function propExpr(item: TimelineItem, p: 'x' | 'y' | 'scale' | 'rotation', T: string): string {
  const keys = item.keyframes?.[p];
  return keys?.length ? keyframeExpr(keys, T) : num(item.transform[p]);
}

/** Largest picture size Rec-It renders an animated layer at (memory and speed). */
const MAX_LAYER = 4096;
/** Largest transparent canvas for an animated layer. */
const MAX_CANVAS = 8192;

/**
 * Filters for a layer whose position, size or rotation is keyframed. Frame sizes cannot change
 * inside an FFmpeg graph, so the picture is scaled once (to its largest size), placed in the
 * middle of a transparent canvas big enough for every size and angle it takes, and moved per
 * frame with `perspective` (an affine map is a special case). The overlay then places the
 * canvas centre where the clip's centre is.
 */
function animatedLayer(
  item: TimelineItem,
  asset: { width: number; height: number },
  W: number,
  H: number,
  fpsValue: number,
): { filters: string[]; overlayX: string; overlayY: string } {
  const t: Transform = item.transform;
  const base =
    t.fit === 'fill'
      ? Math.max(W / asset.width, H / asset.height)
      : Math.min(W / asset.width, H / asset.height);
  const scales = item.keyframes?.scale?.length ? item.keyframes.scale.map((k) => k.v) : [t.scale];
  const sMax = Math.max(...scales, 0.05);
  const fit = Math.min(1, MAX_LAYER / (Math.max(asset.width, asset.height) * base * sMax));
  const sUse = sMax * fit;
  const wB = even(asset.width * base * sUse);
  const hB = even(asset.height * base * sUse);
  const rotates = !!item.keyframes?.rotation?.length || Math.abs(t.rotation) > 1e-9;
  const wMax = asset.width * base * sMax;
  const hMax = asset.height * base * sMax;
  const Dw = Math.min(MAX_CANVAS, even((rotates ? Math.hypot(wMax, hMax) : wMax) + 6));
  const Dh = Math.min(MAX_CANVAS, even((rotates ? Math.hypot(wMax, hMax) : hMax) + 6));

  // Source time for perspective (frame counter) and for overlay (timeline time t).
  const srcIn = flicksToSeconds(item.sourceIn);
  const start = flicksToSeconds(item.start);
  const Tp = `(${num(srcIn)}+in/${num(fpsValue)})`;
  const To = `(t-${num(start)}+${num(srcIn)})`;
  const k = `(${propExpr(item, 'scale', Tp)}/${num(sUse)})`;
  const r = `(${propExpr(item, 'rotation', Tp)}*PI/180)`;
  const corner = (px: number, py: number) => [
    `${num(Dw / 2)}+${k}*(${num(px)}*cos(${r})-${num(py)}*sin(${r}))`,
    `${num(Dh / 2)}+${k}*(${num(px)}*sin(${r})+${num(py)}*cos(${r}))`,
  ];
  const [x0, y0] = corner(-Dw / 2, -Dh / 2);
  const [x1, y1] = corner(Dw / 2, -Dh / 2);
  const [x2, y2] = corner(-Dw / 2, Dh / 2);
  const [x3, y3] = corner(Dw / 2, Dh / 2);
  return {
    filters: [
      `scale=${wB}:${hB}:flags=bicubic:out_color_matrix=bt709:out_range=tv`,
      'setsar=1',
      'format=yuva420p',
      `pad=${Dw}:${Dh}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      `perspective=x0='${x0}':y0='${y0}':x1='${x1}':y1='${y1}':x2='${x2}':y2='${y2}':x3='${x3}':y3='${y3}':sense=destination:eval=frame:interpolation=linear`,
    ],
    overlayX: `'W/2+(${propExpr(item, 'x', To)})*W-w/2'`,
    overlayY: `'H/2+(${propExpr(item, 'y', To)})*H-h/2'`,
  };
}

/** Static volume, or a per-frame expression of source time when volume is keyframed. */
function volumeFilter(item: TimelineItem): string {
  const keys = item.keyframes?.volume;
  if (!keys?.length) return `volume=${item.volume.toFixed(3)}`;
  // After an input seek, audio timestamps start at 0 at the clip's first sample.
  const T = `(t+${num(flicksToSeconds(item.sourceIn))})`;
  return `volume=volume='${keyframeExpr(keys, T)}':eval=frame`;
}

interface GraphParts {
  inputArgs: string[];
  graph: string[];
  total: number;
  width: number;
  height: number;
}

/** Colour effects as one `eq` (ADR-036): the stack combines exactly like chained eq filters. */
function colorFilter(item: TimelineItem): string[] {
  const c = combinedColor(item);
  if (!c) return [];
  return [
    `eq=brightness=${num(c.brightness)}:contrast=${num(c.contrast)}:saturation=${num(c.saturation)}`,
  ];
}

/** Static opacity scales the layer's alpha (the layer is yuva420p by then). */
function opacityFilter(item: TimelineItem): string[] {
  const o = item.opacity ?? 1;
  return o >= 1 ? [] : [`lutyuv=a=val*${num(o)}`];
}

/**
 * Picture fades on the alpha channel, and dips to a colour (ADR-037) on the picture itself, in
 * timeline time (after setpts).
 */
function fadeFilters(item: TimelineItem): string[] {
  const start = flicksToSeconds(item.start);
  const end = flicksToSeconds(itemEnd(item));
  const out: string[] = [];
  const t = item.tint;
  if (t) {
    // FFmpeg's fade takes pure black to mean code 0 on pictures with alpha (darker than video
    // black, 16); any other colour is converted properly, so black is given as 0x000001.
    const color = t.color === 'white' ? 'white' : '0x000001';
    if (t.in > 0)
      out.push(`fade=t=in:st=${num(start)}:d=${num(flicksToSeconds(t.in))}:color=${color}`);
    if (t.out > 0) {
      const d = flicksToSeconds(t.out);
      out.push(`fade=t=out:st=${num(end - d)}:d=${num(d)}:color=${color}`);
    }
  }
  const f = item.fade;
  if (!f) return out;
  if (f.in > 0) out.push(`fade=t=in:st=${num(start)}:d=${num(flicksToSeconds(f.in))}:alpha=1`);
  if (f.out > 0) {
    const d = flicksToSeconds(f.out);
    out.push(`fade=t=out:st=${num(end - d)}:d=${num(d)}:alpha=1`);
  }
  return out;
}

/** Sound fades, in the clip's own time (its audio starts at 0 after the input seek). */
function audioFades(item: TimelineItem): string {
  const dur = flicksToSeconds(item.duration);
  let out = '';
  // The clip's fades, then the sound-only fades of transitions (ADR-037): gains multiply.
  for (const f of [item.fade, item.audioFade]) {
    if (!f) continue;
    if (f.in > 0) out += `afade=t=in:st=0:d=${num(flicksToSeconds(f.in))},`;
    if (f.out > 0) {
      const d = flicksToSeconds(f.out);
      out += `afade=t=out:st=${num(dur - d)}:d=${num(d)},`;
    }
  }
  return out;
}

/** Cuts the kept part out of the source (crop, ADR-034); nothing when the whole picture is used. */
function cropFilter(
  asset: { width?: number | undefined; height?: number | undefined },
  r: { x: number; y: number; w: number; h: number },
): string[] {
  if (r.x === 0 && r.y === 0 && r.w === asset.width && r.h === asset.height) return [];
  return [`crop=${r.w}:${r.h}:${r.x}:${r.y}:exact=1`];
}

/** The libass filter for burned-in captions (drawn on the finished, BT.709-tagged frame). */
function captionsFilter(captions: ExportOptions['captions']): string {
  if (!captions) return '';
  const safe = /^[A-Za-z0-9_.\-/]+$/;
  if (!safe.test(captions.file) || !safe.test(captions.fontsDir))
    throw new ExportPlanError('Caption files must have plain relative names.');
  return `,ass=filename=${captions.file}:fontsdir=${captions.fontsDir}:shaping=complex`;
}

function buildGraph(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
  options: Pick<ExportOptions, 'scale' | 'tonemap' | 'captions'>,
  /** Filters after the audio mix; null leaves audio out of the graph. */
  audioFinish: string | null,
  withVideo: boolean,
): GraphParts {
  // What is drawn and heard: transitions become overlapping, faded clips (ADR-037).
  seq = presentSequence(seq, (id) => {
    const a = assets(id);
    if (!a) return undefined;
    if (a.kind === 'image') return null;
    return a.durationSec === undefined ? undefined : secondsToFlicks(a.durationSec);
  });
  const total = flicksToSeconds(sequenceDuration(seq));
  if (total <= 0)
    throw new ExportPlanError('The timeline is empty. Add some clips before exporting.');
  const fps = `${seq.fps.num}/${seq.fps.den}`;
  const scale = Math.min(1, Math.max(0.1, options.scale ?? 1));
  const W = even(seq.width * scale);
  const H = even(seq.height * scale);

  const inputArgs: string[] = [];
  const graph: string[] = [];
  let inputIndex = 0;
  const need = (id: string) =>
    assets(id) ??
    (() => {
      throw new ExportPlanError(
        'A clip on the timeline refers to media that is no longer in the project.',
      );
    })();

  // One input per use, trimmed with an accurate input seek (-ss before -i).
  const addInput = (item: TimelineItem, asset: ExportAsset): number => {
    const dur = sec(flicksToSeconds(item.duration));
    if (asset.kind === 'image')
      inputArgs.push('-loop', '1', '-framerate', fps, '-t', dur, '-i', asset.path);
    else inputArgs.push('-ss', sec(flicksToSeconds(item.sourceIn)), '-t', dur, '-i', asset.path);
    return inputIndex++;
  };

  if (withVideo) {
    graph.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${sec(total)},format=yuv420p[base]`);
    let last = 'base';
    visualItems(seq).forEach((item, n) => {
      const asset = need(item.assetId);
      if (asset.kind === 'audio') return;
      if (!asset.width || !asset.height)
        throw new ExportPlanError('Some media has no frame size; it may still be processing.');
      const k = addInput(item, asset);
      const start = sec(flicksToSeconds(item.start));
      if (
        hasKeyframes(item, 'x') ||
        hasKeyframes(item, 'y') ||
        hasKeyframes(item, 'scale') ||
        hasKeyframes(item, 'rotation')
      ) {
        const kept = cropRect(asset.width, asset.height, item.transform.crop);
        const a = animatedLayer(
          item,
          { width: kept.w, height: kept.h },
          W,
          H,
          seq.fps.num / seq.fps.den,
        );
        const chain = [
          ...(asset.hdr && options.tonemap ? [TONEMAP] : []),
          `fps=${fps}`,
          ...cropFilter(asset, kept),
          ...colorFilter(item),
          ...a.filters,
          ...opacityFilter(item),
          `setpts=PTS-STARTPTS+${start}/TB`,
          ...fadeFilters(item),
        ];
        graph.push(`[${k}:v]${chain.join(',')}[v${n}]`);
        graph.push(
          `[${last}][v${n}]overlay=x=${a.overlayX}:y=${a.overlayY}:eval=frame:eof_action=pass:repeatlast=0[o${n}]`,
        );
        last = `o${n}`;
        return;
      }
      const { width, height, rotation, bounds, source } = computeLayout(
        asset.width,
        asset.height,
        W,
        H,
        item.transform,
      );
      const chain = [
        ...(asset.hdr && options.tonemap ? [TONEMAP] : []),
        `fps=${fps}`,
        ...cropFilter(asset, source),
        // Converting to BT.709 here keeps colours the same as the preview for every source.
        `scale=${width}:${height}:flags=bicubic:out_color_matrix=bt709:out_range=tv`,
        'setsar=1',
        ...colorFilter(item),
        'format=yuva420p',
        ...opacityFilter(item),
        ...(rotation
          ? [
              `rotate=a=${((rotation * Math.PI) / 180).toFixed(6)}:ow=${bounds.width}:oh=${bounds.height}:c=none:bilinear=1`,
            ]
          : []),
        `setpts=PTS-STARTPTS+${start}/TB`,
        ...fadeFilters(item),
      ];
      graph.push(`[${k}:v]${chain.join(',')}[v${n}]`);
      graph.push(
        `[${last}][v${n}]overlay=x=${bounds.left}:y=${bounds.top}:eof_action=pass:repeatlast=0[o${n}]`,
      );
      last = `o${n}`;
    });
    graph.push(
      `[${last}]format=yuv420p,setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709${captionsFilter(options.captions)}[vout]`,
    );
  }

  if (audioFinish === null) return { inputArgs, graph, total, width: W, height: H };

  // Audio: each clip delayed to its position, mixed without automatic level changes.
  const audioLabels: string[] = [];
  audibleItems(seq, assets).forEach((item, n) => {
    const asset = need(item.assetId);
    const k = addInput(item, asset);
    const delayMs = Math.round(flicksToSeconds(item.start) * 1000);
    graph.push(
      `[${k}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `${volumeFilter(item)},${audioFades(item)}adelay=${delayMs}:all=1[a${n}]`,
    );
    audioLabels.push(`[a${n}]`);
  });
  const pad = `apad=whole_dur=${sec(total)},atrim=0:${sec(total)}`;
  if (audioLabels.length) {
    graph.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,${pad}${audioFinish ? `,${audioFinish}` : ''}[aout]`,
    );
  } else {
    graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${sec(total)}[aout]`);
  }
  return { inputArgs, graph, total, width: W, height: H };
}

/** True when the sequence has any sound that would be exported. */
export function hasAudibleContent(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
): boolean {
  return audibleItems(seq, assets).length > 0;
}

/**
 * First pass of two-pass loudness normalisation: mixes the audio exactly as the export will and
 * measures it. Run with `-f null -` and read the JSON block from stderr with parseLoudnorm().
 */
export function planLoudnessAnalysis(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
  target: number,
): ExportPlan {
  const g = buildGraph(
    seq,
    assets,
    { tonemap: false },
    `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=${LRA}:print_format=json`,
    false,
  );
  return {
    inputArgs: g.inputArgs,
    filterGraph: g.graph.join(';\n'),
    outputArgs: ['-map', '[aout]', '-vn'],
    durationSec: g.total,
    width: g.width,
    height: g.height,
  };
}

/** Reads loudnorm's JSON report from FFmpeg's stderr. Returns null for silence or bad output. */
export function parseLoudnorm(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const m: LoudnessMeasurement = {
      input_i: Number(raw.input_i),
      input_tp: Number(raw.input_tp),
      input_lra: Number(raw.input_lra),
      input_thresh: Number(raw.input_thresh),
      target_offset: Number(raw.target_offset),
    };
    // Silence measures as -inf; there is nothing to normalise.
    if (!Object.values(m).every(Number.isFinite) || m.input_i < -70) return null;
    return m;
  } catch {
    return null;
  }
}

function loudnessFilter(loudness: ExportOptions['loudness']): string {
  if (loudness === null) return '';
  const target = loudness?.target ?? -14;
  const base = `loudnorm=I=${target}:TP=${TRUE_PEAK}:LRA=${LRA}`;
  const m = loudness?.measured;
  const tail = m
    ? `:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}` +
      `:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`
    : '';
  // loudnorm works at 192 kHz internally; bring it back to 48 kHz.
  return `${base}${tail},aresample=48000`;
}

/** Builds the FFmpeg command for exporting a sequence. */
export function planExport(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
  options: ExportOptions,
): ExportPlan {
  const g = buildGraph(seq, assets, options, loudnessFilter(options.loudness), true);
  const fps = `${seq.fps.num}/${seq.fps.den}`;
  const outputArgs = [
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    ...videoEncoderArgs(options.encoder, options.quality),
    ...playerSafeArgs(options.encoder, seq.fps),
    '-r',
    fps,
    '-c:a',
    'aac',
    '-b:a',
    `${options.audioBitrateK ?? (options.quality === 'draft' ? 128 : 192)}k`,
    '-ar',
    '48000',
    '-ac',
    '2',
    '-t',
    sec(g.total),
    ...(options.title ? ['-metadata', `title=${options.title}`] : []),
    '-movflags',
    '+faststart',
  ];
  return {
    inputArgs: g.inputArgs,
    filterGraph: g.graph.join(';\n'),
    outputArgs,
    durationSec: g.total,
    width: g.width,
    height: g.height,
  };
}

/**
 * One frame of the sequence as an image, rendered by the same graph as the export (so it matches
 * the exported video exactly). Append the output path (PNG or JPEG).
 */
export function planFrame(
  seq: Sequence,
  assets: (assetId: string) => ExportAsset | undefined,
  timeSec: number,
  options: Pick<ExportOptions, 'tonemap' | 'scale' | 'captions'>,
): ExportPlan {
  const g = buildGraph(seq, assets, options, null, true);
  const t = Math.min(Math.max(0, timeSec), Math.max(0, g.total - 0.001));
  return {
    inputArgs: g.inputArgs,
    filterGraph: g.graph.join(';\n'),
    outputArgs: ['-map', '[vout]', '-ss', sec(t), '-frames:v', '1', '-update', '1'],
    durationSec: g.total,
    width: g.width,
    height: g.height,
  };
}

/**
 * Chooses the encoder for an export. NVENC counts only when its test encode passed. Intel/AMD
 * encoders are compiled into most FFmpeg builds even on machines without that hardware, so
 * "auto" skips them; "gpu" tries them. Returns null when nothing suitable exists.
 */
export function pickExportEncoder(
  codec: VideoCodec,
  preference: 'auto' | 'gpu' | 'cpu',
  ffmpeg: { encoders: Record<string, boolean>; nvencUsable: boolean | null },
): ExportEncoder | null {
  const { gpu, cpu } = ENCODERS[codec];
  const usable = (e: ExportEncoder) =>
    e.endsWith('_nvenc')
      ? !!ffmpeg.nvencUsable && !!ffmpeg.encoders[e]
      : e.endsWith('_videotoolbox')
        ? !!ffmpeg.encoders[e]
        : preference === 'gpu' && !!ffmpeg.encoders[e];
  const hardware = gpu.find(usable) ?? null;
  const software = ffmpeg.encoders[cpu] ? cpu : null;
  if (preference === 'cpu') return software;
  return hardware ?? software;
}

/** Human name for an encoder, for the export dialog and status. */
export function encoderLabel(encoder: ExportEncoder): string {
  if (encoder.endsWith('_nvenc')) return 'NVIDIA NVENC';
  if (encoder.endsWith('_videotoolbox')) return 'Apple VideoToolbox';
  if (encoder.endsWith('_qsv')) return 'Intel Quick Sync';
  if (encoder.endsWith('_amf')) return 'AMD AMF';
  return encoder === 'libx265' ? 'x265 (software)' : 'x264 (software)';
}
