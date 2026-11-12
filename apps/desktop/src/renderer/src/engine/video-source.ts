// Frame-accurate random access to a proxy MP4 with WebCodecs (ADR-008, ADR-029).
// Proxies are H.264, constant frame rate, a keyframe every 12 frames and no B-frames (ADR-023),
// so decode order equals display order and any frame is at most 11 decodes from a keyframe.
// Only the movie header and the byte ranges of the needed frames are fetched, so hour-long
// proxies open instantly.
import { DataStream, Endianness } from 'mp4box';
import { fetchRange, readMovie, sampleIndexAt, trackSamples, type Mp4Sample } from './mp4';

type SampleRef = Mp4Sample;

const MAX_CACHED_FRAMES = 6;
const MAX_CACHED_BLOCKS = 4;

export class VideoSource {
  private decoder: VideoDecoder | null = null;
  /** Index of the next sample to send to the decoder, or -1 after a reset. */
  private next = -1;
  private readonly cache = new Map<number, VideoFrame>();
  private readonly waiting = new Map<number, ((f: VideoFrame | null) => void)[]>();
  private readonly byTimestamp = new Map<number, number>();
  /** Sample data by keyframe index (one block = one group of pictures). */
  private readonly blocks = new Map<number, Promise<ArrayBuffer>>();
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly url: string,
    private readonly samples: SampleRef[],
    private readonly config: VideoDecoderConfig,
    readonly width: number,
    readonly height: number,
  ) {}

  /** Reads the movie header (growing range reads until mp4box has it) and checks decoder support. */
  static async open(url: string): Promise<VideoSource> {
    const { file, movie } = await readMovie(url);
    const track = movie.videoTracks[0];
    if (!track) throw new Error('The preview file has no video.');
    const trak = file.getTrackById(track.id);
    const entry = trak.mdia.minf.stbl.stsd.entries[0] as unknown as {
      avcC?: { write(s: DataStream): void };
      hvcC?: { write(s: DataStream): void };
    };
    const box = entry.avcC ?? entry.hvcC;
    let description: Uint8Array | undefined;
    if (box) {
      const stream = new DataStream(undefined, 0, Endianness.BIG_ENDIAN);
      box.write(stream);
      description = new Uint8Array(stream.buffer as ArrayBuffer, 8); // skip the box header
    }
    const config: VideoDecoderConfig = {
      codec: track.codec,
      codedWidth: track.video!.width,
      codedHeight: track.video!.height,
      ...(description ? { description } : {}),
      optimizeForLatency: true,
    };
    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`This system cannot decode ${track.codec}.`);
    const samples = trackSamples(file, track.id);
    if (!samples.length) throw new Error('The preview file has no frames.');
    return new VideoSource(url, samples, config, track.video!.width, track.video!.height);
  }

  get duration(): number {
    const last = this.samples.at(-1)!;
    const step = this.samples.length > 1 ? last.t - this.samples.at(-2)!.t : 1 / 30;
    return last.t + step;
  }

  /** Index of the frame shown at time `t` (seconds). */
  indexAt(t: number): number {
    return sampleIndexAt(this.samples, t);
  }

  /**
   * The frame shown at `t`. Resolves with a frame the caller owns (and must close), or null if
   * the source was closed. Calls are serialised; sequential calls (playback) reuse the decoder.
   */
  frameAt(t: number): Promise<VideoFrame | null> {
    const index = this.indexAt(t);
    const run = this.queue.then(() => this.decodeTo(index));
    this.queue = run.catch(() => {});
    return run;
  }

  private keyBefore(index: number): number {
    let k = index;
    while (k > 0 && !this.samples[k]!.key) k--;
    return k;
  }

  private block(key: number): Promise<ArrayBuffer> {
    let block = this.blocks.get(key);
    if (!block) {
      let end = key + 1;
      while (end < this.samples.length && !this.samples[end]!.key) end++;
      const first = this.samples[key]!;
      const last = this.samples[end - 1]!;
      block = fetchRange(this.url, first.offset, last.offset + last.size);
      this.blocks.set(key, block);
      while (this.blocks.size > MAX_CACHED_BLOCKS)
        this.blocks.delete(this.blocks.keys().next().value!);
      block.catch(() => this.blocks.delete(key));
    }
    return block;
  }

  private ensureDecoder(): VideoDecoder {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    this.decoder = new VideoDecoder({
      output: (frame) => {
        const index = this.byTimestamp.get(frame.timestamp);
        this.byTimestamp.delete(frame.timestamp);
        if (index === undefined || this.closed) return frame.close();
        const waiters = this.waiting.get(index);
        if (waiters) {
          this.waiting.delete(index);
          for (const w of waiters) w(frame.clone());
        }
        this.cache.set(index, frame);
        while (this.cache.size > MAX_CACHED_FRAMES) {
          const oldest = this.cache.keys().next().value!;
          this.cache.get(oldest)?.close();
          this.cache.delete(oldest);
        }
      },
      error: () => {
        this.next = -1;
      },
    });
    this.decoder.configure(this.config);
    this.next = -1;
    return this.decoder;
  }

  private async feed(from: number, to: number): Promise<void> {
    const decoder = this.ensureDecoder();
    for (let i = from; i <= to && i < this.samples.length; i++) {
      const s = this.samples[i]!;
      const key = this.keyBefore(i);
      const data = await this.block(key);
      if (this.closed) return;
      const start = this.samples[key]!.offset;
      const timestamp = Math.round(s.t * 1e6);
      this.byTimestamp.set(timestamp, i);
      decoder.decode(
        new EncodedVideoChunk({
          type: s.key ? 'key' : 'delta',
          timestamp,
          data: new Uint8Array(data, s.offset - start, s.size),
        }),
      );
      this.next = i + 1;
    }
  }

  private async decodeTo(index: number): Promise<VideoFrame | null> {
    if (this.closed) return null;
    const cached = this.cache.get(index);
    if (cached) {
      // Keep the cache in recency order.
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached.clone();
    }
    const wait = new Promise<VideoFrame | null>((resolve) => {
      this.waiting.set(index, [...(this.waiting.get(index) ?? []), resolve]);
    });
    // Continue from where the decoder is if the target is just ahead; otherwise restart at the
    // keyframe before it.
    const key = this.keyBefore(index);
    const sequential = this.next >= 0 && index >= this.next && index - this.next < 24;
    if (!sequential) {
      this.ensureDecoder();
      if (this.next !== -1 || this.decoder!.decodeQueueSize > 0) {
        this.decoder!.reset();
        this.decoder!.configure(this.config);
        this.byTimestamp.clear();
      }
      this.next = key;
    }
    // Decode the target plus a little ahead so playback has frames ready.
    await this.feed(this.next, Math.min(index + 2, this.samples.length - 1));
    const timeout = new Promise<'late'>((r) => setTimeout(() => r('late'), 40));
    const first = await Promise.race([wait, timeout]);
    if (first !== 'late') return first;
    // Some decoders hold the last frames until more input or a flush arrives.
    await Promise.race([
      this.decoder!.flush().catch(() => {}),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
    this.next = -1; // after a flush the next chunk must be a keyframe
    const settled = await Promise.race([
      wait,
      new Promise<'stuck'>((r) => setTimeout(() => r('stuck'), 1000)),
    ]);
    if (settled !== 'stuck') return settled;
    // The frame never came: a decoder holds a fixed pool of frames, so never leave one unclosed,
    // and start the decoder afresh so the next request is not stuck behind this one.
    void wait.then((f) => f?.close());
    this.waiting.delete(index);
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
    this.decoder = null;
    this.byTimestamp.clear();
    this.next = -1;
    return null;
  }

  close(): void {
    this.closed = true;
    for (const f of this.cache.values()) f.close();
    this.cache.clear();
    for (const waiters of this.waiting.values()) for (const w of waiters) w(null);
    this.waiting.clear();
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close();
  }
}
