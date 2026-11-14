// A sample-exact port of FFmpeg's acompressor (libavfilter/af_sidechaincompress.c, downward
// mode, RMS detection, channels averaged), so the preview compresses like the export (ADR-042).

export interface CompressorSettings {
  /** dB */
  threshold: number;
  ratio: number;
  /** ms */
  attack: number;
  release: number;
  /** dB */
  makeup: number;
}

const KNEE = 2.82843;

function hermite(
  x: number,
  x0: number,
  x1: number,
  p0: number,
  p1: number,
  m0: number,
  m1: number,
) {
  const width = x1 - x0;
  const t = (x - x0) / width;
  m0 *= width;
  m1 *= width;
  const t2 = t * t;
  const t3 = t2 * t;
  const ct2 = -3 * p0 - 2 * m0 + 3 * p1 - m1;
  const ct3 = 2 * p0 + m0 - 2 * p1 + m1;
  return ct3 * t3 + ct2 * t2 + m0 * t + p0;
}

export class Compressor {
  private linSlope = 0;
  private readonly ratio: number;
  private readonly thres: number;
  private readonly kneeStart: number;
  private readonly kneeStop: number;
  private readonly adjKneeStart: number;
  private readonly compressedKneeStop: number;
  private readonly attackCoeff: number;
  private readonly releaseCoeff: number;
  private readonly makeup: number;

  constructor(s: CompressorSettings, sampleRate: number) {
    // FFmpeg clamps its linear threshold to at least 0.000976563.
    const threshold = Math.max(0.000976563, Math.pow(10, s.threshold / 20));
    this.ratio = s.ratio;
    this.thres = Math.log(threshold);
    const linKneeStart = threshold / Math.sqrt(KNEE);
    const linKneeStop = threshold * Math.sqrt(KNEE);
    this.adjKneeStart = linKneeStart * linKneeStart;
    this.kneeStart = Math.log(linKneeStart);
    this.kneeStop = Math.log(linKneeStop);
    this.compressedKneeStop = (this.kneeStop - this.thres) / this.ratio + this.thres;
    this.attackCoeff = Math.min(1, 1 / ((s.attack * sampleRate) / 4000));
    this.releaseCoeff = Math.min(1, 1 / ((s.release * sampleRate) / 4000));
    this.makeup = Math.pow(10, s.makeup / 20);
  }

  private gain(linSlope: number): number {
    const slope = Math.log(linSlope) * 0.5; // RMS detection
    let gain = (slope - this.thres) / this.ratio + this.thres;
    const delta = 1 / this.ratio;
    if (KNEE > 1 && slope < this.kneeStop)
      gain = hermite(
        slope,
        this.kneeStart,
        this.kneeStop,
        this.kneeStart,
        this.compressedKneeStop,
        1,
        delta,
      );
    return Math.exp(gain - slope);
  }

  /** Compresses `channels` in place, `n` samples each. */
  process(channels: Float32Array[], n: number): void {
    const count = channels.length;
    if (!count) return;
    for (let i = 0; i < n; i++) {
      let abs = 0;
      for (let c = 0; c < count; c++) abs += Math.abs(channels[c]![i]!);
      abs /= count;
      abs *= abs;
      this.linSlope +=
        (abs - this.linSlope) * (abs > this.linSlope ? this.attackCoeff : this.releaseCoeff);
      const g =
        this.linSlope > 0 && this.linSlope > this.adjKneeStart ? this.gain(this.linSlope) : 1;
      const k = g * this.makeup;
      for (let c = 0; c < count; c++) channels[c]![i]! *= k;
    }
  }
}
