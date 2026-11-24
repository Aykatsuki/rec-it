// AI pictures and motion-graphics backdrops for generated Shorts (ADR-047), made by the Python
// sidecar: Z-Image Turbo through stable-diffusion.cpp (downloaded once on request) and Pillow.
import type { ImageStatus } from '@rec-it/ipc-contract';
import { EngineInstall } from './engine-install';
import type { SidecarClient } from './sidecar';

export interface ImageDeps {
  sidecar: SidecarClient | null;
  modelsDir: string;
  onChange: (status: ImageStatus) => void;
}

export class ImageService {
  private readonly engine: EngineInstall;

  constructor(private readonly d: ImageDeps) {
    this.engine = new EngineInstall({
      sidecar: d.sidecar,
      modelsDir: d.modelsDir,
      statusMethod: 'images.status',
      installJob: 'images.install',
      what: 'AI pictures',
      onChange: d.onChange,
    });
  }

  status(): ImageStatus {
    return this.engine.status();
  }

  refresh(): Promise<void> {
    return this.engine.refresh();
  }

  /** Downloads the engine and model in the background; progress arrives as images.changed. */
  startInstall(): void {
    this.engine.start();
  }

  cancelInstall(): void {
    this.engine.cancel();
  }

  /** One picture per prompt (PNG paths, in order). */
  async generate(
    prompts: string[],
    o: {
      outDir: string;
      seed: number;
      signal?: AbortSignal;
      onProgress?: (p: number, message?: string) => void;
    },
  ): Promise<string[]> {
    if (!this.d.sidecar) throw new Error('AI pictures need the media-ai helper, which is off.');
    if (!this.engine.available())
      throw new Error('Install the AI picture engine first (Make a Short → AI pictures).');
    this.d.sidecar.start();
    const r = await this.d.sidecar.job<{ images: string[] }>(
      'images',
      { prompts, outDir: o.outDir, seed: o.seed, modelsDir: this.d.modelsDir },
      {
        ...(o.signal ? { signal: o.signal } : {}),
        ...(o.onProgress ? { onProgress: o.onProgress } : {}),
      },
    );
    return r.images;
  }

  /** Motion-graphics backdrops (1080×1920 PNGs) from colour palettes. */
  async backgrounds(items: { out: string; palette: string[]; seed: string }[]): Promise<string[]> {
    if (!this.d.sidecar) throw new Error('Motion graphics need the media-ai helper, which is off.');
    this.d.sidecar.start();
    const r = await this.d.sidecar.request<{ images: string[] }>(
      'backgrounds.render',
      { items },
      300_000,
    );
    return r.images;
  }
}
