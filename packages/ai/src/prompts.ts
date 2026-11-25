// Prompts and answer schemas for one-click features. Kept short: small local models follow
// short, concrete instructions best, and every token counts with a paid key.
import { z } from 'zod';
import type { ChatMessage } from './index';

/** Spoken words per second for a story narrator at normal speed. */
export const WORDS_PER_SECOND = 2.6;

export const STORY_GENRES = {
  aita: { label: 'Am I wrong? (AITA)', community: 'r/AmItheAsshole' },
  tifu: { label: 'I messed up (TIFU)', community: 'r/tifu' },
  revenge: { label: 'Petty revenge', community: 'r/pettyrevenge' },
  relationship: { label: 'Relationship drama', community: 'r/relationship_advice' },
  scary: { label: 'Scary story', community: 'r/nosleep' },
  wholesome: { label: 'Wholesome', community: 'r/MadeMeSmile' },
  askreddit: { label: 'Question thread', community: 'r/AskReddit' },
  facts: { label: 'Facts / explainer about a topic', community: '' },
  motivation: { label: 'Motivation / life lesson', community: '' },
  history: { label: 'History or mystery story', community: '' },
} as const;
/** Kinds that are narrated scripts about a topic rather than first-person posts. */
export const SCRIPT_GENRES: readonly StoryGenre[] = ['facts', 'motivation', 'history'];
export type StoryGenre = keyof typeof STORY_GENRES;

export const storySchema = z.object({
  title: z.string().min(5).max(200),
  story: z.string().min(40).max(6000),
  username: z.string().max(40).optional(),
});
export type Story = z.output<typeof storySchema>;

const NARRATION_RULES = [
  'It will be read aloud by a text-to-speech voice over gameplay footage as a YouTube Short.',
  'Write plain spoken English: no emojis, hashtags, markdown, lists, "Edit:" or "TL;DR" lines.',
  'Spell out abbreviations the way they are said ("Am I the jerk", not "AITA"; "my sister, twenty nine" not "29F").',
  'Open with a line that makes people keep watching, keep paragraphs short, and end on a twist, verdict or question that invites comments.',
  'Fiction only: no real people, brands, or places that could identify someone; nothing sexual or hateful.',
];

/** A new story from an idea (or from nothing but the genre). */
export function writeStoryPrompt(o: {
  genre: StoryGenre;
  idea?: string;
  seconds: number;
}): ChatMessage[] {
  const words = Math.round(o.seconds * WORDS_PER_SECOND);
  const g = STORY_GENRES[o.genre];
  if (SCRIPT_GENRES.includes(o.genre))
    return [
      {
        role: 'system',
        content: `You write scripts for faceless YouTube Shorts narrated over AI pictures. ${NARRATION_RULES.slice(0, 3).join(' ')} Use short, vivid sentences that each describe something that can be pictured. Be accurate: no invented statistics; if unsure, say "reportedly". Reply with JSON only: {"title": "...", "story": "..."}.`,
      },
      {
        role: 'user',
        content: `Kind: ${g.label}.${o.idea?.trim() ? ` Topic: ${o.idea.trim()}` : ' Pick a fascinating topic.'}\nTitle: a hook of under 70 characters that makes people stop scrolling.\nScript: about ${words} words (${o.seconds} seconds when read), not counting the title.`,
      },
    ];
  return [
    {
      role: 'system',
      content: `You write viral first-person stories in the style of ${g.community} posts. ${NARRATION_RULES.join(' ')} Reply with JSON only: {"title": "...", "story": "...", "username": "..."}.`,
    },
    {
      role: 'user',
      content: `Genre: ${g.label}.${o.idea?.trim() ? ` Idea: ${o.idea.trim()}` : ' Invent a fresh, specific situation.'}\nTitle: one sentence, like a post title (under 110 characters).\nStory: about ${words} words (${o.seconds} seconds when read), not counting the title.\nUsername: a believable throwaway username.`,
    },
  ];
}

