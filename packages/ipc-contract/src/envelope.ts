import { z } from 'zod';

/** Wire format shared by every transport (MessagePort, ipcRenderer, named pipe later). */
export const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('request'),
    id: z.number().int().nonnegative(),
    channel: z.string().min(1).max(200),
    payload: z.unknown(),
  }),
  z.object({
    kind: z.literal('response'),
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal('event'),
    channel: z.string().min(1).max(200),
    payload: z.unknown(),
  }),
]);

export type Envelope = z.infer<typeof envelopeSchema>;
export type RequestEnvelope = Extract<Envelope, { kind: 'request' }>;
export type ResponseEnvelope = Extract<Envelope, { kind: 'response' }>;
export type EventEnvelope = Extract<Envelope, { kind: 'event' }>;

/** Minimal message transport. Adapters exist for MessagePort-like objects. */
export interface Transport {
  send(message: Envelope): void;
  subscribe(listener: (message: unknown) => void): () => void;
}

export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
}
