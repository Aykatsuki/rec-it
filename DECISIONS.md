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
| 008 | Custom WebCodecs + WebGL2 preview engine | Accepted (first version: ADR-029) |
| 009 | Claude analyses signals, transcripts and frames, not raw video | Accepted |
| 010 | Local transcription with faster-whisper | Accepted (built: ADR-031) |
| 011 | Captions as ASS rendered by libass in preview and export | Accepted (built: ADR-032) |
| 012 | No downloading from YouTube; rights-aware local import | Accepted |
| 013 | Claude model routing and cost controls | Superseded by 018 |
| 014 | Python sidecar over JSON-RPC on stdio | Accepted |
| 015 | Canvas-rendered timeline | Deferred (ADR-030) |
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
| 027 | Export settings, two-pass loudness and preview/export parity | Accepted |
| 028 | Export folder, linked clips and keyframes | Accepted |
| 029 | GPU preview engine (WebCodecs + WebGL2), first version | Accepted |
| 030 | Web Audio playback, keyframe dragging and a fast DOM timeline | Accepted |
| 031 | Local transcription and text-based editing | Accepted |
| 032 | Automatic captions and transcript corrections | Accepted (caption model superseded by 033) |
| 033 | Captions become clips on caption tracks | Accepted |
| 034 | Crop and the facecam + gameplay layout (manual reframing) | Accepted |
| 035 | Automatic reframing with face detection | Accepted |
| 036 | Fades, opacity and colour effects | Accepted |
| 037 | Transitions: cross dissolve and dips | Accepted |

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

---

## ADR-027 · Export settings, two-pass loudness and preview/export parity

**Status.** Accepted (12 Nov 2026, Phase 3). Details ADR-007, ADR-025 and ARCHITECTURE §10.

**Decisions.**
- **Settings, not just presets.** The dialog offers four presets (YouTube Short, High quality, Smaller file = H.265, Draft = half size, no loudness pass) and the individual settings behind them: resolution (100/75/66/50 % of the sequence), codec (H.264 or H.265), encoder (automatic, graphics card, software), quality, AAC bitrate and loudness target. The renderer remembers the last settings. Output is composed directly at the chosen size, not scaled afterwards.
- **Encoder choice** (`pickExportEncoder`): automatic means NVENC when its test encode passed, VideoToolbox on macOS, otherwise x264/x265. Intel and AMD encoders are compiled into most FFmpeg builds even without the hardware, so they are only tried when the user picks "graphics card". If a graphics-card encoder fails before 5 % of the encode, the export is redone once in software and the dialog says so.
- **Two-pass loudness.** Pass 1 mixes only the audio exactly as the export will and runs `loudnorm` to measure it; pass 2 applies the measured values with `linear=true`, so the whole Short gets one gain instead of dynamic level changes. Silence is detected and left alone. Targets: −14 (YouTube), −11, −16, −23 LUFS or off; true peak −1.5 dBTP.
- **Player-safe output.** 4:2:0, BT.709 colour tags (set in the graph with `setparams` and on the stream), every layer converted to BT.709 when scaled, closed GOP of half the frame rate, two B-frames, `hvc1` tag for HEVC (QuickTime), AAC-LC 48 kHz stereo, `+faststart`, title metadata.
- **Frames as images** use the same graph as the export (`planFrame`), so a saved still is exactly what the video contains.
- **Golden-frame parity in CI.** An end-to-end test builds three cases (fill; fit with offset and rotation; a rotated still over video), screenshots the preview at a moment inside each, exports, and compares with SSIM (≥ 0.98, outer 2 px excluded, both images lightly blurred with σ = 1.5 so the browser's and FFmpeg's scalers on different OSes do not count; a stale or one-frame-off clip still scores about 0.97). Fixtures use flat colours and a moving box, so the score reflects layout, colour and timing rather than scaler differences on noise. This found three preview bugs, now fixed: proxies were untagged and shown with the wrong colour matrix (proxies are now BT.709 and tagged; proxies made earlier keep a slight colour shift until regenerated); paused seeks landed one frame early (seeks now aim a quarter-frame into the frame); and a paused clip seeked while invisible showed a stale frame when it appeared (it is re-seeked once visible; hidden layers use opacity instead of visibility).
- **Scope moved.** Speed changes and fades, listed under Phase 3 originally, are part of Phase 6 (effects, ADR-026).

