// Low-poly 3D Shorts (ADR-054): the vocabulary a shot is built from, the render spec the renderer
// films, and the pure planning around it (beats from a script, beat times from the voice, mouth
// shapes from the voice's sounds, a safe plan from whatever the AI answered). No three.js here:
// the renderer builds the pictures (apps/desktop/src/renderer/src/lowpoly).
import { z } from 'zod';

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
  props: z.array(z.enum(PROPS)).max(4),
  effect: z.enum(EFFECTS),
  camera: z.enum(CAMERAS),
  /** Big words in the picture (a sign, a joke), at most a few words. */
  bigText: z.string().max(24).default(''),
  /** The cast member who says this line on screen ("" when it is narration). */
  speaker: z.string().max(24).default(''),
  /** Mouth shape per frame for the speaker (0 shut … 3 round). */
  mouth: z.array(z.number().int().min(0).max(3)).max(3600).default([]),
  seed: z.number().int().min(0).max(1_000_000),
});
export type ShotSpec = z.output<typeof shotSpecSchema>;

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
    const all = text.split(/\s+/);
    const half = Math.ceil(all.length / 2);
    return [...cut(all.slice(0, half).join(' ')), ...cut(all.slice(half).join(' '))];
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

/** Any AI cast member made safe to build. */
export function normaliseCastMember(raw: Record<string, unknown>): CastMember {
  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Person';
  const id = slug(typeof raw.id === 'string' && raw.id.trim() ? raw.id : name);
  const gender = pick(['male', 'female'] as const, raw.gender, 'male');
  return {
    id,
    name: name.slice(0, 60),
    gender,
    age: pick(['child', 'young', 'adult', 'old'] as const, raw.age, 'adult'),
    skin: pick(SKINS, raw.skin, 'light'),
    hair: pick(HAIRS, raw.hair, gender === 'female' ? 'long' : 'short'),
    hairColor: colour(raw.hairColor, '#3a2a1e'),
    top: pick(TOPS, raw.top, 'tshirt'),
    topColor: colour(raw.topColor, '#4a6fa5'),
    bottomColor: colour(raw.bottomColor, '#3a3f4a'),
    extra: pick(EXTRAS, raw.extra, 'none'),
  };
}

export interface PlannedShot {
  beat?: unknown;
  set?: unknown;
  framing?: unknown;
  subject?: unknown;
  others?: unknown;
  action?: unknown;
  props?: unknown;
  effect?: unknown;
  camera?: unknown;
  bigText?: unknown;
  speaker?: unknown;
}

/** One shot of a plan, before it has times. */
export type ShotPlan = Omit<ShotSpec, 'start' | 'end' | 'mouth' | 'seed'> & {
  /** The cast member whose mouth moves to the voice, if any. */
  speaker: string;
};

/**
 * Makes any AI storyboard safe to build: one shot per beat (a beat the AI skipped repeats the
 * previous set with a closer camera), every value from the vocabulary, subjects that exist, and
 * some variety (never the same framing three times running).
 */
export function normalisePlan(
  plan: { cast?: unknown; shots?: unknown },
  beats: number,
  /** Characters to keep (remembered or chosen); planned ones with the same id or name are replaced. */
  keep: readonly CastMember[] = [YOU],
): { cast: CastMember[]; shots: ShotPlan[] } {
  const cast: CastMember[] = [...keep];
  const rawCast = Array.isArray(plan.cast) ? (plan.cast as Record<string, unknown>[]) : [];
  for (const raw of rawCast.slice(0, 6)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = normaliseCastMember(raw);
    if (cast.some((k) => k.id === c.id || k.name.toLowerCase() === c.name.toLowerCase())) continue;
    if (cast.length < 8) cast.push(c);
  }
  const ids = new Set(cast.map((c) => c.id));
  const resolve = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const s = slug(v);
    if (ids.has(s)) return s;
    const first = s.split('_')[0]!;
    const byName = cast.find((c) => c.name.toLowerCase().split(/\s+/).includes(first));
    if (byName) return byName.id;
    const prop = pick(PROPS, v, '' as PropId);
    if (prop) return prop;
    if (/^(none|nothing|scene|set)$/i.test(v.trim())) return 'none';
    return null;
  };
  const raw = Array.isArray(plan.shots) ? (plan.shots as PlannedShot[]) : [];
  const shots: ShotPlan[] = [];
  // Shots are matched by beat number when the AI numbered them, else by position.
  const numbered = raw.some((x) => x && typeof x === 'object' && Number.isFinite(Number(x.beat)));
  for (let i = 0; i < beats; i++) {
    const s = numbered
      ? raw.find((x) => x && typeof x === 'object' && Number(x.beat) === i + 1)
      : raw[i] && typeof raw[i] === 'object'
        ? raw[i]
        : undefined;
    const prev = shots.at(-1);
    if (!s) {
      shots.push(
        prev
          ? { ...prev, framing: prev.framing === 'wide' ? 'closeUp' : 'wide', bigText: '' }
          : {
              set: 'street',
              framing: 'medium',
              subject: 'you',
              others: [],
              action: 'idle',
              props: [],
              effect: 'none',
              camera: 'pushIn',
              bigText: '',
              speaker: '',
            },
      );
      continue;
    }
    const subject =
      resolve(s.subject) ?? (prev?.subject && ids.has(prev.subject) ? prev.subject : 'you');
    const others = (Array.isArray(s.others) ? s.others : [])
      .map(resolve)
      .filter((o): o is string => !!o && ids.has(o) && o !== subject)
      .slice(0, 4);
    const props = [
      ...new Set(
        (Array.isArray(s.props) ? s.props : [])
          .map((p) => pick(PROPS, p, '' as PropId))
          .filter((p): p is PropId => !!p),
      ),
    ].slice(0, 4);
    const speaker = resolve(s.speaker);
    shots.push({
      set: pick(SETS, s.set, prev?.set ?? 'street'),
      framing: pick(FRAMINGS, s.framing, 'medium'),
      subject,
      others,
      action: pick(ACTIONS, s.action, 'idle'),
      props,
      effect: pick(EFFECTS, s.effect, 'none'),
      camera: pick(CAMERAS, s.camera, 'pushIn'),
      bigText: typeof s.bigText === 'string' ? s.bigText.trim().slice(0, 24) : '',
      speaker: speaker && ids.has(speaker) ? speaker : '',
    });
  }
  // Variety: never the same framing three times in a row.
  for (let i = 2; i < shots.length; i++) {
    const a = shots[i - 2]!.framing;
    if (a === shots[i - 1]!.framing && a === shots[i]!.framing)
      shots[i] = { ...shots[i]!, framing: a === 'closeUp' ? 'wide' : 'closeUp' };
  }
  // A cast member nobody uses is not built.
  const used = new Set(shots.flatMap((s) => [s.subject, ...s.others, s.speaker]));
  return { cast: cast.filter((c) => used.has(c.id)), shots };
}

/** Words per second the narration is written for (the genre talks fast). */
export const WORDS_PER_SECOND = 2.8;
