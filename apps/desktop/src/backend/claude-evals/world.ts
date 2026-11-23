// An in-memory Rec-It for Claude's tool scenarios (ADR-045): the real tool runner, the real
// ClaudeService (change cards, confirmations, activity) and the real core history, with synthetic
// media, transcripts and loudness instead of files. Used by the recorded scripts in CI and by the
// live evals through Claude Code.
import {
  FLICKS_PER_SECOND,
  History,
  emptyDocument,
  secondsToFlicks,
  type AssetLookup,
  type Command,
  type ProjectDocument,
  type Sequence,
  type TranscriptWord,
} from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import type { ToolResult } from '@rec-it/tools/protocol';
import { ClaudeService } from '../services/claude-service';

export interface FakeMedia {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** Seconds (ignored for images). */
  length: number;
  width?: number;
  height?: number;
  /** Has a sound stream (default: true for video and audio). */
  audio?: boolean;
  /** Spoken words; see `speech()`. Makes the media count as transcribed. */
  words?: TranscriptWord[];
  /** Loudness 0–255 per 10 ms; default: loud during `words`, quiet elsewhere. */
  loudness?: Uint8Array;
  /** Music-like: steady loudness all the way through. */
  music?: boolean;
}

export interface WorldFixture {
  media: FakeMedia[];
  luts?: { id: string; name: string }[];
  /** Edits made by "the user" before Claude starts (not part of any change card). */
  setup?: (w: World) => void;
  /** What the user answers to confirmations (default: decline). */
  confirm?: 'allow' | 'decline';
}

/**
 * Words from a script: words are 0.3 s with 0.1 s gaps; `[1.5]` adds a 1.5 s pause; `@12` jumps
 * to 12 s. Returns words in media seconds.
 */
export function speech(script: string, start = 0.5): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  let t = start;
  for (const token of script.split(/\s+/).filter(Boolean)) {
    const pause = /^\[(\d+(?:\.\d+)?)\]$/.exec(token);
    if (pause) {
      t += Number(pause[1]);
      continue;
    }
    const jump = /^@(\d+(?:\.\d+)?)$/.exec(token);
    if (jump) {
      t = Number(jump[1]);
      continue;
    }
    words.push({ text: token, start: round(t), end: round(t + 0.3) });
    t += 0.4;
  }
  return words;
}

const round = (s: number) => Math.round(s * 1000) / 1000;

function loudnessOf(m: FakeMedia): Uint8Array {
  if (m.loudness) return m.loudness;
  const n = Math.ceil(m.length * 100);
  const out = new Uint8Array(n).fill(m.music ? 150 : 4);
  for (const w of m.words ?? []) out.fill(200, Math.floor(w.start * 100), Math.ceil(w.end * 100));
  return out;
}

function asset(m: FakeMedia): MediaAsset {
  const audio = m.audio ?? m.kind !== 'image';
  const video = m.kind !== 'audio';
  return {
    id: m.id,
    name: m.name,
    kind: m.kind,
    originalPath: `/media/${m.name}`,
    sizeBytes: 1,
    importedAt: '2026-11-01T00:00:00.000Z',
    status: 'ready',
    missing: false,
    probe: {
      kind: m.kind,
      container: 'mov,mp4',
      durationSec: m.kind === 'image' ? 0 : m.length,
      durationFlicks: m.kind === 'image' ? 0 : secondsToFlicks(m.length),
      audioStreamCount: audio ? 1 : 0,
      ...(video
        ? {
            video: {
              codec: 'h264',
              width: m.width ?? 1920,
              height: m.height ?? 1080,
              displayWidth: m.width ?? 1920,
              displayHeight: m.height ?? 1080,
              rotation: 0 as const,
              fps: { num: 30, den: 1 },
              avgFps: { num: 30, den: 1 },
              isVfr: false,
              pixFmt: 'yuv420p',
              bitDepth: 8,
              hdr: false,
            },
          }
        : {}),
      ...(audio ? { audio: { codec: 'aac', sampleRate: 48000, channels: 2 } } : {}),
    },
    rights: { source: 'own-recording', userAttested: true },
    jobs: {
      probe: { state: 'done', progress: 1 },
      proxy: { state: 'done', progress: 1 },
      thumbnails: { state: 'done', progress: 1 },
      waveform: { state: audio ? 'done' : 'skipped', progress: 1 },
    },
    urls: {},
  };
}

export interface Started {
  tool: 'export' | 'transcription';
  detail: string;
}

export class World {
  readonly history = new History(emptyDocument());
  readonly service: ClaudeService;
  readonly media: FakeMedia[];
  readonly started: Started[] = [];
  /** Every confirmation Claude asked for, with the answer given. */
  readonly confirmations: { tool: string; detail: string; allowed: boolean }[] = [];
  /** Every tool call Claude made, in order. */
  readonly calls: { name: string; args: unknown; result: ToolResult }[] = [];
  readonly assets: AssetLookup;
  private now = 1_000_000;

