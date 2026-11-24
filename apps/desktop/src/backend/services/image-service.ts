// AI pictures and motion-graphics backdrops for generated Shorts (ADR-047), made by the Python
// sidecar: Z-Image Turbo through stable-diffusion.cpp (downloaded once on request) and Pillow.
import type { ImageStatus } from '@rec-it/ipc-contract';
import type { SidecarClient } from './sidecar';

export interface ImageDeps {
  sidecar: SidecarClient | null;
  modelsDir: string;
  onChange: (status: ImageStatus) => void;
}

export class ImageService {
  private status_: Omit<ImageStatus, 'install'> = { available: null, installable: false };
  private install: ImageStatus['install'] = { state: 'idle' };
  private installing: AbortController | null = null;

  constructor(private readonly d: ImageDeps) {}

  status(): ImageStatus {
    return { ...this.status_, install: this.install };
  }

  private emit(): void {
    this.d.onChange(this.status());
  }

  async refresh(): Promise<void> {
    if (!this.d.sidecar) {
      this.status_ = {
        available: false,
        installable: false,
        blocked: 'The media-ai helper is turned off, so AI pictures are unavailable.',
      };
      this.emit();
      return;
    }
    try {
      this.d.sidecar.start();
      const s = await this.d.sidecar.request<Omit<ImageStatus, 'install'>>(
        'images.status',
        { modelsDir: this.d.modelsDir },
        60_000,
      );
      this.status_ = s;
    } catch (error) {
      this.status_ = {
        available: false,
        installable: false,
        blocked: `The media-ai helper is not running (${
          error instanceof Error ? error.message : String(error)
        }).`,
      };
    }
    this.emit();
  }

  /** Downloads the engine and model in the background; progress arrives as images.changed. */
  startInstall(): void {
    if (!this.d.sidecar) throw new Error('The media-ai sidecar is turned off.');
    if (this.installing) return;
    const controller = new AbortController();
    this.installing = controller;
    this.install = { state: 'running', message: 'Starting…', progress: 0 };
    this.emit();
    this.d.sidecar.start();
    void this.d.sidecar
      .job(
        'images.install',
        { modelsDir: this.d.modelsDir },
        {
          signal: controller.signal,
          onProgress: (progress, message) => {
            this.install = { state: 'running', progress, ...(message ? { message } : {}) };
            this.emit();
          },
        },
      )
      .then(
        () => {
          this.install = { state: 'idle' };
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.install = controller.signal.aborted
            ? { state: 'idle' }
            : { state: 'failed', message };
        },
      )
      .finally(() => {
        this.installing = null;
        void this.refresh();
      });
  }

  cancelInstall(): void {
    this.installing?.abort();
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
    if (!this.status_.available)
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
