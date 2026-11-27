// Prompts and answer schemas for one-click features. Kept short: small local models follow
// short, concrete instructions best, and every token counts with a paid key.
import { z } from 'zod';
import type { ChatMessage } from './index';
import { WORDS_PER_SECOND as FAST_WORDS_PER_SECOND, type CastMember } from '@rec-it/lowpoly';

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
          /** With a written script: the number of the script line this shot shows. */
          line: z.coerce.number().int().optional().catch(undefined),
        })
        .catch({ speaker: 'narrator', text: '', picture: '', characters: [] }),
    )
    .min(1)
    .max(40),
});
export type EpisodePlan = z.output<typeof episodePlanSchema>;

/** Turns a brief (style, story, dialogue, narration notes) into an episode plan for a Short. */
export function episodePrompt(o: {
  brief: string;
  seconds: number;
  /** A written script as numbered lines: spoken exactly as written (ADR-053). */
  script?: string;
  /** Characters remembered from earlier episodes: reused unchanged (ADR-053). */
  cast?: readonly { id: string; name: string; look: string }[];
}): ChatMessage[] {
  const words = Math.round(o.seconds * 2.4);
  const cast = o.cast?.length
    ? '\n\nThese characters already exist from earlier episodes. When they appear, use exactly the same id, name and look (copy the look word for word); add only characters who are new:\n' +
      o.cast.map((c) => `- ${c.id}: ${c.name}: ${c.look}`).join('\n')
    : '';
  if (o.script)
    return [
      {
        role: 'system',
        content:
          'You are the director and storyboard artist of a vertical (9:16) YouTube Short made of illustrated shots with a narrator and spoken dialogue. ' +
          'The script is final and already written as numbered lines: do NOT write, change, merge or skip any spoken text. ' +
          'Make exactly one shot per numbered line, in order, with "line" set to its number; copy the line\'s speaker and text. ' +
          'Your job is only the pictures: every shot whose speaker is a character is a close-up of that character facing the camera, face clearly visible, mouth closed; ' +
          'narration shots show the moment being told (subject, setting, action, camera angle, lighting, no text or letters); follow any [picture: …] note; list the visible character ids; ' +
          'pick a camera motion per shot (zoomIn, zoomOut, panLeft, panRight). ' +
          'Every character who speaks or appears needs an entry in "characters"; describe each ONCE in "look" with fixed, specific details (face shape, eye colour, hair, build, clothing, armour, weapons, colours) taken from the brief, and never change them. ' +
          '"style" is a short list of visual style keywords taken from the brief (for example: 2D anime illustration, dark fantasy, black and crimson palette). ' +
          'Reply with JSON only: {"title": "...", "style": "...", "characters": [{"id": "hiroshi", "name": "Hiroshi Takeda", "gender": "male", "age": "young", "look": "..."}], ' +
          '"shots": [{"line": 1, "speaker": "narrator", "text": "...", "picture": "...", "characters": ["hiroshi"], "motion": "zoomIn"}]}.' +
          cast,
      },
      {
        role: 'user',
        content: `${o.brief.trim() ? `BRIEF:\n${o.brief.trim()}\n\n` : ''}SCRIPT:\n${o.script}`,
      },
    ];
  return [
    {
      role: 'system',
      content:
        'You are the director and storyboard artist of a vertical (9:16) YouTube Short made of illustrated shots with a narrator and spoken dialogue. ' +
        `Turn the brief into a plan of 10 to 16 shots whose spoken text totals about ${words} words (about ${o.seconds} seconds). ` +
        'Rules: follow the story and dialogue of the brief in order; narration is vivid, short sentences, building suspense; keep dialogue lines exactly as written in the brief; ' +
        'every line of dialogue gets its own shot whose speaker is that character and whose picture is a close-up of that character facing the camera, face clearly visible, mouth closed; ' +
        'narration shots have speaker "narrator"; ' +
        'describe each character ONCE in "look" with fixed, specific details (face shape, eye colour, hair, build, clothing, armour, weapons, colours) and never change them; ' +
        'each picture describes ONE striking frame: subject, setting, action, camera angle, lighting, no text or letters; list the visible character ids; ' +
        'pick a camera motion per shot (zoomIn, zoomOut, panLeft, panRight); ' +
        '"style" is a short list of visual style keywords taken from the brief (for example: 2D anime illustration, dark fantasy, black and crimson palette). ' +
        'Reply with JSON only: {"title": "...", "style": "...", "characters": [{"id": "hiroshi", "name": "Hiroshi Takeda", "gender": "male", "age": "young", "look": "..."}], ' +
        '"shots": [{"speaker": "narrator", "text": "...", "picture": "...", "characters": ["hiroshi"], "motion": "zoomIn"}]}.',
    },
    { role: 'user', content: o.brief.trim() },
  ];
}

