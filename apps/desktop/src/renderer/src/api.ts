import type {
  BackendContract,
  Contract,
  EventChannel,
  EventPayload,
  IpcErrorCode,
  RequestChannel,
  RequestInput,
  RequestOutput,
  ShellContract,
} from '@rec-it/ipc-contract';
import type { BridgeResult, RecitBridgeChannel } from '../../shared/bridge';

/** Error thrown by api calls; keeps the IPC error code (e.g. INVALID_INPUT, TIMEOUT). */
export class RecitError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RecitError';
  }
}

function unwrap<T>(result: BridgeResult): T {
  if (result.ok) return result.result as T;
  throw new RecitError(result.error.code, result.error.message);
}

function typedInvoke<C extends Contract>(channel: RecitBridgeChannel) {
  return async <K extends RequestChannel<C>>(
    name: K,
    input: RequestInput<C, K>,
  ): Promise<RequestOutput<C, K>> => unwrap<RequestOutput<C, K>>(await channel.invoke(name, input));
}

/** Renderer ⇄ backend (validated in the preload and again in the backend). */
export const backend = {
  invoke: typedInvoke<BackendContract>(window.recit.backend),
  on<K extends EventChannel<BackendContract>>(
    event: K,
    listener: (payload: EventPayload<BackendContract, K>) => void,
  ) {
    return window.recit.backend.on(event, listener as (payload: unknown) => void);
  },
  onConnectionChange: (listener: (connected: boolean) => void) =>
    window.recit.backend.onConnectionChange(listener),
};

/** Renderer ⇄ main (dialogs, secrets, app info). */
export const shell = {
  invoke: typedInvoke<ShellContract>(window.recit.shell),
};
