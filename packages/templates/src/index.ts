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

export interface StoryShortInput {
  sequenceId: string;
  name: string;
  /** The generated narration (title then story), with word times in its own seconds. */
  voice: Media & { words: readonly TranscriptWord[]; titleEnd: number };
  /** The title card image, or none (captions only). */
  card?: { assetId: string };
  background: Media & {
    /** Where in the footage to start (seconds). */
    start: number;
    /** Keep the footage's own sound (quietly). */
    keepSound?: boolean;
  };
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
  if (background.duration <= 0.5) throw new Error('The background video is too short.');
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
  // Background: as many pieces of footage as needed to cover the story, muted by default.
  let at = 0;
  let n = 0;
  let from = Math.min(Math.max(0, background.start), Math.max(0, background.duration - 1));
  while (at < length - 0.01 && n < 200) {
    const take = Math.min(background.duration - from, length - at);
    commands.push({
      type: 'item.add',
      sequenceId: sid,
      trackId: track('V1'),
      assetId: background.assetId,
      id: ids.background(n),
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
