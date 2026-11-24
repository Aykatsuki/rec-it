// AI voice (Kokoro) and title cards for faceless templates (ADR-046), run by the Python sidecar.
// The voice is an optional extra installed on request, like transcription and face detection.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VoiceStatus } from '@rec-it/ipc-contract';
import { installExtra, type InstallState } from './extras';
import type { SidecarClient, SidecarCommand } from './sidecar';

export interface SpokenSegment {
  id: string;
  start: number;
  end: number;
  words: { text: string; start: number; end: number }[];
}

export interface VoiceDeps {
  sidecar: SidecarClient | null;
  sidecarCommand: SidecarCommand | null;
  modelsDir: string;
  fontsDir: string | undefined;
  onChange: (status: VoiceStatus) => void;
  busyElsewhere?: () => boolean;
  onEngineChanged?: () => void;
}

export class VoiceService {
  private available: boolean | null = null;
  private engine: string | undefined;
  private blocked: string | undefined;
  private install: InstallState = { state: 'idle' };
  private running = 0;

  constructor(private readonly d: VoiceDeps) {}

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
