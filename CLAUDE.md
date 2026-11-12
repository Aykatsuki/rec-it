# Rec-It — notes for Claude

Free, open-source (GPL-3.0) Electron video editor for YouTube Shorts. Read README.md, then
ARCHITECTURE.md, ROADMAP.md and DECISIONS.md before making design changes.

## Current phase

Phase 0 (foundations) is complete. Next is Phase 1 (media pipeline). Priority: a fully working editor
(Phases 0–5) before any Claude features (ADR-019). Reference machine: Windows 11 + RTX 3070 8 GB.

## Commands

- `pnpm install`, `pnpm dev`, `pnpm build`
- `pnpm check` — lint + typecheck + Vitest + pytest. Run before committing.
- `pnpm test:e2e` — Playwright against the built app. On Linux without a display use
  `CI=1 xvfb-run -a pnpm test:e2e` (CI=1 enables the container sandbox workaround).
- `pnpm fetch-ffmpeg` — GPL FFmpeg into `resources/ffmpeg/<platform>-<arch>/`.

## Layout

- `apps/desktop/src/main` — thin Electron main: windows, security, secrets (safeStorage), backend host.
- `apps/desktop/src/preload` — builds `window.recit` from the IPC contract. Sandboxed; bundled as one file.
- `apps/desktop/src/backend` — utilityProcess with all services (DB, settings, FFmpeg checks, sidecar).
- `apps/desktop/src/renderer` — React UI. No Node, no Electron imports.
- `packages/ipc-contract` — every channel and event with zod schemas; typed client/server.
- `packages/core` — pure domain logic (flicks time maths now; data model in Phase 2).
- `packages/db` — `node:sqlite` (ADR-020), migrations, repositories.
- `packages/ffmpeg` — binary resolution, capability detection, run helpers.
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
