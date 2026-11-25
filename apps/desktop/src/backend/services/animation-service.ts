// Talking characters by mouth shapes (ADR-049): FLUX.2 Klein redraws a character's picture with
// each mouth shape (and eyes closed), and the voice's per-sound timings switch between them.
// Both steps run in the sidecar (stable-diffusion.cpp for the drawing, FFmpeg for the clip).
import type { AnimationStatus } from '@rec-it/ipc-contract';
import { EngineInstall } from './engine-install';
import type { SidecarClient } from './sidecar';

export interface AnimationDeps {
  sidecar: SidecarClient | null;
  modelsDir: string;
  ffmpeg: () => Promise<string>;
  onChange: (status: AnimationStatus) => void;
}

/** Shape name → picture path ("rest" is the original picture, lips closed). */
export type MouthShapes = Record<string, string>;

export interface Sound {
  p: string;
  start: number;
  end: number;
}

export class AnimationService {
  private readonly engine: EngineInstall;

  constructor(private readonly d: AnimationDeps) {
    this.engine = new EngineInstall({
      sidecar: d.sidecar,
      modelsDir: d.modelsDir,
      statusMethod: 'lipsync.status',
      installJob: 'lipsync.install',
      what: 'talking characters',
      onChange: d.onChange,
    });
  }

  status(): AnimationStatus {
    return this.engine.status();
  }

  refresh(): Promise<void> {
    return this.engine.refresh();
  }

  startInstall(): void {
    this.engine.start();
  }

  cancelInstall(): void {
    this.engine.cancel();
  }

  private sidecar(): SidecarClient {
    if (!this.d.sidecar)
      throw new Error('Talking characters need the media-ai helper, which is off.');
    this.d.sidecar.start();
    return this.d.sidecar;
  }

  /** Draws the mouth shapes and the blink for a character picture (once per character). */
  async shapes(o: {
    base: string;
    outDir: string;
    seed: number;
    signal?: AbortSignal;
    onProgress?: (p: number, message?: string) => void;
  }): Promise<MouthShapes> {
    if (!this.engine.available()) throw new Error('Install the mouth-shape engine first.');
    const r = await this.sidecar().job<{ shapes: MouthShapes }>(
      'lipsync.shapes',
      { base: o.base, outDir: o.outDir, seed: o.seed, modelsDir: this.d.modelsDir },
      {
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      },
    );
    return r.shapes;
  }

  /** Renders the character saying a line: an MP4 (30 fps, no sound) of the shapes in time. */
  async render(o: {
    shapes: MouthShapes;
    sounds: Sound[];
    /** The voice itself: its loudness opens and closes the mouth (the sounds only shape it). */
    audio?: string;
    /** 0 calm … 1 lively. */
    liveliness?: number;
    duration: number;
    out: string;
    seed: number;
    signal?: AbortSignal;
  }): Promise<{ video: string; seconds: number }> {
    return this.sidecar().job<{ video: string; seconds: number }>(
      'lipsync.render',
      {
        shapes: o.shapes,
        sounds: o.sounds,
        ...(o.audio ? { audio: o.audio } : {}),
        ...(o.liveliness !== undefined ? { liveliness: o.liveliness } : {}),
        duration: o.duration,
        out: o.out,
        seed: o.seed,
        ffmpeg: await this.d.ffmpeg(),
      },
      o.signal ? { signal: o.signal } : {},
    );
  }
}
