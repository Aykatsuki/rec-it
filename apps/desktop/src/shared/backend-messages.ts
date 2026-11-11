// Messages between the main process and the backend utilityProcess (both trusted).
import type { SecretName } from '@rec-it/ipc-contract';

export interface BackendConfig {
  userDataDir: string;
  appVersion: string;
  electronVersion: string;
  ffmpeg: { envPath?: string | undefined; bundledDir: string };
  /** null disables the sidecar (e.g. in tests that do not need Python). */
  sidecar: { command: string; args: string[]; cwd: string } | null;
}

export type MainToBackend =
  | { type: 'init'; config: BackendConfig }
  | { type: 'secrets'; values: Partial<Record<SecretName, string>> }
  /** Carries a MessagePort for one renderer in `ports[0]`. */
  | { type: 'connect'; windowId: number };

export type BackendToMain = { type: 'ready' } | { type: 'fatal'; message: string };
