import type { z } from 'zod';

export interface RequestDef<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  input: I;
  output: O;
}

export interface Contract {
  requests: Record<string, RequestDef>;
  events: Record<string, z.ZodType>;
}

/** Identity helper that preserves literal channel names for type inference. */
export function defineContract<const C extends Contract>(contract: C): C {
  return contract;
}

export type RequestChannel<C extends Contract> = keyof C['requests'] & string;
export type EventChannel<C extends Contract> = keyof C['events'] & string;

export type RequestInput<C extends Contract, K extends RequestChannel<C>> = z.input<
  C['requests'][K]['input']
>;
export type RequestOutput<C extends Contract, K extends RequestChannel<C>> = z.output<
  C['requests'][K]['output']
>;
export type HandlerInput<C extends Contract, K extends RequestChannel<C>> = z.output<
  C['requests'][K]['input']
>;
export type EventPayload<C extends Contract, K extends EventChannel<C>> = z.output<C['events'][K]>;

export type Handlers<C extends Contract> = {
  [K in RequestChannel<C>]: (
    input: HandlerInput<C, K>,
  ) => RequestOutput<C, K> | Promise<RequestOutput<C, K>>;
};

/** The untyped surface exposed across Electron's contextBridge. */
export interface BridgeClient {
  invoke(channel: string, input: unknown): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
}

/** Typed view of a client for a contract. */
export interface TypedClient<C extends Contract> {
  invoke<K extends RequestChannel<C>>(
    channel: K,
    input: RequestInput<C, K>,
  ): Promise<RequestOutput<C, K>>;
  on<K extends EventChannel<C>>(
    event: K,
    listener: (payload: EventPayload<C, K>) => void,
  ): () => void;
}

/** Re-types an untyped bridge (validation already happened on the other side of the bridge). */
export function typed<C extends Contract>(bridge: BridgeClient): TypedClient<C> {
  return bridge as unknown as TypedClient<C>;
}
