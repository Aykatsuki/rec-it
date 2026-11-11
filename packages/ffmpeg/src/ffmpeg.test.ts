import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { detectFfmpeg, resolveFfmpegBinaries } from './detect';
import { licenceFromConfiguration, parseEncoders, parseHwaccels, parseVersion } from './parse';

const VERSION = `ffmpeg version n7.1.1-12-gabc Copyright (c) 2000-2025 the FFmpeg developers
built with gcc 14.2.0 (crosstool-NG 1.27.0.18_7458341)
configuration: --prefix=/ffbuild/prefix --enable-gpl --enable-version3 --enable-libass --enable-libx264 --enable-nvenc
libavutil      59. 39.100 / 59. 39.100`;

const ENCODERS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)
 V....D hevc_nvenc           NVIDIA NVENC hevc encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
 S..... ass                  ASS (Advanced SubStation Alpha) subtitle`;

describe('ffmpeg output parsing', () => {
  it('reads version and configure flags', () => {
    const info = parseVersion(VERSION);
    expect(info?.version).toBe('n7.1.1-12-gabc');
    expect(info?.configuration).toContain('--enable-libx264');
  });

  it('derives licence from configure flags', () => {
    expect(licenceFromConfiguration(['--enable-gpl'])).toBe('gpl');
    expect(licenceFromConfiguration(['--enable-gpl', '--enable-nonfree'])).toBe('nonfree');
    expect(licenceFromConfiguration(['--prefix=/x'])).toBe('lgpl');
    expect(licenceFromConfiguration([])).toBe('unknown');
  });

  it('lists encoders, ignoring the legend', () => {
    const encoders = parseEncoders(ENCODERS);
    expect([...encoders]).toEqual(['libx264', 'h264_nvenc', 'hevc_nvenc', 'aac', 'ass']);
    expect(encoders.has('=')).toBe(false);
  });

  it('lists hardware accelerators, including Windows line endings', () => {
    expect(parseHwaccels('Hardware acceleration methods:\r\ncuda\r\nd3d11va\r\n\r\n')).toEqual([
      'cuda',
      'd3d11va',
    ]);
  });

  it('resolves binaries in priority order', () => {
    expect(
      resolveFfmpegBinaries({ envPath: 'C:/tools/ffmpeg.exe', platform: 'win32' }),
    ).toMatchObject({
      source: 'env',
      ffprobe: expect.stringMatching(/ffprobe\.exe$/),
    });
    expect(resolveFfmpegBinaries({ bundledDir: '/does/not/exist', platform: 'linux' })).toEqual({
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      source: 'path',
    });
  });
});

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('ffmpeg detection (integration, needs ffmpeg on PATH)', () => {
  it('detects a working installation', async () => {
    const result = await detectFfmpeg(resolveFfmpegBinaries({}));
    expect(result.state).toBe('ok');
    expect(result.version).toBeTruthy();
    expect(result.encoders.aac).toBe(true);
  });
});

describe('ffmpeg detection without ffmpeg', () => {
  it('reports missing binaries clearly', async () => {
    const result = await detectFfmpeg({
      ffmpeg: '/nonexistent/ffmpeg',
      ffprobe: '/nonexistent/ffprobe',
      source: 'env',
    });
    expect(result.state).toBe('missing');
    expect(result.message).toMatch(/fetch-ffmpeg/);
  });
});
