# Rec-It — notes for Claude

Free, open-source (GPL-3.0) Electron video editor for YouTube Shorts. Read README.md, then
ARCHITECTURE.md, ROADMAP.md and DECISIONS.md before making design changes.

## Current phase

Phases 0 (foundations) and 1 (media pipeline) are complete. Phase 3 (export, ADR-027) is built; manual checks on the reference PC remain. Phase 2 has five slices done (timeline, mouse transforms, context menus, linked clips, keyframes, GPU preview, Web Audio; ADR-025, 026, 028, 029, 030); what remains is measuring the exit criteria on the reference PC. Phase 4 slices A (transcription, text-based editing; ADR-031), B (word corrections, captions; ADR-032) and C (captions as clips on caption tracks; ADR-033) are done. Phase 5 slices A (crop, facecam + gameplay layout, safe zones; ADR-034) and B (automatic reframing; ADR-035) are done. Phase 6 slices A (fades, opacity, colour effects; ADR-036), B (transitions; ADR-037) C (blur, blurred background; ADR-038) D (speed, reverse, freeze frames; ADR-039) E (LUTs; ADR-040) F (green screen; ADR-041) G (sound effects; ADR-042) and H (wipe/slide/zoom transitions; ADR-043) are done. Phase 7 slices A (the MCP connector; ADR-044) and B (effect/animation tools, scenario evals; ADR-045) are done. **Current priority: Phase 8, the AI Shorts studio (ADR-046)** — slices A (Ollama/Kimi provider, local AI voice, story template, clip finder engine) and B (generated visuals: AI pictures via Z-Image Turbo/stable-diffusion.cpp, motion graphics; ADR-047) are done, plus the talking-character test shot (Wan 2.2 S2V; ADR-048); next talking-character Shorts and Pixar-style stories, then the text-conversation and split-screen templates and the clip finder UI. The rest of Phase 6 (speed ramps, noise reduction, presets, measurements) resumes later. Never route Claude through subscription logins (OmniRoute etc.; ADR-046). Priority: a fully working editor
(Phases 0–6, Phase 6 = effects) before any Claude features (ADR-019). Reference machine: Windows 11 + RTX 3070 8 GB.

## Commands

- `pnpm install`, `pnpm dev`, `pnpm build` (also builds the MCP bridge; `pnpm build:mcp` alone)
- `pnpm check` — lint + typecheck + Vitest + pytest. Run before committing.
- `pnpm test:e2e` — Playwright against the built app (includes the preview/export golden-frame parity suite). On Linux without a display use
  `CI=1 xvfb-run -a pnpm test:e2e` (CI=1 enables the container sandbox workaround).
- `pnpm eval:claude [filter]` — live Claude evals through Claude Code (needs `claude` signed in).
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
  Core `timeline/transcript.ts` maps words onto a sequence (with `doc.transcriptEdits` corrections) and builds `item.cutRange` cuts.
- `packages/captions` — caption styles, grouping, `generateCaptions` and the ASS compiler; `sequenceCaptionsAss` (caption clips
  on `caption` tracks, ADR-033) is used by both the preview
  (renderer `engine/captions-layer.tsx`, JASSUB) and the export (`ass` filter). Fonts in `resources/fonts`.
- Faces: sidecar `recit_media_ai/faces.py` (YuNet, `reframe` extra, `RECIT_FAKE_FACES=1`), backend `services/face-service.ts`,
  core `timeline/reframe.ts` (`autoReframe` → Position X keyframes).
- Crop lives in `Transform.crop`; `cropRect`/`computeLayout` give the kept pixels to preview and export alike.
- Effects (ADR-036): `item.opacity`, `item.fade`, `item.effects`; core `pictureAt`/`fadeAt`/`eqCodes` are shared by the
  compositor shader, the audio engine and render-plan (`eq`, alpha `fade`, `afade`). Inspector: `timeline/EffectsInspector.tsx`.