// ---- Low-poly 3D Shorts (ADR-054) -------------------------------------------------------------

/**
 * The script rules, from studying the low-poly "true story / what if" Shorts that reach tens of
 * millions of views: no intro, the first words are the premise, short clauses that each give a
 * new picture, escalation with "but" turns, and a joke or a looping cut-off as the ending.
 */
const LOWPOLY_SCRIPT_RULES = [
  'The title names the premise in 3 to 7 words, like "Why Stopping Time Is A Bad Idea", "You\'ve Never Touched Anything", "He Wore Upside-Down Glasses For 124 Days", "A Cow With A Window" or "The Eye Socket Problem".',
  'No intro, no "did you know", no greeting: the very first words are the premise as a concrete image ("If you could stop time with the snap of your fingers, you would instantly go blind." / "They would put the nuclear launch codes inside a capsule…" / "He put on special glasses that made him see the world upside down.").',
  'What-ifs and body facts talk to the viewer as "you"; true stories are told in the past tense with specific numbers, dates and names of places.',
  'Short clauses of 4 to 10 words; every clause must be something that can be shown as one picture.',
  'Escalate: each consequence or twist is stranger than the last; turn the story with "But" at least once.',
  'End with a dry joke or a meme-like moral in one short line (for example "So you\'ve never touched grass, and she technically didn\'t cheat on you." or "A lie told long enough becomes your reality."), OR cut the last sentence off mid-word ("so you instant-") so the video loops back into the first line.',
  'Facts must be true and checkable; no gore, no graphic injury detail, nothing hateful, no real private people.',
  'Plain spoken English for a text-to-speech narrator: no emojis, hashtags, lists or stage directions.',
];

/**
 * Blocky-avatar game stories (ADR-055), from the big channels of the genre: an "In this town…"
 * rule that bends one ordinary life, or a big question answered with a story about two people.
 */
const BLOCKY_SCRIPT_RULES = [
  'The title is the premise in 4 to 9 words, like "In this town, your screen time controls the weather", "In this town, the rich live in giant bunkers" or "Why the worst people get the best lives".',
  'Hook in the first sentence, no intro or greeting. Either open with the rule of a strange town ("In this town, whenever the sky turns red, everyone has to hide.") or with a big question the story will answer ("Why does the worst person you know get the best life?").',
  'Then follow ONE main character (named, or "a boy", "a girl", "a man") through a story: what the rule means for ordinary people, a concrete scene, a problem, an escalation, a turn with "But" or "Until one day".',
  'Show places that change: home, bedroom, street, school, shop, gym, stage, office, lab, park, night and day. Name objects people hold and use.',
  'Short clauses of 4 to 10 words; every clause must be something that can be shown as one picture. Use the past tense for the story, present tense for the rule.',
  'End with a twist, a cliffhanger ("…and that was only the beginning."), or a short warm moral or lesson.',
  'Family friendly: no gore, nothing hateful, no real private people, no brands or game names.',
  'Plain spoken English for a text-to-speech narrator: no emojis, hashtags, lists or stage directions.',
];

