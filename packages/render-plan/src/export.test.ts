import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FRAME_RATES,
  History,
  emptyDocument,
  secondsToFlicks,
  valueAt,
  DEFAULT_CAPTIONS,
  type AssetInfo,
  type Command,
} from '@rec-it/core';
import { compileAss } from '@rec-it/captions';
import { runFfmpeg } from '@rec-it/ffmpeg';
import { findTestFfmpeg } from '@rec-it/ffmpeg/testing';
import {
  ExportPlanError,
  parseLoudnorm,
  pickExportEncoder,
  keyframeExpr,
  planExport,
  planFrame,
  planLoudnessAnalysis,
  type ExportAsset,
  type ExportOptions,
} from './index';

const s = secondsToFlicks;
const bins = findTestFfmpeg();

function emptySequence() {
  const h = new History(emptyDocument());
  h.execute(
    {
      type: 'sequence.create',
      id: 'seq',
      name: 'S',
      width: 360,
      height: 640,
      fps: FRAME_RATES.fps30,
    },
    () => undefined,
  );
  return h.doc.sequences[0]!;
}

describe('planExport', () => {
  it('refuses an empty timeline', () => {
    expect(() =>
      planExport(emptySequence(), () => undefined, {
        encoder: 'libx264',
        quality: 'standard',
        tonemap: false,
      }),
    ).toThrow(ExportPlanError);
  });
});

describe('generated FFmpeg arguments', () => {
  // A fixed sequence: two video layers (one rotated, one still) and an audio clip.
  const info: Record<string, AssetInfo> = {
    clip: { kind: 'video', duration: s(10), hasAudio: true, width: 1920, height: 1080 },
    logo: { kind: 'image', duration: null, hasAudio: false, width: 400, height: 400 },
    music: { kind: 'audio', duration: s(30), hasAudio: true },
  };
  const exportAssets = (id: string): ExportAsset | undefined => {
    const i = info[id];
    return i
      ? {
          path: `/media/${id}`,
          kind: i.kind,
          width: i.width,
          height: i.height,
          hasAudio: i.hasAudio,
        }
      : undefined;
  };
  const seq = () => {
    const h = new History(emptyDocument());
    const run = (c: Command) => h.execute(c, (id) => info[id]);
    run({
      type: 'sequence.create',
      id: 'seq',
      name: 'Short',
      width: 1080,
      height: 1920,
      fps: FRAME_RATES.fps30,
    });
    const [v2, v1, a1] = h.doc.sequences[0]!.tracks;
    run({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: v1!.id,
      assetId: 'clip',
      start: 0,
      id: 'c',
      sourceIn: s(2),
      duration: s(6),
    });
    run({
      type: 'item.update',
      sequenceId: 'seq',
      itemId: 'c',
      transform: { rotation: 10, scale: 1.2 },
    });
    run({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: v2!.id,
      assetId: 'logo',
      start: s(1),
      duration: s(2),
      id: 'l',
    });
    run({
      type: 'item.update',
      sequenceId: 'seq',
      itemId: 'l',
      transform: { fit: 'fit', scale: 0.3, y: -0.35 },
    });
    run({
      type: 'item.add',
      sequenceId: 'seq',
      trackId: a1!.id,
      assetId: 'music',
      start: 0,
      duration: s(6),
    });
    return h.doc.sequences[0]!;
  };
  const cases: [string, ExportOptions][] = [
    [
      'NVENC H.264, standard, one-pass loudness',
      { encoder: 'h264_nvenc', quality: 'standard', tonemap: false },
    ],
    [
      'libx264 high, 256k, no normalisation',
      { encoder: 'libx264', quality: 'high', tonemap: false, audioBitrateK: 256, loudness: null },
    ],
    [
      'libx265 draft at half size, measured loudness',
      {
        encoder: 'libx265',
        quality: 'draft',
        tonemap: false,
        scale: 0.5,
        title: 'My Short',
        loudness: {
          target: -14,
          measured: {
            input_i: -23.1,
            input_tp: -6.2,
            input_lra: 4.1,
            input_thresh: -33.4,
            target_offset: 0.3,
          },
        },
      },
    ],
  ];
  it.each(cases)('%s', (_name, options) => {
    expect(planExport(seq(), exportAssets, options)).toMatchSnapshot();
  });
  it('plans the loudness analysis pass and a single frame', () => {
    expect(planLoudnessAnalysis(seq(), exportAssets, -14)).toMatchSnapshot();
    expect(planFrame(seq(), exportAssets, 1.5, { tonemap: false })).toMatchSnapshot();
  });
  it('reads loudnorm reports and ignores silence', () => {
    const report = `[Parsed_loudnorm_3 @ 0x1]\n{\n\t"input_i" : "-23.10",\n\t"input_tp" : "-6.20",\n\t"input_lra" : "4.10",\n\t"input_thresh" : "-33.40",\n\t"output_i" : "-14.0",\n\t"target_offset" : "0.30"\n}\n`;
    expect(parseLoudnorm(report)).toEqual({
      input_i: -23.1,
      input_tp: -6.2,
      input_lra: 4.1,
      input_thresh: -33.4,
      target_offset: 0.3,
    });
    expect(parseLoudnorm(report.replace('"-23.10"', '"-inf"'))).toBeNull();
    expect(parseLoudnorm('no json here')).toBeNull();
  });
});

