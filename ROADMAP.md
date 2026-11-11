# Rec-It Development Roadmap

Version 0.2 · November 2026 · Approved direction: open source, Windows + NVIDIA first, fully working editor first, Claude through the user's own Claude app.

The roadmap is ordered so that each phase produces something that works and can be tested on its own, and so that the hardest technical risks (preview engine, preview/export parity) are tackled early, before AI features are built on top of them.

**Milestones**

| Milestone | After phase | What you can do |
|-----------|-------------|-----------------|
| M1 · Working editor | 3 | Import footage, edit on a multi-track timeline, preview, export a 1080×1920 MP4 |
| M2 · Shorts editor | 5 | Transcribe, add animated captions, reframe to 9:16 by hand or automatically |
| M3 · AI editor | 7 | Ask Claude (in your Claude app) to edit; get AI-ranked clip suggestions from long videos |
| M4 · Full product | 10 | YouTube research, rights tracking, batch Shorts, signed installers |

**Priority: the editor first.** Phases 0–5 deliver a complete, AI-free video editor (multi-track timeline, preview, export, captions, 9:16 reframing). No AI work starts until M2 is reached and you are happy with the editor. Transcription in Phase 4 is local Whisper, not Claude.

**Reference machine.** Your Windows PC with an NVIDIA RTX 3070 (8 GB). Performance targets are measured there. macOS keeps building in CI but is not tested by hand until later.

**Sizing.** Each phase has an indicative size for one developer working with AI assistance: S ≈ 1–2 weeks, M ≈ 2–4 weeks, L ≈ 4–6 weeks. Total is roughly 8–12 months part-time or 5–7 months full-time. These are planning estimates, not commitments; Phase 2 carries the most uncertainty.

**Gate rule.** A phase is done when every exit criterion is met and its tests pass in CI on Windows and macOS. Each phase ends with a short review with you before the next starts.

---

## Phase 0 · Foundations (M)

**Goal:** a secure, empty Electron app with the full process model, build system and CI in place.

**Deliverables**
- pnpm monorepo with every package from ARCHITECTURE §4 created (mostly empty), TypeScript strict, ESLint, Prettier.
- Electron app: main, preload, backend `utilityProcess`, renderer, with the MessagePort channel between renderer and backend.
- `packages/ipc-contract` with typed channels and zod validation; one working example (`app.ping`).
- `packages/db`: app database, migration runner, settings repository.
- `safeStorage` secrets service (used later for the YouTube key); settings screen skeleton.
- `packages/ui`: design tokens, dark theme, the empty editor layout (resizable panels).
- `scripts/fetch-ffmpeg` downloads verified GPL FFmpeg/FFprobe builds (libx264, NVENC, libass) per platform; startup check shows the version and available hardware encoders (NVENC expected on the reference PC).
- Python sidecar skeleton with JSON-RPC `ping`, `version` and a CUDA check, managed by uv.
- Public GitHub repository, GPL-3.0 licence, contribution guide, issue templates.
- GitHub Actions: lint, typecheck, unit tests, pytest, Playwright smoke test on Windows and macOS.

**Exit criteria**
- `pnpm dev` launches the app with the dark editor layout.
- Electron security settings pass the checklist (sandbox, contextIsolation, CSP, no nodeIntegration, navigation blocked).
- A test secret saved, app restarted, secret still available in the backend and never present in the renderer.
- Startup check reports NVENC and CUDA available on the reference PC.
- CI green on both platforms.

**Testing**
- Unit: IPC contract round-trip and rejection of invalid payloads; migration runner.
- E2E: app launches, layout renders, settings saves a key.
- Security: automated scan (`electronegativity`) plus manual checklist.

---

## Phase 1 · Media pipeline (M)

**Goal:** import real footage and prepare everything the editor needs.

**Deliverables**
- Project create/open/save (`.recit` SQLite file), recent projects, autosave journal, crash recovery.
- Import by dialog and drag-and-drop; rights prompt (source category) on import.
- Probe, content hash, proxy generation, thumbnail sprite, waveform peaks, all as jobs.
- JobQueue with progress, cancellation, retries, concurrency limits; jobs panel in the UI.
- `recit-media://` protocol with range requests and allow-list.
- Media bin: grid/list view, metadata, job status, rights badge, missing-media relink.

