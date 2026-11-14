import { z } from 'zod';

/** A 3D LUT imported into the project (ADR-040). */
export const lutInfoSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().max(200),
  size: z.number().int().min(2).max(65),
});
export type LutInfo = z.infer<typeof lutInfoSchema>;

/** A LUT's table: size³ RGB float32 values (red fastest), base64-encoded. */
export const lutDataSchema = lutInfoSchema.extend({ data: z.string().max(5_000_000) });
export type LutData = z.infer<typeof lutDataSchema>;