describe.skipIf(!bins)('export renders correct frames (real FFmpeg)', () => {
  let dir: string;
  const files: Record<string, string> = {};
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'recit-export-'));
    const run = (...args: string[]) =>
      execFileSync(bins!.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    files.red = join(dir, 'red.mp4');
    files.blue = join(dir, 'blue.mp4');
    files.green = join(dir, 'green.png');
    files.tone = join(dir, 'tone.wav');
    run(
      '-f',
      'lavfi',
      '-i',
      'color=red:s=640x360:r=30:d=3',
      '-f',
      'lavfi',
      '-i',
      'sine=f=300:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      files.red,
    );
    run(
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=640x360:r=25:d=3',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      files.blue,
    );
    run('-f', 'lavfi', '-i', 'color=0x00ff00:s=200x200', '-frames:v', '1', files.green);
    files.half = join(dir, 'half.png');
    run(
      '-f',
      'lavfi',
      '-i',
      'color=black:s=200x200,drawbox=x=100:y=0:w=100:h=200:color=white:t=fill',
      '-frames:v',
      '1',
      files.half,
    );
    run('-f', 'lavfi', '-i', 'sine=f=500:d=5', files.tone);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const info: Record<string, AssetInfo> = {
    red: { kind: 'video', duration: s(3), hasAudio: true, width: 640, height: 360 },
    blue: { kind: 'video', duration: s(3), hasAudio: false, width: 640, height: 360 },
    green: { kind: 'image', duration: null, hasAudio: false, width: 200, height: 200 },
    half: { kind: 'image', duration: null, hasAudio: false, width: 200, height: 200 },
    tone: { kind: 'audio', duration: s(5), hasAudio: true },
  };
  const exportAssets = (id: string): ExportAsset | undefined => {
    const i = info[id];
    return i
      ? {
          path: files[id]!,
          kind: i.kind,
          width: i.width,
          height: i.height,
          hasAudio: i.hasAudio,
          ...(i.duration === null ? {} : { durationSec: i.duration / 705_600_000 }),
        }
      : undefined;
  };

  async function render(
    commands: (ids: { v1: string; v2: string; a1: string }) => Omit<Command, 'sequenceId'>[],
    options: Partial<ExportOptions> = {},
  ) {
    const h = new History(emptyDocument());
    h.execute(
      {
        type: 'sequence.create',
        id: 'seq',
        name: 'S',
        width: 360,
        height: 640,
        fps: FRAME_RATES.fps30,
      },
      (id) => info[id],
    );
    const t = h.doc.sequences[0]!.tracks;
    for (const c of commands({ v2: t[0]!.id, v1: t[1]!.id, a1: t[2]!.id })) {
      h.execute({ ...c, sequenceId: 'seq' } as Command, (id) => info[id]);
    }
    const seq = h.doc.sequences[0]!;
    const plan = planExport(seq, exportAssets, {
      encoder: 'libx264',
      quality: 'draft',
      tonemap: false,
      ...options,
    });
    const graphFile = join(dir, `graph-${Math.random()}.txt`);
    writeFileSync(graphFile, plan.filterGraph);
    const out = join(dir, `out-${Math.random()}.mp4`);
    await runFfmpeg(bins!.ffmpeg, [
      ...plan.inputArgs,
      '-/filter_complex',
      graphFile,
      ...plan.outputArgs,
      '-f',
      'mp4',
      out,
    ]);
    return { out, seq, plan };
  }

  const pixel = (file: string, t: number, x: number, y: number): [number, number, number] => {
    const buf = execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-ss',
      String(t),
      '-i',
      file,
      '-frames:v',
      '1',
      '-vf',
      `crop=8:8:${x}:${y},scale=1:1`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    return [buf[0]!, buf[1]!, buf[2]!];
  };
  const colour = ([r, g, b]: [number, number, number]) =>
    r > 180 && g < 80 && b < 80
      ? 'red'
      : b > 180 && r < 80 && g < 80
        ? 'blue'
        : g > 180 && r < 80 && b < 80
          ? 'green'
          : r < 30 && g < 30 && b < 30
            ? 'black'
            : `rgb(${r},${g},${b})`;

  it('places layers in time and space, at the sequence size and frame rate', async () => {
    const { out } = await render(({ v1, v2 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0 },
      { type: 'item.add', trackId: v2, assetId: 'blue', start: s(0.5), duration: s(1) },
    ]);
    const probe = JSON.parse(
      execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', out],
        { encoding: 'utf8' },
      ),
    ) as {
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
    const duration = Number(
      execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out],
        { encoding: 'utf8' },
      ),
    );
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

  it('rotates clips around their centre with transparent corners', async () => {
    const { out } = await render(({ v1 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0, id: 'r' },
      { type: 'item.update', itemId: 'r', transform: { fit: 'fit', rotation: 90 } },
    ]);
    // Unrotated, "fit" is a horizontal band; turned 90° it becomes a vertical band.
    expect(colour(pixel(out, 0.5, 176, 150))).toBe('red');
    expect(colour(pixel(out, 0.5, 176, 480))).toBe('red');
    expect(colour(pixel(out, 0.5, 20, 316))).toBe('black');
    expect(colour(pixel(out, 0.5, 330, 316))).toBe('black');
  }, 60_000);

  const probeJson = (file: string) =>
    JSON.parse(
      execFileSync(
        bins!.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
        { encoding: 'utf8' },
      ),
    ) as {
      streams: Record<string, string | number | undefined>[];
      format: { duration: string; tags?: Record<string, string> };
    };

  const loudness = (file: string): number => {
    // ebur128 prints its summary on stderr.
    const r = spawnSync(
      bins!.ffmpeg,
      ['-hide_banner', '-nostats', '-i', file, '-filter:a', 'ebur128', '-f', 'null', '-'],
      { encoding: 'utf8' },
    );
    const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(r.stderr);
    return m ? Number(m[1]) : NaN;
  };

  it('normalises to -14 LUFS in two passes, within 1 LU', async () => {
    const commands = ({ a1, v1 }: { a1: string; v1: string }) =>
      [
        { type: 'item.add', trackId: v1, assetId: 'blue', start: 0 },
        { type: 'item.add', trackId: a1, assetId: 'tone', start: 0, id: 't' },
        { type: 'item.update', itemId: 't', volume: 0.1 },
      ] as unknown as Omit<Command, 'sequenceId'>[];
    // Pass 1: measure the mix.
    const h = new History(emptyDocument());
    h.execute(
      {
        type: 'sequence.create',
        id: 'seq',
        name: 'S',
        width: 360,
        height: 640,
        fps: FRAME_RATES.fps30,
      },
      (id) => info[id],
    );
    const t = h.doc.sequences[0]!.tracks;
    for (const c of commands({ v1: t[1]!.id, a1: t[2]!.id }))
      h.execute({ ...c, sequenceId: 'seq' } as Command, (id) => info[id]);
    const analysis = planLoudnessAnalysis(h.doc.sequences[0]!, exportAssets, -14);
    const graphFile = join(dir, 'analysis.txt');
    writeFileSync(graphFile, analysis.filterGraph);
    const { stderrTail } = await runFfmpeg(bins!.ffmpeg, [
      ...analysis.inputArgs,
      '-/filter_complex',
      graphFile,
      ...analysis.outputArgs,
      '-f',
      'null',
      '-',
    ]);
    const measured = parseLoudnorm(stderrTail);
    expect(measured).not.toBeNull();
    expect(measured!.input_i).toBeLessThan(-25);
    // Pass 2: export with the measured values.
    const { out } = await render(commands, { loudness: { target: -14, measured: measured! } });
    expect(Math.abs(loudness(out) - -14)).toBeLessThanOrEqual(1);
  }, 90_000);

  it('scales the output, writes HEVC that QuickTime accepts, and tags BT.709', async () => {
    const { out } = await render(
      ({ v1 }) => [{ type: 'item.add', trackId: v1, assetId: 'red', start: 0 }],
      { encoder: 'libx265', scale: 0.5, title: 'Half size' },
    );
    const p = probeJson(out);
    const v = p.streams.find((x) => x.codec_type === 'video')!;
    const a = p.streams.find((x) => x.codec_type === 'audio')!;
    expect(v).toMatchObject({
      codec_name: 'hevc',
      codec_tag_string: 'hvc1',
      width: 180,
      height: 320,
      pix_fmt: 'yuv420p',
      color_space: 'bt709',
      color_primaries: 'bt709',
      color_transfer: 'bt709',
      r_frame_rate: '30/1',
    });
    expect(a).toMatchObject({ codec_name: 'aac', sample_rate: '48000', channels: 2 });
    expect(p.format.tags?.title).toBe('Half size');
    // Duration matches the timeline within one frame.
    expect(Math.abs(Number(p.format.duration) - 3)).toBeLessThanOrEqual(1 / 30 + 0.025);
    expect(colour(pixel(out, 1, 88, 158))).toBe('red');
  }, 90_000);

  it('animates position, size and rotation with keyframes', async () => {
    const { out } = await render(
      ({ v1 }) =>
        [
          { type: 'item.add', trackId: v1, assetId: 'red', start: 0, id: 'r' },
          { type: 'item.update', itemId: 'r', transform: { fit: 'fit' } },
          // Grows from 30% to 100% and turns 90° over two seconds, then holds.
          { type: 'keyframe.set', itemId: 'r', property: 'scale', t: 0, value: 0.3 },
          { type: 'keyframe.set', itemId: 'r', property: 'scale', t: s(2), value: 1 },
          { type: 'keyframe.set', itemId: 'r', property: 'rotation', t: 0, value: 0 },
          { type: 'keyframe.set', itemId: 'r', property: 'rotation', t: s(2), value: 90 },
          { type: 'keyframe.set', itemId: 'r', property: 'y', t: 0, value: -0.3 },
          { type: 'keyframe.set', itemId: 'r', property: 'y', t: s(2), value: 0 },
        ] as unknown as Omit<Command, 'sequenceId'>[],
    );
    // Start: a small band above the centre (y -0.3 → centre at 128 px of 640).
    expect(colour(pixel(out, 0.05, 176, 124))).toBe('red');
    expect(colour(pixel(out, 0.05, 176, 316))).toBe('black');
    expect(colour(pixel(out, 0.05, 20, 124))).toBe('black');
    // End: full-size band turned upright and centred, as in the static rotation test.
    expect(colour(pixel(out, 2.5, 176, 150))).toBe('red');
    expect(colour(pixel(out, 2.5, 176, 480))).toBe('red');
    expect(colour(pixel(out, 2.5, 20, 316))).toBe('black');
  }, 60_000);

  it('fades volume with keyframes', async () => {
    const { out } = await render(
      ({ a1, v1 }) =>
        [
          { type: 'item.add', trackId: v1, assetId: 'blue', start: 0 },
          { type: 'item.add', trackId: a1, assetId: 'tone', start: 0, duration: s(3), id: 't' },
          { type: 'keyframe.set', itemId: 't', property: 'volume', t: 0, value: 0 },
          { type: 'keyframe.set', itemId: 't', property: 'volume', t: s(2), value: 1 },
        ] as unknown as Omit<Command, 'sequenceId'>[],
      { loudness: null },
    );
    const level = (from: number) => {
      const r = spawnSync(
        bins!.ffmpeg,
        [
          '-hide_banner',
          '-ss',
          String(from),
          '-t',
          '0.3',
          '-i',
          out,
          '-af',
          'volumedetect',
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      );
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? -99);
    };
    // Near-silent at the start, about 12 dB louder half-way, full level at the end.
    expect(level(0)).toBeLessThan(-35);
    expect(level(1)).toBeGreaterThan(level(0.2) + 8);
    expect(level(2.4)).toBeGreaterThan(level(1));
  }, 60_000);

  // Homebrew's FFmpeg (macOS CI) is built without libass; Rec-It's own builds include it.
  const hasLibass = () =>
    /\sass\s/.test(
      spawnSync(bins!.ffmpeg, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '',
    );
  it.skipIf(!bins || !hasLibass())(
    'burns in captions with libass and the bundled fonts, timed to the words',
    async () => {
      // Captions are drawn from captions.ass and fonts/ next to the graph (run with cwd).
      const work = mkdtempSync(join(dir, 'captions-'));
      cpSync(resolve(__dirname, '../../../resources/fonts'), join(work, 'fonts'), {
        recursive: true,
      });
      const words = [
        { text: 'Hello', start: 1, end: 1.4 },
        { text: 'world', start: 1.5, end: 1.9 },
      ];
      writeFileSync(
        join(work, 'captions.ass'),
        compileAss(
          words,
          { ...DEFAULT_CAPTIONS, size: 2, position: 0.5 },
          { width: 360, height: 640 },
        ),
      );
      const h = new History(emptyDocument());
      h.execute(
        {
          type: 'sequence.create',
          id: 'seq',
          name: 'S',
          width: 360,
          height: 640,
          fps: FRAME_RATES.fps30,
        },
        (id) => info[id],
      );
      const v1 = h.doc.sequences[0]!.tracks[1]!.id;
      h.execute(
        { type: 'item.add', sequenceId: 'seq', trackId: v1, assetId: 'blue', start: 0 },
        (id) => info[id],
      );
      const plan = planExport(h.doc.sequences[0]!, exportAssets, {
        encoder: 'libx264',
        quality: 'draft',
        tonemap: false,
        captions: { file: 'captions.ass', fontsDir: 'fonts' },
      });
      expect(plan.filterGraph).toContain(',ass=filename=captions.ass:fontsdir=fonts');
      writeFileSync(join(work, 'graph.txt'), plan.filterGraph);
      const out = join(work, 'out.mp4');
      const { stderrTail } = await runFfmpeg(
        bins!.ffmpeg,
        [...plan.inputArgs, '-/filter_complex', 'graph.txt', ...plan.outputArgs, '-f', 'mp4', out],
        { cwd: work },
      );
      // libass found the bundled font rather than a fallback.
      expect(stderrTail).not.toMatch(/fontselect.*fallback|Glyph .* not found/i);
      // Count white and yellow pixels in the middle band of the frame.
      const band = (t: number) => {
        const buf = execFileSync(bins!.ffmpeg, [
          '-v',
          'error',
          '-ss',
          String(t),
          '-i',
          out,
          '-frames:v',
          '1',
          '-vf',
          'crop=360:120:0:260',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-',
        ]);
        let white = 0;
        let yellow = 0;
        for (let i = 0; i < buf.length; i += 3) {
          const [r, g, b] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
          if (r > 200 && g > 200 && b > 200) white++;
          else if (r > 200 && g > 180 && b < 90) yellow++;
        }
        return { white, yellow };
      };
      expect(band(0.5)).toEqual({ white: 0, yellow: 0 }); // before the first word
      const first = band(1.2); // "Hello" spoken: highlighted
      const second = band(1.7); // "world" spoken
      expect(first.yellow).toBeGreaterThan(200);
      expect(first.white).toBeGreaterThan(200);
      expect(second.yellow).toBeGreaterThan(200);
      expect(Math.abs(first.yellow - second.yellow)).toBeGreaterThan(20); // a different word lit
      expect(band(2.9)).toEqual({ white: 0, yellow: 0 }); // gone after the hold
    },
    60_000,
  );

  it('crops before scaling, also on animated clips', async () => {
    // 400×400: red top-left, green top-right, blue bottom-left, white bottom-right.
    const quad = join(dir, 'quad.png');
    execFileSync(bins!.ffmpeg, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=red:s=200x200',
      '-f',
      'lavfi',
      '-i',
      'color=0x00ff00:s=200x200',
      '-f',
      'lavfi',
      '-i',
      'color=blue:s=200x200',
      '-f',
      'lavfi',
      '-i',
      'color=white:s=200x200',
      '-filter_complex',
      '[0][1]hstack[t];[2][3]hstack[b];[t][b]vstack',
      '-frames:v',
      '1',
      quad,
    ]);
    info.quad = { kind: 'image', duration: null, hasAudio: false, width: 400, height: 400 };
    files.quad = quad;
    // Keep the top-right quarter (green), filled to the whole 360×640 frame.
    const crop = { left: 0.5, top: 0, right: 0, bottom: 0.5 };
    const { out } = await render(({ v1 }) => [
      {
        type: 'item.add',
        trackId: v1,
        assetId: 'quad',
        start: 0,
        duration: s(1),
        transform: { fit: 'fill', crop },
      },
      {
        type: 'item.add',
        trackId: v1,
        assetId: 'quad',
        start: s(1),
        duration: s(1),
        id: 'anim',
        transform: { fit: 'fill', crop },
      },
      { type: 'keyframe.set', itemId: 'anim', property: 'scale', t: 0, value: 1 },
      { type: 'keyframe.set', itemId: 'anim', property: 'scale', t: s(1), value: 1.2 },
    ]);
    for (const t of [0.5, 1.5])
      for (const [x, y] of [
        [8, 8],
        [340, 8],
        [8, 620],
        [340, 620],
        [176, 316],
      ])
        expect(colour(pixel(out, t, x!, y!)), `${t}s at ${x},${y}`).toBe('green');
  }, 60_000);

  it('blurs a picture in proportion to its height on screen', async () => {
    const { out, plan } = await render(({ v1 }) => [
      {
        type: 'item.add',
        trackId: v1,
        assetId: 'half',
        start: 0,
        duration: s(1),
        id: 'g',
        transform: { fit: 'fit' },
      },
      { type: 'effect.add', itemId: 'g', kind: 'blur', id: 'b' },
      { type: 'effect.update', itemId: 'g', effectId: 'b', params: { size: 0.05 } },
    ]);
    // The picture is 360 px tall on screen: sigma 18 px.
    expect(plan.filterGraph).toContain(
      'gblur=sigma=18:steps=4:planes=1,gblur=sigma=9:steps=4:planes=6',
    );
    // Black left half, white right half, the edge at x = 180: grey there, a soft ramp around it.
    const v = (x: number) => pixel(out, 0.5, x - 4, 316)[1];
    expect(Math.abs(v(180) - 128)).toBeLessThan(25);
    expect(v(162)).toBeGreaterThan(20); // 1 sigma into the black: about 16% white
    expect(v(162)).toBeLessThan(70);
    expect(v(198)).toBeGreaterThan(185);
    expect(v(198)).toBeLessThan(235);
    expect(v(60)).toBeLessThan(8);
  }, 60_000);

  it('cross dissolves and dips between clips', async () => {
    const twoClips =
      (kind: 'dissolve' | 'dipWhite') =>
      ({ v1 }: { v1: string }) =>
        [
          {
            type: 'item.add',
            trackId: v1,
            assetId: 'red',
            start: 0,
            sourceIn: 0,
            duration: s(1.5),
            id: 'r',
          },
          {
            type: 'item.add',
            trackId: v1,
            assetId: 'blue',
            start: s(1.5),
            sourceIn: s(1),
            duration: s(1.5),
            id: 'b',
          },
          { type: 'transition.set', itemId: 'b', kind, duration: s(1) },
        ] as unknown as Omit<Command, 'sequenceId'>[];
    const at = (file: string, t: number) => pixel(file, t, 176, 316);
    const mix = await render(twoClips('dissolve'));
    expect(at(mix.out, 0.9)[0]).toBeGreaterThan(200); // red, before the dissolve
    const mid = at(mix.out, 1.5);
    // Half way: about half red, half blue.
    expect(Math.abs(mid[0] - 128)).toBeLessThan(35);
    expect(Math.abs(mid[2] - 128)).toBeLessThan(35);
    expect(at(mix.out, 2.1)[2]).toBeGreaterThan(200);
    const dip = await render(twoClips('dipWhite'));
    expect(Math.min(...at(dip.out, 1.5))).toBeGreaterThan(215); // white at the cut
    expect(at(dip.out, 1.25)[1]).toBeGreaterThan(90); // red on its way to white
    expect(at(dip.out, 2.1)[2]).toBeGreaterThan(200);
    expect(dip.plan.filterGraph).toContain('color=white');
  }, 90_000);

  it('fades picture and sound, and applies opacity and colour', async () => {
    const { out } = await render(({ v1 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0, duration: s(3), id: 'r' },
      { type: 'item.update', itemId: 'r', fade: { in: s(1), out: s(1) } },
    ]);
    const red = (t: number) => pixel(out, t, 176, 316)[0];
    expect(red(0.02)).toBeLessThan(30);
    expect(Math.abs(red(0.5) - 128)).toBeLessThan(30);
    expect(red(1.5)).toBeGreaterThan(200);
    expect(Math.abs(red(2.5) - 128)).toBeLessThan(30);
    // Sound: quiet at the very start, full in the middle.
    const level = (from: number) => {
      const r = spawnSync(
        bins!.ffmpeg,
        [
          '-hide_banner',
          '-ss',
          String(from),
          '-t',
          '0.1',
          '-i',
          out,
          '-af',
          'volumedetect',
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      );
      return Number(/mean_volume: (-?[\d.]+) dB/.exec(r.stderr)?.[1] ?? -99);
    };
    expect(level(1.4) - level(0)).toBeGreaterThan(12);

    // Half opacity over black halves the red; a colour effect brightens a grey still.
    const half = await render(({ v1 }) => [
      { type: 'item.add', trackId: v1, assetId: 'red', start: 0, duration: s(1), id: 'h' },
      { type: 'item.update', itemId: 'h', opacity: 0.5 },
    ]);
    expect(Math.abs(pixel(half.out, 0.5, 176, 316)[0] - 128)).toBeLessThan(25);
    const bright = await render(({ v1 }) => [
      { type: 'item.add', trackId: v1, assetId: 'blue', start: 0, duration: s(1), id: 'b' },
      { type: 'effect.add', itemId: 'b', kind: 'color', id: 'fx' },
      { type: 'effect.update', itemId: 'b', effectId: 'fx', params: { saturation: 0 } },
    ]);
    const [r, g, b] = pixel(bright.out, 0.5, 176, 316);
    // No saturation: blue becomes a grey (channels equal).
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(12);
  }, 90_000);

  it('renders a single frame with the export graph', async () => {
    const h = new History(emptyDocument());
    h.execute(
      {
        type: 'sequence.create',
        id: 'seq',
        name: 'S',
        width: 360,
        height: 640,
        fps: FRAME_RATES.fps30,
      },
      (id) => info[id],
    );
    const t = h.doc.sequences[0]!.tracks;
    h.execute(
      { type: 'item.add', sequenceId: 'seq', trackId: t[1]!.id, assetId: 'red', start: 0 },
      (id) => info[id],
    );
    h.execute(
      {
        type: 'item.add',
        sequenceId: 'seq',
        trackId: t[0]!.id,
        assetId: 'blue',
        start: s(1),
        duration: s(1),
      },
      (id) => info[id],
    );
    const plan = planFrame(h.doc.sequences[0]!, exportAssets, 1.5, { tonemap: false });
    const graphFile = join(dir, 'frame.txt');
    writeFileSync(graphFile, plan.filterGraph);
    const png = join(dir, 'frame.png');
    await runFfmpeg(bins!.ffmpeg, [
      ...plan.inputArgs,
      '-/filter_complex',
      graphFile,
      ...plan.outputArgs,
      png,
    ]);
    expect(colour(pixel(png, 0, 176, 316))).toBe('blue');
  }, 60_000);
});