- Transitions (ADR-037): `item.transitionIn` on the clip after a cut; core `presentSequence` (timeline/transitions.ts) turns them
  into overlapping, faded clips — preview (ProgramMonitor) and export (buildGraph) both render the presented sequence.
  Wipe/slide/zoom (ADR-043): presented `motion`/`wipe`; export puts such clips on a frame canvas (perspective, geq);
  perspective's `in` counter starts at 1.
- Blur (ADR-038): effect kind `blur` (`size` = sigma / picture height); compositor two-pass blur in offscreen textures,
  export `gblur` per plane. `blurredBackground` in renderer `edit.ts`.
- Speed (ADR-039): `item.speed/reverse/freeze`; always map times with core `sourceTimeAt`/`timelineTimeAt`/`sliceItem`/
  `itemHandles`/`sourceSpan` (never `sourceIn + offset`). Preview audio time-stretch: `engine/time-stretch.ts` (WSOLA).
- LUTs (ADR-040): core `lut.ts` (parseCube/mixLut/formatCube), project `luts` table, backend `services/lut-service.ts`
  (import, pre-blended .cube files for export), renderer `engine/lut-cache.ts` + compositor 3D texture.
- Chroma key (ADR-041): effect `chromaKey`, core `keyChroma`/`keyOf` (BT.709 key chroma), export `chromakey…:yuv=1`,
  compositor `keyAlpha` (same 3×3 chroma maths).
- Sound effects (ADR-042): effects `eq`/`compressor` after volume+fades; preview per-clip chains in `audio-engine.ts`
  (biquads + `engine/compressor-worklet.ts`, a port of acompressor in `engine/compressor.ts`); ducking in core `ducking.ts`.
- Claude connector (ADR-044): `packages/tools` (tool catalogue with zod schemas, instructions, prompts; `protocol.ts` for
  the local link), backend `services/claude-service.ts` (pipe/socket endpoint + token in `mcp-endpoint.json`, change cards,
  confirmations, activity) and `claude-tools.ts` (runs the tools), `apps/mcp` (stdio bridge, esbuild bundle + `.mcpb`;
  `pnpm build:mcp`), renderer `claude/` (Claude tab, confirm dialog). History entries can carry an undo `group`.
- Claude evals (ADR-045): `backend/claude-evals/` — `world.ts` (in-memory Rec-It), `scenarios.ts` (requests, recorded
  scripts, outcome checks; replayed by `scenarios.test.ts`), `live.test.ts` via `pnpm eval:claude [filter]` (Claude Code,
  uses the signed-in plan; not in CI). New tools need a scenario. Ducking maths is core `ducking.ts`.
- AI Shorts studio (ADR-046): `packages/ai` (OpenAI-compatible client for Ollama/Kimi, prompts; secret `aiApiKey`),
  `packages/templates` (pure template builders → one command batch; Kokoro `VOICES`), `packages/clipping` (clip finder ported
  from Clipalytics), backend `services/ai-service.ts`, `voice-service.ts` (sidecar `tts` job + `card.render`; extra `voice`,
  `RECIT_FAKE_TTS=1`), `template-service.ts` (job pipeline, generated media in "<project> media", rights `made-in-rec-it`),
  sidecar `recit_media_ai/tts.py` + `card.py`, renderer `create/CreateDialog.tsx` (Make a Short) and Settings → AI.
  Generated visuals (ADR-047): sidecar `images.py` (sd-cli install/generate, `RECIT_FAKE_IMAGES=1`, `RECIT_SD_CLI`),
  `card.background` (motion graphics), backend `image-service.ts`; templates `splitSentences`/`normaliseScenes`/scene pictures.
  Talking characters (ADR-048): sidecar `talking.py` (Wan 2.2 S2V via the same sd-cli, `images.run_engine`; `RECIT_FAKE_TALK=1`),
  backend `animation-service.ts` + shared `engine-install.ts`, `TemplateService.talkTest`, templates `talkingShot`/`characterPrompt`.
- Renderer `timeline/` — Timeline, SequenceSettings, ClipInspector, ProgramMonitor, TransformOverlay, ExportDialog, CropDialog,
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
