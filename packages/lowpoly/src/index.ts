// Low-poly 3D Shorts (ADR-054): the vocabulary a shot is built from, the render spec the renderer
// films, and the pure planning around it (beats from a script, beat times from the voice, mouth
// shapes from the voice's sounds, a safe plan from whatever the AI answered). No three.js here:
// the renderer builds the pictures (apps/desktop/src/renderer/src/lowpoly).
import { z } from 'zod';
import {
  ACTION_WORDS,
  EFFECT_WORDS,
  EXTRA_WORDS,
  FRAMING_WORDS,
  MOOD_WORDS,
  CROWD_WORDS,
  PROP_WORDS,
  IMPLIED_EXTRA_WORDS,
  PLACE_WORDS,
  ROLE_WORDS,
  SET_WORDS,
  TOP_WORDS,
  firstMention,
  mentions,
  secondPerson,
  wordList,
} from './words';

export * from './words';

// ---- Vocabulary -------------------------------------------------------------------------------

/** Places a shot can happen in. */
export const SETS = [
  'street',
  'livingRoom',
  'kitchen',
  'bedroom',
  'office',
  'hospital',
  'lab',
  'classroom',
  'prison',
  'bank',
  'city',
  'forest',
  'desert',
  'beach',
  'underwater',
  'space',
  'sky',
  'farm',
  'void',
  'jungle',
  'island',
  'battlefield',
  'snow',
  'ocean',
  'courtroom',
] as const;
export type SetId = (typeof SETS)[number];

/** How close the camera is. */
export const FRAMINGS = [
  'extremeCloseUp',
  'closeUp',
  'medium',
  'wide',
  'overhead',
  'lowAngle',
  'pov',
  'object',
] as const;
export type Framing = (typeof FRAMINGS)[number];

/** What the subject does. */
export const ACTIONS = [
  'idle',
  'talk',
  'walk',
  'run',
  'fall',
  'point',
  'shock',
  'sit',
  'sleep',
  'float',
  'shiver',
  'celebrate',
  'think',
  'crouch',
  'eat',
  'salute',
  'read',
  'wave',
  'lookUp',
  'patrol',
  'pickUp',
  'shakeHead',
  'nod',
  'work',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Something drawn over or around the subject, for things that are invisible or extreme. */
export const EFFECTS = [
  'none',
  'glow',
  'beam',
  'darkness',
  'xray',
  'frozen',
  'explosion',
  'silhouette',
  'sparkles',
  'rain',
  'fire',
  'sick',
  'spotlight',
] as const;
export type Effect = (typeof EFFECTS)[number];

/** How the people in a shot feel: shapes their faces, posture and how they move. */
export const MOODS = [
  'neutral',
  'happy',
  'sad',
  'scared',
  'angry',
  'determined',
  'confused',
  'tired',
  'proud',
  'lonely',
  'surprised',
] as const;
export type Mood = (typeof MOODS)[number];

export const CAMERAS = ['pushIn', 'pullOut', 'orbit', 'static', 'shake', 'tilt'] as const;
export type CameraMove = (typeof CAMERAS)[number];

/** Things the kit can build. */
export const PROPS = [
  'phone',
  'money',
  'cup',
  'pill',
  'syringe',
  'glasses',
  'clock',
  'lightbulb',
  'laser',
  'book',
  'briefcase',
  'computer',
  'tv',
  'car',
  'plane',
  'rocket',
  'house',
  'tree',
  'toilet',
  'fridge',
  'bed',
  'chair',
  'table',
  'door',
  'sign',
  'brain',
  'heart',
  'eye',
  'skull',
  'dna',
  'virus',
  'atom',
  'planet',
  'sun',
  'moon',
  'dog',
  'cat',
  'cow',
  'fish',
  'bird',
  'rat',
  'box',
  'trophy',
  'rifle',
  'sword',
  'paper',
  'banana',
  'coconut',
  'boat',
  'helicopter',
  'flag',
  'tent',
  'campfire',
  'binoculars',
  'map',
  'radio',
  'medal',
] as const;
export type PropId = (typeof PROPS)[number];

export const SKINS = ['pale', 'light', 'tan', 'brown', 'dark'] as const;
export const HAIRS = ['short', 'long', 'bald', 'ponytail', 'curly', 'spiky'] as const;
export const TOPS = [
  'tshirt',
  'jacket',
  'suit',
  'hoodie',
  'labcoat',
  'uniform',
  'dress',
  'prison',
  'sweater',
] as const;
export const EXTRAS = [
  'none',
  'glasses',
  'sunglasses',
  'beard',
  'mustache',
  'hat',
  'cap',
  'helmet',
] as const;

// ---- Render spec (crosses IPC: backend → renderer) ---------------------------------------------

const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const castMemberSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]{1,24}$/),
  name: z.string().max(60),
  gender: z.enum(['male', 'female']),
  age: z.enum(['child', 'young', 'adult', 'old']),
  skin: z.enum(SKINS),
  hair: z.enum(HAIRS),
  hairColor: hex,
  top: z.enum(TOPS),
  topColor: hex,
  bottomColor: hex,
  extra: z.enum(EXTRAS),
});
export type CastMember = z.output<typeof castMemberSchema>;

