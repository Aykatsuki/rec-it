// Status and one-time download of a sidecar engine (AI pictures ADR-047, talking characters
// ADR-048): asks the sidecar whether the engine is there, and runs its install job in the
// background, reporting progress through onChange.
import type { ImageStatus } from '@rec-it/ipc-contract';
import type { SidecarClient } from './sidecar';

export interface EngineInstallOptions {
  sidecar: SidecarClient | null;
  modelsDir: string;
  /** Sidecar method that reports the engine's status, and the job that installs it. */
  statusMethod: string;
  installJob: string;
  /** What this engine makes, for messages ("AI pictures", "talking characters"). */
  what: string;
  /** Extra parameters for the install job (e.g. the uv to use). */
  installParams?: () => Record<string, unknown>;
  onChange: (status: ImageStatus) => void;
}

export class EngineInstall {
  private status_: Omit<ImageStatus, 'install'> = { available: null, installable: false };
  private install: ImageStatus['install'] = { state: 'idle' };
  private installing: AbortController | null = null;

  constructor(private readonly o: EngineInstallOptions) {}

  status(): ImageStatus {
    return { ...this.status_, install: this.install };
  }

  available(): boolean {
    return !!this.status_.available;
  }

  private emit(): void {
    this.o.onChange(this.status());
  }

  async refresh(): Promise<void> {
    const sidecar = this.o.sidecar;
    if (!sidecar) {
      this.status_ = {
        available: false,
        installable: false,
        blocked: `The media-ai helper is turned off, so ${this.o.what} are unavailable.`,
      };
      this.emit();
      return;
    }
    try {
      sidecar.start();
      this.status_ = await sidecar.request<Omit<ImageStatus, 'install'>>(
        this.o.statusMethod,
        { modelsDir: this.o.modelsDir },
        60_000,
      );
    } catch (error) {
      this.status_ = {
        available: false,
        installable: false,
        blocked: `The media-ai helper is not running (${
          error instanceof Error ? error.message : String(error)
        }).`,
      };
    }
    this.emit();
  }

  /** Downloads the engine in the background; progress arrives through onChange. */
  start(): void {
    const sidecar = this.o.sidecar;
    if (!sidecar) throw new Error('The media-ai sidecar is turned off.');
    if (this.installing) return;
    const controller = new AbortController();
    this.installing = controller;
    this.install = { state: 'running', message: 'Starting…', progress: 0 };
    this.emit();
    sidecar.start();
    void sidecar
      .job(
        this.o.installJob,
        { modelsDir: this.o.modelsDir, ...(this.o.installParams?.() ?? {}) },
        {
          signal: controller.signal,
          onProgress: (progress, message) => {
            this.install = { state: 'running', progress, ...(message ? { message } : {}) };
            this.emit();
          },
        },
      )
      .then(
        () => {
          this.install = { state: 'idle' };
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.install = controller.signal.aborted
            ? { state: 'idle' }
            : { state: 'failed', message };
        },
      )
      .finally(() => {
        this.installing = null;
        void this.refresh();
      });
  }

  cancel(): void {
    this.installing?.abort();
  }
}
