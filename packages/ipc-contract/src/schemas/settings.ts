import { z } from 'zod';

const fields = {
  /** Master switch for the Claude connector (ARCHITECTURE §13.6). */
  aiEnabled: z.boolean(),
  /** Reduce UI animation. */
  reduceMotion: z.boolean(),
  /** Where transcription runs. "auto" uses CUDA when available. */
  transcriptionDevice: z.enum(['auto', 'cuda', 'cpu']),
  /** Override for the media cache folder; null means the default inside the user-data folder. */
  cacheDirectory: z.string().max(4096).nullable(),
  /** Open the last project automatically at start-up. */
  reopenLastProject: z.boolean(),
  /** Folder of the last export; the export dialog starts there. null = the Videos folder. */
  exportDirectory: z.string().max(4096).nullable(),
  /** Where one-click AI features get their text (ADR-046). The API key is a secret. */
  aiProvider: z.enum(['ollama', 'kimi', 'custom']),
  /** null: the provider's usual address. */
  aiBaseUrl: z.string().max(500).nullable(),
  /** Empty: the first model the server lists. */
  aiModel: z.string().max(200),
};

export const DEFAULT_SETTINGS = {
  aiEnabled: true,
  reduceMotion: false,
  transcriptionDevice: 'auto',
  cacheDirectory: null,
  reopenLastProject: true,
  exportDirectory: null,
  aiProvider: 'ollama',
  aiBaseUrl: null,
  aiModel: '',
} as const;

/** App-wide settings stored in app.db. Missing keys fall back to defaults so old databases keep working. */
export const settingsSchema = z.object({
  aiEnabled: fields.aiEnabled.default(DEFAULT_SETTINGS.aiEnabled),
  reduceMotion: fields.reduceMotion.default(DEFAULT_SETTINGS.reduceMotion),
  transcriptionDevice: fields.transcriptionDevice.default(DEFAULT_SETTINGS.transcriptionDevice),
  cacheDirectory: fields.cacheDirectory.default(DEFAULT_SETTINGS.cacheDirectory),
  reopenLastProject: fields.reopenLastProject.default(DEFAULT_SETTINGS.reopenLastProject),
  exportDirectory: fields.exportDirectory.default(DEFAULT_SETTINGS.exportDirectory),
  aiProvider: fields.aiProvider.default(DEFAULT_SETTINGS.aiProvider),
  aiBaseUrl: fields.aiBaseUrl.default(DEFAULT_SETTINGS.aiBaseUrl),
  aiModel: fields.aiModel.default(DEFAULT_SETTINGS.aiModel),
});
export type Settings = z.output<typeof settingsSchema>;

/** A partial update; unknown keys are rejected. */
export const settingsPatchSchema = z.object(fields).partial().strict();
export type SettingsPatch = z.input<typeof settingsPatchSchema>;
