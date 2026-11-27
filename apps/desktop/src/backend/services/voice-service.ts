// AI voice (Kokoro) and title cards for faceless templates (ADR-046), run by the Python sidecar.
// The voice is an optional extra installed on request, like transcription and face detection.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageStatus, VoiceSample, VoiceStatus } from '@rec-it/ipc-contract';
import { EngineInstall } from './engine-install';
import { installExtra, type InstallState } from './extras';
import type { SidecarClient, SidecarCommand } from './sidecar';

export interface SpokenSegment {
  id: string;
  start: number;
  end: number;
  words: { text: string; start: number; end: number }[];
  /** Per-sound timings (IPA symbols), for mouth shapes (ADR-049). */
  sounds?: { p: string; start: number; end: number }[];
}

export interface VoiceDeps {
  sidecar: SidecarClient | null;
  sidecarCommand: SidecarCommand | null;
  modelsDir: string;
  fontsDir: string | undefined;
  onChange: (status: VoiceStatus) => void;
  busyElsewhere?: () => boolean;
  onEngineChanged?: () => void;
  /** Human-like voice (ADR-051): where your voice samples live, FFmpeg, and status changes. */
  voicesDir?: string;
  ffmpeg?: () => Promise<string>;
  onHumanChange?: (status: ImageStatus) => void;
  onSamplesChange?: (samples: VoiceSample[]) => void;
}

/** About 12 s of calm narration: what a Kokoro voice reads to become a cloning reference. */
const REFERENCE_TEXT =
  'The old road wound through the valley for miles. Travellers stopped at the inn by the river, ' +
  'where the fire was warm and the stories were long. Nobody remembered who built the bridge, ' +
  'but everyone agreed it had stood there for a very long time.';

/** "hq:builtin" / "hq:<sample id>" are human-like voices; the rest are Kokoro's. */
export const isHumanVoice = (voice: string) => voice.startsWith('hq:');

export class VoiceService {
  private available: boolean | null = null;
  private engine: string | undefined;
  private blocked: string | undefined;
  private install: InstallState = { state: 'idle' };
  private running = 0;

  readonly human: EngineInstall;

  constructor(private readonly d: VoiceDeps) {
    this.human = new EngineInstall({
      sidecar: d.sidecar,
      modelsDir: d.modelsDir,
      statusMethod: 'voicehq.status',
      installJob: 'voicehq.install',
      what: 'human-like voices',
      installParams: () => ({ uv: d.sidecarCommand?.command ?? 'uv' }),
      onChange: (status) => d.onHumanChange?.(status),
    });
  }

  status(): VoiceStatus {
    return {
      available: this.available,
      ...(this.engine ? { engine: this.engine } : {}),
      ...(this.blocked ? { blocked: this.blocked } : {}),
      install: this.install,
    };
  }

  private emit(): void {
    this.d.onChange(this.status());
  }

  busy(): boolean {
    return this.running > 0;
  }

  async refresh(): Promise<void> {
    void this.human.refresh();
    if (!this.d.sidecar) {
      this.available = false;
      this.blocked = 'The media-ai helper is turned off, so the AI voice is unavailable.';
      this.emit();
      return;
    }
    try {
      this.d.sidecar.start();
      const info = await this.d.sidecar.request<{
        voice?: { available: boolean; engine?: string };
      }>('system.info', {}, 60_000);
      this.available = !!info.voice?.available;
      this.engine = info.voice?.engine;
      this.blocked = undefined;
    } catch (error) {
      this.available = false;
      this.blocked = `The media-ai helper is not running (${
        error instanceof Error ? error.message : String(error)
      }). Install uv (see the README) and restart Rec-It.`;
    }
    this.emit();
  }

  /** Installs the AI voice (about 100 MB; the voice model downloads on first use). */
  installEngine(): void {
    const cmd = this.d.sidecarCommand;
    if (!cmd) throw new Error('The media-ai sidecar is turned off.');
    if (this.install.state === 'running') return;
    if (this.busy() || this.d.busyElsewhere?.())
      throw new Error('Wait for the running analysis to finish.');
    this.d.sidecar?.stop();
    installExtra(cmd, 'voice', (state, finished) => {
      this.install = state;
      this.emit();
      if (finished) {
        this.d.onEngineChanged?.();
        void this.refresh();
      }
    });
  }

  private ready(): SidecarClient {
    if (!this.d.sidecar) throw new Error('The AI voice needs the media-ai helper, which is off.');
    if (this.available === false)
      throw new Error('Install the AI voice first (Create → Install voice).');
    this.d.sidecar.start();
    return this.d.sidecar;
  }

  /** Speaks the segments one after another into a WAV file; returns each segment's word times. */
  async speak(
    segments: { id: string; text: string }[],
    o: {
      voice: string;
      speed: number;
      out: string;
      signal?: AbortSignal;
      onProgress?: (p: number, message?: string) => void;
    },
  ): Promise<{ duration: number; segments: SpokenSegment[] }> {
    if (isHumanVoice(o.voice)) return this.speakHuman(segments, o);
    const sidecar = this.ready();
    this.running++;
    try {
      return await sidecar.job(
        'tts',
        {
          segments,
          voice: o.voice,
          speed: o.speed,
          out: o.out,
          modelsDir: this.d.modelsDir,
          gap: 0.35,
        },
        {
          ...(o.signal ? { signal: o.signal } : {}),
          ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        },
      );
    } finally {
      this.running--;
    }
  }

