import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProbe, probeFile, ProbeError } from './probe';
import { CancelledError, parseProgressLine, runFfmpeg } from './process';
import {
  PeakBuilder,
  posterArgs,
  proxyArgs,
  proxyFrameRate,
  spriteArgs,
  spriteLayout,
  waveformPcmArgs,
} from './recipes';
import { findTestFfmpeg, hasFilter, makeFixtures, type Fixtures } from './testing';

const PHONE = {
  streams: [
    {
      codec_type: 'video',
      codec_name: 'hevc',
      profile: 'Main 10',
      width: 3840,
      height: 2160,
      r_frame_rate: '30/1',
      avg_frame_rate: '2997/100',
      pix_fmt: 'yuv420p10le',
      color_transfer: 'arib-std-b67',
      color_primaries: 'bt2020',
      nb_frames: '1798',
      side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }],
    },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2 },
    {
      codec_type: 'video',
      codec_name: 'mjpeg',
      width: 512,
      height: 288,
      disposition: { attached_pic: 1 },
    },
  ],
  format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '60.0', bit_rate: '50000000' },
};

describe('parseProbe', () => {
  it('reads a rotated HDR phone video', () => {
    const info = parseProbe(PHONE);
    expect(info.kind).toBe('video');
    expect(info.durationSec).toBe(60);
    expect(info.video).toMatchObject({
      codec: 'hevc',
      width: 3840,
      height: 2160,
      rotation: 270,
      displayWidth: 2160,
      displayHeight: 3840,
      hdr: true,
      bitDepth: 10,
      isVfr: false,
    });
    expect(info.audio).toEqual({ codec: 'aac', sampleRate: 44100, channels: 2 });
  });

  it('treats a nominal 29.97 vs 30 mismatch under 0.5% as constant rate', () => {
    const info = parseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30000/1001',
          avg_frame_rate: '30000/1001',
        },
      ],
      format: { format_name: 'mp4', duration: '10' },
    });
    expect(info.video?.isVfr).toBe(false);
  });

  it('recognises stills, audio-only files and old rotate tags', () => {
    expect(
      parseProbe({
        streams: [{ codec_type: 'video', codec_name: 'png', width: 800, height: 600 }],
        format: { format_name: 'png_pipe' },
      }).kind,
    ).toBe('image');
    expect(
      parseProbe({
        streams: [{ codec_type: 'audio', codec_name: 'mp3', sample_rate: '48000', channels: 2 }],
        format: { format_name: 'mp3', duration: '3' },
      }).kind,
    ).toBe('audio');
    const tagged = parseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          r_frame_rate: '30/1',
          tags: { rotate: '90' },
        },
      ],
      format: { format_name: 'mp4', duration: '1' },
    });
    expect(tagged.video?.rotation).toBe(270);
    expect(tagged.video?.displayHeight).toBe(1920);
  });

  it('rejects files without usable streams', () => {
    expect(() => parseProbe({ streams: [{ codec_type: 'data' }], format: {} })).toThrow(ProbeError);
    expect(() =>
      parseProbe({
        streams: [{ codec_type: 'audio', codec_name: 'aac' }],
        format: { duration: '0' },
      }),
    ).toThrow(ProbeError);
  });
});

