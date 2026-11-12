// Pure helpers for the recit-media:// protocol (no Electron imports, so they are unit-tested).
import { join } from 'node:path';

/** The only files the protocol will serve, with their content types. */
export const MEDIA_FILES: Readonly<Record<string, string>> = {
  'proxy.mp4': 'video/mp4',
  'proxy.m4a': 'audio/mp4',
  'still.jpg': 'image/jpeg',
  'poster.jpg': 'image/jpeg',
  'sprite.jpg': 'image/jpeg',
  'waveform.bin': 'application/octet-stream',
};

const ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Maps recit-media://asset/<projectId>/<assetId>/<file> to a file inside the cache root.
 * Ids are validated and file names come from an allow-list, so no other file can be reached.
 */
export function resolveMediaUrl(
  url: string,
  cacheRoot: string,
): { path: string; mime: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'recit-media:' || parsed.hostname !== 'asset') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return null;
  const [projectId, assetId, file] = parts as [string, string, string];
  if (!ID.test(projectId) || !ID.test(assetId)) return null;
  const mime = Object.hasOwn(MEDIA_FILES, file) ? MEDIA_FILES[file] : undefined;
  if (!mime) return null;
  return { path: join(cacheRoot, projectId, assetId, file), mime };
}

/**
 * Parses a single-range "bytes=start-end" header. Returns null for no/unsupported range
 * (serve the whole file) or 'unsatisfiable' when the range lies outside the file.
 */
export function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;
  const m = header.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a = '', b = ''] = m;
  if (a === '' && b === '') return null;
  let start: number;
  let end: number;
  if (a === '') {
    const suffix = Number(b);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
