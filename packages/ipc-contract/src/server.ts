import type { Contract, EventChannel, EventPayload, Handlers } from './define';
import { envelopeSchema, zodIssues, type Envelope, type Transport } from './envelope';
import { IpcError } from './errors';

export interface ServerOptions {
  /** Validate handler results against the output schema (recommended; cheap). */
  validateOutput?: boolean;
  /** Called for handler errors, invalid messages and other problems worth logging. */
  onError?: (error: unknown, context: { channel?: string }) => void;
}

export interface IpcServer<C extends Contract> {
  emit<K extends EventChannel<C>>(event: K, payload: EventPayload<C, K>): void;
  dispose(): void;
}

export function createIpcServer<C extends Contract>(
  contract: C,
  handlers: Handlers<C>,
  transport: Transport,
  options: ServerOptions = {},
): IpcServer<C> {
  const validateOutput = options.validateOutput ?? true;
  const report = (error: unknown, channel?: string) => options.onError?.(error, { channel });

  const respondError = (id: number, error: IpcError) => {
    transport.send({ kind: 'response', id, ok: false, error: error.toShape() });
  };

  const handle = async (raw: unknown) => {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success || parsed.data.kind !== 'request') {
      report(
        new IpcError({
          code: 'INVALID_MESSAGE',
          message: 'Ignored a malformed or non-request message',
        }),
      );
      return;
    }
    const { id, channel, payload } = parsed.data;
    const def = Object.hasOwn(contract.requests, channel) ? contract.requests[channel] : undefined;
    const handler = (handlers as Record<string, ((input: unknown) => unknown) | undefined>)[
      channel
    ];
    if (!def || !handler) {
      respondError(
        id,
        new IpcError({ code: 'UNKNOWN_CHANNEL', message: `Unknown channel "${channel}"` }),
      );
      return;
    }
    const input = def.input.safeParse(payload);
    if (!input.success) {
      respondError(
        id,
        new IpcError({
          code: 'INVALID_INPUT',
          message: `Invalid input for "${channel}"`,
          issues: zodIssues(input.error),
        }),
      );
      return;
    }
    let result: unknown;
    try {
      result = await handler(input.data);
    } catch (error) {
      report(error, channel);
      const message = error instanceof Error ? error.message : String(error);
      respondError(
        id,
        error instanceof IpcError ? error : new IpcError({ code: 'HANDLER_ERROR', message }),
      );
      return;
    }
    if (validateOutput) {
      const output = def.output.safeParse(result);
      if (!output.success) {
        const err = new IpcError({
          code: 'INVALID_OUTPUT',
          message: `Handler for "${channel}" returned invalid output`,
          issues: zodIssues(output.error),
        });
        report(err, channel);
        respondError(id, err);
        return;
      }
      result = output.data;
    }
    transport.send({ kind: 'response', id, ok: true, result });
  };

  const unsubscribe = transport.subscribe((message) => {
    void handle(message);
  });

  return {
    emit(event, payload) {
      const schema = contract.events[event];
      if (!schema) throw new Error(`Unknown event "${event}"`);
      const checked = schema.safeParse(payload);
      if (!checked.success) {
        report(
          new IpcError({ code: 'INVALID_OUTPUT', message: `Invalid payload for event "${event}"` }),
          event,
        );
        return;
      }
      const message: Envelope = { kind: 'event', channel: event, payload: checked.data };
      transport.send(message);
    },
    dispose: unsubscribe,
  };
}
