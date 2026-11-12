// Decodes ranges of a proxy's AAC audio with WebCodecs (ADR-030). Like the video source, only
// the header and the needed byte ranges are fetched.
import { fetchRange, readMovie, sampleIndexAt, trackSamples, type Mp4Sample } from './mp4';

/** Decoded audio: `start` is the source time (seconds) of its first sample. */
export interface DecodedAudio {
  start: number;
  sampleRate: number;
  channels: Float32Array[];
}

/** Finds the AudioSpecificConfig (descriptor tag 5) inside an esds box. */
function audioSpecificConfig(desc: unknown): Uint8Array | undefined {
  const d = desc as { tag?: number; data?: Uint8Array; descs?: unknown[] } | undefined;
  if (!d) return undefined;
  if (d.tag === 5 && d.data) return d.data;
  for (const child of d.descs ?? []) {
    const found = audioSpecificConfig(child);
    if (found) return found;
  }
  return undefined;
}

export class AudioSource {
  private constructor(
    private readonly url: string,
    private readonly samples: Mp4Sample[],
    private readonly config: AudioDecoderConfig,
  ) {}

  /** Opens the first audio track; null when the file has no audio. */
  static async open(url: string): Promise<AudioSource | null> {
    const { file, movie } = await readMovie(url);
    const track = movie.audioTracks[0];
    if (!track?.audio) return null;
    const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0] as unknown as {
      esds?: { esd?: unknown };
    };
    const description = audioSpecificConfig(entry.esds?.esd);
    const config: AudioDecoderConfig = {
      codec: track.codec,
      sampleRate: track.audio.sample_rate,
      numberOfChannels: track.audio.channel_count,
      ...(description ? { description } : {}),
    };
    const support = await AudioDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error(`This system cannot decode ${track.codec} audio.`);
    const samples = trackSamples(file, track.id);
    if (!samples.length) return null;
    return new AudioSource(url, samples, config);
  }

  get sampleRate(): number {
    return this.config.sampleRate;
  }

  /** Decodes source time [from, to) (seconds), with a frame of pre-roll for the AAC decoder. */
  async decode(from: number, to: number): Promise<DecodedAudio | null> {
    const s = this.samples;
    const first = Math.max(0, sampleIndexAt(s, from) - 1);
    const last = Math.min(s.length - 1, sampleIndexAt(s, to) + 1);
    if (to <= s[0]!.t && first === 0 && last === 0) return null;
    // Audio samples are interleaved with video in a proxy; one range covers them all.
    const begin = Math.min(...s.slice(first, last + 1).map((x) => x.offset));
    const end = Math.max(...s.slice(first, last + 1).map((x) => x.offset + x.size));
    const data = await fetchRange(this.url, begin, end);
    const outputs: AudioData[] = [];
    let failure: unknown = null;
    const decoder = new AudioDecoder({
      output: (a) => outputs.push(a),
      error: (e) => (failure = e),
    });
    try {
      decoder.configure(this.config);
      for (let i = first; i <= last; i++) {
        const x = s[i]!;
        decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: Math.round(x.t * 1e6),
            data: new Uint8Array(data, x.offset - begin, x.size),
          }),
        );
      }
      await decoder.flush();
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
    if (failure) throw failure instanceof Error ? failure : new Error(String(failure));
    if (!outputs.length) return null;
    outputs.sort((a, b) => a.timestamp - b.timestamp);
    const channels = this.config.numberOfChannels;
    const length = outputs.reduce((n, a) => n + a.numberOfFrames, 0);
    const out = Array.from({ length: channels }, () => new Float32Array(length));
    let at = 0;
    for (const a of outputs) {
      for (let c = 0; c < channels; c++) {
        a.copyTo(out[c]!.subarray(at, at + a.numberOfFrames), {
          planeIndex: c,
          format: 'f32-planar',
        });
      }
      at += a.numberOfFrames;
    }
    const start = outputs[0]!.timestamp / 1e6;
    for (const a of outputs) a.close();
    return { start, sampleRate: this.config.sampleRate, channels: out };
  }
}
