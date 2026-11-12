import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join, parse } from 'node:path';

const CHUNK = 4 * 1024 * 1024;

/**
 * Fast content fingerprint: SHA-256 of the size plus the first and last 4 MB. Used to spot
 * duplicate imports and to check that a relinked file is the same media (ARCHITECTURE §6.3).
 */
export async function contentHash(
  path: string,
): Promise<{ hash: string; size: number; mtimeMs: number }> {
  const info = await stat(path);
  const hash = createHash('sha256');
  hash.update(String(info.size));
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(CHUNK, info.size));
    await handle.read(head, 0, head.length, 0);
    hash.update(head);
    if (info.size > CHUNK) {
      const tailLength = Math.min(CHUNK, info.size - CHUNK);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, info.size - tailLength);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }
  return { hash: hash.digest('hex'), size: info.size, mtimeMs: Math.round(info.mtimeMs) };
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** Makes a string safe as a file name on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  let cleaned = name
    .replace(/[<>:"/\\|?*]/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned) cleaned = 'Untitled';
  if (RESERVED.test(cleaned)) cleaned = `${cleaned}_`;
  return cleaned.slice(0, 100);
}

/** Returns `dir/name.ext`, or `dir/name (2).ext` etc. if taken. */
export function uniquePath(dir: string, name: string, ext: string): string {
  const base = safeFileName(name);
  let candidate = join(dir, `${base}${ext}`);
  for (let i = 2; existsSync(candidate); i++) candidate = join(dir, `${base} (${i})${ext}`);
  return candidate;
}

export function displayName(path: string): string {
  return parse(path).base;
}
