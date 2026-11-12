import { z } from 'zod';
import { defineContract } from './define';
import { secretNameSchema, secretValueSchema } from './schemas/secrets';

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
