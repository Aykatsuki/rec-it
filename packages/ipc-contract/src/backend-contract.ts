import { z } from 'zod';
import { defineContract } from './define';
import { settingsPatchSchema, settingsSchema } from './schemas/settings';
import { systemStatusSchema } from './schemas/status';

const empty = z.object({}).strict();

/** Renderer ⇄ backend (utilityProcess) over a MessagePort. */
export const backendContract = defineContract({
  requests: {
    'app.ping': {
      input: z.object({ sentAt: z.number() }).strict(),
      output: z.object({ sentAt: z.number(), receivedAt: z.number(), backendVersion: z.string() }),
    },
    'system.getStatus': { input: empty, output: systemStatusSchema },
    /** Re-runs the FFmpeg and sidecar checks, then returns the new status. */
    'system.refresh': { input: empty, output: systemStatusSchema },
    'settings.get': { input: empty, output: settingsSchema },
    'settings.update': { input: settingsPatchSchema, output: settingsSchema },
  },
  events: {
    'system.statusChanged': systemStatusSchema,
    'settings.changed': settingsSchema,
  },
});

export type BackendContract = typeof backendContract;