**Exit criteria**
- Importing a 1-hour 4K HEVC iPhone video, a VFR Android clip and a ProRes clip all produce working proxies.
- Cancelling a proxy job stops FFmpeg within 1 second and leaves no partial files.
- Killing the app mid-edit and reopening loses at most 1 second of work.

**Testing**
- Integration with real FFmpeg on a fixture set (HEVC, H.264, VFR, rotated, audio-only, image, corrupt file).
- Proxy validation with ffprobe: constant frame rate, expected keyframe interval, duration within one frame of source.
- Protocol tests: path traversal attempts are rejected.
- Crash-recovery test: kill the backend process during writes, reopen, verify the document.

---

## Phase 2 · Timeline and preview engine (L, highest risk)

**Goal:** a real multi-track editor with accurate playback.

**Deliverables**
- `packages/core`: full data model (ARCHITECTURE §6), flicks time maths, commands, invariants.
- CommandBus with Immer patches, transactions, undo/redo, document versioning.
- Canvas timeline: tracks, clips with filmstrips and waveforms, ruler, playhead, zoom, snapping, selection, multi-select.
- Editing: add, move, trim (normal and ripple), split, delete, ripple delete, link/unlink audio, track lock/hide/mute.
- `packages/render-plan`: Sequence → RenderPlan.
- Preview engine, in two steps behind one interface:
  - 2a: single-layer preview using WebCodecs on proxies, with Web Audio master clock.
  - 2b: full WebGL2 compositor with multiple layers, transforms, opacity, keyframes and audio mixing.
- Inspector panel for clip properties and keyframes.
- Keyboard shortcuts (J/K/L, I/O, S, Q/W, undo/redo).

**Exit criteria**
- Three video layers + two audio tracks of 1080p proxies play at the sequence frame rate on the reference PC (RTX 3070) with no audio dropouts.
- Audio/video sync stays within one frame over a 10-minute playback.
- Scrubbing shows the right frame within 150 ms.
- A timeline with 1,000 items scrolls and zooms at 60 fps.

**Testing**
- Property tests: 10,000 random command sequences never break invariants; undo all returns the original document exactly.
- Unit: flicks conversions at every supported frame rate; RenderPlan snapshots.
- Frame accuracy: a fixture video with burned-in frame numbers; the preview at time *t* must show frame *n* exactly.
- Performance benchmarks in CI (recorded, alert on regression).
- Memory: 30-minute scripted playback/scrub session with no growth in VideoFrame count or GPU memory.

---

## Phase 3 · Export (M) → **Milestone M1**

**Goal:** export what you see.

**Deliverables**
- `packages/ffmpeg`: argument builder, filter-graph escaping, progress parser, encoder detection.
- RenderPlan → FFmpeg `filter_complex` compiler (cuts, speed, transforms, overlays, fades, audio mix).
- Two-pass loudness normalisation to −14 LUFS.
- Export presets (ARCHITECTURE §10.3), export dialog, progress, cancel, reveal in folder.
- Encoder selection: NVENC by default, libx264 fallback and "best quality" preset.

**Exit criteria**
- Exported MP4 plays in QuickTime, Windows Media Player, VLC and uploads to YouTube as a Short.
- Golden-frame SSIM between preview and export ≥ 0.98 on all fixture sequences.
- Output duration matches the timeline within one frame; integrated loudness within ±1 LU of target.

**Testing**
- Snapshot tests of generated FFmpeg arguments.
- Integration: export each fixture sequence, then verify with ffprobe (resolution, fps, duration, codecs) and `ebur128` (loudness).
- Golden-frame parity suite (new in this phase, kept for all later phases).
- Manual: test upload of one Short to a private YouTube channel.

---

## Phase 4 · Transcription and captions (M)

**Goal:** accurate word-timed transcripts and animated captions.

**Deliverables**
- Python sidecar: faster-whisper (`large-v3-turbo`, float16 on CUDA) with word timestamps and VAD; model download manager with checksums; GPU/CPU detection; CPU fallback with `small`.
- Transcript panel: read along, click a word to seek, search, edit text.
- Text-based editing: select words in the transcript to delete those ranges from the timeline.
- `packages/captions`: segmenter and ASS compiler; 8–10 built-in styles (karaoke highlight, pop, word-by-word, boxed, etc.).
- Caption track, caption editor, style editor; JASSUB in preview, `ass` filter in export; bundled fonts.