export const shotSpecSchema = z.object({
  /** Seconds into the video. */
  start: z.number().min(0),
  end: z.number().min(0),
  set: z.enum(SETS),
  framing: z.enum(FRAMINGS),
  /** A cast id, a prop, or "none" (the set alone). */
  subject: z.string().max(24),
  /** Other cast members in the shot. */
  others: z.array(z.string().max(24)).max(4),
  action: z.enum(ACTIONS),
  /** Kit props, or "m:<id>" for a model the AI designed (see RenderSpec.models). */
  props: z.array(z.string().regex(/^(?:[a-z]+|m:[a-z0-9_]{1,24})$/i)).max(4),
  effect: z.enum(EFFECTS),
  camera: z.enum(CAMERAS),
  /** How the people feel. */
  mood: z.enum(MOODS).default('neutral'),
  /** Extra people in the background (villagers, soldiers, a crowd). */
  crowd: z.number().int().min(0).max(8).default(0),
  /** Big words in the picture (a sign, a joke), at most a few words. */
  bigText: z.string().max(24).default(''),
  /** The cast member who says this line on screen ("" when it is narration). */
  speaker: z.string().max(24).default(''),
  /** Mouth shape per frame for the speaker (0 shut … 3 round). */
  mouth: z.array(z.number().int().min(0).max(3)).max(3600).default([]),
  seed: z.number().int().min(0).max(1_000_000),
});
export type ShotSpec = z.output<typeof shotSpecSchema>;

/** One primitive of a model the AI designed: metres, y up, ground at y = 0, front towards +z. */
export const modelPartSchema = z.object({
  shape: z.enum(['box', 'cylinder', 'sphere', 'cone']),
  size: z.tuple([z.number(), z.number(), z.number()]),
  at: z.tuple([z.number(), z.number(), z.number()]),
  turn: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  color: hex,
});
export const modelSchema = z.object({
  name: z.string().max(40),
  parts: z.array(modelPartSchema).min(1).max(16),
});
export type Model = z.output<typeof modelSchema>;

export const renderSpecSchema = z.object({
  width: z.number().int().min(64).max(2160),
  height: z.number().int().min(64).max(3840),
  fps: z.number().int().min(1).max(60),
  /** Height the 3D is drawn at before it is enlarged with hard pixels (the PS1 look). */
  pixelHeight: z.number().int().min(120).max(2160),
  cast: z.array(castMemberSchema).max(8),
  shots: z.array(shotSpecSchema).min(1).max(120),
  /** Channel name flashed on screen early on, like a watermark ("" for none). */
  brand: z.string().max(40).default(''),
  /** How solid the channel name is (0.1 faint … 1 solid). */
  brandOpacity: z.number().min(0.1).max(1).default(0.9),
  /**
   * The look (ADR-055): "ps1" is the low-poly PlayStation look; "blocky" is the bright,
   * smooth-plastic look of blocky-avatar game stories (full resolution, soft shadows, depth of
   * field, a livelier camera).
   */
  style: z.enum(['ps1', 'blocky']).default('ps1'),
  /** Blocky look: everyone gets the classic yellow skin. */
  classicSkin: z.boolean().default(false),
  /** Models the AI designed for things the kit has no prop for, by id ("m:<id>" in shots). */
  models: z.record(z.string().regex(/^[a-z0-9_]{1,24}$/), modelSchema).default({}),
});
export type RenderSpec = z.output<typeof renderSpecSchema>;

/** Frames a shot covers: frame-exact, so cuts land on frames and shots never overlap. */
export function shotFrames(shot: { start: number; end: number }, fps: number): [number, number] {
  return [Math.round(shot.start * fps), Math.round(shot.end * fps)];
}

/** Total frames of a spec. */
export function totalFrames(spec: Pick<RenderSpec, 'shots' | 'fps'>): number {
  return shotFrames(spec.shots.at(-1)!, spec.fps)[1];
}

// ---- Beats -------------------------------------------------------------------------------------

function words(text: string): string[] {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
}

const MAX_BEAT = 12;
const MIN_BEAT = 3;

/**
 * A script cut into beats: one picture each, a short clause of up to about twelve words, as the
 * fast-cut low-poly channels do (a new picture every 2–4 seconds). Long sentences are split at
 * commas (pieces rejoined while they fit), then before joining words, then in half; tiny pieces
 * join their neighbour.
 */
