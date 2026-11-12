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
  private token = 0;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.compositor = new Compositor(canvas);
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
   * Decodes and draws one frame. When `playing`, a layer whose frame is late keeps its previous
   * picture. Returns false if a newer render started meanwhile (this one was abandoned).
   */
  async render(
    frame: { width: number; height: number },
    layers: EngineLayer[],
    pixel: { w: number; h: number },
    playing: boolean,
  ): Promise<boolean> {
    const token = ++this.token;
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
          // Use it when it arrives only if nothing newer has been drawn.
          void pending.then((f) => f?.close());
          return;
        }
        if (!result) return;
        if (token !== this.token || this.disposed) {
          result.close();
          return;
        }
        this.compositor.upload(layer.key, result);
        result.close();
      }),
    );
    if (token !== this.token || this.disposed) return false;
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
