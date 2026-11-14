import { z } from 'zod';
import { defineContract } from './define';
import { secretNameSchema, secretValueSchema } from './schemas/secrets';

/** A video handed over by ProDown, the separate downloader app (ADR-040). */
export const prodownFileSchema = z.object({
  path: z.string().min(1).max(4096),
  title: z.string().max(500),
  url: z.string().max(2000).optional(),
  channel: z.string().max(200).optional(),
  qualityLabel: z.string().max(40).optional(),
});
export type ProDownFile = z.output<typeof prodownFileSchema>;

export const prodownLibraryItemSchema = prodownFileSchema.extend({
  sizeBytes: z.number().nonnegative(),
  durationSec: z.number().nonnegative(),
  createdAt: z.string().max(40),
});
export type ProDownLibraryItem = z.output<typeof prodownLibraryItemSchema>;

/** Renderer ⇄ main process (ipcRenderer.invoke). Deliberately tiny. */
export const shellContract = defineContract({
  requests: {
    'shell.getInfo': {
      input: z.object({}).strict(),
      output: z.object({
        appVersion: z.string(),
        platform: z.string(),
        isPackaged: z.boolean(),
        versions: z.object({ electron: z.string(), chrome: z.string(), node: z.string() }),
      }),
    },
    /** Values travel renderer → main once, are encrypted with safeStorage, and are never sent back. */
    'secrets.set': {
      input: z.object({ name: secretNameSchema, value: secretValueSchema }).strict(),
      output: z.object({ ok: z.literal(true) }),
    },
    'secrets.clear': {
      input: z.object({ name: secretNameSchema }).strict(),
      output: z.object({ ok: z.literal(true) }),
    },
    // Native dialogs. They only return paths; the backend does the work.
    'dialog.importMedia': {
      input: z.object({}).strict(),
      output: z.object({ paths: z.array(z.string()) }),
    },
    'dialog.importLut': {
      input: z.object({}).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.openProject': {
      input: z.object({}).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.saveProjectAs': {
      input: z.object({ defaultPath: z.string().max(4096) }).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.saveExport': {
      input: z.object({ defaultPath: z.string().max(4096) }).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.chooseFolder': {
      input: z.object({ defaultPath: z.string().max(4096), title: z.string().max(120) }).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.saveImage': {
      input: z.object({ defaultPath: z.string().max(4096) }).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    'dialog.locateFile': {
      input: z.object({ name: z.string().max(260) }).strict(),
      output: z.object({ path: z.string().nullable() }),
    },
    /** Opens the folder containing a file in Explorer / Finder. */
    'shell.showItemInFolder': {
      input: z.object({ path: z.string().min(1).max(4096) }).strict(),
      output: z.object({ ok: z.literal(true) }),
    },
    /** Videos ProDown sent (live or while Rec-It was closed). `peek` leaves them queued. */
    'prodown.takeIncoming': {
      input: z.object({ peek: z.boolean() }).strict(),
      output: z.object({ files: z.array(prodownFileSchema) }),
    },
    /** ProDown's downloads, for "Import from ProDown". */
    'prodown.library': {
      input: z.object({}).strict(),
      output: z.object({ installed: z.boolean(), items: z.array(prodownLibraryItemSchema) }),
    },
    'secrets.status': {
      input: z.object({}).strict(),
      output: z.object({
        encryptionAvailable: z.boolean(),
        secrets: z.record(secretNameSchema, z.object({ set: z.boolean() })),
      }),
    },
  },
  events: {},
});

export type ShellContract = typeof shellContract;