---

## ADR-028 · Export folder, linked clips and keyframes

**Status.** Accepted (12 Nov 2026, Phase 2 third slice).

**Decisions.**
- **Export destination.** The export window shows the folder and an editable file name instead of opening a save dialog every time. The folder is the last one exported to (app setting `exportDirectory`), falling back to the user's Videos folder, and "Change…" picks another. File names are cleaned for Windows; an existing file is pointed out and the button says "Replace and export". Saved frames start in the same folder.
- **Linked clips.** Items carry an optional `linkId`. Clips sharing one move (keeping their own tracks), trim to the same edge (each limited by its own media), split (the right-hand pieces get a new shared link) and delete together. Detach audio creates a linked pair. An overwrite that cuts a linked clip in two keeps only the first part linked. Selecting a linked clip selects its partner; Alt-click selects one side. The inspector and transform box work on the picture clip of a linked group.
- **Keyframes.** `x`, `y`, `scale`, `rotation` and `volume` can be keyframed; each keyframe has a value and an easing (linear, ease = smoothstep, hold) towards the next. Keyframe times are stored in *source* time, so animation stays on the same picture when a clip is trimmed or split. A property with keyframes ignores its static value; setting a static value (Reset, Fill/Fit buttons excluded) removes that property's animation; removing the last keyframe keeps its value. Editing an animated property (slider or preview drag) sets a keyframe at the playhead — one undo step per gesture.
- **Keyframed export.** FFmpeg filter graphs cannot change frame size mid-stream, so an animated layer is scaled once to its largest size (capped at 4096 px), centred on a transparent canvas big enough for every size and angle (capped at 8192 px), and moved per frame by `perspective` with expressions for its corners (an affine map is a special case of perspective). The overlay places the canvas centre at the animated position. Volume keyframes become a per-frame `volume` expression. Expressions are generated from the same keyframes and match `valueAt` exactly (unit-tested); the parity suite includes a keyframed case (SSIM 0.987). Static clips keep the simpler path, so existing exports are unchanged (argument snapshots).
- **Bugs fixed on the way:** inspector sliders never committed (their live preview made every value look unchanged), and the frame-step shortcut stole arrow keys from focused sliders.

---

## ADR-029 · GPU preview engine (WebCodecs + WebGL2), first version

**Status.** Accepted (12 Nov 2026, Phase 2 fourth slice). Implements most of ADR-008; supersedes the interim engine of ADR-025 as the default.

