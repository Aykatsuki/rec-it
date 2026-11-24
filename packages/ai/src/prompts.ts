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
} as const;
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
