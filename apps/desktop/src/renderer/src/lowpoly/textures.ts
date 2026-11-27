// Procedural low-resolution textures for the low-poly kit (ADR-054). Everything is painted on
// small canvases with a seeded random generator and sampled with hard pixels, like a PlayStation
// game: no image files, so there is nothing to license and nothing to download.
import * as THREE from 'three';
import { blocky } from './style';

/** Seeded random numbers in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Paint = (g: CanvasRenderingContext2D, w: number, h: number, r: () => number) => void;

const cache = new Map<string, THREE.CanvasTexture>();

/** A texture painted once per key (the cache is cleared between renders). */
export function texture(
  key: string,
  size: [number, number],
  paint: Paint,
  repeat: [number, number] = [1, 1],
): THREE.CanvasTexture {
  const id = `${key}|${size.join('x')}|${repeat.join('x')}`;
  const hit = cache.get(id);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = size[0];
  c.height = size[1];
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  let seed = 0;
  for (const ch of key) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  paint(g, c.width, c.height, rng(seed));
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (blocky()) {
    // Smooth plastic: filtered, not hard pixels.
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
  } else {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
  }
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  cache.set(id, t);
  return t;
}

export function clearTextures(): void {
  for (const t of cache.values()) t.dispose();
  cache.clear();
}

// ---- Colour helpers ----------------------------------------------------------------------------

export function shade(hex: string, k: number): string {
  const c = new THREE.Color(hex);
  if (k >= 0) c.lerp(new THREE.Color('#ffffff'), k);
  else c.multiplyScalar(1 + k);
  return `#${c.getHexString()}`;
}

/** Fills with a colour and per-pixel noise (the grain every PS1 texture has). */
export function noise(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  r: () => number,
  base: string,
  amount = 0.12,
  cell = 1,
): void {
  const c = new THREE.Color(base);
  // Game plastic is clean: a trace of grain only.
  if (blocky()) amount *= 0.3;
  for (let y = 0; y < h; y += cell)
    for (let x = 0; x < w; x += cell) {
      const k = 1 + (r() - 0.5) * 2 * amount;
      g.fillStyle = `rgb(${Math.min(255, c.r * 255 * k)},${Math.min(255, c.g * 255 * k)},${Math.min(255, c.b * 255 * k)})`;
      g.fillRect(x, y, cell, cell);
    }
}

