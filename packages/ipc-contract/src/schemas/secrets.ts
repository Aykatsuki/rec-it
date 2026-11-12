import { z } from 'zod';

/** The only secrets Rec-It stores. Anything else is rejected. */
export const secretNameSchema = z.enum(['youtubeApiKey', 'testSecret']);
export type SecretName = z.output<typeof secretNameSchema>;
export const SECRET_NAMES = secretNameSchema.options;

export const secretValueSchema = z.string().min(1).max(4096);

/** What the backend may report about a secret: never the value, only a short fingerprint. */
export const secretStatusSchema = z.object({
  set: z.boolean(),
  /** First 12 hex characters of SHA-256(value); lets tests and users confirm which value is stored. */
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional(),
});