  /** The human-like voice: Chatterbox Turbo, built-in or cloned from one of your samples. */
  private async speakHuman(
    segments: { id: string; text: string }[],
    o: {
      voice: string;
      out: string;
      signal?: AbortSignal;
      onProgress?: (p: number, message?: string) => void;
    },
  ): Promise<{ duration: number; segments: SpokenSegment[] }> {
    if (!this.d.sidecar) throw new Error('The AI voice needs the media-ai helper, which is off.');
    if (!this.human.available())
      throw new Error('Install the human-like voice first (Make a Short → voice).');
    const id = o.voice.slice(3);
    let sample: string | undefined;
    if (id.startsWith('k-')) {
      sample = await this.reference(id.slice(2));
    } else if (id !== 'builtin') {
      const found = (await this.samples()).find((v) => v.id === id);
      if (!found) throw new Error('That voice sample was removed; choose another voice.');
      sample = this.samplePath(id);
    }
    this.d.sidecar.start();
    this.running++;
    try {
      return await this.d.sidecar.job(
        'voicehq.speak',
        {
          segments,
          out: o.out,
          modelsDir: this.d.modelsDir,
          gap: 0.35,
          ...(sample ? { sample } : {}),
        },
        {
          ...(o.signal ? { signal: o.signal } : {}),
          ...(o.onProgress ? { onProgress: o.onProgress } : {}),
        },
      );
    } finally {
      this.running--;
    }
  }

  /**
   * A reference for cloning a Kokoro voice into the human-like voice: the Kokoro voice reads a
   * short neutral passage once (kept for next time), and Chatterbox speaks in that voice with
   * its own delivery. Gives every fast voice, men's included, a human-like version.
   */
  private async reference(kokoroVoice: string): Promise<string> {
    if (!/^[a-z]{2}_[a-z]+$/.test(kokoroVoice)) throw new Error('Unknown voice.');
    const path = join(this.samplesDir(), `reference-${kokoroVoice}.wav`);
    try {
      await readFile(path);
      return path;
    } catch {
      await mkdir(this.samplesDir(), { recursive: true });
      await this.speak([{ id: 'reference', text: REFERENCE_TEXT }], {
        voice: kokoroVoice,
        speed: 1,
        out: path,
      });
      return path;
    }
  }

  // ---- Voice samples (ADR-051) ----------------------------------------------------------------

  private samplesDir(): string {
    if (!this.d.voicesDir) throw new Error('Voice samples are not available here.');
    return this.d.voicesDir;
  }

  private samplePath(id: string): string {
    return join(this.samplesDir(), `${id}.wav`);
  }

  async samples(): Promise<VoiceSample[]> {
    try {
      const raw = await readFile(join(this.samplesDir(), 'voices.json'), 'utf8');
      const list = JSON.parse(raw) as VoiceSample[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  private async saveSamples(list: VoiceSample[]): Promise<void> {
    await mkdir(this.samplesDir(), { recursive: true });
    await writeFile(join(this.samplesDir(), 'voices.json'), JSON.stringify(list, null, 2));
    this.d.onSamplesChange?.(list);
  }

  /** Adds a recording you have the rights to as a voice (5–15 s of clear speech is used). */
  async addSample(path: string, name: string): Promise<VoiceSample> {
    if (!this.d.sidecar || !this.d.ffmpeg) throw new Error('The media-ai helper is off.');
    const id = `v-${randomBytes(4).toString('hex')}`;
    this.d.sidecar.start();
    const r = await this.d.sidecar.request<{ out: string; seconds: number }>(
      'voicehq.addSample',
      { path, out: this.samplePath(id), ffmpeg: await this.d.ffmpeg() },
      120_000,
    );
    const sample = { id, name: name.trim().slice(0, 60), seconds: r.seconds };
    await this.saveSamples([...(await this.samples()), sample]);
    return sample;
  }

  async removeSample(id: string): Promise<void> {
    const list = await this.samples();
    if (!list.some((v) => v.id === id)) return;
    await rm(this.samplePath(id), { force: true });
    await this.saveSamples(list.filter((v) => v.id !== id));
  }

  /**
   * Joins pieces of voice recordings (wav, start, end in seconds) into one track with short gaps,
   * and writes each piece alone too; returns where each piece landed (ADR-052).
   */
  async assemble(
    pieces: { wav: string; start: number; end: number }[],
    out: string,
    slicesDir: string,
    gap = 0.25,
  ): Promise<{ duration: number; pieces: { start: number; end: number; wav: string }[] }> {
    if (!this.d.sidecar) throw new Error('The AI voice needs the media-ai helper, which is off.');
    this.d.sidecar.start();
    return this.d.sidecar.request('audio.assemble', { pieces, out, slicesDir, gap }, 120_000);
  }

  /** A short sample of a voice as base64 WAV (for the voice picker). */
  async preview(voice: string, speed: number, text?: string): Promise<string> {
    const work = await mkdtemp(join(tmpdir(), 'recit-voice-'));
    try {
      const out = join(work, 'preview.wav');
      await this.speak(
        [{ id: 'p', text: text?.trim() || 'So this happened at my sister’s wedding last week.' }],
        { voice, speed, out },
      );
      return (await readFile(out)).toString('base64');
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Draws a title card PNG with the bundled fonts. */
  async card(params: {
    out: string;
    title: string;
    community: string;
    username: string;
    upvotes: number;
    comments: number;
    theme: 'light' | 'dark';
  }): Promise<{ width: number; height: number }> {
    const sidecar = this.ready();
    if (!this.d.fontsDir) throw new Error('The fonts are missing from this installation.');
    return sidecar.request('card.render', { ...params, fontsDir: this.d.fontsDir }, 60_000);
  }
}
