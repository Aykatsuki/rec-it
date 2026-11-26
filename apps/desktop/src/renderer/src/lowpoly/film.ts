// Films a low-poly render spec frame by frame (ADR-054): each shot is built, every frame is drawn
// small with the PS1 look, enlarged, overlaid with the big words and the channel name, and
// handed over as a JPEG. The backend encodes the frames with FFmpeg.
import * as THREE from 'three';
import { shotFrames, totalFrames, type RenderSpec } from '@rec-it/lowpoly';
import { Ps1Post, setGrid } from './ps1';
import { buildShot, disposeShot } from './shot';
import { clearTextures } from './textures';

export interface FilmOptions {
  /** Receives frames in order; resolves false to stop (cancelled). */
  onFrames: (frames: Uint8Array<ArrayBuffer>[]) => Promise<boolean>;
  onProgress?: (done: number, total: number) => void;
  /** Frames per hand-over. */
  batch?: number;
  quality?: number;
}

const ease = (x: number) => {
  const k = Math.min(1, Math.max(0, x));
  return 1 - (1 - k) ** 3;
};

/** Chunky outlined words in the middle of the picture, popping in. */
function bigText(g: CanvasRenderingContext2D, text: string, t: number, w: number, h: number) {
  if (!text) return;
  const pop = ease(t / 0.18);
  const size = Math.round(h * 0.075 * (0.6 + 0.4 * pop) * (1 + Math.sin(t * 6) * 0.015));
  g.save();
  g.translate(w / 2, h * 0.3);
  g.rotate(Math.sin(t * 2) * 0.03);
  g.font = `900 ${size}px "Arial Black", Impact, "Anton", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = size * 0.16;
  g.strokeStyle = '#111111';
  g.strokeText(text.toUpperCase(), 0, 0, w * 0.9);
  g.fillStyle = '#ffffff';
  g.fillText(text.toUpperCase(), 0, 0, w * 0.9);
  g.restore();
}

/** The channel name, flashed early on like a watermark: yellow bubble letters with depth. */
function brand(g: CanvasRenderingContext2D, text: string, t: number, w: number, h: number) {
  const from = 1.6,
    to = 5.2;
  if (!text || t < from || t > to) return;
  const k = ease((t - from) / 0.25) * (1 - ease((t - (to - 0.25)) / 0.25));
  const size = Math.round(h * 0.06 * (0.7 + 0.3 * k));
  g.save();
  g.globalAlpha = Math.min(1, k * 1.5);
  g.translate(w / 2, h * 0.2);
  g.font = `900 ${size}px "Arial Black", Impact, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  const lines =
    text.split(/\s+/).length > 2
      ? [text.split(/\s+/).slice(0, 2).join(' '), text.split(/\s+/).slice(2).join(' ')]
      : [text];
  lines.forEach((line, i) => {
    const y = (i - (lines.length - 1) / 2) * size * 1.05;
    for (let d = Math.round(size * 0.12); d > 0; d--) {
      g.fillStyle = '#9a4a12';
      g.fillText(line, d * 0.5, y + d);
    }
    g.lineWidth = size * 0.1;
    g.strokeStyle = '#2a1404';
    g.strokeText(line, 0, y);
    const grad = g.createLinearGradient(0, y - size / 2, 0, y + size / 2);
    grad.addColorStop(0, '#fff27a');
    grad.addColorStop(1, '#f2b21c');
    g.fillStyle = grad;
    g.fillText(line, 0, y);
  });
  g.restore();
}

/** Films the whole spec. */
export async function film(spec: RenderSpec, o: FilmOptions): Promise<void> {
  const { width: w, height: h, fps } = spec;
  const lowH = spec.pixelHeight;
  const lowW = Math.max(16, Math.round((lowH * w) / h));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  setGrid(lowW, lowH);
  const post = new Ps1Post(lowW, lowH);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const g = out.getContext('2d')!;
  const total = totalFrames(spec);
  const batch: Uint8Array<ArrayBuffer>[] = [];
  let done = 0;
  const flush = async () => {
    if (!batch.length) return true;
    const frames = batch.splice(0);
    return o.onFrames(frames);
  };
  try {
    for (const shot of spec.shots) {
      const [f0, f1] = shotFrames(shot, fps);
      if (f1 <= f0) continue;
      const built = buildShot(shot, spec.cast, (f1 - f0) / fps);
      built.camera.aspect = w / h;
      try {
        for (let f = f0; f < f1; f++) {
          const t = (f - f0) / fps;
          built.update(t, f - f0);
          const look = built.look(t);
          post.uniforms.uTint.value.set(look.tint);
          post.uniforms.uTintAmount.value = look.tintAmount;
          post.uniforms.uFlash.value = look.flash;
          post.uniforms.uGrain.value = (f % 7) + 1;
          post.render(renderer, built.scene, built.camera);
          g.drawImage(canvas, 0, 0);
          bigText(g, built.overlay, t, w, h);
          brand(g, spec.brand, f / fps, w, h);
          const blob = await new Promise<Blob>((res, rej) =>
            out.toBlob(
              (b) => (b ? res(b) : rej(new Error('Could not encode a frame.'))),
              'image/jpeg',
              o.quality ?? 0.92,
            ),
          );
          batch.push(new Uint8Array(await blob.arrayBuffer()));
          done++;
          if (batch.length >= (o.batch ?? 8)) {
            if (!(await flush())) return;
            o.onProgress?.(done, total);
          }
        }
      } finally {
        disposeShot(built);
      }
    }
    await flush();
    o.onProgress?.(done, total);
  } finally {
    post.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    clearTextures();
  }
}
