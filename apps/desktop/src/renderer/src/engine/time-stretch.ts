// Pitch-preserving time stretch for the preview's sound at other speeds (ADR-039): WSOLA
// (waveform-similarity overlap-add). Each output window is taken from near its nominal input
// position, at the offset whose waveform best continues the previous window, so speech keeps its
// pitch. The export uses FFmpeg's atempo, which works the same way.

const WINDOW = 0.03; // seconds per window (overlap 50 %)
const SEEK = 0.012; // how far either side to look for the best continuation

/**
 * Plays `input` (channels, all the same length) `rate` times as fast, producing `outLength`
 * samples per channel. The input must hold at least outLength × rate samples (plus a window).
 */
export function timeStretch(
  input: Float32Array[],
  sampleRate: number,
  rate: number,
  outLength: number,
): Float32Array[] {
  const n = Math.max(64, Math.round(WINDOW * sampleRate) & ~1);
  const hop = n / 2;
  const seek = Math.round(SEEK * sampleRate);
  const len = input[0]?.length ?? 0;
  const out = input.map(() => new Float32Array(outLength));
  const norm = new Float32Array(outLength);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
  // Mono mix for matching.
  const mono = new Float32Array(len);
  for (const ch of input) for (let i = 0; i < len; i++) mono[i]! += ch[i]! / input.length;

  let prev = -1;
  for (let o = -hop; o < outLength; o += hop) {
    const nominal = Math.round(Math.max(0, o) * rate) - (o < 0 ? hop : 0);
    let best = Math.max(0, Math.min(len - n, nominal));
    if (prev >= 0) {
      // The natural continuation of the previous window, compared over half a window.
      const natural = prev + hop;
      let bestScore = -Infinity;
      const lo = Math.max(0, nominal - seek);
      const hi = Math.min(len - n, nominal + seek);
      for (let c = lo; c <= hi; c += 2) {
        let score = 0;
        for (let i = 0; i < hop; i += 4) score += mono[c + i]! * (mono[natural + i] ?? 0);
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
    }
    prev = best;
    for (let i = 0; i < n; i++) {
      const t = o + i;
      if (t < 0 || t >= outLength) continue;
      const w = win[i]!;
      norm[t]! += w;
      for (let c = 0; c < input.length; c++) out[c]![t]! += (input[c]![best + i] ?? 0) * w;
    }
  }
  for (let t = 0; t < outLength; t++) {
    const k = norm[t]! > 1e-3 ? 1 / norm[t]! : 0;
    for (const ch of out) ch[t]! *= k;
  }
  return out;
}