/** A pasted post made ready to be read aloud, cut to length. */
export function narrationPrompt(o: {
  title: string;
  text: string;
  seconds: number;
}): ChatMessage[] {
  const words = Math.round(o.seconds * WORDS_PER_SECOND);
  return [
    {
      role: 'system',
      content: `You prepare posts for narration. ${NARRATION_RULES.slice(0, 4).join(' ')} Keep the author's story, voice and ending; cut repetition and side details to fit. Reply with JSON only: {"title": "...", "story": "..."}.`,
    },
    {
      role: 'user',
      content: `Make this fit about ${words} words (${o.seconds} seconds).\nTitle: ${o.title}\nPost:\n${o.text.slice(0, 12000)}`,
    },
  ];
}

/** Spoken length of a text at a speed, in seconds (for planning, before the voice exists). */
export function estimateSeconds(text: string, speed = 1): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND / speed;
}

// ---- Scenes (ADR-047) -----------------------------------------------------------------------

export const PICTURE_STYLES = {
  // The look of hand-drawn history and explainer channels: simple stick figures with round white
  // heads in detailed, muted, hand-drawn scenes.
  cartoon: {
    label: 'Stick-figure cartoon',
    prompt:
      '2D cartoon illustration, simple stick-figure people with round plain white heads, dot eyes ' +
      'and subtle, understated facial expressions, bold clean black outlines, flat muted colours ' +
      'with soft shading, detailed hand-drawn background, webcomic explainer style',
  },
  cinematic: {
    label: 'Cinematic photo',
    prompt:
      'cinematic photograph, dramatic lighting, shallow depth of field, rich colour, highly detailed',
  },
  anime: {
    label: 'Anime',
    prompt:
      'anime illustration, clean line art, vibrant colours, detailed background, studio quality',
  },
  render3d: {
    label: '3D render',
    prompt: '3D render, soft global illumination, stylised, octane render, highly detailed',
  },
  comic: {
    label: 'Comic book',
    prompt: 'comic book art, bold ink outlines, halftone shading, dynamic composition',
  },
  watercolour: {
    label: 'Watercolour',
    prompt: 'watercolour painting, soft washes, paper texture, gentle colours',
  },
  dark: {
    label: 'Dark and moody',
    prompt: 'dark moody photograph, low key lighting, fog, high contrast, cinematic',
  },
  historical: {
    label: 'Historical painting',
    prompt: 'oil painting in the style of an old master, historical scene, dramatic chiaroscuro',
  },
} as const;
export type PictureStyle = keyof typeof PICTURE_STYLES;

export const MOTIONS = ['zoomIn', 'zoomOut', 'panLeft', 'panRight'] as const;
export type Motion = (typeof MOTIONS)[number];

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const scenePlanSchema = z.object({
  scenes: z
    .array(
      z.object({
        /** First and last sentence numbers (as given, from 1) this scene covers. */
        from: z.number().int().min(1),
        to: z.number().int().min(1),
        /** What the picture shows (subject, setting, action); no text in the picture. */
        picture: z.string().min(3).max(400),
        motion: z.enum(MOTIONS).optional(),
        /** Three colours for a motion-graphics backdrop matching the mood. */
        palette: z.array(hex).min(2).max(4).optional(),
      }),
    )
    .min(1)
    .max(40),
});
export type ScenePlan = z.output<typeof scenePlanSchema>;

/** Splits a script into scenes (groups of numbered sentences) with a picture and colours each. */
export function scenePlanPrompt(o: {
  title: string;
  sentences: readonly string[];
  /** Roughly how many scenes (one picture every 3–6 seconds). */
  scenes: number;
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You are a storyboard artist for vertical YouTube Shorts. Split the numbered narration into scenes of consecutive sentences, in order, covering every sentence once. For each scene describe ONE striking picture for an image generator: concrete subject, setting, action, camera angle and lighting, consistent characters across scenes, no words or letters in the picture. Pick a camera motion (zoomIn, zoomOut, panLeft, panRight) and a palette of 3 hex colours matching the mood. Reply with JSON only: {"scenes": [{"from": 1, "to": 2, "picture": "...", "motion": "zoomIn", "palette": ["#112233", "#445566", "#778899"]}]}.',
    },
    {
      role: 'user',
      content: `Title: ${o.title}\nAbout ${o.scenes} scenes.\nNarration:\n${o.sentences.map((t, i) => `${i + 1}. ${t}`).join('\n')}`,
    },
  ];
}