**Exit criteria**
- Word error rate ≤ 10% on the clean-speech fixture set with the default GPU model (reported, not just pass/fail, for CPU models).
- Caption word highlights stay within ±50 ms of the spoken word on the fixtures.
- Caption appearance in preview and export matches (golden-frame SSIM ≥ 0.98 on caption frames).

**Testing**
- pytest: WER on fixture audio; timestamp accuracy against hand-labelled words.
- Unit: segmenter (line breaks, punctuation, word limits); ASS output snapshots per style.
- Parity: caption golden frames for every built-in style.
- E2E: transcribe → generate captions → change style → export.

---

## Phase 5 · Vertical reframing (M) → **Milestone M2**

**Goal:** reliable 9:16 conversion.

**Deliverables**
- 5a Manual: crop window overlay in preview, keyframes, safe-area guides for the Shorts UI.
- 5b Automatic: face detection, active-speaker heuristic, smoothing, scene-aware cuts, editable result.
- Fallback layouts: blurred-background fit, two-speaker split.
- "Convert to vertical" command that creates a 1080×1920 sequence from a landscape one.

**Exit criteria**
- On the reframing fixture set (single speaker, two-person interview, moving subject, no faces), the main subject stays in frame for ≥ 95% of frames on single-speaker clips, with results reviewed by you on the harder clips.
- No visible jitter (path acceleration below threshold) on static-camera shots.

**Testing**
- pytest: tracking on fixtures with labelled subject boxes (in-frame percentage, jitter metric).
- Unit: smoothing filter, sendcmd generation snapshots.
- Parity: crop path matches between preview and export.
- Manual review session on real footage you provide.

---

## Phase 6 · Claude connection (M)

**Goal:** Claude can read and edit the project from your Claude app, using your existing plan.

**Deliverables**
- 6a · MCP connector (main deliverable):
  - `packages/tools`: tool definitions (zod), project summariser, tool instructions; read tools, then edit tools, then confirm-in-Rec-It tools (ARCHITECTURE §13.3).
  - Local tool endpoint in the backend: named pipe (Windows) / Unix socket (macOS), per-launch token, AI on/off switch.
  - `recit-mcp` bridge (stdio MCP server), packaged as a Claude desktop extension (`.mcpb`) for one-click install; also works with `claude mcp add` for Claude Code.
  - MCP prompts: "Find the best Shorts", "Remove silences and filler words", "Caption this", "Convert to vertical".
  - In Rec-It: Claude activity feed, change cards (Undo all / Keep), confirmation cards for heavy tools, connection status, first-connection privacy notice.
  - AI edit transactions and document-version conflict handling.
- 6b · Optional in-app chat panel using the Claude Agent SDK, built only if Anthropic's rules for third-party Agent SDK apps are clear at that point (ADR-018). Can be skipped without affecting anything else.

**Exit criteria**
- From the Claude desktop app, "remove the silences from the first two minutes" works end to end on your PC and is undone with one click in Rec-It.
- Eval suite (≥ 40 scenarios) passes at ≥ 90% when run live through Claude Code with the connector; 100% of runs leave the document valid.
- No heavy or external tool runs without a click in Rec-It, including when transcripts contain injected instructions.
- With Rec-It closed, every tool returns a clear "Rec-It is not open" message.

**Testing**
- Unit: each tool's schema validation and result formatting.
- Tool contract tests through a real MCP client against the bridge.
- Recorded tool-call scripts in CI (deterministic); live evals through Claude Code before releases.
- Red-team fixtures: transcripts and video descriptions telling Claude to export, delete or import.
- Endpoint security: connections without the token, from another user, or with AI switched off are refused.

---

## Phase 7 · AI analysis and clip selection (M) → **Milestone M3**

**Goal:** find the best Shorts in long videos.

**Deliverables**
- Signal extraction in Python: scene cuts, loudness, silence map, speech rate, faces, motion energy.
- Deterministic candidate generator; frame sampler.
- Local signal-based ranking that works with no AI; Claude scoring through `get_candidate_bundle` and `submit_candidate_scores`.
- Highlights panel: ranked candidates with preview, reasons, scores, accept/reject.
- `build_short_from_candidate`: sequence with cuts, reframe and captions applied.