  constructor(
    readonly fixture: WorldFixture,
    userDataDir = '/nowhere',
  ) {
    this.media = fixture.media;
    const byId = new Map(this.media.map((m) => [m.id, m]));
    this.assets = (id) => {
      const m = byId.get(id);
      if (!m) return undefined;
      return {
        kind: m.kind,
        duration: m.kind === 'image' ? null : secondsToFlicks(m.length),
        hasAudio: m.audio ?? m.kind !== 'image',
        width: m.kind === 'audio' ? undefined : (m.width ?? 1920),
        height: m.kind === 'audio' ? undefined : (m.height ?? 1080),
      };
    };
    const assets = this.media.map(asset);
    this.service = new ClaudeService({
      userDataDir,
      appVersion: 'eval',
      enabled: () => true,
      now: () => this.now,
      tools: () => ({
        projectName: () => 'Eval project',
        doc: () => ({ doc: this.history.doc, version: this.history.version }),
        media: () => assets,
        transcript: (id) => byId.get(id)?.words,
        transcribed: () => new Set(this.media.filter((m) => m.words).map((m) => m.id)),
        transcriptionAvailable: () => true,
        jobs: () => this.started.map((s) => `${s.tool}: running (${s.detail})`),
        frame: () => Promise.resolve(TINY_JPEG),
        startTranscription: (id) => this.started.push({ tool: 'transcription', detail: id }),
        exportRunning: () => this.started.some((s) => s.tool === 'export'),
        exportPath: (name) => `/exports/${name}.mp4`,
        startExport: (_seq, path) => this.started.push({ tool: 'export', detail: path }),
        luts: () => fixture.luts ?? [],
        loudness: (id) => Promise.resolve(byId.has(id) ? loudnessOf(byId.get(id)!) : undefined),
      }),
      execute: (command, group) => {
        const before = this.history.version;
        this.history.execute(command, this.assets, group);
        return { version: this.history.version, changed: this.history.version !== before };
      },
      topGroup: () => this.history.topGroup,
      undoGroup: (group) => {
        if (this.history.topGroup !== group) throw new Error('Other edits were made since.');
        this.history.undo();
      },
      setup: { bridgePath: null, bridgeExists: false, bundlePath: null },
      onChange: (state) => {
        // Answer confirmations the way the fixture's user would.
        for (const c of state.confirmations) {
          if (this.confirmations.some((k) => k.detail === `${c.id}:${c.detail}`)) continue;
          const allowed = fixture.confirm === 'allow';
          this.confirmations.push({ tool: c.tool, detail: `${c.id}:${c.detail}`, allowed });
          queueMicrotask(() => this.service.respond(c.id, allowed));
        }
      },
    });
    fixture.setup?.(this);
  }

  get doc(): ProjectDocument {
    return this.history.doc;
  }

  get seq(): Sequence | undefined {
    return this.doc.sequences.find((s) => s.id === this.doc.activeSequenceId);
  }

  /** An edit by the user (outside Claude's change cards). */
  userEdit(command: Command): void {
    this.history.execute(command, this.assets);
  }

  /** Claude calls a tool (through the same path as the local endpoint). */
  async call(name: string, args: unknown = {}): Promise<ToolResult> {
    const result = await this.service.call(name, args);
    this.calls.push({ name, args, result });
    this.now += 1000;
    return result;
  }

  /** Records a call made by a live Claude session (the endpoint path calls service.call). */
  observe(): void {
    const call = this.service.call.bind(this.service);
    this.service.call = async (name, args) => {
      const result = await call(name, args);
      this.calls.push({ name, args, result });
      return result;
    };
  }
}

/** Helpers for fixtures: a sequence with clips at known ids. */
export function shortWith(
  w: World,
  clips: {
    id: string;
    assetId: string;
    start?: number;
    sourceIn?: number;
    duration?: number;
    track?: string;
  }[],
  size: [number, number] = [1080, 1920],
): void {
  w.userEdit({
    type: 'sequence.create',
    id: 'seq1',
    name: 'Short 1',
    width: size[0],
    height: size[1],
    fps: { num: 30, den: 1 },
  });
  const seq = w.seq!;
  let cursor = 0;
  for (const c of clips) {
    const kind = w.assets(c.assetId)?.kind === 'audio' ? 'audio' : 'video';
    const track = seq.tracks.find((t) =>
      c.track ? t.name === c.track : t.name === (kind === 'audio' ? 'A2' : 'V1'),
    )!;
    const start = c.start ?? cursor;
    w.userEdit({
      type: 'item.add',
      sequenceId: seq.id,
      trackId: track.id,
      assetId: c.assetId,
      id: c.id,
      start: secondsToFlicks(start),
      ...(c.sourceIn !== undefined ? { sourceIn: secondsToFlicks(c.sourceIn) } : {}),
      ...(c.duration !== undefined ? { duration: secondsToFlicks(c.duration) } : {}),
    });
    const item = w.seq!.tracks.flatMap((t) => t.items).find((i) => i.id === c.id)!;
    if (kind === 'video') cursor = (item.start + item.duration) / FLICKS_PER_SECOND;
  }
}

// A 1×1 JPEG, enough for get_frame in scenarios.
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=';