**Decisions.**
- **Decoding.** `VideoSource` opens a proxy with mp4box.js (BSD-3-Clause), reading only the movie header with growing range requests over `recit-media://`, then fetches one group of pictures at a time (the proxies' keyframe interval is 12 and they have no B-frames, so decode order is display order). Seeks restart at the keyframe before the target; sequential requests (playback, stepping forward) continue the running decoder. A few decoded frames and a few blocks are cached. Edit lists are honoured when mapping sample times to presentation time.
- **Compositing.** `Compositor` draws each layer as a textured quad in WebGL2, placing it with `computeLayout` and the rotation exactly as the export does; textures are mipmapped so large downscales stay smooth. The canvas keeps its last frame, so the picture never blanks while decoding.
- **Engine.** `PreviewEngine.render(time)` decodes every visible layer and draws when all are ready; a newer request abandons an older one. During playback a layer whose frame is more than 50 ms late keeps its previous picture so time keeps moving. Decoders for clips far from the playhead are closed.
- **Audio** still plays through media elements synced to the playhead (as in ADR-025). Web Audio with the audio clock as master is the next step.
- **Fallback.** If WebCodecs or WebGL2 is unavailable or the engine fails, the compatible media-element engine is used automatically (with a notice); it can also be chosen from the preview's right-click menu. End-to-end tests run Chromium's software WebGL (`--enable-unsafe-swiftshader`) so the GPU path is tested in CI.
- **Tests.** A frame-accuracy test uses a fixture whose frames each have a different brightness and checks the exact frame after stepping forward, backward and jumping; the parity suite now runs against the GPU engine (SSIM 0.995–0.997).
- **Development mode and lost contexts (fix, 12 Nov 2026).** In `pnpm dev`, React StrictMode mounts effects twice on the same canvas. The first version deliberately lost the WebGL context when unmounting, and a canvas hands back that same lost context, so the second mount failed with an empty message ("The GPU preview could not start ()"). The compositor now frees its resources without losing the context, handles real context loss (driver reset, sleep) by restoring and redrawing, and errors name their cause. A decoder that does not deliver a frame is restarted and late frames are always closed (a decoder has a fixed pool of frames; leaking them would freeze it). Choosing the GPU engine again in the preview menu retries after a failure. Rendering no longer lets a newer request cancel one that is already decoding: requests are coalesced (one render at a time, then the newest waiting one), because when a render took longer than a screen refresh — on slower machines or in development mode — every render was cancelled and playback froze. The frame test now plays back with the CPU throttled 4× to cover this. CI runs the GPU tests on Windows against a React development build (`RECIT_REACT_DEV=1`) as well, and the frame test loses and restores the context.
- **Proxy frame-rate fix.** The proxy rate picked the *first* standard rate within 1% instead of the nearest, so 24, 30 and 60 fps footage got 23.976, 29.97 and 59.94 fps proxies: the preview drifted by a frame every ~33 s. The nearest rate is now used. Proxies are now named `proxy-v2.mp4`; projects with older proxies regenerate them automatically (which also applies the BT.709 tagging of ADR-027) and the old file is deleted.

---

## ADR-030 · Web Audio playback, keyframe dragging and a fast DOM timeline

**Status.** Accepted (12 Nov 2026, Phase 2 fifth slice). Completes ADR-008's audio part; defers ADR-015.

**Decisions.**
- **Audio.** `AudioSource` reads a proxy's AAC track with mp4box (header and needed ranges only, edit list applied) and decodes ranges with WebCodecs `AudioDecoder` (one frame of pre-roll). `AudioEngine` schedules each audible clip in one-second blocks, two seconds ahead, as `AudioBufferSourceNode`s at exact context times; static volume is a gain value, keyframed volume a gain curve (50 points per second). The audible-clip rules are the export's (muted tracks/clips silent, hidden tracks still heard).
- **Clock.** In the GPU engine at normal speed the playhead follows the audio clock. If the audio clock does not move within 300 ms of wall time (no audio device), playback follows the wall clock instead. J/K/L at other speeds and the compatible engine use the wall clock without Web Audio. An edit during playback restarts the sound from the current position.
- **Verification.** `AudioEngine.renderOffline` uses the same scheduling with an `OfflineAudioContext`. An end-to-end test compares the preview's offline mix with the exported audio (10 ms RMS envelopes): correlation ≥ 0.98, offset ≤ 20 ms, level within 1 dB (measured 0.9975, 0 ms, 0.1 dB).
- **Keyframe dragging.** Dragging a diamond on a clip moves every keyframe at that time to another frame inside the clip (one undo step); clicking still jumps to it.
- **Timeline performance without a canvas (for now).** Rendering only clips near the visible area, memoising clips (they no longer re-render on every playhead change), sharing each file's waveform between clips and drawing clips under 24 px as plain blocks makes 1,000 clips scroll at 60 fps and zoom at a median of 60 fps even in CI's software rendering. The canvas timeline of ADR-015 is deferred until the DOM timeline is shown to be too slow.
- **Fixed:** with the audio clock, playback stopped at once because the clock reads 0 during the start-up latency and the playback loop treated time 0 as "reached the start".

---

## ADR-031 · Local transcription and text-based editing

**Status.** Accepted (13 Nov 2026, Phase 4 first slice). Implements the transcription half of Phase 4; captions follow.

**Decisions.**
- **Engine.** faster-whisper in the Python sidecar, installed on request as the optional `transcribe` extra (`uv sync --extra transcribe --inexact`, about 1.5 GB on Windows because it includes the CUDA 12 cuBLAS and cuDNN 9 wheels). It is not installed by default so the app stays small for people who never transcribe. The transcript panel offers an "Install transcription" button; the helper is stopped during the install and restarted afterwards.
- **Models and device.** `large-v3-turbo` in float16 on CUDA (the RTX 3070 has room for it), falling back to `small` in int8 on the CPU when CUDA is missing or fails to load. The device follows the `transcriptionDevice` setting (auto, cuda, cpu). Word timestamps and Silero VAD are on. Models download from Hugging Face on first use into the app's `models` folder; faster-whisper's own download (which checks file hashes from the model repository) replaces the planned checksum-pinning download manager for now.
- **Jobs.** The sidecar runs long jobs on worker threads: it keeps answering other requests, reports `job.progress` notifications and stops on `job.cancel` (error code −32800). The backend extracts 16 kHz mono WAV with FFmpeg first (8% of the progress bar), then runs one transcription at a time because Whisper uses the whole GPU.
- **Storage.** Transcripts are word lists (`text`, `start`, `end` in *source* seconds, confidence `p`) stored in the project file (`transcripts` table, migration 3), one per media file, deleted with the media. Source time means a transcript never needs updating after edits.
- **Text-based editing.** The panel shows the words the active sequence plays, in timeline order (linked clips and identical copies once; words belong to a clip when their middle is inside the clip). Clicking a word moves the playhead to it, and the word under the playhead is highlighted. Selecting words and pressing Delete cuts each run of selected words from the first word's start to the next kept word's start (so the pause after them goes too) with a new core command, `item.cutRange` (source-time range; linked partners are cut too; with "Close gaps", later clips on those tracks move left). All cuts are one undo step.
- **Testing without a model.** `RECIT_FAKE_WHISPER=1` makes the sidecar produce "word1", "word2", … every 0.5 s (with `RECIT_FAKE_WHISPER_DELAY` to make it slow enough to cancel). Backend integration and end-to-end tests use it with the real sidecar. A separate CI job installs the extra and transcribes speech synthesised by espeak-ng with the `tiny.en` model.
- **Deferred to the next slices:** captions (ASS compiler, styles, JASSUB preview, `ass` export, bundled fonts), transcript search and correcting words, and the word-error-rate and ±50 ms timing measurements of the exit criteria.

---

## ADR-032 · Automatic captions and transcript corrections

**Status.** Accepted (13 Nov 2026, Phase 4 second slice). Implements ADR-011; changes the caption model of ARCHITECTURE §6.5 for now.

**Decisions.**
- **Captions are derived, not stored.** A sequence has caption *settings* (`captions`: on/off, style, size, vertical position, words per line, one or two lines, capitals, spoken-word colour), changed with the undoable `captions.update` command. The captions themselves are computed whenever they are drawn: the words the timeline plays (ADR-031's mapping, so cuts, trims, moves and muted clips are followed automatically) are grouped into captions and compiled to ASS. There is no separate caption track to keep in sync. Per-caption overrides (moving one caption, restyling one word) are left for later and would add stored segments on top of this.
- **Corrections live in the document.** `transcript.editWord` stores `{from, to}` for a recognised word in `doc.transcriptEdits`, so corrections are undoable with Ctrl+Z and saved with the timeline, while the original transcript stays untouched. A correction with several words shares the original word's time by letter count; an empty one hides the word from captions (it stays in the transcript, struck through, and can still be cut). A correction whose `from` no longer matches (the media was transcribed again) is ignored. Corrections only change text; cutting words from the video is still Delete (ADR-031).
- **Grouping** (`packages/captions`): up to words-per-line × lines words per caption, a new caption after a sentence end or a pause over 0.7 s, never longer than 4 s; lines balanced; a caption stays up 0.5 s after its last word unless the next starts sooner. The "Pop" style shows one word at a time.
- **Six built-in styles**: Highlight (Montserrat ExtraBold, spoken word coloured), Pop (one big word with a scale-in), Karaoke (Poppins, words fill with colour as spoken, `\kf`), Bold caps (Anton), Clean box (Poppins SemiBold on a translucent box) and Bebas (Bebas Neue). Highlighting uses one ASS event per spoken word, so a word lights up exactly at its start time (centisecond precision).
- **One file, one renderer, two places.** `sequenceCaptionsAss` in `packages/captions` builds the ASS; the renderer and the backend both call it. The preview draws it with JASSUB (libass in WebAssembly, LGPL/MIT; canvas-only mode on an OffscreenCanvas worker, redrawn at each playhead position) on a canvas above the picture; the export burns it in with FFmpeg's `ass` filter after the frame is converted to BT.709 YUV, with `shaping=complex` to match JASSUB. The export writes `captions.ass` and a copy of the fonts into its work folder and runs FFmpeg there, so the filter graph only contains plain relative names (no path escaping).
- **Fonts.** Six OFL fonts are bundled in `resources/fonts` (licences included) and given to both renderers; JASSUB is told not to look for system or web fonts, so captions look the same on every computer. Packaging must copy `resources/fonts` next to FFmpeg (Phase 11).
- **Security.** The renderer's CSP gains `'wasm-unsafe-eval'`, which allows compiling WebAssembly but not JavaScript `eval` (`'unsafe-eval'` stays absent; the security test checks both).
- **Tests.** ASS snapshots for every style; segmentation rules; a real-FFmpeg test that libass draws the bundled font with the right word highlighted at the right times; an end-to-end test (correct a word, hide one, turn captions on, change style, undo, turn off); and two caption cases in the golden-frame parity suite (Highlight 0.992, Karaoke mid-word fill 0.996 SSIM).
- **JASSUB owns its canvas.** JASSUB moves its canvas to a worker and removes it from the page when destroyed, so the preview creates that canvas itself inside a container React owns. In React development mode (StrictMode mounts twice) a React-owned canvas was removed behind React's back and the next re-render crashed the preview; CI caught this on Windows, and the captions end-to-end test now also runs in development mode there.
- **JASSUB is patched to draw on normal canvases** (`patches/jassub@2.5.37.patch`, applied by pnpm). It requested `desynchronized` canvases, which Chromium on Windows with a hardware GPU presents as overlays without transparency: the whole caption layer became opaque black over the preview (found on the reference PC; CI's software rendering ignores the flag, so no automated test could see it). A unit test fails if an upgrade drops the patch, and the caption layer is only mounted while captions are shown.
- **No libass, no burned-in captions.** If the FFmpeg in use lacks libass (Homebrew's build on macOS), exporting with captions on says so instead of failing inside FFmpeg; Rec-It's own FFmpeg builds include libass.
- **Layout.** The placeholder Claude tab in the right panel is removed until Phase 7 (the top bar still shows the connection), so Inspector, Transcript and Captions fit.

---

## ADR-033 · Captions become clips on caption tracks

**Status.** Accepted (13 Nov 2026, Phase 4 third slice). Supersedes the "captions are derived, not stored" part of ADR-032; keeps its styles, renderer, fonts and parity rules. Brings back the stored caption segments of ARCHITECTURE §6.5.

**Context.** Derived captions always followed the transcript, but the user wants to edit captions freely after they are generated: move, resize, retime, rewrite and delete individual captions like any other layer.

**Decisions.**
- **Caption tracks.** A third track kind, `caption` (named C1, C2, …), sits above the video tracks. "Generate captions" (`captions.generate`) groups the timeline's transcript words (with corrections, ADR-032) into captions and puts one **caption clip** per caption on the first caption track, creating it if needed and replacing what was there (the button asks first when captions exist; Ctrl+Z undoes it). "Add caption" (`caption.add`) adds one at the playhead. After generation, captions no longer follow the transcript; generating again rebuilds them.
- **Caption clips are ordinary timeline items** with `assetId: 'captions'` and a `caption: { words }` field. Word times are in the clip's own source time (like media), so the existing move, trim, split, delete, ripple, copy/paste and undo commands work on captions unchanged, and a trimmed or split caption shows only its words. Captions cannot move to video/audio tracks (nor media to caption tracks), be linked, or be keyframed (yet); the export's missing-media check skips them.
- **Text.** `caption.edit` replaces a clip's text from the Inspector. With the same number of words each word keeps its timing (spelling fixes); otherwise the old words' time span is shared out by letter count.
- **Placement.** Each caption clip uses the item transform: `x`/`y` offset its centre from the sequence's caption position, `scale` multiplies the style size, `rotation` turns it (ASS `\pos`, `\fscx/\fscy`, `\frz`). Captions are selected and dragged, resized and rotated in the preview with the same transform box as video; their box is measured from the text with the bundled fonts loaded into the page. They are hit-tested above all pictures. The Captions tab's style settings still apply to all captions; per-caption style overrides can come later.
- **Rendering.** `sequenceCaptionsAss(seq)` compiles the caption clips of visible caption tracks (upper tracks on higher ASS layers); preview (JASSUB) and export (`ass` filter) both call it, as before. While a caption is dragged its draft transform is compiled, so the text follows the mouse. Golden-frame parity: 0.990 (Highlight) and 0.992 (Karaoke).
- **Fix in the same change:** clicking the empty area around the preview frame now deselects (a clip that fills the frame left nowhere to click off), and selecting a caption while the Captions tab is open switches to its Inspector.

---

## ADR-034 · Crop and the facecam + gameplay layout (manual reframing)

**Status.** Accepted (13 Nov 2026, Phase 5 first slice). Implements most of Phase 5a; automatic (face-tracked) reframing is the next slice.

**Context.** The common way to turn a landscape stream or gameplay clip into a Short is to stack the streamer's camera above the gameplay. The editor could scale and move clips but not crop them, so neither the camera nor a chosen part of the game could be isolated.

**Decisions.**
- **Crop is part of the transform**: `crop: {left, top, right, bottom}`, the share of the picture cut from each edge (at least 5% is kept each way; an empty crop is removed). It is static for now (not keyframed). `cropRect` turns it into whole, even source pixels, and `computeLayout` lays out only that part, so fill/fit, scale, position and rotation all apply to the cropped picture, and the selection box in the preview follows it. The GPU preview samples the kept part of the texture; the compatible preview uses CSS `object-view-box`; the export puts `crop=w:h:x:y:exact=1` before the scale (also on animated clips). Everyone uses the same rounded pixels.
- **Crop window.** "Crop…" (Inspector, or the clip's Framing menu) opens a window showing the clip's own frame at the playhead (the proxy, or the still) with the kept area marked. Drag inside to move it, corners (and edges when the shape is free) to resize. "Keep shape" (on by default) holds the proportions, so a clip keeps its size on screen and a layout panel stays filled. One Apply is one undoable edit.
- **Facecam + gameplay layout.** One action turns a video clip into two panels: the clip itself becomes the gameplay (bottom 65%, fit to width, cropped to that panel's shape from the middle of the picture) and a muted, linked copy on the nearest free video track above (or a new one) becomes the facecam (top 35%, cropped to its shape, starting in the top-left corner). The crop window then opens on the facecam so it can be dragged over the camera. Both panels move, trim, split and delete together because they are linked (an existing link with detached audio is kept). One undo step.
- **Shorts safe zones.** An optional overlay (preview right-click menu) shades where YouTube's Shorts player covers the frame: the top 8%, the bottom 20% (title, channel, music) and a column of buttons on the right. These are approximations of the current player and are labelled as such.
- **Tests.** Layout and limit unit tests; a real-FFmpeg test that a cropped corner fills the frame on static and keyframed clips; an end-to-end test of the layout, crop window (moving keeps the shape), undo and safe zones; and a golden-frame parity case for the layout (SSIM 0.995).

---

## ADR-035 · Automatic reframing with face detection

**Status.** Accepted (13 Nov 2026, Phase 5 second slice). Implements Phase 5b's tracking and smoothing; scene-cut detection, active-speaker choice and the reframing fixture set remain.

**Decisions.**
- **Detector: OpenCV's YuNet** (`FaceDetectorYN`, model MIT-licensed, 227 KB, shipped in `services/media-ai/recit_media_ai/models` with its licence; OpenCV is Apache-2.0). Chosen over MediaPipe because it needs no model download at run time, is a single small ONNX file, and runs fast on the CPU at analysis size, so it works on any machine. OpenCV is an optional sidecar extra (`reframe`, about 60 MB), installed from the Inspector like transcription (ADR-031); the install code is now shared (`services/extras.ts`), and installing waits for any running analysis because it restarts the helper.
- **Analysis** (`faces` job in the sidecar): FFmpeg decodes the media's preview copy at 5 frames a second, scaled to 480 px on the long edge, straight into the detector through a pipe (no temporary frames). Faces with confidence ≥ 0.6 are stored per sampled frame as fractions of the picture in the project file (`face_tracks`, migration 4), once per media file; every clip of that media reuses it. Cancellable with progress. `RECIT_FAKE_FACES=1` gives a deterministic moving face for tests.
- **Framing path** (`autoReframe` in `packages/core`, pure and unit-tested): the main face is the largest at first, then the one nearest to where it was (among faces at least 40% of the largest); gaps hold the last position; a five-sample median removes single-frame mistakes. A virtual camera then holds still while the face stays within a dead zone (12% of the visible width), pans at up to 0.6 visible widths per second when it leaves it (and keeps panning smoothly while the face keeps moving), and cuts — holding still first, then jumping on one frame — when the face has been far away (more than 55% of the visible width) for 0.6 s. The path respects the clip's crop, fill/fit and zoom, never shows past the picture's edges, and is simplified (Ramer–Douglas–Peucker, 0.4% of the frame width) into linear keyframes on Position X, with `hold` before cuts. A steady walk across the picture becomes about five keyframes.
- **Applying.** "Auto reframe" (Inspector, or the clip's Framing menu) analyses the media if needed and applies itself when the analysis finishes. It replaces the clip's X keyframes in one undoable batch; "Remove" clears them. Clips that show their full width (fit, or panels of the facecam layout) are refused with an explanation, as are clips with no faces.
- **Not yet:** scene cuts (the cut rule covers most hard cuts), picking the active speaker among several people, vertical movement and zoom, and measuring against labelled footage (Phase 5 exit criteria) on the reference PC.

---

## ADR-036 · Fades, opacity and colour effects

**Status.** Accepted (14 Nov 2026, Phase 6 first slice). Starts the effect model of Phase 6; transitions, blur, speed, LUTs, chroma key and audio effects follow.

**Context.** Phase 6 asks for an effect stack per clip whose every effect looks the same in the preview and the export. The most used ones in Shorts are fades, opacity and simple colour correction, and they set up the shape the later effects will use.

**Decisions.**
- **Model.** A timeline item gains `opacity` (0–1, absent = 1), `fade: {in, out}` (lengths in flicks) and `effects`, an ordered list. The first effect kind is `color` (brightness −1…1, contrast and saturation 0…3, with an `enabled` switch), the same parameters as FFmpeg's `eq` filter. Commands: `item.update` takes `opacity` and `fade`; `effect.add/update/remove/move` edit the stack (video tracks only, at most 16, values clamped). Fades are kept within the clip (the fade-out keeps its length first when they would overlap) and follow trims; a split keeps the fade-in on the left part and the fade-out on the right. Caption clips have no opacity or effects yet. Effect parameters are not keyframed yet.
- **One meaning, two renderers.** `pictureAt(item, time)` in `packages/core` gives a clip's alpha (opacity × fade, linear ramps) and its combined colour (stacked colour effects collapse into one `eq`: contrasts multiply, brightness carries through, saturations multiply). The export applies `eq` after the crop and scale, then `format=yuva420p`, `lutyuv=a=val*opacity` and `fade=…:alpha=1` in timeline time, so faded and transparent clips show the layers below (or black). Audio fades are `afade` (linear). The GPU preview draws each layer with alpha blending and a shader that converts to BT.709 TV-range codes and applies exactly the per-plane gain and offset FFmpeg's `eq` uses (`eqCodes`, which mirrors vf_eq's integer maths, including that 0.12 brightness adds 27 codes, not 30.6). Web Audio multiplies the gain curve by the fade, as for volume keyframes. The compatible preview approximates with CSS `opacity` and `filter`.
- **Editing.** The Inspector has a Colour section (add effects, switch each on/off to compare, remove, brightness/contrast/saturation sliders) and a Fades section (fade in, fade out, and opacity for pictures). Clips show fade ramps and small round handles at their top corners; dragging a handle sets the fade length in tenths of a second. Fades apply to a clip and its linked partners together, so picture and sound fade as one. Sliders keep showing a committed value until the document catches up, so arrow-key changes do not jump back.
- **Tests.** Unit tests for fades, splitting/trimming with fades, stacking and the `eq` integer maths (checked against FFmpeg 8.1 output); a real-FFmpeg export test (fade levels over time, sound fades, half opacity, zero saturation); an audio parity case with fades (r = 0.999, 0.1 dB); a golden-frame case with a faded, partly transparent, colour-graded clip over a still (SSIM 0.994 at three times, mean colour within 3 levels); and an end-to-end test of the Inspector and the fade handles.

---

## ADR-037 · Transitions: cross dissolve and dips

**Status.** Accepted (14 Nov 2026, Phase 6 second slice). Wipes, slides, zooms, dragging transitions from a browser, and frame holding when there is no extra footage come later.

**Decisions.**
- **Stored on the cut, applied when drawing.** A clip's `transitionIn: {kind, duration}` describes the transition from the clip that ends exactly where it starts on the same track. The timeline itself never changes: clips do not overlap in the document, so moving, trimming, splitting, ripple, captions and the transcript keep working as before. A transition whose clips stop touching is ignored (and comes back if they touch again). Splitting keeps it on the left piece only. `transition.set` / `transition.remove` (one undo step) also apply to linked partners that have a cut in the same place, so a video and its detached sound change together. Length: one frame to 5 s, and no longer than either clip. Video and audio tracks; not caption tracks yet.
- **`presentSequence(seq, mediaLength)`** in `packages/core` turns transitions into what is drawn and heard, and both the preview and the export call it, so they cannot disagree:
  - **Cross dissolve.** The window is centred on the cut and uses the footage after the first clip (A) and before the second (B). B starts earlier and fades in over A, its sound with it. A plays on past the cut underneath, opaque, while its sound fades out. When one side has too little footage, the other side gives more. When neither has any, nothing is shown, and the Inspector says to trim the clips. Stills always have enough.
  - **Dip to black / white.** A fades to the colour over the first half, and B fades from it over the second; the sound dips with it. Clips do not move.
  - The fades a transition replaces (A's fade-out, B's fade-in) are not applied on those sides. Sound-only fades (`audioFade`) and fades to a colour (`tint`) exist only on presented clips.
- **Rendering.**
  - Export: the existing alpha fade and `afade`, plus `fade` with a colour for dips. FFmpeg's `fade` treats pure black as code 0 on frames with alpha (darker than video black, 16), so black is passed as `0x000001`. This was found by the new golden-frame case.
  - GPU preview: the shader mixes towards the colour (the same linear mix in YUV codes).
  - Web Audio: `gainAt` is volume × fades × transition fades, the same as the export.
  - Compatible preview: CSS approximations.
  - Media lengths come from the same probe in both: `ExportAsset.durationSec` in the export, the asset's probe in the preview.
- **Editing.**
  - The clip menu has "Transition from previous clip ▸ Cross dissolve / Dip to black / Dip to white / None", with a default length of 0.5 s.
  - The Inspector has a Transition section: None, Dissolve, Black or White, a length slider, and a note when footage limits the dissolve.
  - The timeline draws each transition as a band across the cut, as long as the transition really is. Clicking the band selects the clip, and right-clicking opens its menu.
- **Tests.**
  - Unit tests: overlap, fades and gains summing to one; one-sided and impossible dissolves; dips; ignored when not touching; limits; split.
  - A real-FFmpeg test: half red/half blue mid-dissolve, white at the cut of a dip.
  - A golden-frame case with a dissolve and a dip to black at frame-exact times: SSIM 0.994–0.997, mean colour within 4 levels.
  - An end-to-end test of the menu, the Inspector, the timeline band and undo.