function rect(
  g: CanvasRenderingContext2D,
  colour: string,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  g.fillStyle = colour;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

// ---- Surfaces ----------------------------------------------------------------------------------

export const SURFACES = {
  grass: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#5e8f3a', 0.22);
    for (let i = 0; i < w * 2; i++)
      rect(g, r() > 0.5 ? '#7aa84a' : '#45702c', r() * w, r() * h, 1, 2);
  },
  asphalt: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#55575c', 0.18);
    for (let i = 0; i < w; i++) rect(g, '#6c6e72', r() * w, r() * h, 1, 1);
  },
  road: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#4e5055', 0.16);
    rect(g, '#d8c25a', w / 2 - 1, 0, 2, h * 0.55);
    rect(g, '#d0d0c8', 1, 0, 1, h);
    rect(g, '#d0d0c8', w - 2, 0, 1, h);
  },
  pavement: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#a8a49a', 0.1);
    g.fillStyle = '#86837b';
    for (let i = 0; i <= w; i += w / 2) g.fillRect(i, 0, 1, h);
    for (let i = 0; i <= h; i += h / 2) g.fillRect(0, i, w, 1);
  },
  brick:
    (colour = '#9a4a36'): Paint =>
    (g, w, h, r) => {
      rect(g, '#b8afa2', 0, 0, w, h);
      const bh = h / 8;
      for (let row = 0; row < 8; row++)
        for (let col = -1; col < 4; col++) {
          const x = col * (w / 4) + (row % 2 ? w / 8 : 0);
          g.fillStyle = shade(colour, (r() - 0.5) * 0.25);
          g.fillRect(x + 1, row * bh + 1, w / 4 - 1, bh - 1);
        }
    },
  siding:
    (colour = '#d9d2c0'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.05);
      for (let y = 0; y < h; y += 4) rect(g, shade(colour, -0.18), 0, y, w, 1);
    },
  roof:
    (colour = '#5a3b32'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.15);
      for (let y = 0; y < h; y += 4) {
        rect(g, shade(colour, -0.3), 0, y, w, 1);
        for (let x = (y / 4) % 2 ? 0 : 3; x < w; x += 6) rect(g, shade(colour, -0.3), x, y, 1, 4);
      }
    },
  wood:
    (colour = '#8a5a34'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.08);
      for (let x = 0; x < w; x += w / 4) rect(g, shade(colour, -0.35), x, 0, 1, h);
      for (let i = 0; i < 24; i++) rect(g, shade(colour, -0.15), r() * w, r() * h, 1, 3 + r() * 6);
    },
  tiles:
    (colour = '#d9d6cf', line = '#a9a59c'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.05);
      g.fillStyle = line;
      for (let i = 0; i < w; i += w / 4) g.fillRect(i, 0, 1, h);
      for (let i = 0; i < h; i += h / 4) g.fillRect(0, i, w, 1);
    },
  checker:
    (a = '#e5e2da', b = '#3a3d44'): Paint =>
    (g, w, h) => {
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 4; x++)
          rect(g, (x + y) % 2 ? a : b, (x * w) / 4, (y * h) / 4, w / 4, h / 4);
    },
  carpet:
    (colour = '#7a5a4a'): Paint =>
    (g, w, h, r) =>
      noise(g, w, h, r, colour, 0.2),
  wallpaper:
    (colour = '#cfc3a2'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.04);
      for (let x = 0; x < w; x += 8) rect(g, shade(colour, -0.08), x, 0, 3, h);
      for (let y = 2; y < h; y += 8)
        for (let x = 5; x < w; x += 8) rect(g, shade(colour, 0.2), x, y, 1, 1);
    },
  plaster:
    (colour = '#d8d4ca'): Paint =>
    (g, w, h, r) =>
      noise(g, w, h, r, colour, 0.06),
  concrete: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#8d8b86', 0.14);
    for (let i = 0; i < 6; i++) rect(g, '#6f6d68', r() * w, r() * h, 2 + r() * 4, 1);
  },
  sand: (): Paint => (g, w, h, r) => noise(g, w, h, r, '#d6bd86', 0.12),
  rock: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#7d7468', 0.25, 2);
  },
  water: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#2f6fa3', 0.12);
    for (let i = 0; i < w; i++) rect(g, '#7fb6dc', r() * w, r() * h, 3, 1);
  },
  metal:
    (colour = '#9ea3a8'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.06);
      for (let y = 0; y < h; y += 2) rect(g, shade(colour, (r() - 0.5) * 0.15), 0, y, w, 1);
    },
  marble: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#e2ddd3', 0.04);
    g.strokeStyle = '#b9b2a6';
    for (let i = 0; i < 5; i++) {
      g.beginPath();
      g.moveTo(r() * w, 0);
      for (let y = 0; y <= h; y += 4) g.lineTo(r() * w * 0.2 + (i * w) / 5, y);
      g.stroke();
    }
  },
  stars: (): Paint => (g, w, h, r) => {
    rect(g, '#05060c', 0, 0, w, h);
    for (let i = 0; i < (w * h) / 60; i++)
      rect(g, r() > 0.9 ? '#ffe8b0' : '#ffffff', r() * w, r() * h, 1, 1);
    for (let i = 0; i < 6; i++) {
      g.fillStyle = `rgba(${90 + r() * 120},${40 + r() * 60},${120 + r() * 120},0.18)`;
      g.beginPath();
      g.arc(r() * w, r() * h, 10 + r() * 30, 0, Math.PI * 2);
      g.fill();
    }
  },
  sky:
    (top: string, bottom: string, clouds = true): Paint =>
    (g, w, h, r) => {
      const grad = g.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, top);
      grad.addColorStop(1, bottom);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      if (!clouds) return;
      for (let i = 0; i < 14; i++) {
        const cx = r() * w,
          cy = h * (0.15 + r() * 0.5),
          s = 6 + r() * 14;
        for (let k = 0; k < 6; k++) {
          g.fillStyle = k % 2 ? 'rgba(255,255,255,0.85)' : 'rgba(225,232,240,0.85)';
          g.beginPath();
          g.ellipse(
            cx + (r() - 0.5) * s * 2.4,
            cy + (r() - 0.5) * s * 0.5,
            s * (0.6 + r() * 0.5),
            s * 0.45,
            0,
            0,
            Math.PI * 2,
          );
          g.fill();
        }
      }
    },
  leaves:
    (colour = '#3f7a32'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.3, 2);
      for (let i = 0; i < w; i++) rect(g, shade(colour, 0.25), r() * w, r() * h, 2, 2);
    },
  bark: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#5c4130', 0.2);
    for (let x = 0; x < w; x += 3) rect(g, '#3e2c20', x, 0, 1, h);
  },
  windowLit: (): Paint => (g, w, h, r) => {
    rect(g, '#2a2f3a', 0, 0, w, h);
    for (let y = 2; y < h; y += 6)
      for (let x = 2; x < w; x += 5) rect(g, r() > 0.45 ? '#f2d58a' : '#3b4252', x, y, 3, 4);
  },
  glass: (): Paint => (g, w, h, r) => {
    const grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#9fc6e0');
    grad.addColorStop(1, '#e8f3fa');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    rect(g, '#ffffff', w * 0.2, 0, 2, h);
    void r;
  },
  screen:
    (colour = '#3a7bd5'): Paint =>
    (g, w, h, r) => {
      rect(g, '#0d1018', 0, 0, w, h);
      rect(g, colour, 2, 2, w - 4, h - 4);
      for (let y = 5; y < h - 4; y += 4)
        rect(g, shade(colour, 0.4), 4, y, (w - 10) * (0.3 + r() * 0.7), 2);
    },
  earth: (): Paint => (g, w, h, r) => {
    rect(g, '#1d4f8f', 0, 0, w, h);
    for (let i = 0; i < 9; i++) {
      const cx = r() * w,
        cy = h * (0.2 + r() * 0.6);
      for (let k = 0; k < 14; k++) {
        g.fillStyle = r() > 0.3 ? '#4f8a3a' : '#a08a5a';
        g.beginPath();
        g.ellipse(
          cx + (r() - 0.5) * 26,
          cy + (r() - 0.5) * 14,
          4 + r() * 8,
          3 + r() * 6,
          r() * 3,
          0,
          Math.PI * 2,
        );
        g.fill();
      }
    }
    rect(g, '#f2f5f8', 0, 0, w, h * 0.06);
    rect(g, '#f2f5f8', 0, h * 0.94, w, h * 0.06);
    for (let i = 0; i < 30; i++) {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      g.fillRect(r() * w, r() * h, 6 + r() * 14, 2);
    }
  },
  sun: (): Paint => (g, w, h, r) => noise(g, w, h, r, '#ffb02e', 0.2),
  moon: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#b9b6ae', 0.12);
    for (let i = 0; i < 12; i++) {
      g.fillStyle = '#8f8c85';
      g.beginPath();
      g.arc(r() * w, r() * h, 1 + r() * 4, 0, Math.PI * 2);
      g.fill();
    }
  },
  flesh:
    (colour = '#c9564e'): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.25, 2);
      g.strokeStyle = shade(colour, -0.35);
      for (let i = 0; i < 8; i++) {
        g.beginPath();
        g.moveTo(r() * w, r() * h);
        g.quadraticCurveTo(r() * w, r() * h, r() * w, r() * h);
        g.stroke();
      }
    },
  money: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#8fae7a', 0.08);
    g.strokeStyle = '#4a6a3e';
    g.strokeRect(1.5, 1.5, w - 3, h - 3);
    g.fillStyle = '#4a6a3e';
    g.beginPath();
    g.arc(w / 2, h / 2, h / 4, 0, Math.PI * 2);
    g.fill();
  },
  fur:
    (colour: string): Paint =>
    (g, w, h, r) => {
      noise(g, w, h, r, colour, 0.18);
      for (let i = 0; i < w * 2; i++)
        rect(g, shade(colour, (r() - 0.5) * 0.4), r() * w, r() * h, 1, 2);
    },
  cowHide: (): Paint => (g, w, h, r) => {
    noise(g, w, h, r, '#ece8df', 0.05);
    g.fillStyle = '#1e1c1a';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.ellipse(r() * w, r() * h, 1.5 + r() * 2.5, 1 + r() * 2, r() * 3, 0, Math.PI * 2);
      g.fill();
    }
  },
};
