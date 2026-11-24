// Small numeric helpers for per-second signal curves. Pure, no Node or DOM.

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values)
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values)
    .filter(Number.isFinite)
    .sort((x, y) => x - y);
  if (!a.length) return 0;
  const i = clamp(p, 0, 1) * (a.length - 1);
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return a[lo]! + (a[hi]! - a[lo]!) * (i - lo);
}

/** Median absolute deviation scaled to a standard deviation (robust spread). */
export function robustStd(values: ArrayLike<number>): number {
  const m = median(values);
  const dev = Array.from(values, (v) => Math.abs(v - m));
  return median(dev) * 1.4826;
}

/**
 * Rolling median over a centred window of `radius` samples each side. Uses a coarse stride so an
 * hour of per-second data stays fast (the baseline only needs to follow slow changes).
 */
export function rollingMedian(values: ArrayLike<number>, radius: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (!n) return out;
  const stride = Math.max(1, Math.floor(radius / 8));
  const anchors: number[] = [];
  const at: number[] = [];
  for (let i = 0; i < n; i += stride) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const slice: number[] = [];
    for (let j = lo; j < hi; j++) slice.push(values[j]!);
    anchors.push(i);
    at.push(median(slice));
  }
  for (let k = 0; k < anchors.length; k++) {
    const i0 = anchors[k]!;
    const i1 = anchors[k + 1] ?? n;
    const v0 = at[k]!;
    const v1 = at[k + 1] ?? v0;
    for (let i = i0; i < i1 && i < n; i++) out[i] = v0 + ((v1 - v0) * (i - i0)) / (i1 - i0 || 1);
  }
  return out;
}

/** Gaussian smoothing with sigma in samples. */
export function smooth(values: ArrayLike<number>, sigma: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  if (sigma <= 0) {
    for (let i = 0; i < n; i++) out[i] = values[i]!;
    return out;
  }
  const r = Math.ceil(sigma * 3);
  const kernel: number[] = [];
  for (let k = -r; k <= r; k++) kernel.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let w = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const kw = kernel[k + r]!;
      sum += values[j]! * kw;
      w += kw;
    }
    out[i] = w ? sum / w : 0;
  }
  return out;
}

/**
 * How far each value rises above its local baseline, in robust standard deviations, mapped to
 * 0..1 (3 deviations or more = 1). This is what makes a moment stand out *in this video*: a loud
 * streamer is not "exciting" all the time, only when louder than usual.
 */
export function excitement(
  values: ArrayLike<number>,
  baselineRadius: number,
  minSpread: number,
): Float64Array {
  const base = rollingMedian(values, baselineRadius);
  const spread = Math.max(minSpread, robustStd(values));
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = clamp((values[i]! - base[i]!) / spread / 3);
  return out;
}

/** Resamples a series by averaging into `buckets` equal parts (for the UI). */
export function downsample(values: ArrayLike<number>, buckets: number): number[] {
  const n = values.length;
  if (n <= buckets) return Array.from(values, round3);
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor((b * n) / buckets);
    const hi = Math.max(lo + 1, Math.floor(((b + 1) * n) / buckets));
    let s = 0;
    let mx = 0;
    for (let i = lo; i < hi; i++) {
      s += values[i]!;
      mx = Math.max(mx, values[i]!);
    }
    // Keep peaks visible: blend the mean with the maximum.
    out.push(round3(0.5 * (s / (hi - lo)) + 0.5 * mx));
  }
  return out;
}

export const round3 = (v: number) => Math.round(v * 1000) / 1000;
export const round1 = (v: number) => Math.round(v * 10) / 10;

export function mean(values: ArrayLike<number>, lo = 0, hi = values.length): number {
  let s = 0;
  let n = 0;
  for (let i = Math.max(0, lo); i < Math.min(values.length, hi); i++) {
    s += values[i]!;
    n++;
  }
  return n ? s / n : 0;
}

export function max(values: ArrayLike<number>, lo = 0, hi = values.length): number {
  let m = 0;
  for (let i = Math.max(0, lo); i < Math.min(values.length, hi); i++) m = Math.max(m, values[i]!);
  return m;
}

/** "754.2" → "12:34" (or "1:02:03"). */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
}
