// Pure helpers for fetch-ffmpeg.mjs, kept separate so they can be unit-tested.

export const DEFAULT_SERIES = '8.1';
export const RELEASE_BASE = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest';

/** BtbN target names for the platforms Rec-It supports. */
const TARGETS = {
  'win32-x64': { target: 'win64', ext: 'zip', exe: '.exe' },
  'win32-arm64': { target: 'winarm64', ext: 'zip', exe: '.exe' },
  'linux-x64': { target: 'linux64', ext: 'tar.xz', exe: '' },
  'linux-arm64': { target: 'linuxarm64', ext: 'tar.xz', exe: '' },
};

/**
 * Returns the archive for a platform, e.g. ffmpeg-n8.1-latest-win64-gpl-8.1.zip,
 * or null when BtbN has no build for it (macOS).
 */
export function assetFor(platform, arch, series = DEFAULT_SERIES) {
  const t = TARGETS[`${platform}-${arch}`];
  if (!t) return null;
  if (!/^\d+\.\d+$/.test(series))
    throw new Error(`Invalid FFmpeg series "${series}" (expected e.g. 8.1)`);
  const folder = `ffmpeg-n${series}-latest-${t.target}-gpl-${series}`;
  return {
    folder,
    file: `${folder}.${t.ext}`,
    url: `${RELEASE_BASE}/${folder}.${t.ext}`,
    exe: t.exe,
  };
}

/** Parses a sha256sum-style file: "<hex>  <name>" per line. */
export function parseChecksums(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/i);
    if (m) map.set(m[2].trim(), m[1].toLowerCase());
  }
  return map;
}
