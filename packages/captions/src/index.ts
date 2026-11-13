// Automatic captions (ADR-011, ADR-032): groups timed words into captions and compiles them,
// with a style, into an ASS subtitle file. The same file is drawn by libass in the preview
// (JASSUB) and in the export (FFmpeg's `ass` filter), so both look the same.
import {
  DEFAULT_CAPTIONS,
  FLICKS_PER_SECOND,
  applyTranscriptEdits,
  sequenceWords,
  type TimelineItem,
  type CaptionSettings,
  type CaptionStyleId,
  type Sequence,
  type TranscriptEdits,
  type TranscriptWord,
} from '@rec-it/core';

/** A word on the timeline, in seconds. */
export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionLine {
  words: CaptionWord[];
}

export interface Caption {
  start: number;
  end: number;
  lines: CaptionLine[];
  /** Per-caption placement (caption clips): offset as a fraction of the frame, size, angle. */
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  /** Higher is drawn on top (upper caption tracks). */
  layer?: number;
}

type Animation = 'highlight' | 'pop' | 'karaoke' | 'none';

export interface CaptionStyle {
  id: CaptionStyleId;
  name: string;
  /** Font family as libass looks it up (see FONT_FILES). */
  font: string;
  bold: boolean;
  /** Text height in pixels for a 1920-pixel-high frame. */
  size: number;
  fill: string;
  outline: string;
  /** Outline width in pixels at 1920 high. */
  outlineWidth: number;
  shadow: number;
  /** A box behind each line instead of an outline (colour with alpha, "#RRGGBBAA"). */
  box?: string;
  animation: Animation;
  /** Letter spacing in pixels at 1920 high. */
  spacing?: number;
  uppercase?: boolean;
}

/** The built-in looks. The user's settings (size, position, colour, …) apply on top. */
export const CAPTION_STYLE_DEFS: Record<CaptionStyleId, CaptionStyle> = {
  highlight: {
    id: 'highlight',
    name: 'Highlight',
    font: 'Montserrat ExtraBold',
    bold: false,
    size: 84,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 7,
    shadow: 0,
    animation: 'highlight',
  },
  pop: {
    id: 'pop',
    name: 'Pop',
    font: 'Montserrat Black',
    bold: false,
    size: 112,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 8,
    shadow: 4,
    animation: 'pop',
    uppercase: true,
  },
  karaoke: {
    id: 'karaoke',
    name: 'Karaoke',
    font: 'Poppins',
    bold: true,
    size: 80,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 6,
    shadow: 0,
    animation: 'karaoke',
  },
  caps: {
    id: 'caps',
    name: 'Bold caps',
    font: 'Anton',
    bold: false,
    size: 104,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 7,
    shadow: 3,
    animation: 'highlight',
    spacing: 2,
    uppercase: true,
  },
  clean: {
    id: 'clean',
    name: 'Clean box',
    font: 'Poppins SemiBold',
    bold: false,
    size: 64,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 0,
    shadow: 0,
    box: '#000000B3',
    animation: 'none',
  },
  bebas: {
    id: 'bebas',
    name: 'Bebas',
    font: 'Bebas Neue',
    bold: false,
    size: 128,
    fill: '#FFFFFF',
    outline: '#000000',
    outlineWidth: 6,
    shadow: 0,
    animation: 'highlight',
    spacing: 3,
    uppercase: true,
  },
};

/** Font family → bundled file (resources/fonts). Both renderers get exactly these files. */
export const FONT_FILES: Record<string, string> = {
  'Montserrat ExtraBold': 'Montserrat-ExtraBold.ttf',
  'Montserrat Black': 'Montserrat-Black.ttf',
  Poppins: 'Poppins-Bold.ttf',
  'Poppins SemiBold': 'Poppins-SemiBold.ttf',
  Anton: 'Anton-Regular.ttf',
  'Bebas Neue': 'BebasNeue-Regular.ttf',
};

/** A pause this long (seconds) starts a new caption. */
const PAUSE = 0.7;
/** Longest a caption stays on screen. */
const MAX_DURATION = 4;
/** A caption stays up this long after its last word unless the next one starts sooner. */
const HOLD = 0.5;

