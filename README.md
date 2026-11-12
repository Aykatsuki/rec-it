# Rec-It

**An AI-powered desktop video editor for making YouTube Shorts.**

Rec-It is a free, open-source, timeline-based video editor (in the style of CapCut and DaVinci Resolve) that Claude can operate. You talk to Claude in your own Claude app; through Rec-It's local MCP connector, Claude can research YouTube topics, analyse your footage, suggest the best clips, generate animated captions, reframe video to vertical 9:16 and make edits on the real timeline. Every edit it makes can be undone. Rec-It has no paid tier and no AI bill of its own: AI usage comes from your existing Claude plan.

> **Status: Phases 0–1 complete, first slices of Phases 2–3 done.** Create projects and import footage; Rec-It makes preview copies, thumbnails and waveforms in the background, using NVENC on NVIDIA GPUs. Drag clips onto a multi-track timeline; move, trim, split, copy and paste them with undo; move, resize and rotate clips with the mouse in the preview; use right-click menus everywhere; set the resolution and frame rate; preview the edit and export an MP4. Effects and transitions are planned for Phase 6. The first goal is a fully working video editor (Phases 0–5) that needs no AI at all; Claude features build on top of it afterwards.

## Quick start (Windows)

```powershell
npm install -g pnpm@10
pnpm install
pnpm fetch-ffmpeg
pnpm dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for requirements (Node 24, pnpm 10, uv) and all commands.

---

## Planned features

| # | Feature | Summary |
|---|---------|---------|
| 1 | Timeline editor | Multi-track video, audio and caption tracks; trim, split, move, ripple, keyframes, undo/redo |
| 2 | Claude integration | Claude (in your Claude desktop app) edits the actual project through Rec-It's MCP connector: typed, validated, undoable tool calls |
| 3 | YouTube research | Topic search, trend and competitor discovery through YouTube Data API v3 |
| 4 | Rights-aware importing | Every asset records where it came from and under what licence; attribution is generated automatically |
| 5 | AI clip selection | Transcript, scene, audio and visual signals ranked by Claude into candidate Shorts |
| 6 | Transcription and captions | Local Whisper transcription with word-level timing; animated caption styles |
| 7 | 9:16 conversion | Manual and automatic (face/subject-tracked) reframing |
| 8 | AI-assisted editing | Remove silences and filler words, tighten pacing, add hooks and titles |
| 9 | Batch Shorts | Turn one long video into many Shorts from a template, then review and export them together |
| 10 | Preview and export | Real-time preview from proxies; FFmpeg export with hardware encoding |

## Technology stack

| Layer | Technology |
|-------|------------|
| Desktop shell | Electron 45 (main process, a backend `utilityProcess`, and a sandboxed renderer) |
| UI | React 19, TypeScript 6 (strict), react-resizable-panels, lucide icons, custom canvas timeline |
| Preview engine | WebCodecs + WebGL2 compositor, Web Audio, JASSUB (libass WASM) for captions |
| Application services | Node.js (TypeScript) in an Electron utility process |
| Video processing | FFmpeg / FFprobe (bundled binaries) |
| AI media processing | Python sidecar: faster-whisper, PySceneDetect, MediaPipe |
| Storage | SQLite via Node's built-in `node:sqlite`: one app database plus one SQLite file per project |
| AI | Model Context Protocol (MCP) server inside Rec-It, used from the Claude desktop app with your own Claude plan; optional in-app panel via the Claude Agent SDK |
| Research | YouTube Data API v3 |
| Build | pnpm workspaces, electron-vite, electron-builder, uv (Python) |
| Testing | Vitest, Playwright (Electron), pytest, golden-frame render tests, agent evals |

## Documentation

| Document | Contents |
|----------|----------|
| [ARCHITECTURE.md](ARCHITECTURE.md) | System design, process model, folder structure, data models, rendering, Claude tool calling, dependencies, risks, costs |
| [ROADMAP.md](ROADMAP.md) | Phased development plan with deliverables, exit criteria and testing for each phase |
| [DECISIONS.md](DECISIONS.md) | Architecture Decision Records (ADRs): what was decided, why, and the alternatives considered |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, commands and project rules |

## Important constraints (read before building)

1. **Rec-It will not download videos from YouTube.** The YouTube Data API does not provide video files, and YouTube's Terms of Service prohibit downloading except through features YouTube itself provides. YouTube research in Rec-It is for discovery, analysis and inspiration. Footage is imported from local files you have the rights to use. See ADR-012.
2. **Claude cannot watch video or listen to audio directly.** Rec-It turns footage into transcripts, sampled frames and numeric signals that Claude can reason about. See ADR-009.
3. **Rec-It does not sign in to Claude on your behalf.** Anthropic does not allow third-party apps to reuse your Claude login freely, and the rules have changed several times in 2026. Rec-It therefore exposes its tools as an MCP connector that your own Claude desktop app connects to; your normal Claude plan covers the usage. See ADR-018.

## Planned development prerequisites

- Windows 11 (primary development platform; macOS kept building in CI)
- Node.js 24 and pnpm 10
- Python 3.11+ and [uv](https://github.com/astral-sh/uv)
- FFmpeg 7.x GPL build with libx264 and NVENC (downloaded by `scripts/fetch-ffmpeg`, not committed)
- NVIDIA GPU with current drivers (reference machine: RTX 3070 8 GB) for NVENC export and CUDA transcription; CPU fallback for everything
- For AI features (Phase 7 onwards): the Claude desktop app on a Pro plan or higher
- For YouTube research (Phase 9): a free Google Cloud project with YouTube Data API v3 enabled

## Cost to users

Rec-It is free. Transcription, tracking and rendering run locally. AI features use the Claude plan the user already pays for. The YouTube Data API is free within Google's daily quota.

## Licence

GPL-3.0-or-later (ADR-007). Rec-It bundles a GPL build of FFmpeg with libx264, so the application is GPL as well.
