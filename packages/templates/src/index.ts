// Faceless Short templates (ADR-046). Pure: given the generated voiceover (with word times), the
// title card and the background footage, build the whole Short as one batch of ordinary timeline
// commands, so the result is plain clips and captions the user can edit and undo in one step.
import { generateCaptions } from '@rec-it/captions';
import {
  DEFAULT_CAPTIONS,
  secondsToFlicks,
  type CaptionSettings,
  type CaptionStyleId,
  type Command,
  type Flicks,
  type Sequence,
  type TranscriptWord,
} from '@rec-it/core';

/** Kokoro voices offered in the app (English). */
export const VOICES = [
  { id: 'af_heart', label: 'Heart', accent: 'US', gender: 'female', note: 'warm, natural' },
  { id: 'af_bella', label: 'Bella', accent: 'US', gender: 'female', note: 'bright' },
  { id: 'af_nicole', label: 'Nicole', accent: 'US', gender: 'female', note: 'soft, close' },
  { id: 'af_sarah', label: 'Sarah', accent: 'US', gender: 'female', note: 'clear' },
  { id: 'af_sky', label: 'Sky', accent: 'US', gender: 'female', note: 'young' },
  { id: 'am_adam', label: 'Adam', accent: 'US', gender: 'male', note: 'deep storyteller' },
  { id: 'am_michael', label: 'Michael', accent: 'US', gender: 'male', note: 'calm' },
  { id: 'am_eric', label: 'Eric', accent: 'US', gender: 'male', note: 'confident' },
  { id: 'am_liam', label: 'Liam', accent: 'US', gender: 'male', note: 'friendly' },
  { id: 'am_onyx', label: 'Onyx', accent: 'US', gender: 'male', note: 'low, serious' },
  { id: 'am_fenrir', label: 'Fenrir', accent: 'US', gender: 'male', note: 'energetic' },
  { id: 'bf_emma', label: 'Emma', accent: 'UK', gender: 'female', note: 'British' },
  { id: 'bf_isabella', label: 'Isabella', accent: 'UK', gender: 'female', note: 'British' },
  { id: 'bm_george', label: 'George', accent: 'UK', gender: 'male', note: 'British' },
  { id: 'bm_lewis', label: 'Lewis', accent: 'UK', gender: 'male', note: 'British' },
] as const;
export type VoiceId = (typeof VOICES)[number]['id'];
export const DEFAULT_VOICE: VoiceId = 'am_adam';

export interface Media {
  assetId: string;
  /** Seconds. */
  duration: number;
}

export interface Footage extends Media {
  kind?: 'footage';
  /** Where in the footage to start (seconds). */
  start: number;
  /** Keep the footage's own sound (quietly). */
  keepSound?: boolean;
}

/** A still (AI picture or motion-graphics backdrop) shown from `start` to `end` (timeline s). */
export interface ScenePicture {
  assetId: string;
  start: number;
  end: number;
  motion: Motion;
}

export const MOTIONS = ['zoomIn', 'zoomOut', 'panLeft', 'panRight'] as const;
export type Motion = (typeof MOTIONS)[number];

export interface StoryShortInput {
  sequenceId: string;
  name: string;
  /** The generated narration (title then story), with word times in its own seconds. */
  voice: Media & { words: readonly TranscriptWord[]; titleEnd: number };
  /** The title card image, or none (captions only). */
  card?: { assetId: string };
  /** Footage looped behind the story, or one generated picture per scene (ADR-047). */
  background: Footage | { kind: 'scenes'; scenes: readonly ScenePicture[] };
  music?: Media & { volume: number };
  captions: Partial<Pick<CaptionSettings, 'style' | 'position' | 'uppercase' | 'highlight'>>;
  /** Item ids (so callers and tests know them). */
  ids: { voice: string; card: string; background: (n: number) => string; music: string };
}

/** Seconds of picture after the last word. */
export const TAIL = 0.6;
/** How long the card takes to pop in. */
const POP = 0.25;

/** Default caption look for stories: big words in the middle of the frame. */
export const STORY_CAPTIONS: Pick<CaptionSettings, 'style' | 'position' | 'uppercase' | 'size'> = {
  style: 'pop' as CaptionStyleId,
  position: 0.5,
  uppercase: false,
  size: 1.4,
};