describe('pickExportEncoder', () => {
  const all = Object.fromEntries(
    ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_amf'].map((e) => [
      e,
      true,
    ]),
  );
  it('prefers a working NVENC, then software', () => {
    expect(pickExportEncoder('h264', 'auto', { encoders: all, nvencUsable: true })).toBe(
      'h264_nvenc',
    );
    expect(pickExportEncoder('hevc', 'auto', { encoders: all, nvencUsable: true })).toBe(
      'hevc_nvenc',
    );
    expect(pickExportEncoder('h264', 'auto', { encoders: all, nvencUsable: false })).toBe(
      'libx264',
    );
    expect(pickExportEncoder('h264', 'cpu', { encoders: all, nvencUsable: true })).toBe('libx264');
  });
  it('only tries Intel/AMD encoders when the graphics card is asked for', () => {
    expect(pickExportEncoder('h264', 'gpu', { encoders: all, nvencUsable: false })).toBe(
      'h264_qsv',
    );
    expect(pickExportEncoder('hevc', 'gpu', { encoders: all, nvencUsable: false })).toBe(
      'hevc_amf',
    );
    expect(pickExportEncoder('hevc', 'auto', { encoders: {}, nvencUsable: null })).toBeNull();
  });
});

describe('keyframeExpr', () => {
  it('matches valueAt for linear, eased and held segments', () => {
    const keys = [
      { t: s(1), v: 0, e: 'linear' as const },
      { t: s(2), v: 10, e: 'ease' as const },
      { t: s(3), v: 20, e: 'hold' as const },
      { t: s(4), v: 0, e: 'linear' as const },
    ];
    const expr = keyframeExpr(keys, 'T');
    // Evaluate FFmpeg's expression syntax with a tiny JS translation.
    const evaluate = (T: number) =>
      Function(
        'T',
        'lt',
        'if_',
        `return ${expr.replace(/if\(/g, 'if_(')}`,
      )(
        T,
        (a: number, b: number) => (a < b ? 1 : 0),
        (c: number, a: number, b: number) => (c ? a : b),
      ) as number;
    for (const sec of [0, 1, 1.25, 1.5, 2, 2.3, 2.7, 3, 3.5, 4, 5])
      expect(evaluate(sec)).toBeCloseTo(valueAt(keys, s(sec)), 6);
  });
});
