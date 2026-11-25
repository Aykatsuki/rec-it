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
import { transcriptSchema, transcriptionStatusSchema } from './schemas/transcript';
import { faceStatusSchema, faceTrackSchema } from './schemas/faces';
import { lutDataSchema, lutInfoSchema } from './schemas/luts';
import { claudeStateSchema } from './schemas/claude';
import {
  aiStatusSchema,
  imageStatusSchema,
  talkTestSchema,
  episodeSchema,
  storedCharacterSchema,
  voiceIdSchema,
  voiceSampleSchema,
  storyGenreSchema,
  storyShortSchema,
  storyTextSchema,
  templateJobSchema,
  voiceStatusSchema,
} from './schemas/create';

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

    // Transcription (Phase 4, ADR-031).
    'transcript.status': { input: empty, output: transcriptionStatusSchema },
    /** Installs local transcription (faster-whisper) into the sidecar's environment, once. */
    'transcript.install': { input: empty, output: ok },
    'transcript.start': {
      input: z
        .object({
          assetId: z.string().min(1).max(100),
          /** ISO language code such as "en", or null to detect it. */
          language: z.string().min(2).max(8).nullable(),
        })
        .strict(),
      output: ok,
    },
    'transcript.cancel': {
      input: z.object({ assetId: z.string().min(1).max(100) }).strict(),
      output: ok,
    },
    'transcript.get': {
      input: z.object({ assetId: z.string().min(1).max(100) }).strict(),
      output: transcriptSchema.nullable(),
    },

    // Face analysis for automatic reframing (Phase 5b, ADR-035).
    'faces.status': { input: empty, output: faceStatusSchema },
    /** Installs face detection (OpenCV) into the sidecar's environment, once. */
    'faces.install': { input: empty, output: ok },
    'faces.start': {
      input: z.object({ assetId: z.string().min(1).max(100) }).strict(),
      output: ok,
    },
    'faces.cancel': {
      input: z.object({ assetId: z.string().min(1).max(100) }).strict(),
      output: ok,
    },
    'faces.get': {
      input: z.object({ assetId: z.string().min(1).max(100) }).strict(),
      output: faceTrackSchema.nullable(),
    },

    // AI text, AI voice and faceless templates (Phase 8, ADR-046).
    'ai.status': { input: empty, output: aiStatusSchema },
    /** Models the configured AI server offers (fails with a readable message). */
    'ai.models': { input: empty, output: z.object({ models: z.array(z.string()) }) },
    /** A tiny request to check the AI setup end to end. */
    'ai.test': { input: empty, output: z.object({ model: z.string(), reply: z.string() }) },
    'ai.writeStory': {
      input: z
        .object({
          genre: storyGenreSchema,
          idea: z.string().max(1000).optional(),
          seconds: z.number().min(15).max(180),
        })
        .strict(),
      output: storyTextSchema,
    },
    /** A pasted post made ready to be read aloud and cut to length. */
    'ai.narrate': {
      input: z
        .object({
          title: z.string().max(300),
          text: z.string().min(1).max(20000),
          seconds: z.number().min(15).max(180),
        })
        .strict(),
      output: storyTextSchema,
    },
    'voice.status': { input: empty, output: voiceStatusSchema },
    /** Installs the AI voice (Kokoro) into the sidecar's environment, once. */
    'voice.install': { input: empty, output: ok },
    /** A short sample of a voice, as base64 WAV. */
    'voice.preview': {
      input: z
        .object({
          voice: voiceIdSchema,
          speed: z.number().min(0.7).max(1.5).default(1),
          text: z.string().max(300).optional(),
        })
        .strict(),
      output: z.object({ wav: z.string() }),
    },
    'images.status': { input: empty, output: imageStatusSchema },
    /** Downloads the AI picture engine and model (about 7 GB), once. */
    'images.install': { input: empty, output: ok },
    'images.cancelInstall': { input: empty, output: ok },
    /** The human-like voice (Chatterbox Turbo; ADR-051): status and one-time install (~5 GB). */
    'voicehq.status': { input: empty, output: imageStatusSchema },
    'voicehq.install': { input: empty, output: ok },
    'voicehq.cancelInstall': { input: empty, output: ok },
    /** Voice samples for cloning (recordings you have the rights to, 5–15 s used). */
    'voices.list': { input: empty, output: z.array(voiceSampleSchema) },
    'voices.add': {
      input: z
        .object({ path: z.string().min(1).max(4096), name: z.string().trim().min(1).max(60) })
        .strict(),
      output: voiceSampleSchema,
    },
    'voices.remove': { input: z.object({ id: z.string() }).strict(), output: ok },
    'animation.status': { input: empty, output: imageStatusSchema },
    /** Downloads the mouth-shape engine for talking characters (about 5.5 GB), once. */
    'animation.install': { input: empty, output: ok },
    'animation.cancelInstall': { input: empty, output: ok },
    'templates.jobs': { input: empty, output: z.array(templateJobSchema) },
    /** Starts building a story Short; follow it with templates.changed. */
    'templates.story': { input: storyShortSchema, output: z.object({ jobId: z.string() }) },
    'templates.cancel': { input: z.object({ jobId: z.string() }).strict(), output: ok },
    /** Starts an episode from a brief; follow it with templates.changed. */
    'templates.episode': { input: episodeSchema, output: z.object({ jobId: z.string() }) },
    /** Characters the open project remembers from earlier episodes (ADR-053). */
    'characters.list': { input: empty, output: z.array(storedCharacterSchema) },
    /** Forgets one: the next episode designs it afresh. */
    'characters.remove': {
      input: z.object({ id: z.string().min(1).max(40) }).strict(),
      output: ok,
    },
    /** Starts one talking-character test shot; follow it with templates.changed. */
    'templates.talkTest': { input: talkTestSchema, output: z.object({ jobId: z.string() }) },

    // 3D LUTs imported into the project (Phase 6e, ADR-040).
    'luts.list': { input: empty, output: z.array(lutInfoSchema) },
    /** Reads a .cube file (a path from dialog.importLut) into the project. */
    'luts.import': { input: z.object({ path: filePathSchema }).strict(), output: lutInfoSchema },
    'luts.get': {
      input: z.object({ id: z.string().min(1).max(100) }).strict(),
      output: lutDataSchema.nullable(),
    },

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
      output: z.object({
        directory: z.string(),
        fileName: z.string(),
        path: z.string(),
        exists: z.boolean(),
      }),
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

    // Claude connector (ADR-044). Claude itself talks to the backend over a local socket.
    'claude.state': { input: empty, output: claudeStateSchema },
    /** Answers a confirmation request (export, transcription). */
    'claude.respond': {
      input: z.object({ id: z.string().min(1).max(100), allow: z.boolean() }).strict(),
      output: ok,
    },
    /** Undoes all of a change card's edits (only while they are the newest undo step). */
    'claude.undoChange': {
      input: z.object({ group: z.string().min(1).max(100) }).strict(),
      output: ok,
    },
    /** Keeps a change card's edits: later edits by Claude start a new card. */
    'claude.keepChange': {
      input: z.object({ group: z.string().min(1).max(100) }).strict(),
      output: ok,
    },
    'claude.clearActivity': { input: empty, output: ok },
  },
  events: {
    'system.statusChanged': systemStatusSchema,
    'settings.changed': settingsSchema,
    'project.changed': projectInfoSchema.nullable(),
    'media.changed': z.array(mediaAssetSchema),
    'jobs.changed': z.array(jobSummarySchema),
    'doc.changed': documentStateSchema,
    'export.changed': exportStateSchema,
    'transcript.changed': transcriptionStatusSchema,
    'faces.changed': faceStatusSchema,
    'luts.changed': z.array(lutInfoSchema),
    'claude.changed': claudeStateSchema,
    'voice.changed': voiceStatusSchema,
    'images.changed': imageStatusSchema,
    'animation.changed': imageStatusSchema,
    'voicehq.changed': imageStatusSchema,
    'voices.changed': z.array(voiceSampleSchema),
    'templates.changed': z.array(templateJobSchema),
  },
});

export type BackendContract = typeof backendContract;
