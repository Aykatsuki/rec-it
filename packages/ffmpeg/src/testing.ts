// Test helpers: locate FFmpeg and generate small synthetic clips that mimic real-world problem
// footage (rotated phone HEVC, variable frame rate, HDR, ProRes, audio-only, stills, corrupt files).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveFfmpegBinaries, type FfmpegBinaries } from './detect';

const repoRoot = resolve(__dirname, '../../..');

/** Bundled build (pnpm fetch-ffmpeg) if present, else PATH; null when neither works. */
export function findTestFfmpeg(): FfmpegBinaries | null {
  const bins = resolveFfmpegBinaries({
    envPath: process.env.RECIT_FFMPEG_PATH,
    bundledDir: join(repoRoot, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`),
  });
  try {
    execFileSync(bins.ffmpeg, ['-version'], { stdio: 'ignore' });
    execFileSync(bins.ffprobe, ['-version'], { stdio: 'ignore' });
    return bins;
  } catch {
    return null;
  }
}

function hasEncoder(ffmpeg: string, name: string): boolean {
  const out = execFileSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' });
  return new RegExp(`\\s${name}\\s`).test(out);
}

export interface Fixtures {
  dir: string;
  h264: string;
  vfr: string;
  prores: string;
  audio: string;
  image: string;
  corrupt: string;
  long: string;
  /** Present only when the build has libx265. */
  hevcRotated?: string;
  hdr?: string;
}

/** Generates fixtures into a temp folder. Takes a few seconds. */
export function makeFixtures(ffmpeg: string, options: { longSeconds?: number } = {}): Fixtures {
  const dir = mkdtempSync(join(tmpdir(), 'recit-fixtures-'));
  const run = (...args: string[]) =>
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  const f = (name: string) => join(dir, name);

  run(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=1280x720:r=30:d=3',
    '-f',
    'lavfi',
    '-i',
    'sine=f=440:d=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    f('clip h264.mp4'),
  );
  run(
    '-f',
    'lavfi',
    '-i',
    "testsrc2=s=640x360:r=30:d=4,setpts='if(lt(N,30),PTS,PTS*2)'",
    '-fps_mode',
    'vfr',
    '-c:v',
    'libx264',
    f('vfr.mp4'),
  );
  run(
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=640x360:r=24000/1001:d=2',
    '-c:v',
    'prores_ks',
    '-profile:v',
    '2',
    f('prores.mov'),
  );
  run('-f', 'lavfi', '-i', 'sine=f=220:d=2', f('audio.wav'));
  run('-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', f('image.png'));
  run(
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=1920x1080:r=30:d=${options.longSeconds ?? 20}`,
    '-f',
    'lavfi',
    '-i',
    `sine=d=${options.longSeconds ?? 20}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-shortest',
    f('long.mp4'),
  );
  writeFileSync(f('corrupt.mp4'), Buffer.alloc(20_000, 7));

  const fixtures: Fixtures = {
    dir,
    h264: f('clip h264.mp4'),
    vfr: f('vfr.mp4'),
    prores: f('prores.mov'),
    audio: f('audio.wav'),
    image: f('image.png'),
    corrupt: f('corrupt.mp4'),
    long: f('long.mp4'),
  };
  if (hasEncoder(ffmpeg, 'libx265')) {
    run(
      '-i',
      fixtures.h264,
      '-c:v',
      'libx265',
      '-tag:v',
      'hvc1',
      '-x265-params',
      'log-level=none',
      '-c:a',
      'copy',
      f('hevc-tmp.mov'),
    );
    // Store the rotation as metadata, as phones do, instead of rotating pixels.
    run('-display_rotation', '90', '-i', f('hevc-tmp.mov'), '-c', 'copy', f('phone hevc.mov'));
    run(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=640x360:r=25:d=2',
      '-c:v',
      'libx265',
      '-x265-params',
      'log-level=none:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc',
      '-pix_fmt',
      'yuv420p10le',
      '-color_primaries',
      'bt2020',
      '-color_trc',
      'arib-std-b67',
      '-colorspace',
      'bt2020nc',
      f('hdr.mp4'),
    );
    fixtures.hevcRotated = f('phone hevc.mov');
    fixtures.hdr = f('hdr.mp4');
  }
  for (const path of Object.values(fixtures))
    if (typeof path === 'string' && path !== dir && !existsSync(path)) {
      throw new Error(`Fixture was not created: ${path}`);
    }
  return fixtures;
}
