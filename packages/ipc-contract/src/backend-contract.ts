import { z } from 'zod';
import { defineContract } from './define';
import {
  filePathSchema,
  jobKindSchema,
  jobSummarySchema,
  mediaAssetSchema,
  projectInfoSchema,
  recentProjectSchema,
  rightsInputSchema,
} from './schemas/media';
import { settingsPatchSchema, settingsSchema } from './schemas/settings';
import {
  commandSchema,
  documentStateSchema,
  exportSettingsSchema,
  exportStateSchema,
} from './schemas/timeline';
import { systemStatusSchema } from './schemas/status';

const empty = z.object({}).strict();
const ok = z.object({ ok: z.literal(true) });
const assetIds = z.array(z.string().min(1).max(100)).min(1).max(1000);
const projectName = z.string().trim().min(1).max(120);

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

    // Projects (ARCHITECTURE §17). A project is one .recit SQLite file; changes save immediately.
    'project.current': { input: empty, output: projectInfoSchema.nullable() },
    'project.create': {
      input: z.object({ name: projectName, directory: filePathSchema.optional() }).strict(),
      output: projectInfoSchema,
    },
    'project.open': {
      input: z.object({ path: filePathSchema }).strict(),
      output: projectInfoSchema,
    },
    'project.close': { input: empty, output: ok },
    /** Copies the project to a new file and switches to the copy. */
    'project.saveAs': {
      input: z.object({ path: filePathSchema }).strict(),
      output: projectInfoSchema,
    },
    'project.rename': {
      input: z.object({ name: projectName }).strict(),
      output: projectInfoSchema,
    },
    'project.recent': { input: empty, output: z.array(recentProjectSchema) },
    'project.forgetRecent': { input: z.object({ path: filePathSchema }).strict(), output: ok },
    'project.defaultDirectory': { input: empty, output: z.object({ path: z.string() }) },

    // Media (ARCHITECTURE §8).
    'media.list': { input: empty, output: z.array(mediaAssetSchema) },
    'media.import': {
      input: z
        .object({ paths: z.array(filePathSchema).min(1).max(500), rights: rightsInputSchema })
        .strict(),
      output: z.object({
        imported: z.array(z.string()),
        skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
      }),
    },
    'media.remove': { input: z.object({ assetIds }).strict(), output: ok },
    /** Points a missing asset at its new location; the file must have the same content. */
    'media.relink': {
      input: z.object({ assetId: z.string(), path: filePathSchema }).strict(),
      output: mediaAssetSchema,
    },
    'media.retry': {
      input: z.object({ assetId: z.string(), job: jobKindSchema.optional() }).strict(),
      output: ok,
    },
    'media.cancel': { input: z.object({ assetIds }).strict(), output: ok },
    'media.updateRights': {
      input: z.object({ assetId: z.string(), rights: rightsInputSchema }).strict(),
      output: mediaAssetSchema,
    },
    'jobs.list': { input: empty, output: z.array(jobSummarySchema) },

    // Timeline document (ARCHITECTURE §7). Every edit is a validated command; undo is exact.
    'doc.get': { input: empty, output: documentStateSchema },
    'doc.execute': {
      input: z.object({ command: commandSchema }).strict(),
      output: documentStateSchema,
    },
    'doc.undo': { input: empty, output: documentStateSchema },
    'doc.redo': { input: empty, output: documentStateSchema },

    // Export (ARCHITECTURE §10).
    'export.start': {
      input: z
        .object({
          sequenceId: z.string().min(1).max(100),
          path: filePathSchema,
          settings: exportSettingsSchema,
        })
        .strict(),
      output: exportStateSchema,
    },
    /**
     * Where an export will be written: `directory` (default: the last export folder, else the
     * Videos folder) joined with a cleaned-up file name. `exists` warns before replacing a file.
     */
    'export.target': {
      input: z
        .object({ fileName: z.string().min(1).max(255), directory: filePathSchema.optional() })
        .strict(),
      output: z.object({ directory: z.string(), fileName: z.string(), path: z.string(), exists: z.boolean() }),
    },
    /** Saves the frame at `time` (seconds) as PNG or JPEG, rendered exactly like the export. */
    'export.frame': {
      input: z
        .object({
          sequenceId: z.string().min(1).max(100),
          time: z.number().min(0),
          path: filePathSchema,
        })
        .strict(),
      output: ok,
    },
    'export.cancel': { input: empty, output: ok },
    'export.status': { input: empty, output: exportStateSchema },
  },
  events: {
    'system.statusChanged': systemStatusSchema,
    'settings.changed': settingsSchema,
    'project.changed': projectInfoSchema.nullable(),
    'media.changed': z.array(mediaAssetSchema),
    'jobs.changed': z.array(jobSummarySchema),
    'doc.changed': documentStateSchema,
    'export.changed': exportStateSchema,
  },
});

export type BackendContract = typeof backendContract;
