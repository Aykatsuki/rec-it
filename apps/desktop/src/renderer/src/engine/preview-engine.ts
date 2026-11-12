// Frame-accurate preview (ADR-008, ADR-029): WebCodecs decodes the proxies, WebGL2 composites.
import type { Transform } from '@rec-it/core';
import { Compositor } from './compositor';
import { VideoSource } from './video-source';

export interface EngineLayer {
  /** Timeline item id. */
  key: string;
  kind: 'video' | 'image';
  url: string;
  /** Source time to show, in seconds (video only). */
  sourceTime: number;
  /** Picture size as displayed (used for layout, not the texture size). */
  width: number;
  height: number;
  transform: Transform;
}

/** True when this system can run the GPU preview. */
export function gpuPreviewSupported(): boolean {
  try {
    return (
      typeof VideoDecoder !== 'undefined' && !!document.createElement('canvas').getContext('webgl2')
    );
  } catch {
    return false;
  }
}

/** How long playback waits for a frame before showing the previous one (keeps time moving). */
const PLAYBACK_BUDGET_MS = 50;

export class PreviewEngine {
  private readonly compositor: Compositor;
  private readonly sources = new Map<string, { url: string; source: Promise<VideoSource> }>();
  private readonly images = new Map<string, Promise<ImageBitmap>>();
  private readonly uploadedImage = new Map<string, string>();
  private disposed = false;

  /** `restored` is called when the graphics context comes back after being lost. */
  constructor(canvas: HTMLCanvasElement, restored?: () => void) {
    this.compositor = new Compositor(canvas, () => {
      this.uploadedImage.clear();
      restored?.();
    });
  }

  private source(key: string, url: string): Promise<VideoSource> {
    const existing = this.sources.get(key);
    if (existing && existing.url === url) return existing.source;
    if (existing) void existing.source.then((s) => s.close()).catch(() => {});
    const source = VideoSource.open(url);
    this.sources.set(key, { url, source });
    source.catch(() => this.sources.delete(key));
    return source;
  }

  private image(url: string): Promise<ImageBitmap> {
    let image = this.images.get(url);
    if (!image) {
      image = fetch(url)
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b));
      this.images.set(url, image);
      image.catch(() => this.images.delete(url));
    }
    return image;
  }

  /** Closes decoders for clips that are no longer near the playhead. */
  retain(keys: Set<string>): void {
    for (const [key, entry] of this.sources)
      if (!keys.has(key)) {
        this.sources.delete(key);
        void entry.source.then((s) => s.close()).catch(() => {});
      }
  }

  /**
   * Draws the frame for these layers. Requests are coalesced: one render runs at a time, and
   * while it runs only the newest request waits, so a slow machine draws fewer frames instead of
   * none (a newer request never cancels one that is already decoding). Resolves true when this
   * request was drawn, false when a newer one replaced it before it started.
   */
  render(
    frame: { width: number; height: number },
    layers: EngineLayer[],
    pixel: { w: number; h: number },
    playing: boolean,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pending?.resolve(false);
      this.pending = { args: [frame, layers, pixel, playing], resolve, reject };
      if (!this.busy) void this.pump();
    });
  }

  private busy = false;
  private pending: {
    args: [{ width: number; height: number }, EngineLayer[], { w: number; h: number }, boolean];
    resolve: (drawn: boolean) => void;
    reject: (error: unknown) => void;
  } | null = null;

  private async pump(): Promise<void> {
    this.busy = true;
    while (this.pending && !this.disposed) {
      const job = this.pending;
      this.pending = null;
      try {
        job.resolve(await this.renderNow(...job.args));
      } catch (error) {
        job.reject(error);
      }
    }
    this.busy = false;
  }

  private async renderNow(
    frame: { width: number; height: number },
    layers: EngineLayer[],
    pixel: { w: number; h: number },
    playing: boolean,
  ): Promise<boolean> {
    await Promise.all(
      layers.map(async (layer) => {
        if (layer.kind === 'image') {
          if (this.uploadedImage.get(layer.key) === layer.url && this.compositor.has(layer.key))
            return;
          const bitmap = await this.image(layer.url);
          if (this.disposed) return;
          this.compositor.upload(layer.key, bitmap);
          this.uploadedImage.set(layer.key, layer.url);
          return;
        }
        const source = await this.source(layer.key, layer.url);
        const pending = source.frameAt(layer.sourceTime);
        const result = playing
          ? await Promise.race([
              pending,
              new Promise<'late'>((r) => setTimeout(() => r('late'), PLAYBACK_BUDGET_MS)),
            ])
          : await pending;
        if (result === 'late') {
          // Keep the previous picture for this layer; release the frame when it arrives.
          void pending.then((f) => f?.close());
          return;
        }
        if (!result) return;
        if (this.disposed) {
          result.close();
          return;
        }
        this.compositor.upload(layer.key, result);
        result.close();
      }),
    );
    if (this.disposed || this.compositor.isLost) return false;
    this.compositor.retain(new Set(layers.map((l) => l.key)));
    this.compositor.draw(frame.width, frame.height, layers, pixel);
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.retain(new Set());
    this.compositor.dispose();
    for (const image of this.images.values()) void image.then((b) => b.close()).catch(() => {});
  }
}

/** A readable description of any error, including DOMExceptions with empty messages. */
export function describeError(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : '';
    return `${name}${error.message || 'no details'}`;
  }
  return String(error) || 'no details';
}