const f = secondsToFlicks;

/** The Short as one batch: background, card, voice, music and captions. */
export function storyShort(input: StoryShortInput): { command: Command; length: number } {
  const { sequenceId: sid, voice, background, card, music, ids } = input;
  if (background.kind !== 'scenes' && background.duration <= 0.5)
    throw new Error('The background video is too short.');
  const length = voice.duration + TAIL;
  const track = (name: string) => `${sid}-${name}`;
  const commands: Command[] = [
    {
      type: 'sequence.create',
      id: sid,
      name: input.name,
      width: 1080,
      height: 1920,
      fps: { num: 30, den: 1 },
      trackIds: { V2: track('V2'), V1: track('V1'), A1: track('A1'), A2: track('A2') },
    },
  ];
  if (background.kind === 'scenes')
    commands.push(...scenePictures(sid, track('V1'), background.scenes, length, ids.background));
  else commands.push(...footage(sid, track('V1'), background, length, ids.background));
  // Voiceover.
  commands.push({
    type: 'item.add',
    sequenceId: sid,
    trackId: track('A1'),
    assetId: voice.assetId,
    id: ids.voice,
    start: 0,
    duration: f(voice.duration),
  });
  // Title card while the title is read: pops in, fades out.
  if (card) {
    const shown = Math.min(length, voice.titleEnd + 0.25);
    commands.push(
      {
        type: 'item.add',
        sequenceId: sid,
        trackId: track('V2'),
        assetId: card.assetId,
        id: ids.card,
        start: 0,
        duration: f(shown),
        transform: { fit: 'fit', scale: 0.9, y: -0.05 },
      },
      {
        type: 'keyframe.set',
        sequenceId: sid,
        itemId: ids.card,
        property: 'scale',
        t: 0,
        value: 0.75,
        easing: 'ease',
      },
      {
        type: 'keyframe.set',
        sequenceId: sid,
        itemId: ids.card,
        property: 'scale',
        t: f(POP),
        value: 0.9,
        easing: 'linear',
      },
      {
        type: 'item.update',
        sequenceId: sid,
        itemId: ids.card,
        // No fade in: the first frame (often the thumbnail) shows the card.
        fade: { out: f(0.15) },
      },
    );
  }
  // Music bed under the voice, faded out at the end.
  if (music && music.duration > 0.5) {
    const len = Math.min(music.duration, length);
    commands.push(
      {
        type: 'item.add',
        sequenceId: sid,
        trackId: track('A2'),
        assetId: music.assetId,
        id: ids.music,
        start: 0,
        duration: f(len),
        volume: music.volume,
      },
      { type: 'item.update', sequenceId: sid, itemId: ids.music, fade: { out: f(1) } },
    );
  }
  // Captions for the story (the card shows the title), grouped by the caption settings.
  const settings = { ...DEFAULT_CAPTIONS, ...STORY_CAPTIONS, ...input.captions };
  commands.push({ type: 'captions.update', sequenceId: sid, captions: settings });
  const body = voice.words.filter((w) => !card || w.start >= voice.titleEnd - 0.01);
  const captions = generateCaptions(
    captionSequence(sid, voice, settings),
    (id) => (id === voice.assetId ? body : undefined),
    undefined,
  );
  if (captions.length) commands.push({ type: 'captions.generate', sequenceId: sid, captions });
  return { command: { type: 'batch', commands }, length };
}

/** Footage repeated to cover `length` seconds, muted by default. */
function footage(
  sid: string,
  trackId: string,
  background: Footage,
  length: number,
  id: (n: number) => string,
): Command[] {
  const out: Command[] = [];
  let at = 0;
  let n = 0;
  let from = Math.min(Math.max(0, background.start), Math.max(0, background.duration - 1));
  while (at < length - 0.01 && n < 200) {
    const take = Math.min(background.duration - from, length - at);
    out.push({
      type: 'item.add',
      sequenceId: sid,
      trackId,
      assetId: background.assetId,
      id: id(n),
      start: f(at),
      sourceIn: f(from),
      duration: f(take),
      transform: { fit: 'fill' },
      ...(background.keepSound ? { volume: 0.15 } : { muted: true }),
    });
    at += take;
    from = 0;
    n++;
  }
  return out;
}

