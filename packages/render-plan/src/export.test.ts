import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FRAME_RATES, History, emptyDocument, secondsToFlicks, type AssetInfo, type Command } from '@rec-it/core';
import { runFfmpeg } from '@rec-it/ffmpeg';
import { findTestFfmpeg } from '@rec-it/ffmpeg/testing';
import { ExportPlanError, planExport, type ExportAsset } from './index';

const s = secondsToFlicks;
const bins = findTestFfmpeg();

function emptySequence() {
  const h = new History(emptyDocument());
  h.execute({ type: 'sequence.create', id: 'seq', name: 'S', width: 360, height: 640, fps: FRAME_RATES.fps30 }, () => undefined);
  return h.doc.sequences[0]!;
}

describe('planExport', () => {
  it('refuses an empty timeline', () => {
    expect(() => planExport(emptySequence(), () => undefined, { encoder: 'libx264', quality: 'standard', tonemap: false })).toThrow(
      ExportPlanError,
    );
  });
});

describe.skipIf(!bins)('export renders correct frames (real FFmpeg)', () => {
  let dir: string;
  const files: Record<string, string> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recit-export-'));
    const run = (...args: string[]) => execFileSync(bins!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    files.red = join(dir, 'red.mp4');
    files.blue = join(dir, 'blue.mp4');
    files.green = join(dir, 'green.png');
    files.tone = join(dir, 'tone.wav');
    run('-f', 'lavfi', '-i', 'color=red:s=640x360:r=30:d=3', '-f', 'lavfi', '-i', 'sine=f=300:d=3', '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', files.red);
    run('-f', 'lavfi', '-i', 'color=blue:s=640x360:r=25:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', files.blue);
    run('-f', 'lavfi', '-i', 'color=0x00ff00:s=200x200', '-frames:v', '1', files.green);
    run('-f', 'lavfi', '-i', 'sine=f=500:d=5', files.tone);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const info: Record<string, AssetInfo> = {
    red: { kind: 'video', duration: s(3), hasAudio: true, width: 640, height: 360 },
    blue: { kind: 'video', duration: s(3), hasAudio: false, width: 640, height: 360 },
    green: { kind: 'image', duration: null, hasAudio: false, width: 200, height: 200 },
    tone: { kind: 'audio', duration: s(5), hasAudio: true },
  };
  const exportAssets = (id: string): ExportAsset | undefined => {
    const i = info[id];
    return i ? { path: files[id]!, kind: i.kind, width: i.width, height: i.height, hasAudio: i.hasAudio } : undefined;
  };

  async function render(commands: (ids: { v1: string; v2: string; a1: string }) => Omit<Command, 'sequenceId'>[]) {
    const h = new History(emptyDocument());
    h.execute({ type: 'sequence.create', id: 'seq', name: 'S', width: 360, height: 640, fps: FRAME_RATES.fps30 }, (id) => info[id]);
    const t = h.doc.sequences[0]!.tracks;
    for (const c of commands({ v2: t[0]!.id, v1: t[1]!.id, a1: t[2]!.id })) {
      h.execute({ ...c, sequenceId: 'seq' } as Command, (id) => info[id]);
    }
    const seq = h.doc.sequences[0]!;
    const plan = planExport(seq, exportAssets, { encoder: 'libx264', quality: 'draft', tonemap: false });
    const graphFile = join(dir, `graph-${Math.random()}.txt`);
    writeFileSync(graphFile, plan.filterGraph);
    const out = join(dir, `out-${Math.random()}.mp4`);
    await runFfmpeg(bins!.ffmpeg, [...plan.inputArgs, '-/filter_complex', graphFile, ...plan.outputArgs, '-f', 'mp4', out]);
    return { out, seq, plan };
  }

  const pixel = (file: string, t: number, x: number, y: number): [number, number, number] => {
    const buf = execFileSync(bins!.ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf',
      `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return [buf[0]!, buf[1]!, buf[2]!];
  };
  const colour = ([r, g, b]: [number, number, number]) =>
    r > 180 && g < 80 && b < 80 ? 'red' : b > 180 && r < 80 && g < 80 ? 'blue' : g > 180 && r < 80 && b < 80 ? 'green' : r < 30 && g < 30 && b < 30 ? 'black' : `rgb(${r},${g},${b})`;

  it('places layers in time and space, at the sequence size and frame rate', async () => {
    const { out } = await render(({ v1, v2 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0 },
      { type: 'item.add', trackId: v2, assetId: 'blue', start: s(0.5), duration: s(1) },
    ]);
    const probe = JSON.parse(execFileSync(bins!.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out], { encoding: 'utf8' })) as {
      streams: { codec_type: string; width?: number; height?: number; r_frame_rate?: string }[];
      format: { duration: string };
    };
    const v = probe.streams.find((x) => x.codec_type === 'video')!;
    expect([v.width, v.height, v.r_frame_rate]).toEqual([360, 640, '30/1']);
    expect(probe.streams.some((x) => x.codec_type === 'audio')).toBe(true);
    expect(Math.abs(Number(probe.format.duration) - 3)).toBeLessThan(0.05);
    expect(colour(pixel(out, 0.25, 176, 316))).toBe('red');
    expect(colour(pixel(out, 1.0, 176, 316))).toBe('blue');
    expect(colour(pixel(out, 2.0, 176, 316))).toBe('red');
  }, 60_000);

  it('applies fit, offsets, trims, stills and audio-only tracks', async () => {
    const { out, seq } = await render(({ v1, v2, a1 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0, id: 'r' },
      { type: 'item.update', itemId: 'r', transform: { fit: 'fit' } },
      { type: 'item.add', trackId: v2, assetId: 'green', start: s(1), duration: s(1), id: 'g' },
      { type: 'item.update', itemId: 'g', transform: { fit: 'fit', scale: 0.25, y: -0.3 } },
      { type: 'item.add', trackId: a1, assetId: 'tone', start: s(0.5), id: 't' },
      { type: 'item.trim', itemId: 't', edge: 'end', time: s(4) },
    ]);
    expect(seq.tracks[2]!.items[0]!.duration).toBe(s(3.5));
    // "fit": the 16:9 red clip is a band across the middle with black above and below.
    expect(colour(pixel(out, 0.5, 176, 20))).toBe('black');
    expect(colour(pixel(out, 0.5, 176, 316))).toBe('red');
    // The small green still sits above centre between 1 s and 2 s only.
    expect(colour(pixel(out, 1.5, 176, 124))).toBe('green');
    expect(colour(pixel(out, 0.5, 176, 124))).toBe('black');
    // The audio track runs past the video, so the export lasts until 4 s.
    const duration = Number(execFileSync(bins!.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }));
    expect(Math.abs(duration - 4)).toBeLessThan(0.05);
  }, 60_000);

  it('leaves hidden tracks out', async () => {
    const { out } = await render(({ v1, v2 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0 },
      { type: 'item.add', trackId: v2, assetId: 'blue', start: 0 },
      { type: 'track.update', trackId: v2, hidden: true },
    ]);
    expect(colour(pixel(out, 1, 176, 316))).toBe('red');
  }, 60_000);
});
