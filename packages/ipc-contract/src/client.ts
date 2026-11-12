import type { BridgeClient, Contract, TypedClient } from './define';
import { envelopeSchema, zodIssues, type Transport } from './envelope';
import { IpcError, type IpcErrorCode } from './errors';

export interface ClientOptions {
  timeoutMs?: number;
}

export interface IpcClient<C extends Contract> extends TypedClient<C> {
  /** Untyped surface, safe to pass through Electron's contextBridge. */
  readonly bridge: BridgeClient;
  /** Rejects all pending requests (e.g. when the transport closes). */
  dispose(reason?: string): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  channel: string;
}

export function createIpcClient<C extends Contract>(
  contract: C,
  transport: Transport,
  options: ClientOptions = {},
): IpcClient<C> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  let nextId = 1;
  let disposed = false;

  const unsubscribe = transport.subscribe((raw) => {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.kind === 'response') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (!message.ok) {
        const e = message.error ?? { code: 'HANDLER_ERROR', message: 'Unknown error' };
        entry.reject(
          new IpcError({ code: e.code as IpcErrorCode, message: e.message, issues: e.issues }),
        );
        return;
      }
      const def = contract.requests[entry.channel];
      const output = def?.output.safeParse(message.result);
      if (!output?.success) {
        entry.reject(
          new IpcError({
            code: 'INVALID_OUTPUT',
            message: `Response for "${entry.channel}" failed validation`,
            ...(output ? { issues: zodIssues(output.error) } : {}),
          }),
        );
        return;
      }
      entry.resolve(output.data);
    } else if (message.kind === 'event') {
      const schema = contract.events[message.channel];
      const checked = schema?.safeParse(message.payload);
      if (!checked?.success) return;
      for (const listener of listeners.get(message.channel) ?? []) listener(checked.data);
    }
  });

  const invoke = (channel: string, input: unknown): Promise<unknown> => {
    if (disposed)
      return Promise.reject(new IpcError({ code: 'DISCONNECTED', message: 'Client is disposed' }));
    const def = Object.hasOwn(contract.requests, channel) ? contract.requests[channel] : undefined;
    if (!def) {
      return Promise.reject(
        new IpcError({ code: 'UNKNOWN_CHANNEL', message: `Unknown channel "${channel}"` }),
      );
    }
    const checked = def.input.safeParse(input);
    if (!checked.success) {
      return Promise.reject(
        new IpcError({
          code: 'INVALID_INPUT',
          message: `Invalid input for "${channel}"`,
          issues: zodIssues(checked.error),
        }),
      );
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new IpcError({
            code: 'TIMEOUT',
            message: `"${channel}" timed out after ${timeoutMs} ms`,
          }),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, channel });
      transport.send({ kind: 'request', id, channel, payload: checked.data });
    });
  };

  const on = (event: string, listener: (payload: unknown) => void) => {
    if (!Object.hasOwn(contract.events, event)) throw new Error(`Unknown event "${event}"`);
    let set = listeners.get(event);
    if (!set) listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  };

  const bridge: BridgeClient = { invoke, on };

  return {
    bridge,
    invoke: invoke as IpcClient<C>['invoke'],
    on: on as IpcClient<C>['on'],
    dispose(reason = 'Connection closed') {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new IpcError({ code: 'DISCONNECTED', message: reason }));
        pending.delete(id);
      }
      listeners.clear();
    },
  };
}
