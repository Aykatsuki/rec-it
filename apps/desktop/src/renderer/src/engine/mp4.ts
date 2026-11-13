// Reading MP4 headers over range requests (shared by the video and audio sources).
import { createFile, MP4BoxBuffer, type ISOFile, type Movie } from 'mp4box';

/** Fetches part of a file served by recit-media:// (which supports HTTP ranges). */
export async function fetchRange(url: string, start: number, end: number): Promise<ArrayBuffer> {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end - 1}` } });
  if (!res.ok && res.status !== 206) throw new Error(`Could not read ${url} (${res.status})`);
  return res.arrayBuffer();
}

export interface Mp4Sample {
  /** Presentation time in seconds (edit list applied). */
  t: number;
  offset: number;
  size: number;
  key: boolean;
}

/** Reads the movie header with growing range requests until mp4box has it. */
export async function readMovie(url: string): Promise<{ file: ISOFile; movie: Movie }> {
  const file = createFile();
  let movie: Movie | null = null;
  let failure: string | null = null;
  file.onReady = (m) => (movie = m);
  file.onError = (_module, message) => (failure = message);
  let pos = 0;
  let chunk = 256 * 1024;
  for (let i = 0; i < 12 && !movie && !failure; i++) {
    const data = await fetchRange(url, pos, pos + chunk);
    if (!data.byteLength) break;
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, pos));
    // mp4box tells us where it wants to continue reading (skipping media data).
    pos = typeof next === 'number' && next > pos ? next : pos + data.byteLength;
    chunk *= 2;
  }
  if (!movie) throw new Error(failure ?? 'Could not read the preview file header.');
  return { file, movie };
}

/**
 * Samples of a track sorted by presentation time. An edit list can start presentation part-way
 * into the media (encoder delay, AAC priming); browsers and FFmpeg honour it, so we do too.
 */
export function trackSamples(file: ISOFile, trackId: number): Mp4Sample[] {
  const trak = file.getTrackById(trackId);
  const elst = (
    trak as unknown as { edts?: { elst?: { entries?: { media_time: number }[] } } }
  ).edts?.elst?.entries?.find((e) => e.media_time >= 0);
  const shift = elst ? elst.media_time / trak.mdia.mdhd.timescale : 0;
  return file
    .getTrackSamplesInfo(trackId)
    .map((s) => ({
      t: s.cts / s.timescale - shift,
      offset: s.offset,
      size: s.size,
      key: s.is_sync,
    }))
    .sort((a, b) => a.t - b.t);
}

/** Index of the last sample starting at or before `t` (binary search). */
export function sampleIndexAt(samples: Mp4Sample[], t: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  const target = t + 1e-4; // timestamps often round to just under their nominal time
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid]!.t <= target) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