export const lowPolyScriptSchema = z.object({
  title: z.string().min(2).max(100),
  script: z.string().min(20).max(3000),
});
export type LowPolyScript = z.output<typeof lowPolyScriptSchema>;

/** A narrated script for a low-poly 3D Short about a topic. */
export function lowPolyScriptPrompt(o: {
  topic: string;
  seconds: number;
  style?: 'ps1' | 'blocky';
}): ChatMessage[] {
  const words = Math.round(o.seconds * FAST_WORDS_PER_SECOND);
  if (o.style === 'blocky')
    return [
      {
        role: 'system',
        content:
          'You write viral narrated story Shorts animated with blocky 3D avatar characters (bright game-world stories like "In this town…" and story answers to big questions). ' +
          `Write one script of about ${words} words (about ${o.seconds} seconds read briskly). Rules: ` +
          BLOCKY_SCRIPT_RULES.join(' ') +
          ' Reply with JSON only: {"title": "...", "script": "..."}.',
      },
      { role: 'user', content: o.topic.trim() || 'Invent a strange town rule and a story in it.' },
    ];
  return [
    {
      role: 'system',
      content:
        'You write viral narrated YouTube Shorts in the style of low-poly 3D story channels (strange true stories, body and science facts, "what if" scenarios). ' +
        `Write one script of about ${words} words (about ${o.seconds} seconds read quickly). Rules: ` +
        LOWPOLY_SCRIPT_RULES.join(' ') +
        ' Reply with JSON only: {"title": "...", "script": "..."}.',
    },
    { role: 'user', content: o.topic.trim() || 'Pick a surprising true story or what-if.' },
  ];
}

export const lowPolyIdeasSchema = z.object({
  ideas: z
    .array(
      z
        .object({ title: z.string().min(2).max(100), premise: z.string().max(400).catch('') })
        .catch({ title: '', premise: '' }),
    )
    .max(20)
    .transform((a) => a.filter((i) => i.title)),
});

/** Ten ideas for low-poly Shorts, optionally around a theme. */
export function lowPolyIdeasPrompt(theme: string, style: 'ps1' | 'blocky' = 'ps1'): ChatMessage[] {
  if (style === 'blocky')
    return [
      {
        role: 'system',
        content:
          'You plan viral narrated story Shorts animated with blocky 3D avatar characters. The formats that get millions of views are: ' +
          '(1) "In this town, …" a strange rule that bends everyday life (your screen time controls the weather; the more you doomscroll, the longer your legs get; whenever the sky turns red everyone hides; the rich live in giant bunkers; everyone gets a superpower on their 13th birthday; we live on the back of a giant animal), with a story of one person inside it; ' +
          '(2) a big life question answered with a story about two people (why the worst people get the best lives; what happens after we die; why we rinse our mouth after milk; who found out how eyes see). ' +
          'Give 10 different ideas, each a short punchy title in that style and a one-sentence premise. Family friendly. ' +
          'Reply with JSON only: {"ideas": [{"title": "...", "premise": "..."}]}.',
      },
      { role: 'user', content: theme.trim() || 'Any topics.' },
    ];
  return [
    {
      role: 'system',
      content:
        'You plan viral narrated YouTube Shorts for a low-poly 3D story channel. The formats that get the most views are: ' +
        '(1) "Why X Is A Bad Idea" what-ifs with escalating consequences (stopping time, living forever, solar-powered humans); ' +
        '(2) "You…" facts that make the viewer doubt their own body or reality (you\'ve never touched anything, you are radioactive); ' +
        '(3) bizarre but true stories about one person, told with numbers (upside-down glasses for 124 days, a nose grown on an arm, the nuclear codes proposal); ' +
        '(4) strange true facts about one animal or body part (a cow with a window, the eye socket problem, how anglerfish mate); ' +
        '(5) dumb criminals and weird laws. ' +
        'Give 10 different ideas, each a short punchy title in that style and a one-sentence premise. Only true facts or clearly hypothetical what-ifs. ' +
        'Reply with JSON only: {"ideas": [{"title": "...", "premise": "..."}]}.',
    },
    { role: 'user', content: theme.trim() || 'Any topics.' },
  ];
}

