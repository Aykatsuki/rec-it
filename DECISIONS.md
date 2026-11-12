# Architecture Decision Records

Each record states the decision, why it was made and what else was considered. Records were approved on 11 November 2026 with the changes in ADR-007, ADR-013, ADR-016, ADR-017, ADR-018 and ADR-019. A later change creates a new record that supersedes the old one, rather than editing history.

| ADR | Title | Status |
|-----|-------|--------|
| 001 | Electron with a backend utility process | Accepted |
| 002 | pnpm monorepo with pure-TypeScript core | Accepted |
| 003 | Command-based document owned by the backend | Accepted |
| 004 | SQLite file per project | Accepted |
| 005 | Flicks as the unit of timeline time | Accepted |
| 006 | Normalised proxies for all preview playback | Accepted |
| 007 | FFmpeg build and licensing: GPL, open source | Accepted |
| 008 | Custom WebCodecs + WebGL2 preview engine | Accepted |
| 009 | Claude analyses signals, transcripts and frames, not raw video | Accepted |
| 010 | Local transcription with faster-whisper | Accepted |
| 011 | Captions as ASS rendered by libass in preview and export | Accepted |
| 012 | No downloading from YouTube; rights-aware local import | Accepted |
| 013 | Claude model routing and cost controls | Superseded by 018 |
| 014 | Python sidecar over JSON-RPC on stdio | Accepted |
| 015 | Canvas-rendered timeline | Accepted |
| 016 | Permission tiers for Claude's tools | Accepted (revised for MCP) |
| 017 | Target platform: Windows + NVIDIA first | Accepted |
| 018 | Claude through the user's own Claude app via MCP | Accepted |
| 019 | Editor first: Phases 0–5 have no AI dependency | Accepted |
| 020 | SQLite through Node's built-in `node:sqlite` | Accepted |
| 021 | Toolchain baseline and the Linux CI sandbox switch | Accepted |
| 022 | Assets are committed to the project file immediately | Accepted |
| 023 | Proxy encoding, derived files and the media protocol | Accepted |
| 024 | Backend heartbeat so FFmpeg never outlives a crashed app | Accepted |
| 025 | First timeline, preview and export slice | Accepted |
| 026 | Direct manipulation, context menus and an effects phase | Accepted |

---

## ADR-001 · Electron with a backend utility process

**Decision.** Use Electron with three tiers: a thin main process (windows, menus, protocol, secrets, updates), a sandboxed React renderer, and a Node `utilityProcess` that hosts all application services (project, commands, database, agent, jobs). The renderer and backend talk directly through a `MessagePort`.

**Why.** Keeping services out of main means a slow SQLite write or a large diff cannot freeze menus and window handling. Keeping them out of the renderer means API keys, the file system and FFmpeg are never reachable from code that renders untrusted text (YouTube titles, Claude output).

**Alternatives.** *Everything in main*: simpler, but main stalls under load and becomes a security choke point. *Tauri*: smaller and faster to start, but its webview differs per OS (WebKit on macOS lacks some WebCodecs support), which would break the preview engine; also not your preferred stack.

---

## ADR-002 · pnpm monorepo with pure-TypeScript core

**Decision.** One repository with `apps/desktop`, shared `packages/*` and `services/media-ai`. `packages/core` has no Electron, React or Node-specific dependencies.

**Why.** Clear module boundaries, one CI pipeline, shared types between renderer, backend and agent. A pure core is fast to unit-test and reusable later (for example a command-line batch tool).

**Alternatives.** Single package (boundaries erode quickly); multiple repositories (version coordination overhead for one team).

---

## ADR-003 · Command-based document owned by the backend

**Decision.** The project document lives in the backend. The UI and Claude change it only through validated commands. Immer patches drive renderer updates and undo/redo. Each Claude turn is one undoable transaction.

**Why.** It gives one code path for human and AI edits, exact undo, an audit trail of what Claude did, crash recovery from a command journal, and conflict detection when the user and Claude edit at the same time.

**Alternatives.** *Renderer owns state, Claude sends edits to the renderer*: the agent would depend on the window being open and healthy, and batch jobs would need the UI. *CRDT (Yjs/Automerge)*: built for multi-user collaboration, which is not a requirement, at a large complexity cost.

---

## ADR-004 · SQLite file per project

