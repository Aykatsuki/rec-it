// Where a caption clip sits in the frame, for selecting and dragging it in the preview (ADR-033).
// libass draws the text; here the same bundled fonts are measured with a 2D canvas, which gives
// a box close enough to grab and transform.
import {
  CAPTION_STYLE_DEFS,
  FONT_FILES,
  captionClipLines,
  captionClipWords,
} from '@rec-it/captions';
import { DEFAULT_CAPTIONS, type Sequence, type TimelineItem, type Transform } from '@rec-it/core';

const fontUrls = import.meta.glob('../../../../../../resources/fonts/*.ttf', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

let fontsLoaded = false;
/** Loads the caption fonts into the page (style buttons and caption measuring use them). */
export function ensureCaptionFonts(): void {
  if (fontsLoaded || typeof FontFace === 'undefined') return;
  fontsLoaded = true;
  for (const [family, file] of Object.entries(FONT_FILES)) {
    const url = Object.entries(fontUrls).find(([p]) => p.endsWith(`/${file}`))?.[1];
    if (!url) continue;
    const face = new FontFace(`Caption ${family}`, `url(${url})`);
    document.fonts.add(face);
    void face.load().catch(() => {});
  }
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  rotation: number;
  /** Axis-aligned box around the rotated rectangle. */
  bounds: { left: number; top: number; width: number; height: number };
}

let measure: CanvasRenderingContext2D | null = null;

/** The caption clip's text box in sequence pixels, with transform `t`; null if it has no words. */
export function captionBox(seq: Sequence, item: TimelineItem, t: Transform): Box | null {
  const words = captionClipWords(item);
  if (!words.length) return null;
  ensureCaptionFonts();
  const settings = { ...DEFAULT_CAPTIONS, ...seq.captions };
  const style = CAPTION_STYLE_DEFS[settings.style];
  const upper = settings.uppercase || !!style.uppercase;
  const px = style.size * (seq.height / 1920) * settings.size * t.scale;
  measure ??= document.createElement('canvas').getContext('2d');
  const lines =
    style.animation === 'pop'
      ? [[words.reduce((a, b) => (b.text.length > a.text.length ? b : a))]]
      : captionClipLines(words, settings).map((l) => l.words);
  let width = 0;
  if (measure) {
    measure.font = `${style.bold ? 700 : 400} ${px}px "Caption ${style.font}", sans-serif`;
    for (const line of lines) {
      const text = line.map((w) => (upper ? w.text.toLocaleUpperCase('en') : w.text)).join(' ');
      const spacing = ((style.spacing ?? 0) * px * text.length) / style.size;
      width = Math.max(width, measure.measureText(text).width + spacing);
    }
  } else {
    width = Math.max(...lines.map((l) => l.map((w) => w.text).join(' ').length)) * px * 0.55;
  }
  const pad = ((style.box ? 18 : style.outlineWidth) * px) / style.size;
  width += 2 * pad;
  const height = lines.length * px * 1.22 + 2 * pad;
  const cx = seq.width / 2 + t.x * seq.width;
  const cy = seq.height * settings.position + t.y * seq.height;
  const r = (t.rotation * Math.PI) / 180;
  const bw = Math.abs(width * Math.cos(r)) + Math.abs(height * Math.sin(r));
  const bh = Math.abs(width * Math.sin(r)) + Math.abs(height * Math.cos(r));
  return {
    left: cx - width / 2,
    top: cy - height / 2,
    width,
    height,
    rotation: t.rotation,
    bounds: { left: cx - bw / 2, top: cy - bh / 2, width: bw, height: bh },
  };
}
