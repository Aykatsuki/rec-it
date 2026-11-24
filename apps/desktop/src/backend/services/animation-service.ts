// Talking characters (ADR-048): Wan 2.2 S2V through the sidecar's stable-diffusion.cpp engine.
// A character picture plus a spoken line becomes a short clip of the character saying it.
import type { AnimationStatus } from '@rec-it/ipc-contract';
import { EngineInstall } from './engine-install';
import type { SidecarClient } from './sidecar';

export interface AnimationDeps {
  sidecar: SidecarClient | null;
  modelsDir: string;
  /** FFmpeg, for the test stand-in engine (RECIT_FAKE_TALK). */
  ffmpeg: () => Promise<string>;
  onChange: (status: AnimationStatus) => void;
}

export interface TalkResult {
  /** The clip (.avi, 16 fps, no sound: the voice stays its own clip). */
  video: string;
  frames: number;
  seconds: number;
}

export class AnimationService {
  private readonly engine: EngineInstall;

  constructor(private readonly d: AnimationDeps) {
    this.engine = new EngineInstall({
      sidecar: d.sidecar,
      modelsDir: d.modelsDir,
      statusMethod: 'talking.status',
      installJob: 'talking.install',
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

  /** Animates `image` saying the line in `audio` (`seconds` long; one shot holds about 5 s). */
  async talk(o: {
    image: string;
    audio: string;
    out: string;
    seconds: number;
    prompt: string;
    seed: number;
    signal?: AbortSignal;
    onProgress?: (p: number, message?: string) => void;
  }): Promise<TalkResult> {
    if (!this.d.sidecar)
      throw new Error('Talking characters need the media-ai helper, which is off.');
    if (!this.engine.available()) throw new Error('Install the animation engine first.');
    this.d.sidecar.start();
    return this.d.sidecar.job<TalkResult>(
      'talk',
      {
        modelsDir: this.d.modelsDir,
        image: o.image,
        audio: o.audio,
        out: o.out,
        seconds: o.seconds,
        prompt: o.prompt,
        seed: o.seed,
        ffmpeg: await this.d.ffmpeg(),
      },
      {
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      },
    );
  }
}
