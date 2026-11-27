// Low-poly 3D Shorts (ADR-054): the renderer films the 3D with three.js (WebGL lives there, not in
// this process) and streams JPEG frames back; this service feeds them to FFmpeg as they arrive.
// One render runs at a time. Backpressure: a batch of frames resolves only once FFmpeg took it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createId } from '@rec-it/core';
import { totalFrames, type RenderSpec } from '@rec-it/lowpoly';

export interface LowPolyDeps {
  ffmpeg: () => Promise<string>;
  /** Sends the spec to the renderer (the `lowpoly.render` event). */
  emit: (request: string, spec: RenderSpec) => void;
  /** Seconds without frames before the renderer counts as gone. */
  stallSeconds?: number;
}

interface Running {
  request: string;
  ffmpeg: ChildProcess;
  frames: number;
  total: number;
  stderr: string;
  onProgress?: ((p: number) => void) | undefined;
  finished: (error?: string) => void;
  cancelled: boolean;
  last: number;
}

export class LowPolyService {
  private current: Running | null = null;

  constructor(private readonly d: LowPolyDeps) {}

  /** Films a spec into an MP4 (no sound) at `out`. */
  async render(
    spec: RenderSpec,
    out: string,
    o: { signal?: AbortSignal; onProgress?: (p: number) => void } = {},
  ): Promise<void> {
    if (this.current) throw new Error('Another 3D render is running; wait for it to finish.');
    const ffmpegPath = await this.d.ffmpeg();
    const request = createId('lp');
    const ffmpeg = spawn(
      ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-y',
        '-f',
        'image2pipe',
        '-framerate',
        String(spec.fps),
        '-c:v',
        'mjpeg',
        '-i',
        'pipe:0',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '17',
        '-pix_fmt',
        'yuv420p',
        '-r',
        String(spec.fps),
        '-movflags',
        '+faststart',
        out,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    );
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const run: Running = {
        request,
        ffmpeg,
        frames: 0,
        total: totalFrames(spec),
        stderr: '',
        onProgress: o.onProgress,
        cancelled: false,
        last: Date.now(),
        finished: (error) => {
          if (!error && !run.cancelled) ffmpeg.stdin?.end();
          else ffmpeg.kill();
          rendererDone = { error };
        },
      };
      let rendererDone: { error?: string | undefined } | null = null;
      const done = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(watch);
        o.signal?.removeEventListener('abort', abort);
        this.current = null;
        if (error) reject(error);
        else resolve();
      };
      ffmpeg.stderr?.on('data', (b: Buffer) => {
        run.stderr = (run.stderr + b.toString('utf8')).slice(-4000);
      });
      ffmpeg.stdin?.on('error', () => undefined);
      ffmpeg.on('error', (e) => done(e));
      ffmpeg.on('close', (code) => {
        if (run.cancelled) return done(new Error('Cancelled'));
        if (rendererDone?.error)
          return done(new Error(`The 3D renderer failed: ${rendererDone.error}`));
        if (code !== 0)
          return done(
            new Error(
              `FFmpeg could not encode the 3D frames: ${run.stderr.trim().split('\n').at(-1) ?? code}`,
            ),
          );
        if (!rendererDone) return done(new Error('The 3D renderer stopped early.'));
        done();
      });
      const abort = () => {
        run.cancelled = true;
        ffmpeg.kill();
      };
      o.signal?.addEventListener('abort', abort, { once: true });
      const stall = (this.d.stallSeconds ?? 90) * 1000;
      const watch = setInterval(() => {
        if (!rendererDone && Date.now() - run.last > stall) {
          rendererDone = { error: 'it stopped sending pictures (is the Rec-It window open?)' };
          ffmpeg.kill();
        }
      }, 1000);
      this.current = run;
      this.d.emit(request, spec);
    });
  }

  /** A batch of frames from the renderer. Resolves false when the render was cancelled. */
  async frames(request: string, frames: Uint8Array[]): Promise<boolean> {
    const run = this.current;
    if (!run || run.request !== request || run.cancelled) return false;
    run.last = Date.now();
    const stdin = run.ffmpeg.stdin;
    if (!stdin || stdin.destroyed) return false;
    for (const f of frames) {
      if (!stdin.write(Buffer.from(f.buffer, f.byteOffset, f.byteLength)))
        await new Promise<void>((r) => stdin.once('drain', () => r()));
    }
    run.frames += frames.length;
    run.onProgress?.(Math.min(1, run.frames / Math.max(1, run.total)));
    return true;
  }

  /** The renderer is done with a request (or failed it). */
  finished(request: string, error?: string): void {
    const run = this.current;
    if (!run || run.request !== request) return;
    run.finished(error);
  }

  /** Whether a render is in progress (for tests). */
  busy(): boolean {
    return !!this.current;
  }
}