/** How far a scene zooms or pans over its length. */
const ZOOM = 1.14;
const PAN = 0.06;
/** Cross-dissolve between scenes. */
const DISSOLVE = 0.3;
/** Shortest scene worth showing (seconds); a dissolve needs room on both sides. */
const MIN_SCENE = 0.7;

/**
 * One still per scene, edge to edge, each slowly zooming or panning (keyframes, so it stays
 * editable), with a short dissolve between scenes.
 */
function scenePictures(
  sid: string,
  trackId: string,
  scenes: readonly ScenePicture[],
  length: number,
  id: (n: number) => string,
): Command[] {
  const out: Command[] = [];
  // Boundaries in flicks, computed once, so each clip ends exactly where the next starts (the
  // dissolve needs that). A scene too short to show gives its time to the next scene's picture.
  const total = f(length);
  const shown: { sc: ScenePicture; n: number; start: number }[] = [];
  scenes.forEach((sc, n) => {
    const start = n === 0 ? 0 : Math.min(f(Math.max(0, sc.start)), total);
    const prev = shown[shown.length - 1];
    if (prev && start - prev.start < f(MIN_SCENE)) {
      // The earlier scene is too short: this scene's picture takes over its slot a moment early.
      if (shown.length > 1) shown[shown.length - 1] = { sc, n, start: prev.start };
      return;
    }
    shown.push({ sc, n, start });
  });
  if (shown.length > 1 && total - shown[shown.length - 1]!.start < f(MIN_SCENE)) shown.pop();
  shown.forEach(({ sc, n, start: startF }, k) => {
    const endF = k === shown.length - 1 ? total : shown[k + 1]!.start;
    const start = startF / f(1);
    const end = endF / f(1);
    const item = id(n);
    out.push({
      type: 'item.add',
      sequenceId: sid,
      trackId,
      assetId: sc.assetId,
      id: item,
      start: startF as Flicks,
      duration: (endF - startF) as Flicks,
      transform: { fit: 'fill' },
    });
    // Keyframe times are source time; a still's source time runs from 0 with the clip.
    const [p0, p1, v0, v1] =
      sc.motion === 'zoomIn'
        ? (['scale', 'scale', 1, ZOOM] as const)
        : sc.motion === 'zoomOut'
          ? (['scale', 'scale', ZOOM, 1] as const)
          : ([
              'x',
              'x',
              sc.motion === 'panLeft' ? PAN : -PAN,
              sc.motion === 'panLeft' ? -PAN : PAN,
            ] as const);
    if (p0 === 'x')
      out.push({ type: 'item.update', sequenceId: sid, itemId: item, transform: { scale: ZOOM } });
    out.push(
      {
        type: 'keyframe.set',
        sequenceId: sid,
        itemId: item,
        property: p0,
        t: 0,
        value: v0,
        easing: 'linear',
      },
      {
        type: 'keyframe.set',
        sequenceId: sid,
        itemId: item,
        property: p1,
        t: f(Math.max(0.05, end - start - 0.04)),
        value: v1,
        easing: 'linear',
      },
    );
    if (k > 0)
      out.push({
        type: 'transition.set',
        sequenceId: sid,
        itemId: item,
        kind: 'dissolve',
        duration: f(DISSOLVE),
      });
  });
  return out;
}

/** Just enough of the sequence for caption grouping: the voice at the start of an audio track. */
function captionSequence(id: string, voice: Media, captions: CaptionSettings): Sequence {
  return {
    id,
    name: '',
    width: 1080,
    height: 1920,
    fps: { num: 30, den: 1 },
    captions,
    tracks: [
      {
        id: 'a',
        name: 'A1',
        kind: 'audio',
        muted: false,
        hidden: false,
        locked: false,
        items: [
          {
            id: 'voice',
            assetId: voice.assetId,
            start: 0 as never,
            duration: f(voice.duration),
            sourceIn: 0 as never,
            volume: 1,
            muted: false,
            transform: { fit: 'fill', scale: 1, x: 0, y: 0, rotation: 0 },
          },
        ],
      },
    ],
  } as Sequence;
}

/** A random start inside the footage that leaves room for the story (seconds). */
export function randomStart(footage: number, needed: number, random = Math.random): number {
  const room = footage - needed;
  return room > 1 ? Math.round(random() * room * 10) / 10 : 0;
}