// ---- Episodes from a brief (ADR-052) -----------------------------------------------------------

const id = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,23}$/)
  .or(
    z.string().transform(
      (s) =>
        s
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '')
          .slice(0, 24) || 'character',
    ),
  );

export const episodePlanSchema = z.object({
  title: z.string().min(1).max(120),
  /** Visual style keywords appended to every picture prompt. */
  style: z.string().min(3).max(400),
  characters: z
    .array(
      z.object({
        id,
        name: z.string().min(1).max(60),
        gender: z.enum(['male', 'female']).catch('male'),
        age: z.enum(['young', 'adult', 'old']).catch('adult'),
        /** Fixed look: face, hair, build, clothing, armour, weapons, colours. */
        look: z.string().min(3).max(500),
      }),
    )
    .max(6)
    .default([]),
  // Lenient on purpose: a local model often gets one shot slightly wrong (an empty speaker or
  // line); that shot is repaired or dropped by normaliseEpisode instead of failing the episode.
  shots: z
    .array(
      z
        .object({
          /** "narrator" or a character id. */
          speaker: z.string().max(60).catch('narrator'),
          /** What is said in this shot (narration or dialogue), spoken aloud. */
          text: z.string().max(600).catch(''),
          /** What the picture shows; for dialogue, a close-up of the speaker facing the camera. */
          picture: z.string().max(800).catch(''),
          /** Character ids visible in the picture. */
          characters: z.array(z.string()).catch([]).default([]),
          motion: z.enum(MOTIONS).optional().catch(undefined),
        })
        .catch({ speaker: 'narrator', text: '', picture: '', characters: [] }),
    )
    .min(1)
    .max(40),
});
export type EpisodePlan = z.output<typeof episodePlanSchema>;

/** Turns a brief (style, story, dialogue, narration notes) into an episode plan for a Short. */
export function episodePrompt(o: { brief: string; seconds: number }): ChatMessage[] {
  const words = Math.round(o.seconds * 2.4);
  return [
    {
      role: 'system',
      content:
        'You are the director and storyboard artist of a vertical (9:16) YouTube Short made of illustrated shots with a narrator and spoken dialogue. ' +
        `Turn the brief into a plan of 10 to 16 shots whose spoken text totals about ${words} words (about ${o.seconds} seconds). ` +
        'Rules: follow the story and dialogue of the brief in order; narration is vivid, short sentences, building suspense; keep dialogue lines exactly as written in the brief; ' +
        'every line of dialogue gets its own shot whose speaker is that character and whose picture is a close-up of that character facing the camera, face clearly visible, mouth closed; ' +
        'narration shots have speaker "narrator"; ' +
        'describe each character ONCE in "look" with fixed, specific details (face, hair, build, clothing, armour, weapons, colours) and never change them; ' +
        'each picture describes ONE striking frame: subject, setting, action, camera angle, lighting, no text or letters; list the visible character ids; ' +
        'pick a camera motion per shot (zoomIn, zoomOut, panLeft, panRight); ' +
        '"style" is a short list of visual style keywords taken from the brief (for example: 2D anime illustration, dark fantasy, black and crimson palette). ' +
        'Reply with JSON only: {"title": "...", "style": "...", "characters": [{"id": "hiroshi", "name": "Hiroshi Takeda", "gender": "male", "age": "young", "look": "..."}], ' +
        '"shots": [{"speaker": "narrator", "text": "...", "picture": "...", "characters": ["hiroshi"], "motion": "zoomIn"}]}.',
    },
    { role: 'user', content: o.brief.trim() },
  ];
}