**Exit criteria**
- On a set of 5 long fixture videos where you have marked the moments you would choose, at least 60% of your picks appear in Rec-It's top 10 per video (a practical benchmark that we will refine with you).
- Highlights panel produces a ranked list with AI switched off; Claude scoring of a 1-hour video completes in one conversation without hitting tool-size limits.
- Candidate boundaries never cut a word in half.

**Testing**
- pytest: each signal on labelled fixtures.
- Unit: candidate generator boundaries, dedupe, word snapping.
- Eval: the recall benchmark above, tracked over time as prompts change.
- Payload tests: candidate bundles stay under a set size (frames downscaled, transcript excerpts trimmed).

---

## Phase 8 · YouTube research and rights-aware importing (M)

**Goal:** research what works and keep track of usage rights.

**Deliverables**
- `packages/youtube`: client, quota ledger, cache with expiry, error handling for `quotaExceeded`.
- Research panel: topic search with filters, results with views, view velocity and duration, channel lookups, saved searches.
- Claude research tools (via the connector) and a "trend brief" prompt summarising patterns in a niche.
- Setup guide for creating a free YouTube API key; key stored with `safeStorage`.
- Rights ledger UI, CC-BY attribution generation, pre-export rights check, project rights report.
- Re-check of the YouTube API Services policies (data storage, display rules) and of current quota costs.

**Exit criteria**
- Quota ledger matches Google Cloud console usage exactly over a test day.
- No API data older than the cache limit is shown.
- Export of a project with an `unknown`-rights asset always shows the rights check.

**Testing**
- Unit with recorded API responses: parsing, pagination, quota accounting, cache expiry.
- Contract test against the live API (small, quota-cheap) before release.
- E2E: search → ask Claude for a trend brief → import a local file with CC-BY rights → export → attribution in manifest.

---

## Phase 9 · Batch Shorts (M)

**Goal:** turn one long video into many finished Shorts.

**Deliverables**
- ShortsTemplate model and editor (style, reframe, intro/outro, music bed with ducking, title card, length range).
- Batch build from accepted candidates; review grid with hover preview; open-in-editor.
- Batch export queue with pause, resume, cancel, retry; export manifest (CSV/JSON) with titles, descriptions, attribution, hashtags.

**Exit criteria**
- 20 Shorts built and exported from one 1-hour source without manual steps beyond accepting candidates.
- A failure in one item does not stop the batch; retry works.
- Batch export of 20 × 45 s Shorts finishes within a target time on the reference PC (to be set after Phase 3 measurements).

**Testing**
- Integration: batch of fixture candidates through to verified MP4s.
- Fault injection: kill FFmpeg mid-item, fill the disk, remove a source file.
- E2E: full long-video-to-20-Shorts flow.

---

## Phase 10 · Hardening and release (M) → **Milestone M4**

**Goal:** an installable, signed, updatable application.

**Deliverables**
- electron-builder packaging for Windows (NSIS) first, with bundled GPL FFmpeg and standalone Python with CUDA libraries; macOS (DMG) when you decide to support it.
- Release on GitHub Releases with the GPL source offer and licence notices.
- Windows code signing (apply to a free open-source signing programme; unsigned builds as fallback); auto-update from GitHub Releases.
- Opt-in crash reporting and diagnostics export (no media, no keys).
- First-run onboarding: model download, "connect Claude" (install the desktop extension), optional YouTube key, privacy notice.
- Performance pass, accessibility pass, licence notices for all bundled components.

**Exit criteria**
- Clean install, update and uninstall on fresh Windows 11 and macOS machines.
- No SmartScreen blocking for signed builds (or a documented workaround if signing is not yet approved).
- All earlier phase suites green on the packaged app.

**Testing**
- Packaged-app E2E suite in CI.
- Update test: install version N, publish N+1, verify the update and that projects still open.
- Licence audit of bundled binaries (FFmpeg build configuration, Python packages, fonts).

---

## After the first release (candidates)

- Direct upload to YouTube with OAuth (`videos.insert`), scheduled publishing.
- Own-channel analytics to learn which Shorts perform best and feed that back into scoring.
- Overlay-frames render path for effects libass cannot do (colour emoji, glows).
- B-roll and stock footage search from licensed providers.
- AI voice-over and music generation through licensed services.
- Linux build.