describe('recipes', () => {
  it('snaps proxy frame rates to standard rates', () => {
    // Nominal 30 fps (average 29.97): the nearest standard rate to the nominal rate is 30.
    expect(proxyFrameRate(parseProbe(PHONE))).toEqual({ num: 30, den: 1 });
    const odd = parseProbe({
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 640,
          height: 360,
          r_frame_rate: '15/1',
          avg_frame_rate: '15/1',
        },
      ],
      format: { format_name: 'mp4', duration: '1' },
    });
    expect(proxyFrameRate(odd)).toEqual({ num: 15, den: 1 });
    // Exact rates stay exact: 30 must not become 29.97 (the nearest rate wins, not the first).
    const at = (r: string) =>
      proxyFrameRate(
        parseProbe({
          streams: [
            {
              codec_type: 'video',
              codec_name: 'h264',
              width: 2,
              height: 2,
              r_frame_rate: r,
              avg_frame_rate: r,
            },
          ],
          format: { format_name: 'mp4', duration: '1' },
        }),
      );
    expect(at('30/1')).toEqual({ num: 30, den: 1 });
    expect(at('24/1')).toEqual({ num: 24, den: 1 });
    expect(at('60/1')).toEqual({ num: 60, den: 1 });
    expect(at('60000/1001')).toEqual({ num: 60000, den: 1001 });
    expect(at('2997/100')).toEqual({ num: 30000, den: 1001 });
  });

  it('builds proxy arguments with CFR, short GOP, tonemapping and faststart', () => {
    const args = proxyArgs('in.mov', 'out.mp4', parseProbe(PHONE), 'h264_nvenc');
    const joined = args.join(' ');
    expect(joined).toContain('-fps_mode cfr -r 30/1');
    expect(joined).toContain('-c:v h264_nvenc');
    expect(joined).toContain('-g 12');
    expect(joined).toContain('tonemap=tonemap=hable');
    expect(joined).toContain('+faststart');
    expect(args.at(-1)).toBe('out.mp4');
  });

  it('lays out sprites with at most 100 tiles', () => {
    expect(spriteLayout(3)).toMatchObject({ interval: 1, count: 3, columns: 3, rows: 1 });
    expect(spriteLayout(3600)).toMatchObject({ interval: 36, count: 100, columns: 10, rows: 10 });
    expect(spriteArgs('a', 'b', spriteLayout(3600)).join(' ')).toContain('tile=10x10');
    expect(posterArgs('a', 'b', parseProbe(PHONE)).slice(0, 2)).toEqual(['-ss', '6.000']);
  });

  it('builds peaks across chunk boundaries', () => {
    const builder = new PeakBuilder();
    const pcm = Buffer.alloc(80 * 2 * 2);
    pcm.writeInt16LE(-32768, 10);
    pcm.writeInt16LE(16384, 200);
    builder.push(pcm.subarray(0, 101));
    builder.push(pcm.subarray(101));
    expect([...builder.finish()]).toEqual([255, 128]);
  });

  it('parses progress lines', () => {
    expect(parseProgressLine('out_time_us=1500000')).toBe(1.5);
    expect(parseProgressLine('out_time_ms=2000000')).toBe(2);
    expect(parseProgressLine('frame=12')).toBeNull();
  });
});

const ffmpeg = findTestFfmpeg();