**Decision.** A `.recit` project is a SQLite database containing the document snapshot, a journal, transcripts, analysis results, agent conversations and the rights ledger. Media is referenced, not embedded. A separate `app.db` holds app-wide data.

**Why.** Atomic, crash-safe writes; large transcripts and analysis stored without rewriting one huge JSON file; one portable file; schema migrations.

**Alternatives.** JSON project file plus sidecar folders (simpler to read by hand, but fragile on crash and slow at scale); one global database for all projects (projects are not portable).

---

## ADR-005 · Flicks as the unit of timeline time

**Decision.** Store all timeline times as integer *flicks* (1/705,600,000 s). Exchange seconds (millisecond precision) with Claude and the UI.

**Why.** Flicks divide exactly into all common frame rates, including 29.97 and 59.94, and all common audio sample rates, so repeated edits never drift. Integers up to 2^53 are exact in JavaScript (about 147 days).

**Alternatives.** Floating-point seconds (rounding drift, equality bugs); frame numbers (break when mixing frame rates and for audio); rational numbers everywhere (correct, but slower and harder to work with).

---

## ADR-006 · Normalised proxies for all preview playback

**Decision.** Every imported video gets a proxy: H.264, constant frame rate, long edge 1280 px, short keyframe interval. The preview only plays proxies; export always uses originals.

**Why.** Chromium's codec support varies by platform (HEVC especially), phone footage is often variable-frame-rate, and long-GOP sources scrub slowly. One predictable proxy format removes a whole class of preview bugs.

**Costs.** Proxy generation time after import (roughly real-time or faster with hardware encoding) and disk space (about 1–2 GB per hour of footage). Proxies can be deleted and regenerated.

---

## ADR-007 · FFmpeg build and licensing: GPL, open source

**Status.** Accepted (11 Nov 2026). Rec-It is open source.

**Decision.** Rec-It is licensed **GPL-3.0-or-later** and bundles a GPL build of FFmpeg that includes libx264, NVENC and libass. FFmpeg still runs as a separate executable. Licence notices and a source offer for the bundled FFmpeg build ship with every release.

**Why.** Making Rec-It open source removes the reason to avoid GPL components, so the app gets libx264 (the best software H.264 encoder) as a fallback and "best quality" option alongside NVENC.

**Consequences.** Anyone who distributes a modified Rec-It must also release their source under the GPL. All other dependencies must be GPL-3.0-compatible (MIT, BSD, Apache-2.0, ISC and LGPL are). A dependency licence check runs in CI. Patent questions around distributing H.264 encoders are revisited before the first public release.

*This is not legal advice.*

---

## ADR-008 · Custom WebCodecs + WebGL2 preview engine

**Decision.** Build the preview from WebCodecs decoding (proxies demuxed with mp4box.js), WebGL2 compositing and Web Audio, driven by the same RenderPlan that the export uses. The audio clock is the master clock.

**Why.** Layered `<video>` elements cannot seek frame-accurately, sync several layers or apply per-frame crop paths reliably. Generating preview with FFmpeg and streaming it back has too much latency for scrubbing. A native engine (e.g. MLT through a Node addon) would be capable but adds a large native build and a second rendering model.

**Risk.** This is the largest engineering task in the project. Mitigations: proxies (ADR-006), an interim single-layer engine behind the same interface (Phase 2a), golden-frame tests from Phase 3.

---

## ADR-009 · Claude analyses signals, transcripts and frames, not raw video

**Decision.** Footage is converted locally into a word-timed transcript, scene boundaries, audio and visual signals, and a small number of downscaled frames. Claude reasons over these.

**Why.** The Claude API accepts text and images, not video or audio. This approach is also much cheaper: an hour of footage becomes tens of thousands of tokens instead of millions.

**Consequence.** Claude can miss purely visual or musical moments that the transcript and sampled frames do not capture. Visual signals (motion, scene cuts, faces) reduce this but do not remove it.

---

## ADR-010 · Local transcription with faster-whisper

**Decision.** Transcribe locally with faster-whisper (Whisper models on CTranslate2), word timestamps and VAD, in the Python sidecar. Model size chosen by hardware.

**Why.** Free per use, private, accurate, good word timings, works offline.

**Alternatives.** whisper.cpp through Node bindings (fewer moving parts but weaker word-timestamp tooling); cloud speech APIs (fast on any machine, but ongoing cost and uploads of user audio) — kept as an optional fallback for later.

---

