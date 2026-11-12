# Contributing to Rec-It

## Requirements

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | 24 (see `.nvmrc`) | Matches the Node inside Electron 45 |
| pnpm | 10 | `npm install -g pnpm@10` (Corepack is no longer bundled with newer Node versions) |
| uv | 0.8+ | Manages the Python sidecar's environment ([install](https://docs.astral.sh/uv/getting-started/installation/)) |
| Git | any recent | |
| NVIDIA driver | recent | Optional, for NVENC export and CUDA transcription |

## First-time setup (Windows)

Install the tools once, then open a **new** terminal so they are on your PATH:

```powershell
winget install OpenJS.NodeJS.LTS
winget install --id=astral-sh.uv -e
npm install -g pnpm@10
```

Then:

```powershell
git clone https://github.com/Aykatsuki/rec-it.git
cd rec-it
pnpm install
pnpm fetch-ffmpeg      # downloads a checksum-verified GPL FFmpeg into resources/ffmpeg/win32-x64
pnpm dev               # starts the app with hot reload
```

The first launch downloads the Electron binary (about 100 MB) and the first start of the Python sidecar
creates its environment with uv; both take a minute once. Open **Settings → System** to check that
FFmpeg reports **GPL** and **NVENC test encode: working**, and that the media AI sees your GPU.

## Everyday commands

| Command | What it does |
|---------|--------------|
| `pnpm dev` | Run the app with hot reload |
| `pnpm build` | Production build of main, preload, backend and renderer |
| `pnpm check` | Lint, typecheck, unit tests and Python tests (run before every commit) |
| `pnpm test` | TypeScript unit tests (Vitest) |
| `pnpm test:py` | Python sidecar tests (pytest) |
| `pnpm test:e2e` | Build, then run Playwright end-to-end tests against the real app |
| `pnpm format` | Format with Prettier |
| `pnpm fetch-ffmpeg --series 9.0` | Use another FFmpeg release branch |

## Environment variables

| Variable | Purpose |
|----------|---------|
| `RECIT_FFMPEG_PATH` | Use a specific `ffmpeg` binary (ffprobe must sit next to it) |
| `RECIT_UV_PATH` | Path to `uv` if it is not on PATH |
| `RECIT_DISABLE_SIDECAR=1` | Do not start the Python sidecar |
| `RECIT_USER_DATA` | Use a different profile folder (tests use this) |
| `RECIT_PROJECTS_DIR` | Default folder for new projects (normally Documents\Rec-It Projects) |

## Project rules

These keep the architecture intact; reviews check them.

1. **The renderer has no Node access.** It talks to the rest of the app only through `window.recit`,
   which the preload builds from `packages/ipc-contract`. ESLint blocks Node imports in renderer code.
2. **Every IPC channel is declared once** in `packages/ipc-contract` with zod schemas. Inputs are
   validated where they are sent and where they are received.
3. **Never spawn through a shell.** Use argument arrays (`execFile`/`spawn` with `shell: false`).
4. **`packages/core` stays pure.** No Electron, React, Node or DOM imports.
5. **Secrets never reach the renderer** and are never logged.
6. **Design decisions go in `DECISIONS.md`** as a new ADR; never rewrite an accepted one.
7. **Tests come with the change.** Each roadmap phase lists the tests it needs.

## Licence

By contributing you agree that your contributions are licensed under GPL-3.0-or-later.
