import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runTool } from './run';
import {
  licenceFromConfiguration,
  parseEncoders,
  parseHwaccels,
  parseVersion,
  type Licence,
} from './parse';

/** Encoders Rec-It cares about, reported in the status panel. */
export const ENCODERS_OF_INTEREST = [
  'libx264',
  'h264_nvenc',
  'hevc_nvenc',
  'av1_nvenc',
  'h264_qsv',
  'h264_amf',
  'h264_videotoolbox',
  'libopenh264',
  'aac',
] as const;

export interface FfmpegBinaries {
  ffmpeg: string;
  ffprobe: string;
  source: 'env' | 'bundled' | 'path';
}

export interface ResolveOptions {
  /** Explicit path to ffmpeg from RECIT_FFMPEG_PATH; ffprobe is expected next to it. */
  envPath?: string | undefined;
  /** Folder that holds bundled binaries, e.g. resources/ffmpeg/win32-x64. */
  bundledDir?: string | undefined;
  platform?: NodeJS.Platform;
}

/** Picks binaries in priority order: env override → bundled build → system PATH. */
export function resolveFfmpegBinaries(options: ResolveOptions = {}): FfmpegBinaries {
  const exe = (options.platform ?? process.platform) === 'win32' ? '.exe' : '';
  if (options.envPath) {
    const dir = options.envPath.replace(/[\\/][^\\/]*$/, '');
    return { ffmpeg: options.envPath, ffprobe: join(dir, `ffprobe${exe}`), source: 'env' };
  }
  if (options.bundledDir) {
    const ffmpeg = join(options.bundledDir, `ffmpeg${exe}`);
    const ffprobe = join(options.bundledDir, `ffprobe${exe}`);
    if (existsSync(ffmpeg) && existsSync(ffprobe)) return { ffmpeg, ffprobe, source: 'bundled' };
  }
  return { ffmpeg: `ffmpeg${exe}`, ffprobe: `ffprobe${exe}`, source: 'path' };
}

export interface FfmpegDetection {
  state: 'ok' | 'missing' | 'error';
  path?: string;
  source?: FfmpegBinaries['source'];
  version?: string;
  licence?: Licence;
  encoders: Record<string, boolean>;
  hwaccels: string[];
  nvencUsable: boolean | null;
  hasLibass: boolean;
  /** zimg provides the zscale filter used to tone-map HDR proxies. */
  hasZimg: boolean;
  message?: string;
}

/**
 * Checks that ffmpeg and ffprobe run, reads their capabilities, and — if NVENC is
 * compiled in — does a real one-frame test encode, because a listed encoder can still
 * fail without a supported NVIDIA GPU and driver.
 */
export async function detectFfmpeg(binaries: FfmpegBinaries): Promise<FfmpegDetection> {
  const base = {
    encoders: {},
    hwaccels: [],
    nvencUsable: null,
    hasLibass: false,
    hasZimg: false,
    source: binaries.source,
  };
  let versionOut: string;
  try {
    const result = await runTool(binaries.ffmpeg, ['-hide_banner', '-version']);
    versionOut = result.stdout;
  } catch {
    return {
      ...base,
      state: 'missing',
      message: 'FFmpeg was not found. Run "pnpm fetch-ffmpeg" or set RECIT_FFMPEG_PATH.',
    };
  }
  const info = parseVersion(versionOut);
  if (!info)
    return {
      ...base,
      state: 'error',
      path: binaries.ffmpeg,
      message: 'Could not read the FFmpeg version.',
    };

  try {
    await runTool(binaries.ffprobe, ['-hide_banner', '-version']);
  } catch {
    return {
      ...base,
      state: 'error',
      path: binaries.ffmpeg,
      version: info.version,
      message: 'ffprobe was not found next to ffmpeg.',
    };
  }

  const [encodersOut, hwOut] = await Promise.all([
    runTool(binaries.ffmpeg, ['-hide_banner', '-encoders']),
    runTool(binaries.ffmpeg, ['-hide_banner', '-hwaccels']),
  ]);
  const available = parseEncoders(encodersOut.stdout);
  const encoders = Object.fromEntries(ENCODERS_OF_INTEREST.map((e) => [e, available.has(e)]));
  const nvencUsable = available.has('h264_nvenc')
    ? await testEncode(binaries.ffmpeg, 'h264_nvenc')
    : null;
  const licence = licenceFromConfiguration(info.configuration);

  const warnings: string[] = [];
  if (licence !== 'gpl')
    warnings.push('This FFmpeg build is not GPL, so libx264 is unavailable (ADR-007).');
  if (!info.configuration.includes('--enable-libass'))
    warnings.push('libass is missing; captions cannot be rendered.');

  return {
    state: 'ok',
    path: binaries.ffmpeg,
    source: binaries.source,
    version: info.version,
    licence,
    encoders,
    hwaccels: parseHwaccels(hwOut.stdout),
    nvencUsable,
    hasLibass: info.configuration.includes('--enable-libass'),
    hasZimg: info.configuration.includes('--enable-libzimg'),
    ...(warnings.length ? { message: warnings.join(' ') } : {}),
  };
}

/** Encodes one black frame to the null muxer. Returns true if the encoder works on this machine. */
export async function testEncode(ffmpeg: string, encoder: string): Promise<boolean> {
  try {
    const result = await runTool(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:d=0.1',
        '-frames:v',
        '1',
        '-c:v',
        encoder,
        '-f',
        'null',
        '-',
      ],
      { timeoutMs: 20_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}
