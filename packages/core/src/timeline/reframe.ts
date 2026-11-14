// Automatic reframing (Phase 5b, ADR-035): turns face detections into a smooth horizontal
// framing path, written as keyframes on the clip's x position (source time, like all keyframes).
import { secondsToFlicks } from '../time';
import { computeLayout, type Keyframe, type Transform } from './model';

/** Face boxes per sampled frame: [x, y, width, height, score], fractions of the full picture. */
export interface FaceTrack {
  fps: number;
  frames: number[][][];
}

export interface ReframeOptions {
  /** The framing does not move while the face stays this close to the centre (share of the visible width). */
  deadZone?: number;
  /** Fastest pan, in visible widths per second. */
  maxSpeed?: number;
  /** A face this far away (visible widths) for `cutAfter` seconds makes a cut instead of a pan. */
  cutDistance?: number;
  cutAfter?: number;
  /** Keyframes may differ from the path by this much (share of the frame width). */
  tolerance?: number;
}

export type ReframeResult =
  | { ok: true; keyframes: Keyframe[]; facesSeen: number; samples: number }
  | { ok: false; reason: 'no-faces' | 'no-room' };

const DEFAULTS: Required<ReframeOptions> = {
  deadZone: 0.12,
  maxSpeed: 0.6,
  cutDistance: 0.55,
  cutAfter: 0.6,
  tolerance: 0.004,
};

/**
 * A framing path for `item` (a `srcW × srcH` picture in a `frameW × frameH` frame, with its
 * current fill/fit, scale and crop): the picture slides sideways to keep the main face near the
 * centre, holds still for small movements, pans smoothly for larger ones and cuts when the face
 * jumps far away. The main face is the largest one at first, then the one nearest to where it was.
 */
