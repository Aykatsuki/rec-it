// Timeline audio through Web Audio (ADR-030). Clips are decoded in one-second blocks a little
// ahead of the playhead and scheduled sample-accurately; the audio clock is the master clock.
import {
  FLICKS_PER_SECOND,
  flicksToSeconds,
  sourceTimeAt,
  gainAt,
  isRetimed,
  speedOf,
  type Sequence,
  type TimelineItem,
} from '@rec-it/core';
import { AudioSource } from './audio-source';
import { timeStretch } from './time-stretch';

/** One audible clip: where its sound comes from. */
export interface AudioClip {
  item: TimelineItem;
  /** Preview file with the clip's sound (proxy-v2.mp4 or proxy.m4a). */
  url: string;
}

const BLOCK = 1; // seconds per scheduled block
const LOOKAHEAD = 2; // seconds scheduled ahead of the playhead
const START_DELAY = 0.08; // seconds between pressing play and the first sample
const CURVE_POINTS_PER_SECOND = 50; // volume automation resolution

const sec = (flicks: number) => flicksToSeconds(flicks as never);

/** Audible clips in a sequence (same rules as export: muted tracks and clips are silent). */
export function audibleClips(
  seq: Sequence,
  urlFor: (item: TimelineItem) => string | undefined,
): AudioClip[] {
  return seq.tracks
    .filter((t) => !t.muted)
    .flatMap((t) => t.items)
    .filter((i) => !i.muted && !i.freeze)
    .flatMap((item) => {
      const url = urlFor(item);
      return url ? [{ item, url }] : [];
    });
}

interface Block {
  channels: Float32Array[];
  rate: number;
  /** Where in `channels` (seconds) timeline time `a` is. */
  offset: number;
}

async function plainBlock(
  source: AudioSource,
  item: TimelineItem,
  a: number,
  b: number,
): Promise<Block | null> {
  const srcA = sec(sourceTimeAt(item, Math.round(a * FLICKS_PER_SECOND)));
  const decoded = await source.decode(srcA, srcA + (b - a));
  if (!decoded) return null;
  return { channels: decoded.channels, rate: decoded.sampleRate, offset: srcA - decoded.start };
}

/** Margin decoded around a retimed block for the time stretch's windows (seconds). */
const STRETCH_MARGIN = 0.06;

/**
 * Sound of a clip at another speed or reversed (ADR-039): the source range the block plays,
 * reversed if needed, stretched to the block's length with its pitch kept.
 */
