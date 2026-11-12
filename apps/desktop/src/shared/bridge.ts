// Types for what the preload exposes on `window.recit`. Shared by preload and renderer.
import type { IpcErrorCode } from '@rec-it/ipc-contract';

/** Results cross the contextBridge as plain objects so error codes survive cloning. */
export type BridgeResult<T = unknown> =
  | { ok: true; result: T }
  | {
      ok: false;
      error: { code: IpcErrorCode; message: string; issues?: { path: string; message: string }[] };
    };

export interface RecitBridgeChannel {
  invoke(channel: string, input: unknown): Promise<BridgeResult>;
}

export interface RecitBridge {
  backend: RecitBridgeChannel & {
    on(event: string, listener: (payload: unknown) => void): () => void;
    onConnectionChange(listener: (connected: boolean) => void): () => void;
  };
  shell: RecitBridgeChannel;
}

export const IPC = {
  requestBackendPort: 'recit:backend:request-port',
  backendPort: 'recit:backend:port',
  backendDisconnected: 'recit:backend:disconnected',
  shell: 'recit:shell',
} as const;