describe.skipIf(!ffmpeg)('media pipeline with real FFmpeg', () => {
  let fx: Fixtures;
  beforeAll(() => {
    fx = makeFixtures(ffmpeg!.ffmpeg, { longSeconds: 30 });
  }, 120_000);
  afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true });
  });

  const probeStream = (file: string) =>
    JSON.parse(
      execFileSync(
        ffmpeg!.ffprobe,
        ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
        {
          encoding: 'utf8',
        },
      ),
    ) as {
      streams: {
        codec_type: string;
        codec_name: string;
        width: number;
        height: number;
        r_frame_rate: string;
        avg_frame_rate: string;
      }[];
      format: { duration: string };
    };

  it('probes every fixture type and rejects the corrupt file', async () => {
    expect((await probeFile(ffmpeg!.ffprobe, fx.h264)).kind).toBe('video');
    expect((await probeFile(ffmpeg!.ffprobe, fx.vfr)).video?.isVfr).toBe(true);
    expect((await probeFile(ffmpeg!.ffprobe, fx.prores)).video?.codec).toBe('prores');
    expect((await probeFile(ffmpeg!.ffprobe, fx.audio)).kind).toBe('audio');
    expect((await probeFile(ffmpeg!.ffprobe, fx.image)).kind).toBe('image');
    if (fx.hevcRotated)
      expect((await probeFile(ffmpeg!.ffprobe, fx.hevcRotated)).video?.rotation).toBe(90);
    if (fx.hdr) expect((await probeFile(ffmpeg!.ffprobe, fx.hdr)).video?.hdr).toBe(true);
    await expect(probeFile(ffmpeg!.ffprobe, fx.corrupt)).rejects.toThrow(ProbeError);
  });

  for (const name of ['h264', 'vfr', 'prores', 'hevcRotated', 'hdr'] as const) {
    it(`makes a constant-frame-rate, upright H.264 proxy from ${name}`, async (ctx) => {
      const input = fx[name];
      if (!input) return ctx.skip();
      const probe = await probeFile(ffmpeg!.ffprobe, input);
      const out = join(fx.dir, `${name}.proxy.mp4`);
      const progress: number[] = [];
      const tonemap = hasFilter(ffmpeg!.ffmpeg, 'zscale');
      await runFfmpeg(ffmpeg!.ffmpeg, proxyArgs(input, out, probe, 'libx264', { tonemap }), {
        durationSec: probe.durationSec,
        onProgress: (p) => progress.push(p),
      });
      const result = probeStream(out);
      const v = result.streams.find((s) => s.codec_type === 'video')!;
      expect(v.codec_name).toBe('h264');
      expect(v.r_frame_rate).toBe(v.avg_frame_rate);
      expect(v.width).toBeLessThanOrEqual(1280);
      expect(v.height).toBeLessThanOrEqual(1280);
      if (probe.video && probe.video.displayHeight > probe.video.displayWidth)
        expect(v.height).toBeGreaterThan(v.width);
      const frame = 1 / (Number(eval(v.r_frame_rate)) || 30);
      expect(Math.abs(Number(result.format.duration) - probe.durationSec)).toBeLessThan(
        frame * 2 + 0.05,
      );
      expect(progress.at(-1)).toBe(1);
    }, 60_000);
  }

  it('makes sprites, posters and waveform peaks', async () => {
    const probe = await probeFile(ffmpeg!.ffprobe, fx.h264);
    const sprite = join(fx.dir, 'sprite.jpg');
    await runFfmpeg(ffmpeg!.ffmpeg, spriteArgs(fx.h264, sprite, spriteLayout(probe.durationSec)));
    expect(statSync(sprite).size).toBeGreaterThan(1000);
    const poster = join(fx.dir, 'poster.jpg');
    await runFfmpeg(
      ffmpeg!.ffmpeg,
      posterArgs(fx.image, poster, await probeFile(ffmpeg!.ffprobe, fx.image)),
    );
    expect(readFileSync(poster).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    const peaks = new PeakBuilder();
    await runFfmpeg(ffmpeg!.ffmpeg, waveformPcmArgs(fx.audio), { onStdout: (c) => peaks.push(c) });
    const result = peaks.finish();
    expect(result.length).toBeGreaterThanOrEqual(199);
    // lavfi's sine source plays at 1/8 of full scale, which is about 32 of 255.
    expect(Math.max(...result)).toBeGreaterThan(20);
  }, 60_000);

  it('cancels within a second', async () => {
    const out = join(fx.dir, 'cancel.mp4');
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      const run = runFfmpeg(
        ffmpeg!.ffmpeg,
        ['-i', fx.long, '-c:v', 'libx264', '-preset', 'slow', out],
        {
          signal: controller.signal,
          durationSec: 30,
          onProgress: () => resolve(),
        },
      );
      void run.catch(() => {});
      (globalThis as { __run?: Promise<unknown> }).__run = run;
    });
    await started;
    const t0 = Date.now();
    controller.abort();
    await expect((globalThis as { __run?: Promise<void> }).__run).rejects.toBeInstanceOf(
      CancelledError,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(out) ? statSync(out).size : 0).toBeGreaterThanOrEqual(0);
  }, 60_000);
});

describe.skipIf(!ffmpeg)('killAllFfmpeg', () => {
  it('stops every running FFmpeg process', async () => {
    const { killAllFfmpeg } = await import('./process');
    const runs = [1, 2].map(() =>
      runFfmpeg(ffmpeg!.ffmpeg, [
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=d=60',
        '-f',
        'null',
        '-',
      ]).catch((e: unknown) => e),
    );
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    killAllFfmpeg();
    const results = await Promise.all(runs);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(results.every((r) => r instanceof Error)).toBe(true);
  }, 30_000);
});

describe.skipIf(!ffmpeg)('orphaned FFmpeg clean-up', () => {
  it('ends FFmpeg processes left by a crashed run, and nothing else', async () => {
    const { spawn } = await import('node:child_process');
    const { mkdtempSync, readFileSync: read } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { killOrphanedFfmpeg, isFfmpegProcess, writePidFile } = await import('./orphans');
    const orphan = spawn(
      ffmpeg!.ffmpeg,
      ['-re', '-f', 'lavfi', '-i', 'testsrc2=d=60', '-f', 'null', '-'],
      {
        stdio: 'ignore',
      },
    );
    const exited = new Promise((r) => orphan.once('exit', r));
    await new Promise((r) => setTimeout(r, 300));
    expect(await isFfmpegProcess(orphan.pid!)).toBe(true);
    expect(await isFfmpegProcess(process.pid)).toBe(false);

    const file = join(mkdtempSync(join(tmpdir(), 'recit-pids-')), 'ffmpeg-pids.json');
    writePidFile(file, [orphan.pid!, process.pid, 999_999]);
    expect(await killOrphanedFfmpeg(file)).toEqual([orphan.pid]);
    await exited;
    expect(JSON.parse(read(file, 'utf8'))).toEqual([]);
  }, 30_000);
});