/**
 * Groups words into captions: up to `wordsPerLine × lines` words, a new caption after a sentence
 * end or a pause, and never longer than four seconds. Lines are balanced.
 */
export function segmentCaptions(
  words: readonly CaptionWord[],
  opts: { wordsPerLine: number; lines: 1 | 2; oneWord?: boolean },
): Caption[] {
  const max = opts.oneWord ? 1 : Math.max(1, opts.wordsPerLine) * opts.lines;
  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  for (const w of words) {
    const prev = current.at(-1);
    const breakHere =
      current.length >= max ||
      (prev &&
        (w.start - prev.end > PAUSE ||
          /[.!?…]["')\]]*$/.test(prev.text) ||
          w.end - current[0]!.start > MAX_DURATION));
    if (breakHere && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(w);
  }
  if (current.length) groups.push(current);

  return groups.map((group, i) => {
    const next = groups[i + 1]?.[0];
    const last = group.at(-1)!;
    const end = next ? Math.min(next.start, last.end + HOLD) : last.end + HOLD;
    const lineCount = Math.min(
      opts.lines,
      Math.ceil(group.length / Math.max(1, opts.wordsPerLine)),
    );
    const per = Math.ceil(group.length / lineCount);
    const lines: CaptionLine[] = [];
    for (let l = 0; l < lineCount; l++) {
      const slice = group.slice(l * per, (l + 1) * per);
      if (slice.length) lines.push({ words: slice });
    }
    return { start: group[0]!.start, end: Math.max(end, last.end), lines };
  });
}

/** "#RRGGBB" or "#RRGGBBAA" → ASS "&HAABBGGRR" (ASS alpha: 00 = opaque). */
export function assColour(hex: string): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex);
  if (!m) throw new Error(`Bad colour ${hex}`);
  const alpha = m[4] ? 255 - parseInt(m[4], 16) : 0;
  const h = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
  return `&H${h(alpha)}${m[3]!.toUpperCase()}${m[2]!.toUpperCase()}${m[1]!.toUpperCase()}`;
}