## ADR-011 · Captions as ASS rendered by libass in preview and export

**Decision.** Compile captions and their animations to an ASS subtitle file. Preview draws it with JASSUB (libass compiled to WebAssembly); export burns it in with FFmpeg's `ass` filter (also libass). Fonts are bundled and passed to both.

**Why.** Using the same rendering library on both sides makes caption parity — the most visible preview/export mismatch in Shorts editors — close to guaranteed. ASS supports per-word timing, colour changes, scaling and movement, which covers the popular caption styles.

**Limitations.** No colour emoji; no glows with motion blur or 3D effects. If needed, a later overlay-frames path renders an RGBA layer in Rec-It and passes it to FFmpeg as an extra input.

**Alternatives.** Canvas-drawn captions in preview plus a separate export renderer (two renderers that drift apart); rendering captions to video files (slow, large).

---

## ADR-012 · No downloading from YouTube; rights-aware local import

**Decision.** Rec-It will not include a YouTube downloader (such as yt-dlp). YouTube research is for discovery, analysis and inspiration. Footage comes from local files, each with a rights record; CC-BY assets get generated attribution; export warns about unknown rights.

**Why.** The YouTube Data API does not provide video files. YouTube's Terms of Service prohibit downloading content except through features YouTube provides, regardless of the video's licence. Shipping a downloader would expose you and your users to account termination and legal risk, and would likely get the app's API access revoked.

**What this means for the "import" requirement.** Rights-aware import is implemented as local import with provenance tracking and an optional link to the YouTube video a clip came from. This is the main point in your brief that needs a different approach than it might suggest.

---

## ADR-013 · Claude model routing and cost controls

**Status.** Superseded by ADR-018. Rec-It no longer calls the Claude API with its own key, so it does not choose models or meter spending; the user picks the model in their Claude app.

---

## ADR-014 · Python sidecar over JSON-RPC on stdio

**Decision.** One long-lived Python process, started by the backend, speaking newline-delimited JSON-RPC 2.0 over stdin/stdout. Large results are written to files in the project cache. Packaged with a standalone Python build and pinned dependencies; models downloaded on first use.

**Why.** Python has the best tooling for Whisper, scene detection and face tracking. stdio needs no open network ports (no local HTTP server for other software to reach), and a long-lived process loads models once.

**Alternatives.** Local HTTP server (open port, firewall prompts); spawning Python per task (slow model loading); porting everything to Node/ONNX (possible later for single tasks, but slower to build now).

**Costs.** Installer grows by a few hundred MB (Python runtime and ML libraries), plus model downloads of 0.5–3 GB depending on choice.

---

## ADR-015 · Canvas-rendered timeline

**Decision.** Draw the timeline body (clips, filmstrips, waveforms, caption blocks, playhead) on a `<canvas>`, with React only for headers, menus and popovers.

**Why.** Shorts projects quickly reach hundreds of caption segments and cut pieces; a DOM element per item becomes slow to scroll and zoom. Canvas keeps interaction at 60 fps.

**Cost.** Hit-testing, accessibility and text rendering must be implemented by hand. Keyboard navigation of timeline items is provided through an accessible list alongside the canvas.

---

## ADR-016 · Permission tiers for Claude's tools

