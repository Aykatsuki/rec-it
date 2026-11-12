import { protocol } from 'electron';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { parseRange, resolveMediaUrl } from './media-paths';

export const MEDIA_SCHEME = 'recit-media';

/** Must run before app 'ready'. Lets <video> stream and seek recit-media:// URLs. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/**
 * Serves proxies, thumbnails and waveforms from the media cache (ARCHITECTURE §5) with
 * HTTP range support so video can seek. Originals are never served.
 */
export function handleMediaProtocol(getCacheRoot: () => string | null): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const root = getCacheRoot();
    const resolved = root ? resolveMediaUrl(request.url, root) : null;
    if (!resolved) return new Response('Not found', { status: 404 });
    let size: number;
    try {
      size = (await stat(resolved.path)).size;
    } catch {
      return new Response('Not found', { status: 404 });
    }
    const headers: Record<string, string> = {
      'Content-Type': resolved.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    };
    const range = parseRange(request.headers.get('range'), size);
    if (range === 'unsatisfiable') {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}` },
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? size - 1;
    const body =
      size === 0
        ? null
        : (Readable.toWeb(createReadStream(resolved.path, { start, end })) as ReadableStream);
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Length': String(size === 0 ? 0 : end - start + 1),
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
      },
    });
  });
}