/** Text ready for the voice: no markdown, links, emojis or "Edit:" lines; tidy spacing. */
export function speakable(text: string): string {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !/^\s*(edit|update|tl;?dr)\b\s*\d*\s*[:\-–]/i.test(line))
    .join('\n')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_#>`~]+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Scenes (ADR-047) -----------------------------------------------------------------------

/** Sentences of a script; very long ones are split at commas so scenes stay short. */
export function splitSentences(text: string): string[] {
  const parts = speakable(text).match(/[^.!?…]+[.!?…]+["'”’)]*|[^.!?…]+$/g) ?? [];
  const out: string[] = [];
  for (const raw of parts.map((p) => p.trim()).filter(Boolean)) {
    if (raw.split(/\s+/).length <= 28) {
      out.push(raw);
      continue;
    }
    let cur = '';
    for (const piece of raw.split(/(?<=,)\s+/)) {
      if (cur && `${cur} ${piece}`.split(/\s+/).length > 22) {
        out.push(cur);
        cur = piece;
      } else cur = cur ? `${cur} ${piece}` : piece;
    }
    if (cur) out.push(cur);
  }
  return out;
}

export interface Scene {
  /** First and last sentence (0-based, inclusive). */
  from: number;
  to: number;
  text: string;
  picture: string;
  motion: Motion;
  palette: string[];
}

const PALETTES = [
  ['#0F172A', '#7C3AED', '#F472B6'],
  ['#FF7A18', '#AF002D', '#FFD166'],
  ['#00C9A7', '#003049', '#90E0EF'],
  ['#1D2B64', '#F8CDDA', '#6A82FB'],
  ['#11998E', '#38EF7D', '#F9F871'],
  ['#232526', '#414345', '#E94560'],
];

/** A plan without AI: about `count` scenes of consecutive sentences, picturing their words. */
export function fallbackScenes(sentences: readonly string[], count: number): Scene[] {
  const n = sentences.length;
  const k = Math.max(1, Math.min(n, Math.round(count)));
  const out: Scene[] = [];
  for (let i = 0; i < k; i++) {
    const from = Math.floor((i * n) / k);
    const to = Math.floor(((i + 1) * n) / k) - 1;
    const text = sentences.slice(from, to + 1).join(' ');
    out.push({
      from,
      to,
      text,
      picture: text,
      motion: MOTIONS[i % MOTIONS.length]!,
      palette: PALETTES[i % PALETTES.length]!,
    });
  }
  return out;
}

/**
 * Makes the AI's plan safe to use: scenes in order, covering every sentence exactly once (gaps
 * join the scene before, overlaps are trimmed), with a motion and palette each.
 */
export function normaliseScenes(
  planned: readonly {
    from: number;
    to: number;
    picture: string;
    motion?: Motion | undefined;
    palette?: string[] | undefined;
  }[],
  sentences: readonly string[],
): Scene[] {
  const n = sentences.length;
  if (!n) return [];
  const sorted = planned
    .map((p) => ({
      ...p,
      from: Math.max(0, Math.min(n - 1, p.from - 1)),
      to: Math.max(0, Math.min(n - 1, p.to - 1)),
    }))
    .filter((p) => p.to >= p.from)
    .sort((a, b) => a.from - b.from);
  const out: Scene[] = [];
  let next = 0;
  for (const p of sorted) {
    if (p.to < next) continue; // entirely covered already
    const from = out.length ? next : 0;
    out.push({
      from,
      to: p.to,
      text: '',
      picture: p.picture.trim(),
      motion: p.motion ?? MOTIONS[out.length % MOTIONS.length]!,
      palette: p.palette?.length ? p.palette : PALETTES[out.length % PALETTES.length]!,
    });
    next = p.to + 1;
  }
  if (!out.length) return fallbackScenes(sentences, Math.ceil(n / 2));
  if (next < n) out[out.length - 1]!.to = n - 1;
  for (const sc of out) sc.text = sentences.slice(sc.from, sc.to + 1).join(' ');
  return out;
}

/** About one picture every 4.5 seconds of narration, 3–24 pictures. */
export function sceneCount(seconds: number): number {
  return Math.max(3, Math.min(24, Math.round(seconds / 4.5)));
}
