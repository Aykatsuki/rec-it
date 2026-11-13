# Rec-It — notes for Claude

Free, open-source (GPL-3.0) Electron video editor for YouTube Shorts. Read README.md, then
ARCHITECTURE.md, ROADMAP.md and DECISIONS.md before making design changes.

## Current phase

Phases 0 (foundations) and 1 (media pipeline) are complete. Phase 3 (export, ADR-027) is built; manual checks on the reference PC remain. Phase 2 has five slices done (timeline, mouse transforms, context menus, linked clips, keyframes, GPU preview, Web Audio; ADR-025, 026, 028, 029, 030); what remains is measuring the exit criteria on the reference PC. Phase 4 slice A (transcription, transcript panel, text-based editing; ADR-031) is done; next is captions. Priority: a fully working editor
(Phases 0–6, Phase 6 = effects) before any Claude features (ADR-019). Reference machine: Windows 11 + RTX 3070 8 GB.

## Commands

- `pnpm install`, `pnpm dev`, `pnpm build`
- `pnpm check` — lint + typecheck + Vitest + pytest. Run before committing.
- `pnpm test:e2e` — Playwright against the built app (includes the preview/export golden-frame parity suite). On Linux without a display use
  `CI=1 xvfb-run -a pnpm test:e2e` (CI=1 enables the container sandbox workaround).
- `pnpm fetch-ffmpeg` — GPL FFmpeg into `resources/ffmpeg/<platform>-<arch>/`.

## Layout

- `apps/desktop/src/main` — thin Electron main: windows, security, secrets (safeStorage), backend host.
- `apps/desktop/src/preload` — builds `window.recit` from the IPC contract. Sandboxed; bundled as one file.
- `apps/desktop/src/backend` — utilityProcess with all services: settings, FFmpeg checks, sidecar,
  `services/project-service.ts` (one open .recit project), `services/media-service.ts` (import, probe,
  proxy/thumbnail/waveform jobs, relink), `services/jobs.ts` (JobQueue with per-kind concurrency).
- `apps/desktop/src/main/media-protocol.ts` — serves the media cache over `recit-media://` (allow-listed
  files, range requests). Pure helpers in `media-paths.ts`.
- `apps/desktop/src/renderer` — React UI. No Node, no Electron imports. `engine/` is the GPU preview:
  `video-source.ts` (mp4box + WebCodecs, range reads), `compositor.ts` (WebGL2), `preview-engine.ts`,
  `audio-source.ts` + `audio-engine.ts` (Web Audio, master clock). `window.recitDebug.renderAudio` renders the
  preview mix offline (used by the audio parity test).
- `packages/ipc-contract` — every channel and event with zod schemas; typed client/server.
- `packages/core` — pure domain logic: flicks time maths, timeline model, commands, Immer undo/redo history,
  keyframe interpolation (`valueAt`, `transformAt`, `volumeAt`; keyframe times are *source* time).
- `packages/render-plan` — Sequence → FFmpeg plans: export, loudness analysis (two-pass), single frame;
  encoder choice. Argument snapshots in `src/__snapshots__`.
- Backend `services/document-service.ts` (timeline document + undo, saved per edit), `services/export-service.ts` and
  `services/transcript-service.ts` (FFmpeg audio extraction → sidecar `transcribe` job → `transcripts` table).
- Sidecar `recit_media_ai/transcribe.py` (faster-whisper, optional `transcribe` extra; `RECIT_FAKE_WHISPER=1` for tests).
  Core `timeline/transcript.ts` maps words onto a sequence and builds `item.cutRange` cuts.
- Renderer `timeline/` — Timeline, SequenceSettings, ClipInspector, ProgramMonitor, TransformOverlay, ExportDialog,
  `menus.tsx` (right-click menus); edits go through `edit.ts`. `ui/ContextMenu.tsx` is the generic menu.
- `packages/db` — `node:sqlite` (ADR-020), migrations, repositories.
- `packages/ffmpeg` — binary resolution, capability detection, ffprobe parsing, abortable runner, proxy /
  sprite / poster / waveform recipes. `@rec-it/ffmpeg/testing` generates synthetic fixtures for tests.
- `packages/ui` — design tokens and components.
- `services/media-ai` — Python sidecar, JSON-RPC over stdio, managed by uv.

## Rules

See CONTRIBUTING.md "Project rules". Most important: renderer never gets Node; every IPC channel is
declared in `packages/ipc-contract`; never spawn through a shell; `packages/core` stays pure; secrets
never reach the renderer or logs; new decisions become new ADRs.

## Toolchain notes

- TypeScript 6.0 (not 7.0: typescript-eslint does not support 7 yet). TS 6 defaults `types` to `[]`,
  so each tsconfig lists the ambient types it needs.
- Electron 45 (Node 24 inside). Electron itself only downloads its binary lazily, which electron-vite does not
  trigger, so `apps/desktop` has a `postinstall` that runs `install-electron`.
- Workspace packages export `.ts` sources directly; electron-vite bundles them (externalizeDeps: false).