export function splitBeats(script: string): string[] {
  const sentences =
    script
      .replace(/\s+/g, ' ')
      .trim()
      .match(/[^.!?…]+(?:[.!?…]+["'”’)]*|$)/g)
      ?.map((s) => s.trim())
      .filter((s) => words(s).length) ?? [];
  const out: string[] = [];
  const cut = (text: string): string[] => {
    const n = words(text).length;
    if (n <= MAX_BEAT) return [text];
    const commas = text.split(/(?<=[,;:—–])\s+/);
    if (commas.length > 1) {
      const joined: string[] = [];
      for (const c of commas) {
        const last = joined.at(-1);
        if (last && words(last).length + words(c).length <= MAX_BEAT)
          joined[joined.length - 1] = `${last} ${c}`;
        else joined.push(c);
      }
      if (joined.length > 1) return joined.flatMap(cut);
    }
    const parts = text.split(/\s+(?=(?:and|but|so|because|while|until|which|that|then|or)\s)/i);
    if (parts.length > 1 && parts.every((p) => words(p).length >= MIN_BEAT))
      return parts.flatMap(cut);
    // Split before a small joining word nearest the middle, else in half.
    const all = text.split(/\s+/);
    const joins =
      /^(?:in|on|at|with|to|from|for|after|before|until|while|and|but|so|because|which|that|who|when|where|saying)$/i;
    let at = Math.ceil(all.length / 2);
    let best = Infinity;
    for (let k = MIN_BEAT; k <= all.length - MIN_BEAT; k++)
      if (joins.test(all[k]!) && Math.abs(k - all.length / 2) < best) {
        best = Math.abs(k - all.length / 2);
        at = k;
      }
    return [...cut(all.slice(0, at).join(' ')), ...cut(all.slice(at).join(' '))];
  };
  for (const s of sentences) {
    const pieces = cut(s);
    const merged: string[] = [];
    for (const p of pieces) {
      const last = merged.at(-1);
      if (last && (words(p).length < MIN_BEAT || words(last).length < MIN_BEAT))
        merged[merged.length - 1] = `${last} ${p}`;
      else merged.push(p);
    }
    out.push(...merged);
  }
  return out;
}

function letters(text: string): number {
  return text.replace(/[^\p{L}\p{N}]/gu, '').length;
}

/**
 * When each beat is said, from the voice's word times. Words are matched by their share of the
 * letters, so spoken numbers ("1980s" read as words) or merged tokens cannot throw the
 * alignment. Beats run edge to edge: each ends where the next starts (in the pause between).
 */
export function beatTimes(
  beats: readonly string[],
  spoken: readonly { text: string; start: number; end: number }[],
  duration: number,
): { start: number; end: number }[] {
  if (!beats.length) return [];
  if (!spoken.length)
    return beats.map((_, i) => ({
      start: (duration * i) / beats.length,
      end: (duration * (i + 1)) / beats.length,
    }));
  const total = beats.reduce((a, b) => a + letters(b), 0) || 1;
  const wordLetters = spoken.map((w) => Math.max(1, letters(w.text)));
  const wordTotal = wordLetters.reduce((a, b) => a + b, 0);
  // Cumulative share at the end of each word.
  const ends: number[] = [];
  let acc = 0;
  for (const n of wordLetters) ends.push((acc += n) / wordTotal);
  const starts: number[] = [0];
  let share = 0;
  for (let i = 0; i < beats.length - 1; i++) {
    share += letters(beats[i]!) / total;
    // The first word of the next beat: the word whose cumulative end passes the share.
    let k = ends.findIndex((e) => e > share + 1e-9);
    if (k < 0) k = spoken.length - 1;
    const prevEnd = k > 0 ? spoken[k - 1]!.end : 0;
    const at = (prevEnd + spoken[k]!.start) / 2;
    starts.push(Math.max(starts.at(-1)! + 0.2, at));
  }
  return starts.map((s, i) => ({
    start: i === 0 ? 0 : s,
    end: i + 1 < starts.length ? starts[i + 1]! : duration,
  }));
}

// ---- Mouth -------------------------------------------------------------------------------------

const ROUND = /[oouʊɔOWYw]/;
const OPEN = /[aeiouæɑɐɒəɚɛɜɝɪʊʌɔAIOWYEU]/;
const SHUT = /^[mbp]/;

/**
 * Mouth shape per frame from the voice's sounds (0 shut, 1 parted, 2 open, 3 round): vowels open
 * the mouth (rounded ones round it), m/b/p shut it, silence shuts it. Each shape holds at least
 * two frames so the mouth never flickers.
 */
export function mouthFrames(
  sounds: readonly { p: string; start: number; end: number }[],
  start: number,
  end: number,
  fps: number,
): number[] {
  const n = Math.max(0, Math.round(end * fps) - Math.round(start * fps));
  const out: number[] = [];
  let k = 0;
  for (let f = 0; f < n; f++) {
    const t = start + (f + 0.5) / fps;
    while (k < sounds.length && sounds[k]!.end <= t) k++;
    const s = sounds[k];
    let shape = 0;
    if (s && s.start <= t) {
      if (SHUT.test(s.p)) shape = 0;
      else if (ROUND.test(s.p)) shape = 3;
      else if (OPEN.test(s.p)) shape = 2;
      else shape = 1;
    }
    out.push(shape);
  }
  // Hold every shape at least two frames.
  for (let f = 1; f < out.length - 1; f++)
    if (out[f] !== out[f - 1] && out[f] !== out[f + 1]) out[f] = out[f - 1]!;
  return out;
}

// ---- Plans -------------------------------------------------------------------------------------

const COLOURS: Record<string, string> = {
  black: '#1c1c1f',
  white: '#e8e6e0',
  grey: '#7a7c80',
  gray: '#7a7c80',
  red: '#a3342a',
  darkred: '#6e1f1a',
  maroon: '#6e1f1a',
  orange: '#d0702a',
  yellow: '#d9b53a',
  gold: '#c9a23a',
  green: '#3f7a3a',
  darkgreen: '#2a4a2a',
  olive: '#6b6b3a',
  teal: '#2f8c86',
  blue: '#3b5a8c',
  navy: '#1f2b4a',
  lightblue: '#7fa8d0',
  denim: '#3b5a8c',
  purple: '#5e3c7a',
  pink: '#d68aa0',
  brown: '#6b4a2f',
  tan: '#b9a57c',
  beige: '#cdbb98',
  blonde: '#d4b46a',
  ginger: '#b5562a',
  silver: '#b8bcc0',
  khaki: '#a8925a',
  cream: '#e8dcc0',
  crimson: '#8a1f24',
  scarlet: '#b8282a',
  violet: '#6a4a9a',
  lime: '#7ab83a',
  turquoise: '#3ab0a8',
  camo: '#5a6a3a',
  camouflage: '#5a6a3a',
  charcoal: '#36383c',
  ivory: '#efe8d8',
};

/** A colour from a name or "#rrggbb", or the fallback. */
export function colour(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const v = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join('')}`;
  return COLOURS[v] ?? fallback;
}

function pick<T extends string>(options: readonly T[], value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  const exact = options.find((o) => o === v);
  if (exact) return exact;
  const lower = v.toLowerCase().replace(/[\s_-]+/g, '');
  return options.find((o) => o.toLowerCase() === lower) ?? fallback;
}

/** "You": the recurring hero of a what-if Short (red jacket and jeans, like the genre's). */
export const YOU: CastMember = {
  id: 'you',
  name: 'You',
  gender: 'male',
  age: 'adult',
  skin: 'light',
  hair: 'short',
  hairColor: '#4a3324',
  top: 'jacket',
  topColor: '#9c2f24',
  bottomColor: '#3b5a8c',
  extra: 'none',
};

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'person'
  );
}

/** The value a description asks for, from a field or from its words. */
function fromText<T extends string>(
  options: readonly T[],
  field: unknown,
  text: string,
  table: Record<string, string>,
  fallback: T,
): T {
  const exact = pick(options, field, '' as T);
  if (exact) return exact;
  const said =
    (typeof field === 'string' ? firstMention(field, table) : undefined) ??
    firstMention(text, table);
  return (said && options.includes(said as T) ? said : fallback) as T;
}

const CLOTHES =
  /^(uniform|shirt|t-shirt|tshirt|jacket|coat|suit|hoodie|dress|sweater|jumper|top|blouse|robe|cloak|vest|armour|armor|overalls|scrubs|gown|tunic|kimono)s?$/;
const LEGS = /^(trousers|pants|jeans|shorts|skirt|leggings|bottoms|slacks)$/;

/**
 * Clothes colours from a description: the colour words just before a garment ("olive army
 * uniform", "blue jeans"), never the hair's ("short black hair" is not a black uniform).
 */
function clothesColours(text: string): { top?: string; bottom?: string; hair?: string } {
  const ws = wordList(text);
  const out: { top?: string; bottom?: string; hair?: string } = {};
  const before = (i: number) => {
    for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
      const c = colour(ws[k], '');
      if (c) return c;
    }
    return '';
  };
  ws.forEach((w, i) => {
    if (!out.top && CLOTHES.test(w)) out.top = before(i) || undefined;
    if (!out.bottom && LEGS.test(w)) out.bottom = before(i) || undefined;
    if (!out.hair && w === 'hair') out.hair = before(i) || undefined;
  });
  return out;
}

/**
 * Any AI cast member made safe to build. Fields the AI left out or got wrong are read from its
 * description instead ("an old Japanese soldier in an olive uniform and cap, thin moustache").
 */
export function normaliseCastMember(raw: Record<string, unknown>): CastMember {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Person';
  const id = slug(typeof raw.id === 'string' && raw.id.trim() ? raw.id : name);
  const text = ['look', 'description', 'appearance', 'clothes', 'outfit', 'role']
    .map((k) => (typeof raw[k] === 'string' ? (raw[k] as string) : ''))
    .concat(name)
    .join(' ');
  const ws = new Set(wordList(text));
  const said = (...w: string[]) => w.some((x) => ws.has(x));
  const gender =
    pick(['male', 'female'] as const, raw.gender, '' as 'male') ||
    (said('woman', 'girl', 'she', 'her', 'female', 'lady', 'mother', 'wife', 'queen', 'nurse')
      ? 'female'
      : 'male');
  const age =
    pick(['child', 'young', 'adult', 'old'] as const, raw.age, '' as 'adult') ||
    (said('old', 'elderly', 'grandfather', 'grandmother', 'aged', 'grey', 'gray')
      ? 'old'
      : said('child', 'boy', 'girl', 'kid', 'baby', 'son', 'daughter')
        ? 'child'
        : said('young', 'teen', 'teenager', 'student')
          ? 'young'
          : 'adult');
  const top = fromText(TOPS, raw.top, text, TOP_WORDS, 'tshirt');
  const worn = clothesColours(text);
  const hair =
    pick(HAIRS, raw.hair, '' as 'short') ||
    (said('bald')
      ? 'bald'
      : said('ponytail')
        ? 'ponytail'
        : said('curly', 'afro')
          ? 'curly'
          : said('spiky')
            ? 'spiky'
            : gender === 'female' || said('long')
              ? 'long'
              : 'short');
  const explicit = fromText(EXTRAS, raw.extra, text, EXTRA_WORDS, 'none');
  const extra =
    explicit !== 'none' ? explicit : fromText(EXTRAS, undefined, text, IMPLIED_EXTRA_WORDS, 'none');
  const soldier =
    top === 'uniform' &&
    said(
      'soldier',
      'army',
      'military',
      'commander',
      'officer',
      'major',
      'general',
      'captain',
      'sergeant',
    );
  return {
    id,
    name: name.slice(0, 60),
    gender,
    age,
    skin: fromText(
      SKINS,
      raw.skin,
      text,
      {
        pale: 'pale',
        white: 'light',
        fair: 'light',
        tan: 'tan',
        asian: 'tan',
        japanese: 'tan',
        brown: 'brown',
        black: 'dark',
        dark: 'dark',
      },
      'light',
    ),
    hair,
    hairColor: colour(
      raw.hairColor,
      said('blonde', 'blond') ? '#d4b46a' : said('ginger', 'redhead') ? '#b5562a' : '#2a1f18',
    ),
    top,
    topColor: colour(raw.topColor, worn.top ?? (soldier ? '#6b6b3a' : '#4a6fa5')),
    bottomColor: colour(
      raw.bottomColor,
      worn.bottom ?? (top === 'uniform' && worn.top ? worn.top : soldier ? '#5a5a34' : '#3a3f4a'),
    ),
    extra,
  };
}

/** One shot of a plan, before it has times. */
export type ShotPlan = Omit<ShotSpec, 'start' | 'end' | 'mouth' | 'seed'> & {
  /** The cast member whose mouth moves to the voice, if any. */
  speaker: string;
};

/** A crowd in the line: "people", "everyone", or a plural like "soldiers" (not "a soldier"). */
function crowdMentioned(text: string): boolean {
  return wordList(text).some(
    (w) =>
      ['people', 'crowd', 'everyone', 'townspeople', 'audience', 'army'].includes(w) ||
      (w.endsWith('s') && !!CROWD_WORDS[w.slice(0, -1)]),
  );
}

/** Things that fly: shots with them look up at the sky. */
export const FLYING = new Set(['plane', 'helicopter', 'rocket', 'bird']);

const PRONOUNS = new Set([
  'he',
  'him',
  'his',
  'she',
  'her',
  'they',
  'them',
  'i',
  'me',
  'we',
  'protagonist',
  'hero',
  'main',
]);
const NOBODY = new Set(['none', 'nobody', 'no one', 'noone', 'narrator', 'nothing', '']);

function texts(v: unknown): string[] {
  if (typeof v === 'string')
    return v
      .split(/,|\band\b|;|\//)
      .map((x) => x.trim())
      .filter(Boolean);
  if (Array.isArray(v))
    return v
      .flatMap((x) =>
        typeof x === 'string'
          ? [x.trim()]
          : x && typeof x === 'object' && typeof (x as { name?: unknown }).name === 'string'
            ? [(x as { name: string }).name]
            : [],
      )
      .filter(Boolean);
  return [];
}

function field(s: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (s[k] !== undefined && s[k] !== null && s[k] !== '') return s[k];
  return undefined;
}

function str(v: unknown): string {
  return typeof v === 'string'
    ? v
    : Array.isArray(v)
      ? v.filter((x) => typeof x === 'string').join(' ')
      : '';
}

/** A short id for an object the kit has no prop for ("Bamboo raft" → "bamboo_raft"). */
export function modelId(name: string): string {
  return slug(name.replace(/^(a|an|the|some|his|her|their)\s+/i, '')).slice(0, 24);
}

export interface PlanOptions {
  /** Characters to keep (remembered or chosen); planned ones with the same id or name are replaced. */
  keep?: readonly CastMember[];
  /** The whole script (decides "you" versus a story's own hero, and default places). */
  script?: string;
}

/**
 * Makes any AI storyboard safe and true to the script. The AI may answer in its own words
 * ("place": "a dense jungle", "who": ["he"], "objects": ["leaflets", "rifle"]); words are mapped
 * onto the kit, and whatever the AI left out is read from the beat's own narration, so each shot
 * shows what is being said. People default to the story's hero (or "you" in a what-if), never to
 * a stranger. Objects the kit lacks come back in `models`, to be designed. Framing follows simple
 * film rules: a wide shot to open each new place, close-ups at most every other shot, and
 * extreme close-ups only now and then.
 */
export function normalisePlan(
  plan: { cast?: unknown; shots?: unknown },
  beats: readonly string[],
  o: PlanOptions = {},
): { cast: CastMember[]; shots: ShotPlan[]; models: { id: string; name: string }[] } {
  const script = o.script ?? beats.join(' ');
  const you = secondPerson(script);
  const cast: CastMember[] = [...(o.keep ?? (you ? [YOU] : []))];
  /** Role words of each character ("officer", "soldier"), and the words of their description. */
  const roles = new Map<string, string[]>();
  const looks = new Map<string, string[]>();
  const addCast = (raw: Record<string, unknown>): string | null => {
    const c = normaliseCastMember(raw);
    const text = Object.values(raw)
      .filter((v) => typeof v === 'string')
      .join(' ');
    const existing = cast.find(
      (k) => k.id === c.id || k.name.toLowerCase() === c.name.toLowerCase(),
    );
    if (existing) return existing.id;
    if (c.id === 'you' && !you) return null;
    if (cast.length >= 8) return null;
    cast.push(c);
    roles.set(c.id, mentions(text, ROLE_WORDS));
    looks.set(
      c.id,
      wordList(text).filter((w) => w.length > 3),
    );
    return c.id;
  };
  const rawCast = Array.isArray(plan.cast) ? (plan.cast as Record<string, unknown>[]) : [];
  for (const raw of rawCast.slice(0, 6)) if (raw && typeof raw === 'object') addCast(raw);
  const raw = Array.isArray(plan.shots) ? (plan.shots as Record<string, unknown>[]) : [];

  // The hero: "you" in a what-if; else the AI's first character; else the person the AI kept
  // describing in its shots ("Japanese soldier"), named from the script when it names them.
  let hero = you ? 'you' : (cast.find((c) => c.id !== 'you')?.id ?? '');
  if (you && !cast.some((c) => c.id === 'you')) cast.unshift(YOU);
  if (!hero) {
    const counts = new Map<string, number>();
    for (const s of raw)
      for (const w of texts(
        s && typeof s === 'object' ? field(s, 'who', 'characters', 'people', 'subject') : undefined,
      )) {
        const t = w.toLowerCase();
        if (NOBODY.has(t) || isGroup(t) || firstMention(t, PROP_WORDS)) continue;
        if (wordList(t).every((x) => PRONOUNS.has(x))) continue;
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    const described = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0] ?? '';
    const ws = wordList(script);
    const she =
      ws.filter((w) => w === 'she' || w === 'her').length >
      ws.filter((w) => w === 'he' || w === 'his' || w === 'him').length;
    const first =
      beats.find((b) => described && wordList(b).some((w) => wordList(described).includes(w))) ??
      beats[0] ??
      '';
    const name = properNames(script)[0] ?? (she ? 'Her' : 'Him');
    hero =
      addCast({
        name,
        description: `${described} ${first}`.trim(),
        gender: she ? 'female' : 'male',
      }) ?? 'hero';
  }
  const heroRoles = new Set([
    ...(roles.get(hero) ?? []),
    ...mentions(script.split(/[.!?]/)[0] ?? '', ROLE_WORDS),
  ]);
  const heroItems = [...heroRoles].some((r) =>
    ['soldier', 'officer', 'police', 'guard'].includes(r),
  )
    ? ['rifle']
    : [];

  /** Whom a "who" entry means: a cast id, "crowd", "prop:<id>", or null. */
  const person = (v: string): string | null => {
    const t = v.trim().toLowerCase();
    if (NOBODY.has(t)) return null;
    const s = slug(t);
    if (cast.some((c) => c.id === s)) return s;
    const words = wordList(t);
    if (words.some((w) => w === 'you' || w === 'your' || w === 'viewer')) return you ? 'you' : hero;
    if (words.length && words.every((w) => PRONOUNS.has(w))) return hero;
    const named = cast.find((c) => words.some((w) => w.length > 2 && wordList(c.name).includes(w)));
    if (named) return named.id;
    const role = firstMention(t, ROLE_WORDS);
    const byRole = role && cast.find((c) => roles.get(c.id)?.includes(role));
    if (byRole) return byRole.id;
    if (isGroup(t)) return 'crowd';
    const p = firstMention(t, PROP_WORDS);
    if (p) return `prop:${p}`;
    // The hero's own description ("Japanese soldier") or a plain person word.
    const heroLook = looks.get(hero) ?? [];
    if (words.some((w) => w.length > 3 && heroLook.includes(w)) && (!role || heroRoles.has(role)))
      return hero;
    if (words.some((w) => PERSON_WORDS.has(w)) && (!role || heroRoles.has(role))) return hero;
    // Someone new the story needs ("old commander").
    if (role || words.some((w) => PERSON_WORDS.has(w) || w === 'old' || w === 'young'))
      return addCast({
        name: v
          .trim()
          .replace(/\b\w/g, (c) => c.toUpperCase())
          .slice(0, 40),
        description: v,
      });
    return null;
  };
  const prop = (v: string): string | null =>
    pick(PROPS, v, '' as PropId) || (firstMention(v, PROP_WORDS) ?? null);

  const models = new Map<string, string>();
  const numbered = raw.some((x) => x && typeof x === 'object' && Number.isFinite(Number(x.beat)));
  const opening = firstMention(script, SET_WORDS) ?? 'street';
  const shots: ShotPlan[] = [];
  /** Who each line is about (before staging), for lines that carry on a sentence. */
  const present: string[][] = [];
  let prevMood: Mood = 'neutral';
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!;
    const soFar = beats.slice(0, i + 1).join(' ');
    // Things named in this line or the two before it are still in the scene.
    const seen = new Set(mentions(beats.slice(Math.max(0, i - 2), i + 1).join(' '), PROP_WORDS));
    const soFarWords = new Set(wordList(soFar).flatMap((w) => [w, w.replace(/s$/, '')]));
    const found = numbered
      ? raw.find((x) => x && typeof x === 'object' && Number(x.beat) === i + 1)
      : raw[i] && typeof raw[i] === 'object'
        ? raw[i]
        : undefined;
    const s: Record<string, unknown> = found ?? {};
    const prev = shots.at(-1);

    // Where: the narration's own words win, then the AI's, then where we were.
    const place = str(field(s, 'place', 'set', 'location', 'scene', 'setting'));
    let set = ((firstMention(beat, PLACE_WORDS) as SetId | undefined) ||
      pick(SETS, place, '' as SetId) ||
      (firstMention(place, SET_WORDS) as SetId | undefined) ||
      (firstMention(beat, SET_WORDS) as SetId | undefined) ||
      prev?.set ||
      (opening as SetId)) as SetId;

    // Who: the AI's people, groups become a crowd, things it listed as "who" become objects.
    const whoRaw = texts(field(s, 'who', 'characters', 'people', 'subject', 'character'));
    const people: string[] = [];
    const whoObjects: string[] = [];
    let crowd = 0;
    for (const w of whoRaw) {
      const r = person(w);
      if (!r) continue;
      if (r === 'crowd') crowd = 3;
      else if (r.startsWith('prop:')) whoObjects.push(r.slice(5));
      else if (!people.includes(r)) people.push(r);
    }
    const saidNobody = whoRaw.some((w) => NOBODY.has(w.toLowerCase()));
    const ws = wordList(beat);
    // The narration names people too: "his old commander", "he", "Onoda".
    for (const c of cast) {
      if (people.includes(c.id) || c.id === 'you') continue;
      const byName = wordList(c.name).some((w) => w.length > 2 && ws.includes(w));
      const byRole =
        c.id !== hero && roles.get(c.id)?.some((r) => mentions(beat, ROLE_WORDS).includes(r));
      if (byName || byRole) people.push(c.id);
    }
    if (
      !people.includes(hero) &&
      (ws.some((w) => (you ? ['you', 'your'] : ['he', 'she', 'his', 'her', 'him']).includes(w)) ||
        (!people.length && !saidNobody))
    )
      people.push(hero);
    // A line that carries on the previous sentence keeps its people.
    if (prev && !/[.!?…]["')\]]*$/.test(beats[i - 1]!.trim()))
      for (const p of present.at(-1) ?? []) if (!people.includes(p)) people.push(p);

    // What is in the picture: what the line names first, then the AI's objects, but only things
    // the story has already mentioned (no leaflets before the leaflets), plus the hero's kit.
    const objectsRaw = [...texts(field(s, 'objects', 'props', 'things', 'items')), ...whoObjects];
    const props: string[] = [...mentions(beat, PROP_WORDS)];
    for (const name of objectsRaw) {
      const t = name.toLowerCase().trim();
      if (!t || NOT_OBJECTS.test(t) || person(name) === hero) continue;
      const p = prop(name);
      if (p) {
        if (seen.has(p) || (heroItems.includes(p) && people.includes(hero))) props.push(p);
        continue;
      }
      // Something the kit lacks: only when the story has named it.
      const noun = wordList(t).at(-1) ?? '';
      if (
        noun &&
        soFarWords.has(noun.replace(/s$/, '')) &&
        wordList(t).length <= 4 &&
        !firstMention(t, SET_WORDS)
      ) {
        const id = modelId(name);
        if (id && id !== 'person') {
          models.set(id, name.trim().slice(0, 40));
          props.push(`m:${id}`);
        }
      }
    }
    // The hero carries their kit once the story has made them who they are.
    if (people.includes(hero))
      for (const item of heroItems) if (!props.includes(item)) props.push(item);
    const scenery = new Set(
      set === 'forest' || set === 'jungle' || set === 'island' ? ['tree'] : [],
    );
    const uniqueProps = [...new Set(props)].filter((p) => !scenery.has(p)).slice(0, 4);

    const flying = uniqueProps.some((p) => FLYING.has(p));
    // A crowd only when the line is about people here (not people in a plane).
    if (crowdMentioned(beat) && !flying) crowd = Math.max(crowd, 3);
    if (flying) crowd = 0;
    // A plane seen by someone on the ground: stay on the ground and look up.
    if (set === 'sky' && flying && prev && prev.set !== 'sky') set = prev.set;
    present.push([...people]);
    // Something in the sky is seen from the ground, by the hero (whoever is flying is up there).
    if (flying && !['space', 'sky', 'underwater'].includes(set))
      people.splice(0, people.length, hero);
    const subject = people[0] ?? uniqueProps[0] ?? 'none';

    // What they do: the AI's action unless it is a big one the line does not support
    // (nobody sleeps, falls or floats unless the narration says so).
    const doing = str(field(s, 'doing', 'action', 'activity', 'pose'));
    const speaker = person(str(field(s, 'speaker')) || '') ?? '';
    const aiAction =
      pick(ACTIONS, doing, '' as Action) ||
      (firstMention(doing, ACTION_WORDS) as Action | undefined);
    const lineAction = firstMention(beat, ACTION_WORDS) as Action | undefined;
    const feeling = str(field(s, 'feeling', 'mood', 'emotion'));
    // The line's own feeling words win ("Nobody told him" is lonely), then the AI's.
    let mood: Mood =
      (firstMention(beat, MOOD_WORDS) as Mood | undefined) ||
      pick(MOODS, feeling, '' as Mood) ||
      (firstMention(`${feeling} ${doing}`, MOOD_WORDS) as Mood | undefined) ||
      prevMood;
    const outdoors = ![
      'livingRoom',
      'kitchen',
      'bedroom',
      'office',
      'hospital',
      'lab',
      'classroom',
      'prison',
      'bank',
      'courtroom',
    ].includes(set);
    const calm: Action =
      mood === 'scared'
        ? 'crouch'
        : outdoors && ['lonely', 'determined'].includes(mood)
          ? 'patrol'
          : 'idle';
    let action: Action =
      (aiAction && (!BIG_ACTIONS.has(aiAction) || aiAction === lineAction)
        ? aiAction
        : undefined) ??
      lineAction ??
      (speaker ? 'talk' : calm);
    // Looking up needs something up there (or a line about the sky).
    if (
      action === 'lookUp' &&
      !uniqueProps.some((p) => FLYING.has(p)) &&
      !ws.some((w) => ['sky', 'up', 'stars', 'heaven', 'moon'].includes(w))
    )
      action = lineAction && lineAction !== 'lookUp' ? lineAction : calm;
    // Being searched for: the hero hides while the searchers pass.
    if (crowd && subject === hero && !ws.some((w) => w === 'he' || w === 'she')) action = 'crouch';
    if (action === 'shock' && mood === 'neutral') mood = 'surprised';
    const effectText = str(field(s, 'effect', 'effects'));
    const effect =
      pick(EFFECTS, effectText, '' as Effect) ||
      ((firstMention(effectText, EFFECT_WORDS) ??
        firstMention(`${doing} ${beat}`, EFFECT_WORDS)) as Effect | undefined) ||
      'none';
    const cameraText = str(field(s, 'camera', 'framing', 'shot', 'view'));
    let framing =
      pick(FRAMINGS, cameraText, '' as Framing) ||
      ((firstMention(cameraText, FRAMING_WORDS) as Framing | undefined) ?? 'medium');
    let move = pick(CAMERAS, field(s, 'move', 'motion'), '' as CameraMove);

    // Film rules.
    const personShot = people.length > 0;
    if (
      flying &&
      personShot &&
      ['idle', 'think', 'talk', 'shock', 'patrol', 'crouch', 'walk'].includes(action)
    )
      action = 'lookUp';
    if (
      framing === 'lowAngle' &&
      !['proud', 'determined', 'angry'].includes(mood) &&
      action !== 'celebrate'
    )
      framing = 'medium';
    if (
      !personShot &&
      subject !== 'none' &&
      ['extremeCloseUp', 'closeUp', 'medium', 'lowAngle'].includes(framing)
    )
      framing = 'object';
    if (personShot && framing === 'object') framing = 'medium';
    if (subject === 'none') framing = 'wide';
    if (framing === 'pov' && !personShot) framing = 'object';
    if (prev && set !== prev.set && personShot && !['pov', 'object', 'overhead'].includes(framing))
      framing = 'wide';
    if (framing === 'extremeCloseUp') {
      const recent = shots.slice(-3).some((x) => x.framing === 'extremeCloseUp');
      if (recent || prev?.framing === 'closeUp') framing = 'medium';
    }
    if (
      framing === 'closeUp' &&
      (prev?.framing === 'closeUp' || prev?.framing === 'extremeCloseUp')
    )
      framing = 'medium';
    // Hands at work, and the things the line names, must be in frame.
    if (
      (['work', 'eat', 'read', 'pickUp', 'salute', 'wave'].includes(action) ||
        uniqueProps.some((p) => !heroItems.includes(p))) &&
      (framing === 'closeUp' || framing === 'extremeCloseUp')
    )
      framing = 'medium';
    if (prev && shots.length >= 2 && shots.at(-2)!.framing === framing && prev.framing === framing)
      framing = framing === 'wide' ? 'medium' : 'wide';
    if (!move)
      move =
        framing === 'wide'
          ? i % 2
            ? 'orbit'
            : 'pushIn'
          : framing === 'object'
            ? 'orbit'
            : framing === 'extremeCloseUp' || framing === 'closeUp'
              ? 'static'
              : 'pushIn';

    // Big words only when the AI gave a short, whole phrase (never cut off mid-word).
    const big = typeof s.bigText === 'string' ? s.bigText.trim() : '';
    const bigText = big && big.length <= 18 && big.split(/\s+/).length <= 3 ? big : '';

    shots.push({
      set,
      framing,
      subject,
      others: people.slice(1, 4),
      action,
      props: uniqueProps.filter((p) => p !== subject),
      effect: effect as Effect,
      camera: move,
      bigText,
      speaker: speaker && cast.some((c) => c.id === speaker) ? speaker : '',
      mood,
      crowd,
    });
    prevMood = mood === 'surprised' ? 'neutral' : mood;
  }
  const used = new Set(shots.flatMap((x) => [x.subject, ...x.others, x.speaker]));
  const usedModels = new Set(
    shots
      .flatMap((x) => [x.subject, ...x.props])
      .filter((p) => p.startsWith('m:'))
      .map((p) => p.slice(2)),
  );
  return {
    cast: cast.filter((c) => used.has(c.id)),
    shots,
    models: [...models]
      .filter(([id]) => usedModels.has(id))
      .slice(0, 8)
      .map(([id, name]) => ({ id, name })),
  };
}

/** Words that never mean an object in the picture (clothes are worn, places are sets). */
const NOT_OBJECTS =
  /^(?:(?:his|her|their|a|an|the)\s+)?(?:own\s+)?(?:uniform|clothes|clothing|outfit|shirt|trousers|cap|hat|sky|ground|air|water|sea|ocean|beach|jungle|island|forest|nothing|none|cloth|bushes|bush|grass|sand|sun light|sunlight|light|darkness|silence)s?$/;

/** Plain words for a person. */
const PERSON_WORDS = new Set([
  'man',
  'woman',
  'boy',
  'girl',
  'guy',
  'person',
  'hero',
  'protagonist',
  'character',
  'soldier',
  'kid',
  'lady',
  'gentleman',
]);

/** Actions a shot only gets when its line says so. */
const BIG_ACTIONS = new Set<Action>([
  'sleep',
  'fall',
  'float',
  'celebrate',
  'run',
  'sit',
  'shock',
  'shiver',
]);

/** A group of people ("search party", "villagers", "soldiers"). */
function isGroup(text: string): boolean {
  const ws = wordList(text);
  return ws.some((w) =>
    [
      'party',
      'parties',
      'team',
      'group',
      'crowd',
      'people',
      'everyone',
      'villagers',
      'soldiers',
      'troops',
      'men',
      'women',
      'children',
      'army',
      'police',
      'searchers',
      'locals',
      'family',
    ].includes(w),
  );
}

/** Names in a script: two or more capitalised words not at the start of a sentence. */
export function properNames(script: string): string[] {
  const out: string[] = [];
  const re = /(?<![.!?]\s)(?<!^)\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)+)\b/g;
  for (const m of script.matchAll(re)) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

const SHAPES: Record<string, Model['parts'][number]['shape']> = {
  box: 'box',
  cube: 'box',
  block: 'box',
  plank: 'box',
  cylinder: 'cylinder',
  tube: 'cylinder',
  pipe: 'cylinder',
  disc: 'cylinder',
  sphere: 'sphere',
  ball: 'sphere',
  dome: 'sphere',
  cone: 'cone',
  pyramid: 'cone',
};

function triple(
  v: unknown,
  fallback: [number, number, number],
  min: number,
  max: number,
): [number, number, number] {
  const arr = Array.isArray(v)
    ? v
    : typeof v === 'number'
      ? [v, v, v]
      : v && typeof v === 'object'
        ? [
            (v as Record<string, unknown>).x,
            (v as Record<string, unknown>).y,
            (v as Record<string, unknown>).z,
          ]
        : [];
  return [0, 1, 2].map((i) => {
    const n = Number(arr[i]);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback[i]!;
  }) as [number, number, number];
}

/** A model the AI designed, made safe: known shapes, sane sizes, standing on the ground. */
export function normaliseModel(raw: unknown, name: string): Model | null {
  if (!raw || typeof raw !== 'object') return null;
  const parts = (
    Array.isArray((raw as { parts?: unknown }).parts) ? (raw as { parts: unknown[] }).parts : []
  )
    .slice(0, 16)
    .flatMap((p) => {
      if (!p || typeof p !== 'object') return [];
      const r = p as Record<string, unknown>;
      const shape = SHAPES[String(r.shape ?? r.type ?? '').toLowerCase()] ?? 'box';
      return [
        {
          shape,
          size: triple(r.size ?? r.scale ?? r.dimensions, [0.3, 0.3, 0.3], 0.01, 30),
          at: triple(r.at ?? r.position ?? r.pos, [0, 0.15, 0], -30, 30),
          turn: triple(r.turn ?? r.rotation ?? r.rotate, [0, 0, 0], -7, 7),
          color: colour(r.color ?? r.colour, '#8a8a8a'),
        },
      ];
    });
  if (!parts.length) return null;
  // Stand it on the ground.
  const bottom = Math.min(...parts.map((p) => p.at[1] - p.size[1] / 2));
  for (const p of parts) p.at = [p.at[0], p.at[1] - bottom, p.at[2]];
  return { name: name.slice(0, 40), parts };
}

/** Words per second the narration is written for (the genre talks fast). */
export const WORDS_PER_SECOND = 2.8;