async function retimedBlock(
  source: AudioSource,
  item: TimelineItem,
  a: number,
  b: number,
): Promise<Block | null> {
  const k = speedOf(item);
  if (k <= 0) return null; // freeze frames are silent
  const at = (t: number) => sec(sourceTimeAt(item, Math.round(t * FLICKS_PER_SECOND)));
  const span = (b - a) * k;
  const lo = item.reverse ? at(b) : at(a);
  const from = Math.max(0, lo - STRETCH_MARGIN);
  const decoded = await source.decode(from, lo + span + STRETCH_MARGIN);
  if (!decoded) return null;
  const rate = decoded.sampleRate;
  const i0 = Math.max(0, Math.round((lo - decoded.start) * rate));
  const n = Math.round(span * rate);
  const before = Math.min(i0, Math.round(STRETCH_MARGIN * rate));
  const input = decoded.channels.map((ch) => {
    if (!item.reverse) return ch.subarray(i0);
    // Backwards from the block's last sample, with the margin before it at the end.
    const part = ch.slice(i0 - before, Math.min(ch.length, i0 + n));
    return part.reverse();
  });
  const outLength = Math.max(1, Math.round((b - a) * rate));
  const channels =
    Math.abs(k - 1) < 1e-9
      ? input.map((ch) => {
          const out = new Float32Array(outLength);
          out.set(ch.subarray(0, outLength));
          return out;
        })
      : timeStretch(input, rate, k, outLength);
  return { channels, rate, offset: 0 };
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private readonly sources = new Map<string, Promise<AudioSource | null>>();
  private nodes: AudioScheduledSourceNode[] = [];
  private scheduled = new Set<string>();
  private timer = 0;
  private clips: AudioClip[] = [];
  /** Timeline time at context time `ctxStart`. */
  private seqStart = 0;
  private ctxStart = 0;
  private running = false;
  private generation = 0;

  private source(url: string): Promise<AudioSource | null> {
    let s = this.sources.get(url);
    if (!s) {
      s = AudioSource.open(url).catch(() => null);
      this.sources.set(url, s);
    }
    return s;
  }

  private context(): AudioContext {
    this.ctx ??= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    return this.ctx;
  }

  private perfStart = 0;
  private wallClock = false;

  /**
   * Current timeline time while playing: the audio clock (master), or the wall clock when the
   * audio clock does not run (no audio device, audio blocked by the system).
   */
  now(): number {
    if (!this.running || !this.ctx) return this.seqStart;
    const wall = (performance.now() - this.perfStart) / 1000 - START_DELAY;
    if (!this.wallClock && this.ctx.currentTime <= this.ctxStart - START_DELAY && wall > 0.3)
      this.wallClock = true;
    const elapsed = this.wallClock ? wall : this.ctx.currentTime - this.ctxStart;
    return this.seqStart + Math.max(0, elapsed);
  }

  /** True when playback follows the wall clock because the audio clock is not running. */
  get usingWallClock(): boolean {
    return this.wallClock;
  }

  get playing(): boolean {
    return this.running;
  }

  /** Starts playback at timeline time `from`. */
  async play(clips: AudioClip[], from: number): Promise<void> {
    this.stop();
    const ctx = this.context();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    this.clips = clips;
    this.seqStart = from;
    this.ctxStart = ctx.currentTime + START_DELAY;
    this.perfStart = performance.now();
    this.wallClock = false;
    this.running = true;
    const generation = ++this.generation;
    const tick = () => {
      if (generation !== this.generation) return;
      void this.fill(ctx, this.now(), this.now() + LOOKAHEAD, generation);
    };
    tick();
    this.timer = window.setInterval(tick, 250);
  }

  /** Replaces the clips while playing (after an edit), keeping the clock. */
  async update(clips: AudioClip[]): Promise<void> {
    if (!this.running) return;
    await this.play(clips, this.now());
  }

  stop(): void {
    this.generation++;
    window.clearInterval(this.timer);
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        // Already stopped.
      }
      n.disconnect();
    }
    this.nodes = [];
    this.scheduled.clear();
    if (this.running) this.seqStart = this.now();
    this.running = false;
  }

  /** Schedules every block that overlaps [from, to) and is not scheduled yet. */
  private async fill(
    ctx: BaseAudioContext,
    from: number,
    to: number,
    generation: number,
  ): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const clip of this.clips) {
      const start = sec(clip.item.start);
      const end = sec(clip.item.start + clip.item.duration);
      if (end <= from || start >= to) continue;
      const firstBlock = Math.max(0, Math.floor((from - start) / BLOCK));
      for (let k = firstBlock; start + k * BLOCK < Math.min(end, to); k++) {
        const key = `${clip.item.id}:${k}`;
        if (this.scheduled.has(key)) continue;
        this.scheduled.add(key);
        const a = start + k * BLOCK;
        const b = Math.min(end, a + BLOCK);
        jobs.push(this.scheduleBlock(ctx, clip, a, b, generation).catch(() => {}));
      }
    }
    await Promise.all(jobs);
  }

  private async scheduleBlock(
    ctx: BaseAudioContext,
    clip: AudioClip,
    a: number,
    b: number,
    generation: number,
  ): Promise<void> {
    const source = await this.source(clip.url);
    if (!source) return;
    const item = clip.item;
    const block = isRetimed(item)
      ? await retimedBlock(source, item, a, b)
      : await plainBlock(source, item, a, b);
    if (!block || generation !== this.generation) return;
    const buffer = ctx.createBuffer(block.channels.length, block.channels[0]!.length, block.rate);
    block.channels.forEach((data, c) => buffer.copyToChannel(data as Float32Array<ArrayBuffer>, c));
    let when = this.ctxStart + (a - this.seqStart);
    let offset = block.offset;
    let duration = b - a;
    // A block that should already have started (playback began inside it) starts part-way.
    const late = ctx.currentTime - when;
    if (late > 0) {
      when += late;
      offset += late;
      duration -= late;
    }
    if (duration <= 0 || offset < 0) return;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    const gain = ctx.createGain();
    const it = clip.item;
    const faded = (f?: { in: number; out: number }) => !!f && (f.in > 0 || f.out > 0);
    if (it.keyframes?.volume?.length || faded(it.fade) || faded(it.audioFade)) {
      const points = Math.max(2, Math.ceil(duration * CURVE_POINTS_PER_SECOND));
      const curve = new Float32Array(points);
      const t0 = b - duration; // timeline time where this node starts
      for (let i = 0; i < points; i++) {
        const t = t0 + (duration * i) / (points - 1);
        const at = Math.round(t * FLICKS_PER_SECOND);
        // Fades match FFmpeg's afade (linear) in the export (ADR-036, ADR-037).
        curve[i] = gainAt(clip.item, at);
      }
      gain.gain.setValueCurveAtTime(curve, when, duration);
    } else {
      gain.gain.value = clip.item.volume;
    }
    node.connect(gain).connect(ctx.destination);
    node.start(when, offset, duration);
    if (ctx instanceof AudioContext) this.nodes.push(node);
  }

  /**
   * Renders [from, from + duration) of the timeline offline with the same scheduling, for
   * comparing preview audio with the export (tests and diagnostics).
   */
  async renderOffline(clips: AudioClip[], from: number, duration: number): Promise<AudioBuffer> {
    const ctx = new OfflineAudioContext(2, Math.ceil(duration * 48000), 48000);
    const saved = { clips: this.clips, seqStart: this.seqStart, ctxStart: this.ctxStart };
    const generation = this.generation;
    this.clips = clips;
    this.seqStart = from;
    this.ctxStart = 0;
    const scheduled = this.scheduled;
    this.scheduled = new Set();
    try {
      await this.fill(ctx, from, from + duration, generation);
    } finally {
      this.clips = saved.clips;
      this.seqStart = saved.seqStart;
      this.ctxStart = saved.ctxStart;
      this.scheduled = scheduled;
    }
    return ctx.startRendering();
  }

  dispose(): void {
    this.stop();
    void this.ctx?.close();
    this.ctx = null;
  }
}