/** The storyboard: lenient on purpose; @rec-it/lowpoly normalisePlan makes every value safe. */
export const lowPolyBoardSchema = z.object({
  cast: z.array(z.record(z.string(), z.unknown())).catch([]).default([]),
  shots: z.array(z.record(z.string(), z.unknown())).catch([]).default([]),
});
export type LowPolyBoard = z.output<typeof lowPolyBoardSchema>;

/**
 * Turns numbered beats of narration into low-poly 3D shots. The AI answers in plain words
 * (small local models do that far better than picking from long lists); @rec-it/lowpoly maps the
 * words onto the 3D kit and reads anything missing from the narration itself.
 */
export function lowPolyBoardPrompt(o: {
  title: string;
  beats: readonly string[];
  /** Characters that already exist (kept exactly; reuse their names). */
  cast: readonly CastMember[];
}): ChatMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You storyboard a vertical 3D Short made of simple blocky shapes, like a film director who reads every word. Each numbered line of narration gets exactly ONE shot that shows literally what that line says, in order, with "beat" set to the line number.',
        '',
        'Fields of each shot (plain words, short):',
        '- "place": where the line happens: street, town, park, home, bedroom, kitchen, living room, classroom, school, office, hospital, lab, shop, gym, stage, jungle, island, forest, beach, desert, snow, ocean, space, battlefield, prison, bank, courtroom, farm. If the line does not change place, repeat the last place.',
        '- "who": the NAMES of the people in the picture. The main character is called by their name every time (his, her, he, she and him mean the main character). Write "you" only when the line says "you" or "your". Never put a group here.',
        '- "doing": ONE physical action the main person does that acts the line out: walking, running, standing, talking, scrolling on a phone, lying in bed, sleeping, sitting on a chair, sitting on the floor, eating, reading, looking up, looking down, waving, pointing, picking something up, hiding, shocked, celebrating, crying, shaking his head, nodding, working.',
        '- "feeling": happy, sad, scared, angry, determined, confused, tired, proud, lonely, surprised or neutral.',
        '- "holding": the thing in their hands, if any (a phone while scrolling, a rifle for a soldier).',
        '- "objects": up to 3 physical things that must be visible and that the narration names or the action needs (a bed to lie in, a table and a bowl for breakfast, a phone to scroll). NEVER people, groups, body parts, rooms, walls, floors, ceilings, windows, times of day, feelings or ideas.',
        '- "crowd": how many other people are in the picture (0 to 7): 0 unless the line mentions people, friends, a crowd, the town, classmates or everyone.',
        '- "crowdDoing": what that crowd does (waving, cheering, looking up, scrolling on phones, shouting, walking).',
        '- "size": how tall the main character is NOW: "normal", "a bit taller", "as tall as the ceiling", "taller than the houses", "giant", "tiny". Keep it in every later shot until the story changes it.',
        '- "time": "day" or "night" (night only when the line says night, midnight, evening, dark).',
        '- "camera": wide, medium, close-up, low angle (looking up), overhead (looking down) or first person.',
        '- "effect": "" unless the line literally describes glowing, a beam, x-ray, freezing, darkness, an explosion, fire, rain, a ghost, sickness or a spotlight.',
        '- "bigText": "" unless the line needs a sign or a joke word (at most 3 words).',
        '',
        'Rules (follow them all):',
        '1. Show exactly what the words say, with common sense: someone who "scrolled in bed until midnight" is lying in bed at night holding a phone; "at breakfast" means sitting at a table with a bowl; "sat on the floor" means sitting on the floor, not a chair.',
        '2. Story state carries on: sizes, injuries, clothes, what they hold and where they are stay the same from shot to shot until the narration changes them. If someone is growing, they get taller in every shot about it.',
        '3. Lines about people in general ("most people…", "everyone in this town…") show a crowd doing it, not the main character.',
        '4. Things only appear once the narration has mentioned them; nothing floats, nothing is inside a person, beds and tables are used for what they are for.',
        '5. Open each new place with a wide shot; use close-ups only for faces and feelings, never more than two in a row; vary the camera.',
        '6. Describe every person once in "cast" with "name" and "look": gender, age, skin, hair and clothes with colours (for example "boy about 12, brown hair, red hoodie, blue jeans").',
        '',
        'Example. Lines: 1. Leo never put his phone down. 2. He scrolled in bed until midnight. 3. By Monday, his head touched the ceiling.',
        'Answer: {"cast":[{"name":"Leo","look":"boy about 12, brown hair, red hoodie, blue jeans"}],"shots":[' +
          '{"beat":1,"place":"street","who":["Leo"],"doing":"scrolling on a phone","feeling":"neutral","holding":"phone","objects":["phone"],"crowd":0,"crowdDoing":"","size":"normal","time":"day","camera":"medium","effect":"","bigText":""},' +
          '{"beat":2,"place":"bedroom","who":["Leo"],"doing":"lying in bed","feeling":"tired","holding":"phone","objects":["bed","phone"],"crowd":0,"crowdDoing":"","size":"a bit taller","time":"night","camera":"wide","effect":"","bigText":""},' +
          '{"beat":3,"place":"bedroom","who":["Leo"],"doing":"standing","feeling":"surprised","holding":"phone","objects":["phone"],"crowd":0,"crowdDoing":"","size":"as tall as the ceiling","time":"day","camera":"wide","effect":"","bigText":""}]}',
        '',
        `Existing cast (reuse these names exactly): ${o.cast.map((c) => c.name).join(', ') || 'none'}.`,
        'Reply with JSON only: {"cast": [{"name": "...", "look": "..."}], "shots": [{"beat": 1, "place": "...", "who": ["..."], "doing": "...", "feeling": "...", "holding": "", "objects": ["..."], "crowd": 0, "crowdDoing": "", "size": "normal", "time": "day", "camera": "wide", "effect": "", "bigText": ""}]}.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Title: ${o.title}\n\n${o.beats.map((b, i) => `${i + 1}. ${b}`).join('\n')}`,
    },
  ];
}

export const lowPolyModelsSchema = z.object({
  models: z.array(z.record(z.string(), z.unknown())).catch([]).default([]),
});

/** Asks for simple low-poly models, built from primitives, of things the 3D kit has no prop for. */
export function lowPolyModelsPrompt(names: readonly string[]): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'You design very simple low-poly 3D models for a blocky 3D video, built only from primitive shapes. ' +
        'For each requested object use 3 to 10 parts. Each part has "shape" (box, cylinder, sphere or cone), "size" [width, height, depth] in metres, "at" [x, y, z] its centre in metres (y is up, the ground is y = 0, the front faces +z), optional "turn" [x, y, z] in radians, and "color" as #rrggbb. ' +
        'Use real-world sizes (a hut is about 3 m tall, a leaflet 0.2 m, a banana 0.2 m) and colours that make the object recognisable. ' +
        'Reply with JSON only: {"models": [{"name": "bamboo hut", "parts": [{"shape": "box", "size": [3, 2, 3], "at": [0, 1, 0], "color": "#b8925a"}, {"shape": "cone", "size": [4.2, 1.5, 4.2], "at": [0, 2.75, 0], "color": "#8a7a3a"}]}]}.',
    },
    { role: 'user', content: names.join('\n') },
  ];
}