/** Seconds → ASS time (h:mm:ss.cc), rounded to the nearest centisecond. */
export function assTime(seconds: number): string {
  const cs = Math.max(0, Math.round(seconds * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Text safe inside an ASS event (no override blocks or escapes from the user's words). */
function clean(text: string, upper: boolean): string {
  const t = text.replace(/[{}]/g, '').replace(/\\/g, '/');
  return upper ? t.toLocaleUpperCase('en') : t;
}

/**
 * Compiles captions into an ASS file for a `width × height` frame, grouping the words with the
 * settings first. Times are timeline seconds.
 */
export function compileAss(
  words: readonly CaptionWord[],
  settings: CaptionSettings,
  frame: { width: number; height: number },
): string {
  const style = CAPTION_STYLE_DEFS[settings.style];
  const captions = segmentCaptions(words, {
    wordsPerLine: settings.wordsPerLine,
    lines: settings.lines,
    oneWord: style.animation === 'pop',
  });
  return compileCaptions(captions, settings, frame);
}

/** Compiles already-grouped captions (e.g. caption clips) into an ASS file. */
export function compileCaptions(
  captions: readonly Caption[],
  settings: CaptionSettings,
  frame: { width: number; height: number },
): string {
  const style = CAPTION_STYLE_DEFS[settings.style];
  const scale = (frame.height / 1920) * settings.size;
  const upper = settings.uppercase || !!style.uppercase;
  const px = (n: number) => Math.round(n * scale * 100) / 100;
  const hi = assColour(settings.highlight);
  const x = Math.round(frame.width / 2);
  const y = Math.round(frame.height * settings.position);
  const box = !!style.box;
  // Karaoke fills from SecondaryColour (not yet sung) to PrimaryColour (sung).
  const primary = style.animation === 'karaoke' ? hi : assColour(style.fill);
  const secondary = assColour(style.fill);

  const header = [
    '[Script Info]',
    '; Generated by Rec-It',
    'ScriptType: v4.00+',
    `PlayResX: ${frame.width}`,
    `PlayResY: ${frame.height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    [
      'Style: Caption',
      style.font,
      px(style.size),
      primary,
      secondary,
      box ? assColour(style.box!) : assColour(style.outline),
      box ? assColour(style.box!) : '&H80000000',
      style.bold ? -1 : 0,
      0,
      0,
      0,
      100,
      100,
      px(style.spacing ?? 0),
      0,
      box ? 3 : 1,
      box ? px(18) : px(style.outlineWidth),
      px(style.shadow),
      5,
      0,
      0,
      0,
      1,
    ].join(','),
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  let pos = '';
  let layer = 0;
  const dialogue = (start: number, end: number, text: string) => {
    if (assTime(end) === assTime(start)) return;
    events.push(
      `Dialogue: ${layer},${assTime(start)},${assTime(end)},Caption,,0,0,0,,${pos}${text}`,
    );
  };
  const lineText = (cap: Caption, render: (w: CaptionWord, i: number) => string) => {
    let i = 0;
    return cap.lines.map((line) => line.words.map((w) => render(w, i++)).join(' ')).join('\\N');
  };

  for (const cap of captions) {
    const all = cap.lines.flatMap((l) => l.words);
    if (!all.length) continue;
    layer = cap.layer ?? 0;
    const cx = Math.round(x + (cap.x ?? 0) * frame.width);
    const cy = Math.round(y + (cap.y ?? 0) * frame.height);
    const k = Math.round((cap.scale ?? 1) * 100);
    const angle = Math.round(-(cap.rotation ?? 0) * 100) / 100;
    pos = `{\\an5\\pos(${cx},${cy})${k !== 100 ? `\\fscx${k}\\fscy${k}` : ''}${angle ? `\\frz${angle}` : ''}}`;
    switch (style.animation) {
      case 'none':
        dialogue(
          cap.start,
          cap.end,
          lineText(cap, (w) => clean(w.text, upper)),
        );
        break;
      case 'pop': {
        if (all.length > 1) {
          // A caption clip with several words: each word pops up in turn.
          all.forEach((w, k2) => {
            const from = k2 === 0 ? cap.start : w.start;
            const to = k2 + 1 < all.length ? all[k2 + 1]!.start : cap.end;
            const kk = (cap.scale ?? 1) * 100;
            const f = (n: number) => Math.round(kk * n);
            dialogue(
              from,
              to,
              `{\\fscx${f(0.7)}\\fscy${f(0.7)}\\t(0,90,\\fscx${f(1.08)}\\fscy${f(1.08)})\\t(90,160,\\fscx${f(1)}\\fscy${f(1)})}{\\c${hi}}${clean(w.text, upper)}`,
            );
          });
          break;
        }
        const w = all[0]!;
        const kk = (cap.scale ?? 1) * 100;
        const f = (n: number) => Math.round(kk * n);
        const grow = `{\\fscx${f(0.7)}\\fscy${f(0.7)}\\t(0,90,\\fscx${f(1.08)}\\fscy${f(1.08)})\\t(90,160,\\fscx${f(1)}\\fscy${f(1)})}`;
        dialogue(cap.start, cap.end, `${grow}{\\c${hi}}${clean(w.text, upper)}`);
        break;
      }
      case 'karaoke': {
        // \kf durations in centiseconds, including the pause before each word.
        let t = cap.start;
        const text = lineText(cap, (w, i) => {
          const next = all[i + 1];
          const until = next ? next.start : w.end;
          const lead = Math.round((w.start - t) * 100);
          const dur = Math.max(1, Math.round((until - w.start) * 100));
          t = until;
          return `${lead > 0 ? `{\\k${lead}}` : ''}{\\kf${dur}}${clean(w.text, upper)}`;
        });
        dialogue(cap.start, cap.end, text);
        break;
      }
      case 'highlight':
        // One event per spoken word, with that word in the highlight colour.
        all.forEach((current, k) => {
          const from = k === 0 ? cap.start : current.start;
          const to = k + 1 < all.length ? all[k + 1]!.start : cap.end;
          const text = lineText(cap, (w, i) =>
            i === k ? `{\\c${hi}}${clean(w.text, upper)}{\\c${primary}}` : clean(w.text, upper),
          );
          dialogue(from, to, text);
        });
        break;
    }
  }
  return [...header, ...events, ''].join('\n');
}

/** Caption clips' words in timeline seconds (only the part of each clip that is shown). */
export function captionClipWords(item: TimelineItem): CaptionWord[] {
  if (!item.caption) return [];
  const from = item.sourceIn;
  const to = item.sourceIn + item.duration;
  const sec = (f: number) => f / FLICKS_PER_SECOND;
  const offset = item.start - item.sourceIn;
  return item.caption.words
    .filter((w) => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to)
    .map((w) => ({
      text: w.text,
      start: sec(Math.max(w.start, from) + offset),
      end: sec(Math.min(w.end, to) + offset),
    }));
}

/** The words of a caption clip grouped into lines with the sequence's settings. */
export function captionClipLines(
  words: readonly CaptionWord[],
  settings: Pick<CaptionSettings, 'wordsPerLine' | 'lines'>,
): CaptionLine[] {
  if (!words.length) return [];
  const perLine = Math.max(1, settings.wordsPerLine);
  const count = Math.min(settings.lines, Math.ceil(words.length / perLine));
  const per = Math.ceil(words.length / count);
  const lines: CaptionLine[] = [];
  for (let l = 0; l < count; l++) {
    const slice = words.slice(l * per, (l + 1) * per);
    if (slice.length) lines.push({ words: slice });
  }
  return lines;
}

/**
 * Captions for a sequence's caption tracks (ADR-033): each caption clip, with its own position,
 * size and rotation, in the sequence's caption style. null when there are none. Preview and
 * export both call this, so they draw the same file.
 */
export function sequenceCaptionsAss(seq: Sequence): string | null {
  const tracks = seq.tracks.filter((t) => t.kind === 'caption' && !t.hidden);
  const settings = { ...DEFAULT_CAPTIONS, ...seq.captions };
  const captions: Caption[] = [];
  tracks.forEach((track, i) => {
    for (const item of track.items) {
      const words = captionClipWords(item);
      if (!words.length) continue;
      captions.push({
        start: item.start / FLICKS_PER_SECOND,
        end: (item.start + item.duration) / FLICKS_PER_SECOND,
        lines: captionClipLines(words, settings),
        x: item.transform.x,
        y: item.transform.y,
        scale: item.transform.scale,
        rotation: item.transform.rotation,
        layer: tracks.length - i,
      });
    }
  });
  if (!captions.length) return null;
  return compileCaptions(captions, settings, { width: seq.width, height: seq.height });
}

/**
 * Caption clips for a sequence from its transcripts (the words its clips play, with the user's
 * corrections; hidden words left out), grouped with the caption settings. For the
 * captions.generate command.
 */
export function generateCaptions(
  seq: Sequence,
  transcriptOf: (assetId: string) => readonly TranscriptWord[] | undefined,
  edits: TranscriptEdits | undefined,
): { start: number; duration: number; words: { text: string; start: number; end: number }[] }[] {
  const settings = { ...DEFAULT_CAPTIONS, ...seq.captions };
  const cache = new Map<string, ReturnType<typeof applyTranscriptEdits> | undefined>();
  const wordsOf = (assetId: string) => {
    if (!cache.has(assetId)) {
      const words = transcriptOf(assetId);
      cache.set(assetId, words ? applyTranscriptEdits(words, edits?.[assetId]) : undefined);
    }
    return cache.get(assetId);
  };
  const words = sequenceWords(seq, wordsOf).filter((w) => !w.hidden);
  const f = (s: number) => Math.round(s * FLICKS_PER_SECOND);
  return segmentCaptions(words, {
    wordsPerLine: settings.wordsPerLine,
    lines: settings.lines,
    oneWord: CAPTION_STYLE_DEFS[settings.style].animation === 'pop',
  }).map((c) => ({
    start: f(c.start),
    duration: f(c.end) - f(c.start),
    words: c.lines
      .flatMap((l) => l.words)
      .map((w) => ({ text: w.text, start: f(w.start), end: f(w.end) })),
  }));
}