**Decision.** Three tiers: *read* (annotated read-only in MCP so the user can "always allow" them in the Claude app), *edit* (undoable; Claude's consecutive edits form one undo step), *heavy or external* (transcription, analysis, import, export, deletion: Rec-It shows its own confirmation card and the tool waits for a click inside Rec-It). Rec-It gives Claude no shell, file system, network or settings tools.

**Why.** The Claude app's own tool approvals are controlled by the user and may be set to "always allow". A second confirmation inside Rec-It for heavy actions makes prompt injection and accidental destructive actions impossible without the user, while keeping ordinary editing fast.

---

## ADR-017 · Target platform: Windows + NVIDIA first

**Status.** Accepted (11 Nov 2026).

**Decision.** Develop and test on Windows 11 with an NVIDIA GPU (reference machine: RTX 3070, 8 GB). Defaults: NVENC for export, CUDA decoding where useful, faster-whisper `large-v3-turbo` in float16 on the GPU. Every GPU feature has a CPU fallback. macOS keeps building and passing automated tests in CI so it stays possible, but manual testing, packaging and signing for macOS are deferred. Linux after that.

**Why.** It matches your machine, and 8 GB of GPU memory is enough for the transcription model and the editor's preview at the same time.

**Notes.** Consumer NVIDIA cards limit concurrent NVENC sessions, so batch export encodes one Short at a time on the GPU. CUDA libraries are bundled with the Python environment so users do not install the CUDA toolkit.

---

## ADR-018 · Claude through the user's own Claude app via MCP

**Status.** Accepted (11 Nov 2026). Supersedes ADR-013.

**Context.** You want Rec-It to be free, with AI usage coming from your Claude subscription rather than a paid API key. The Claude API is billed separately from Claude subscriptions. Anthropic's rules on third-party apps using a subscription changed several times in 2026: Claude Code's legal and compliance page says third-party developers may not offer Claude.ai login or route requests through users' Free, Pro or Max credentials, while Anthropic's support pages describe third-party apps built on the Agent SDK drawing on a user's plan, with the billing arrangement for that still changing.

**Decision.** Rec-It exposes its editing tools as a local **MCP server** (`recit-mcp`, installed into the Claude desktop app as a desktop extension). The user chats with Claude in the Claude app; Claude operates Rec-It through the tools. Rec-It never handles Claude credentials. The same server works with Claude Code. An in-app chat panel using the Claude Agent SDK (authenticating with the user's own Claude Code sign-in or their own API key) is optional and built only if the policy is clear when we reach it.

**Why.**
- Using MCP tools from the Claude desktop app is a first-party, documented use of a Claude plan, so it is not affected by the third-party rules.
- No billing, no keys and no login handling in an open-source app.
- One ToolRegistry serves every route, so nothing is wasted if the in-app panel is added later.

**Trade-offs.**
- The conversation happens in the Claude app window, not inside Rec-It. Rec-It shows an activity feed and change cards so you still see what Claude did.
- Local MCP servers in the Claude desktop app require a Pro plan or higher.
- Rec-It cannot see token use or choose the model; heavy analysis counts towards your plan's usage limits.
- Fully unattended analysis (no conversation) is not possible through the Claude app. The local, non-AI ranking (ARCHITECTURE §14) covers this, and Claude Code can script it.

**Alternatives rejected.**
- Rec-It reading or reusing the user's Claude login token: not permitted and fragile.
- Paid API key: contradicts the "free" requirement (kept only as a user-supplied option for the optional panel).
- Automating the Claude app's UI: fragile and against the spirit of the terms.

---

## ADR-019 · Editor first: Phases 0–5 have no AI dependency

**Status.** Accepted (11 Nov 2026).

**Decision.** The first goal is a fully working video editor: import, multi-track timeline, preview, export, local transcription and captions, and 9:16 reframing (Phases 0–5, milestones M1 and M2). No Claude work starts until M2 is reached and reviewed. AI-adjacent features in those phases (Whisper transcription, face tracking) are local and work offline.

**Why.** The editor's quality — accurate preview, matching export, stable undo — decides whether the AI features are useful at all. Claude's tools are a thin layer over the editor's commands, so they are quick to add once the editor is solid.

---

## ADR-020 · SQLite through Node's built-in `node:sqlite`

**Status.** Accepted (11 Nov 2026, Phase 0). Refines ADR-004, which named better-sqlite3.

**Decision.** Use the `node:sqlite` module that ships with Node 24 (and therefore with Electron 45's Node) instead of the better-sqlite3 native module. Access goes through `packages/db`, which wraps opening, pragmas (WAL, foreign keys, busy timeout), transactions and migrations.

**Why.** better-sqlite3 is a native addon that must be compiled or downloaded separately for Electron's ABI and for the Node used by tests, which is a frequent source of broken installs on Windows. `node:sqlite` has the same synchronous API style, needs no build step, and is identical in tests and in the app.

**Risks.** The module is newer than better-sqlite3 and marked as still evolving in Node's documentation. All use is behind `packages/db`, so switching back is a contained change. Unit tests cover migrations, rollback and settings persistence.

---

## ADR-021 · Toolchain baseline and the Linux CI sandbox switch

**Status.** Accepted (11 Nov 2026, Phase 0).

**Decision.** Baseline versions: Electron 45 (Node 24), Node 24 for tooling, pnpm 10, TypeScript 6.0, ESLint 10 with typescript-eslint, Vite 8 with electron-vite 6, React 19, Zod 4, Vitest 5, Playwright 1.65, Python 3.12 managed by uv.

**Notes.**
- TypeScript 7.0 is out but typescript-eslint supports only up to 6.0, so the project stays on 6.0 until it does.
- Workspace packages export TypeScript sources directly and electron-vite bundles them; there is no per-package build step.
- Chromium's OS-level sandbox cannot run in Linux CI containers (root user or restricted user namespaces). End-to-end tests on Linux CI pass `--no-sandbox` together with `RECIT_E2E=1` and `RECIT_NO_OS_SANDBOX=1`; the app only honours this when both test variables are set. The renderer keeps Electron's `sandbox: true` and context isolation. Windows and macOS always run with the full sandbox, in CI and in use.

---

## ADR-022 · Assets are committed to the project file immediately

**Status.** Accepted (12 Nov 2026, Phase 1). Refines ADR-004 and ARCHITECTURE §7.

**Decision.** In the `.recit` file, imported media are rows in an `assets` table, and each change (import, job state, relink, rights) is a separate committed SQLite write. There is no Save button: projects save as they change. "Save a copy as…" uses `VACUUM INTO` and switches to the copy, which keeps the same project id and therefore shares the media cache. The timeline document and its command journal (ARCHITECTURE §7) arrive in Phase 2 on top of this file.

**Why.** Asset changes are infrequent and small, so committing each one is cheap, and it meets the "lose at most one second" crash requirement with no recovery code: after a crash, SQLite's WAL leaves the file consistent, and jobs that were running are simply restarted. The end-to-end suite kills the app mid-import to prove this.

**Consequences.** Progress ticks are kept in memory and only state changes are written, so the database is not written several times a second.

---

## ADR-023 · Proxy encoding, derived files and the media protocol

**Status.** Accepted (12 Nov 2026, Phase 1). Details ADR-006.

**Decisions.**
- **Encoder:** NVENC when FFmpeg's one-frame test encode succeeds (the reference RTX 3070), otherwise libx264 `veryfast`, then other hardware encoders. Proxies are H.264, at most 1280 px on the long edge, constant frame rate snapped to the nearest standard rate, a keyframe every 12 frames, no B-frames, AAC 48 kHz, `+faststart`.
- **Phone footage:** rotation metadata is applied while making the proxy, so proxies are always upright. HDR (PQ/HLG) is tone-mapped to SDR in the proxy only; export will use the originals.
- **Derived files:** `proxy.mp4`, `poster.jpg`, `sprite.jpg` (up to 100 thumbnails in a 10-wide grid) and `waveform.bin` (100 peaks per second, one byte each) live in `<cache>/<projectId>/<assetId>/`. Each is written to a `.part` file and renamed when complete, so a cancelled or failed job leaves nothing behind.
- **Duplicates and relinking:** files are identified by SHA-256 of their size plus first and last 4 MB. Importing the same content twice is refused, and a missing file can only be relinked to a file with the same fingerprint.
- **Serving:** the renderer reads derived files only through `recit-media://asset/<projectId>/<assetId>/<file>`. IDs are validated, file names come from a four-item allow-list, and range requests are supported so video can seek. Original media files are never served to the renderer.
- **Cancelling** kills FFmpeg immediately (SIGKILL / TerminateProcess), because a polite stop makes FFmpeg flush its encoder for several seconds.
- **Shutdown:** main asks the backend to stop jobs and close the project before quitting, because a forced kill on Windows would leave FFmpeg child processes running.

---

## ADR-024 · Backend heartbeat so FFmpeg never outlives a crashed app

**Status.** Accepted (12 Nov 2026, Phase 1).

**Context.** On Windows, killing a process does not kill its children. When Rec-It's main process was force-killed during import, the backend and its FFmpeg jobs kept running. That left media files locked and could stop Rec-It from starting again. Linux hides this because Chromium's helper processes die with their parent there. The crash-recovery end-to-end test found it on Windows CI.

**Decision.**
- Main sends the backend a heartbeat every second. If none arrives for 5 seconds, the backend kills every FFmpeg process it started and exits. `packages/ffmpeg` keeps a registry of running FFmpeg processes for this, and the backend also kills them on any exit.
- Normal quitting asks the backend to shut down cleanly first (ADR-023).
- Checking the parent's process id was tried first and did not work reliably on Windows, so the heartbeat is used on every platform.
- When Windows ends the backend abruptly together with main, no code in the backend gets to run. As a second safety net, the backend records the process ids of the FFmpeg jobs it is running in `ffmpeg-pids.json` in the user-data folder. On the next start it ends any of those that are still running, after checking that each process really is FFmpeg (so a reused process id is never touched).

**Known limitation.** If only Rec-It's main process is killed (for example "End process" on that single entry in Task Manager), Chromium's own helper processes (GPU, network, renderer) can stay alive and prevent a new instance from starting until they are ended. Ending the whole app ("End task") does not have this problem. The Windows CI test kills the main process alone, ends the remaining helpers, relaunches, and checks that the FFmpeg processes left by the killed instance are ended by the new one.


---

## ADR-025 · First timeline, preview and export slice

**Status.** Accepted (12 Nov 2026, Phases 2–3 first slice).

**Context.** After Phase 1 the user could import footage but could not put it on a timeline, set the resolution or frame rate, or export. A usable end-to-end editor was more valuable than finishing the high-risk Phase 2 preview engine first.

**Decisions.**
- **Document storage:** the whole timeline document is saved as one JSON row in the project file after every edit (migration 2). Documents for Shorts are small, so this is simpler and safer than storing patches. Patches are kept in memory for undo/redo only (200 steps).
- **Interim timeline:** built with DOM elements, not the canvas timeline of ADR-015. It is fine for Shorts-sized timelines; the canvas version replaces it when filmstrips, waveforms and 1,000-item timelines arrive.
- **Interim preview:** one HTML media element per visible clip, synced to a wall clock and laid out with the same `computeLayout` used by export. It is not frame-accurate; the WebCodecs/WebGL2 engine of ADR-008 replaces it.
- **Audio of video clips:** a video clip carries its own audio (no separate linked audio item yet). Audio-only files get an AAC proxy (`proxy.m4a`) and images a `still.jpg`, both added to the media protocol allow-list.
- **Editing model:** overwrite edits, snapped to frames; changing the frame rate re-snaps every edit. New sequences default to 1080×1920 at the first clip's frame rate.
- **Export** uses the original files, not proxies, through one `filter_complex` graph passed as a file. It writes to `<name>.part` and renames on success. One export runs at a time.
- **Media in use** on a timeline cannot be removed from the project.

---

## ADR-026 · Direct manipulation, context menus and an effects phase

**Status.** Accepted (12 Nov 2026, Phase 2 second slice). Builds on ADR-025.

**Decisions.**
- **Rotation joins the transform.** `Transform` gains `rotation` (degrees, normalised to −180..180, around the picture's centre). Documents saved earlier load with 0. `computeLayout` also returns the rotated bounding box; export scales, then rotates into that box with transparent corners (`rotate=…:c=none`) and overlays it there, so preview (CSS `rotate`) and export agree.
- **Direct manipulation in the preview.** Clicking the picture selects the topmost clip under the pointer (hit-tested in its rotated rectangle). Drag moves, corners resize uniformly about the centre, the round handle rotates. Snapping to the frame centre and edges (with guides), Shift constrains (axis, 5% scale steps, 15° rotation steps), Alt turns snapping off, Escape cancels. While dragging, a *draft transform* in the renderer store drives the preview; one `item.update` is sent on release, so every gesture is one undo step and nothing is written to disk mid-drag. Inspector sliders use the same draft, which removes ADR-025's "updates on release" limitation.
- **Group edits.** Two new commands: `item.moveMany` (lifts every moving clip before placing any, so a group cannot overwrite itself) and `batch` (several commands, one undo step, all-or-nothing, not nestable). Paste, duplicate, detach audio, multi-clip framing changes and context-menu actions use them. `track.remove` deletes a track and its clips but never the last video or audio track. `item.add` accepts volume, mute and transform so pasted clips keep their settings.
- **Context menus** are one renderer component (`ui/ContextMenu.tsx`: keyboard navigation, submenus, conditional entries) fed by menu builders in `timeline/menus.tsx`. They only call the same edit helpers as buttons and shortcuts; no new IPC.
- **Clipboard** is renderer memory only (clip references, timing, settings), not the system clipboard.
- **Effects get their own phase.** Fades, transitions, colour, blur, keying, speed and audio effects become Phase 6, before the Claude phases, so the editor is complete before AI work starts (consistent with ADR-019). Later phases are renumbered: Claude connection is now Phase 7, AI analysis 8, YouTube research 9, batch Shorts 10, release 11.