export function autoReframe(
  item: {
    sourceIn: number;
    duration: number;
    transform: Transform;
    speed?: number;
    freeze?: boolean;
  },
  src: { width: number; height: number },
  frame: { width: number; height: number },
  track: FaceTrack,
  options: ReframeOptions = {},
): ReframeResult {
  const o = { ...DEFAULTS, ...options };
  const base: Transform = { ...item.transform, x: 0, rotation: 0 };
  const layout = computeLayout(src.width, src.height, frame.width, frame.height, base);
  if (layout.width <= frame.width + 1) return { ok: false, reason: 'no-room' };
  const visible = frame.width / layout.width; // share of the picture's width on screen
  const crop = item.transform.crop;
  const cl = crop?.left ?? 0;
  const cw = 1 - cl - (crop?.right ?? 0);
  const ct = crop?.top ?? 0;
  const ch = 1 - ct - (crop?.bottom ?? 0);

  // Samples inside the clip (plus one either side so the path covers its edges).
  const from = item.sourceIn / secondsToFlicks(1);
  const span = item.freeze ? 0 : item.duration * (item.speed ?? 1);
  const to = (item.sourceIn + span) / secondsToFlicks(1);
  const first = Math.max(0, Math.floor(from * track.fps) - 1);
  const last = Math.min(track.frames.length - 1, Math.ceil(to * track.fps) + 1);
  if (last < first) return { ok: false, reason: 'no-faces' };

  // 1. The main face's centre in each sample (in the cropped picture, 0..1), or null.
  const raw: (number | null)[] = [];
  let prev: number | null = null;
  let seen = 0;
  for (let i = first; i <= last; i++) {
    const faces = (track.frames[i] ?? [])
      .map(([x, y, w, h, s]) => ({
        cx: (x! + w! / 2 - cl) / cw,
        cy: (y! + h! / 2 - ct) / ch,
        area: w! * h!,
        score: s ?? 1,
      }))
      .filter((f) => f.cx >= 0 && f.cx <= 1 && f.cy >= 0 && f.cy <= 1);
    if (!faces.length) {
      raw.push(null);
      continue;
    }
    seen++;
    const biggest = Math.max(...faces.map((f) => f.area));
    const candidates = faces.filter((f) => f.area >= biggest * 0.4);
    const last: number | null = prev;
    const pick: { cx: number; area: number } =
      last === null
        ? candidates.reduce((a, b) => (b.area > a.area ? b : a))
        : candidates.reduce((a, b) => (Math.abs(b.cx - last) < Math.abs(a.cx - last) ? b : a));
    raw.push(pick.cx);
    prev = pick.cx;
  }
  if (!seen) return { ok: false, reason: 'no-faces' };

  // 2. Fill gaps by holding the last position (and the first one backwards).
  const firstSeen = raw.find((v) => v !== null)!;
  let hold = firstSeen;
  const filled = raw.map((v) => (v === null ? hold : (hold = v)));

  // 3. Median of five samples removes single-frame jitter and false detections.
  const median = filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - 2), i + 3).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)]!;
  });

  // 4. A virtual camera follows the face: still inside the dead zone, pans at a limited speed,
  //    cuts when the face has been far away for a while.
  const dt = 1 / track.fps;
  const deadZone = o.deadZone * visible;
  const step = o.maxSpeed * visible * dt;
  const farFor = Math.max(1, Math.round(o.cutAfter * track.fps));
  const half = visible / 2;
  const clampC = (c: number) => Math.min(1 - half, Math.max(half, c));
  let c = clampC(median[0]!);
  let far = 0;
  let following = false;
  const path: { c: number; cut: boolean }[] = [];
  for (const u of median) {
    const d = u - c;
    let cut = false;
    if (Math.abs(d) > o.cutDistance * visible) {
      // Far away: hold still until it has stayed there long enough, then cut to it.
      far++;
      if (far >= farFor) {
        c = clampC(u);
        far = 0;
        following = false;
        cut = true;
      }
    } else {
      far = 0;
      // Start following when the face leaves the dead zone; keep following (so a steady walk
      // gives a steady pan) until the camera has caught up to half the dead zone.
      if (Math.abs(d) > deadZone) following = true;
      if (following) {
        const want = d - Math.sign(d) * deadZone * 0.5;
        if (Math.abs(want) < 1e-6 || Math.sign(want) !== Math.sign(d)) following = false;
        else c = clampC(c + Math.sign(want) * Math.min(Math.abs(want), step));
      }
    }
    path.push({ c, cut });
  }

  // 5. Camera centre → x offset (share of the frame width); simplify into keyframes.
  const limit = (layout.width - frame.width) / (2 * frame.width);
  const xOf = (cc: number) =>
    Math.min(limit, Math.max(-limit, (layout.width * (0.5 - cc)) / frame.width));
  const pts = path.map((p, k) => ({
    t: Math.min(Math.max((first + k) / track.fps, from), to),
    x: xOf(p.c),
    cut: p.cut,
  }));
  // Cuts split the path into pieces that are simplified separately; the last point before a cut
  // holds its value so the picture jumps on the frame of the cut.
  const keys: Keyframe[] = [];
  let start = 0;
  const flush = (end: number, holdLast: boolean) => {
    const piece = simplify(pts.slice(start, end + 1), o.tolerance);
    piece.forEach((p, i) =>
      keys.push({
        t: secondsToFlicks(p.t),
        v: Math.round(p.x * 10000) / 10000,
        e: holdLast && i === piece.length - 1 ? 'hold' : 'linear',
      }),
    );
  };
  for (let k = 1; k < pts.length; k++) {
    if (pts[k]!.cut) {
      flush(k - 1, true);
      start = k;
    }
  }
  flush(pts.length - 1, false);
  // Neighbouring samples clamped to the clip edges can share a time; keep the later one.
  const unique = keys.filter((k, i) => i + 1 >= keys.length || keys[i + 1]!.t !== k.t);
  return { ok: true, keyframes: unique, facesSeen: seen, samples: raw.length };
}

/** Ramer–Douglas–Peucker on (t, x): keeps the points needed to stay within `eps` of the path. */
function simplify<T extends { t: number; x: number }>(pts: T[], eps: number): T[] {
  if (pts.length <= 2) return pts;
  const a = pts[0]!;
  const b = pts.at(-1)!;
  let worst = 0;
  let at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!;
    const k = b.t === a.t ? 0 : (p.t - a.t) / (b.t - a.t);
    const d = Math.abs(p.x - (a.x + k * (b.x - a.x)));
    if (d > worst) {
      worst = d;
      at = i;
    }
  }
  if (worst <= eps) return [a, b];
  return [...simplify(pts.slice(0, at + 1), eps).slice(0, -1), ...simplify(pts.slice(at), eps)];
}
