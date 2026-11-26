import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  DEFAULT_EXPORT_SETTINGS,
  SECRET_NAMES,
  backendContract,
  createIpcServer,
  portTransport,
  settingsSchema,
  type BackendContract,
  type EventChannel,
  type EventPayload,
  type ExportSettings,
  type FfmpegStatus,
  type Handlers,
  type IpcServer,
  type PortLike,
  type SecretName,
  type Settings,
  type SidecarStatus,
  type SystemStatus,
} from '@rec-it/ipc-contract';
import { RecentProjects, SettingsRepository, openAppDatabase, type AppDatabase } from '@rec-it/db';
import {
  detectFfmpeg,
  killOrphanedFfmpeg,
  resolveFfmpegBinaries,
  setFfmpegTracker,
  writePidFile,
  type FfmpegBinaries,
  type H264Encoder,
} from '@rec-it/ffmpeg';
import type { BackendConfig } from '../shared/backend-messages';
import type { Toolchain } from './services/media-service';
import { ExportService, type CaptionsInput, type ExportToolchain } from './services/export-service';
import { sequenceCaptionsAss } from '@rec-it/captions';
import { TranscriptService } from './services/transcript-service';
import { FaceService } from './services/face-service';
import { AiService } from './services/ai-service';
import { VoiceService } from './services/voice-service';
import { LowPolyService } from './services/lowpoly-service';
import { TemplateService } from './services/template-service';
import { ImageService } from './services/image-service';
import { AnimationService } from './services/animation-service';
import { importLut, writeLutFiles } from './services/lut-service';
import { ProjectService } from './services/project-service';
import type { Command, ProjectDocument, Sequence } from '@rec-it/core';
import { ClaudeService } from './services/claude-service';
import type { ToolContext } from './services/claude-tools';
import { SidecarClient, checkSidecar } from './services/sidecar';

const BACKEND_VERSION = '0.1.0';

export interface BackendHooks {
  onCacheRoot?: (path: string) => void;
}

/** Picks the proxy encoder: NVENC when it really works, then libx264, then other hardware. */
export function chooseEncoder(status: FfmpegStatus): H264Encoder | null {
  if (status.nvencUsable) return 'h264_nvenc';
  const order: H264Encoder[] = ['libx264', 'h264_videotoolbox', 'h264_qsv', 'h264_amf'];
  return order.find((e) => status.encoders[e]) ?? null;
}

/** All backend state and services. One instance per backend process. */
export class BackendApp {
  readonly startedAt = Date.now();
  private readonly db: AppDatabase;
  private readonly settings: SettingsRepository<Settings>;
  private readonly sidecar: SidecarClient | null;
  private readonly servers = new Set<IpcServer<BackendContract>>();
  readonly projects: ProjectService;
  readonly exports: ExportService;
  readonly transcripts: TranscriptService;
  readonly faces: FaceService;
  readonly ai: AiService;
  readonly voice: VoiceService;
  readonly templates: TemplateService;
  readonly lowPoly: LowPolyService;
  readonly images: ImageService;
  readonly animation: AnimationService;
  readonly claude: ClaudeService;
  private lastProjectId: string | undefined;
  private secrets: Partial<Record<SecretName, string>> = {};
  private ffmpeg: FfmpegStatus = {
    state: 'checking',
    encoders: {},
    hwaccels: [],
    nvencUsable: null,
    hasLibass: false,
    hasZimg: false,
  };
  private ffmpegBins: FfmpegBinaries;
  private sidecarStatus: SidecarStatus = { state: 'checking', gpus: [] };
  private refreshing: Promise<SystemStatus> | null = null;
  private resolveFfmpegDetected!: () => void;
  private readonly ffmpegDetected = new Promise<void>((r) => (this.resolveFfmpegDetected = r));

  constructor(
    private readonly config: BackendConfig,
    private readonly hooks: BackendHooks = {},
  ) {
    mkdirSync(config.userDataDir, { recursive: true });
    this.db = openAppDatabase(join(config.userDataDir, 'app.db'));
    this.settings = new SettingsRepository(this.db.db, (raw) => settingsSchema.parse(raw));
    this.sidecar = config.sidecar
      ? new SidecarClient(config.sidecar, (l) => console.info(`[sidecar] ${l}`))
      : null;
    this.ffmpegBins = resolveFfmpegBinaries({
      envPath: config.ffmpeg.envPath,
      bundledDir: config.ffmpeg.bundledDir,
    });
    this.projects = new ProjectService({
      recent: new RecentProjects(this.db.db),
      defaultDirectory: config.projectsDir,
      cacheRoot: () => this.cacheRoot(),
      toolchain: () => this.toolchain(),
      onProjectChanged: (p) => {
        this.emit('project.changed', p);
        // Transcription jobs belong to the open project; a different project starts afresh.
        if (p?.id !== this.lastProjectId) {
          this.lastProjectId = p?.id;
          this.transcripts?.reset();
          this.faces?.reset();
          this.templates?.reset();
          this.claude?.projectChanged();
        }
      },
      onAssetsChanged: (a) => this.emit('media.changed', a),
      onJobsChanged: (j) => this.emit('jobs.changed', j),
      onDocumentChanged: (d) => {
        this.emit('doc.changed', d);
        this.claude?.documentChanged();
      },
    });
    this.exports = new ExportService((state) => this.emit('export.changed', state));
    this.transcripts = new TranscriptService({
      projects: this.projects,
      sidecar: this.sidecar,
      sidecarCommand: config.sidecar,
      ffmpeg: async () => (await this.toolchain()).bins.ffmpeg,
      device: () => this.settings.getAll().transcriptionDevice,
      modelsDir: join(config.userDataDir, 'models'),
      onChange: (status) => this.emit('transcript.changed', status),
      busyElsewhere: () => this.faces.busy() || this.voice.busy(),
      onEngineChanged: () => {
        void this.faces.refresh();
        void this.voice.refresh();
      },
    });
    this.faces = new FaceService({
      projects: this.projects,
      sidecar: this.sidecar,
      sidecarCommand: config.sidecar,
      ffmpeg: async () => (await this.toolchain()).bins.ffmpeg,
      onChange: (status) => this.emit('faces.changed', status),
      busyElsewhere: () => this.transcripts.busy() || this.voice.busy(),
      onEngineChanged: () => {
        void this.transcripts.refresh();
        void this.voice.refresh();
      },
    });
    this.ai = new AiService({
      settings: () => this.settings.getAll(),
      apiKey: () => this.secrets.aiApiKey,
    });
    this.voice = new VoiceService({
      sidecar: this.sidecar,
      sidecarCommand: config.sidecar,
      modelsDir: join(config.userDataDir, 'models'),
      fontsDir: config.fontsDir,
      onChange: (status) => this.emit('voice.changed', status),
      voicesDir: join(config.userDataDir, 'voices'),
      ffmpeg: async () => (await this.toolchain()).bins.ffmpeg,
      onHumanChange: (status) => this.emit('voicehq.changed', status),
      onSamplesChange: (samples) => this.emit('voices.changed', samples),
      busyElsewhere: () => this.transcripts.busy() || this.faces.busy(),
      onEngineChanged: () => {
        void this.transcripts.refresh();
        void this.faces.refresh();
      },
    });
    this.images = new ImageService({
      sidecar: this.sidecar,
      modelsDir: join(config.userDataDir, 'models'),
      onChange: (status) => this.emit('images.changed', status),
    });
    this.animation = new AnimationService({
      sidecar: this.sidecar,
      modelsDir: join(config.userDataDir, 'models'),
      ffmpeg: async () => (await this.toolchain()).bins.ffmpeg,
      onChange: (status) => this.emit('animation.changed', status),
    });
    this.lowPoly = new LowPolyService({
      ffmpeg: async () => (await this.toolchain()).bins.ffmpeg,
      emit: (request, spec) => this.emit('lowpoly.render', { request, spec }),
    });
    this.templates = new TemplateService({
      projects: this.projects,
      voice: this.voice,
      images: this.images,
      animation: this.animation,
      planScenes: (title, sentences, count) => this.ai.planScenes(title, sentences, count),
      releaseGpu: () => this.ai.releaseGpu(),
      planEpisode: (brief, seconds, extra) => this.ai.planEpisode(brief, seconds, extra),
      lowPoly: this.lowPoly,
      lowPolyScript: (topic, seconds) => this.ai.lowPolyScript(topic, seconds),
      lowPolyBoard: (title, beats, cast) => this.ai.lowPolyBoard(title, beats, cast),
      lowPolyModels: (names) => this.ai.lowPolyModels(names),
      onTranscript: () => this.transcripts.changed(),
      onChange: (jobs) => this.emit('templates.changed', jobs),
    });
    this.claude = new ClaudeService({
      userDataDir: config.userDataDir,
      appVersion: config.appVersion,
      enabled: () => this.settings.getAll().aiEnabled,
      tools: () => this.claudeTools(),
      execute: (command, group) => {
        const doc = this.projects.document();
        const before = doc.state().version;
        const { version } = doc.execute(command, group);
        return { version, changed: version !== before };
      },
      topGroup: () => (this.projects.info() ? this.projects.document().topGroup : undefined),
      undoGroup: (group) => void this.projects.document().undoGroup(group),
      setup: {
        bridgePath: config.mcpBridge ?? null,
        bridgeExists: !!config.mcpBridge && existsSync(config.mcpBridge),
        bundlePath: config.mcpBundle && existsSync(config.mcpBundle) ? config.mcpBundle : null,
      },
      onChange: (state) => this.emit('claude.changed', state),
    });
    hooks.onCacheRoot?.(this.cacheRoot());
  }

  /** Runs start-up checks, then reopens the last project if enabled. */
  async start(): Promise<void> {
    // End FFmpeg processes orphaned by a previous crash, then track ours (ADR-024).
    const pidFile = join(this.config.userDataDir, 'ffmpeg-pids.json');
    const killed = await killOrphanedFfmpeg(pidFile);
    if (killed.length)
      console.warn(`ended ${killed.length} FFmpeg process(es) left by a previous crash`);
    setFfmpegTracker((pids) => writePidFile(pidFile, pids));
    void this.refresh();
    await this.claude.listen();
    if (this.settings.getAll().reopenLastProject) await this.projects.reopenLast();
  }

  readonly handlers: Handlers<BackendContract> = {
    'app.ping': ({ sentAt }) => ({
      sentAt,
      receivedAt: Date.now(),
      backendVersion: BACKEND_VERSION,
    }),
    'system.getStatus': () => this.status(),
    'system.refresh': () => this.refresh(),
    'settings.get': () => this.settings.getAll(),
    'settings.update': (patch) => {
      const next = this.settings.update(patch as Partial<Settings>);
      if ('cacheDirectory' in patch) this.hooks.onCacheRoot?.(this.cacheRoot());
      this.emit('settings.changed', next);
      if ('aiEnabled' in patch) this.claude.changed();
      return next;
    },

    'project.current': () => this.projects.info(),
    'project.create': ({ name, directory }) => this.projects.create(name, directory),
    'project.open': ({ path }) => this.projects.open(path),
    'project.close': async () => {
      await this.projects.close();
      return { ok: true as const };
    },
    'project.saveAs': ({ path }) => this.projects.saveAs(path),
    'project.rename': ({ name }) => this.projects.rename(name),
    'project.recent': () => new RecentProjects(this.db.db).list(),
    'project.forgetRecent': ({ path }) => {
      new RecentProjects(this.db.db).forget(path);
      return { ok: true as const };
    },
    'project.defaultDirectory': () => ({ path: this.projects.defaultDirectory }),

    'media.list': () => (this.projects.info() ? this.projects.media().list() : []),
    'media.import': ({ paths, rights }) => this.projects.media().import(paths, rights),
    'media.remove': async ({ assetIds }) => {
      const using = this.projects.document().sequencesUsing(assetIds);
      if (using.length) {
        throw new Error(
          `This media is used in ${using.join(', ')}. Remove its clips from the timeline first.`,
        );
      }
      await this.projects.media().remove(assetIds);
      return { ok: true as const };
    },
    'media.relink': ({ assetId, path }) => this.projects.media().relink(assetId, path),
    'media.retry': ({ assetId, job }) => {
      this.projects.media().retry(assetId, job);
      return { ok: true as const };
    },
    'media.cancel': ({ assetIds }) => {
      this.projects.media().cancel(assetIds);
      return { ok: true as const };
    },
    'media.updateRights': ({ assetId, rights }) =>
      this.projects.media().updateRights(assetId, rights),
    'jobs.list': () => (this.projects.info() ? this.projects.media().jobs() : []),

    'doc.get': () => this.projects.document().state(),
    'doc.execute': ({ command }) => this.projects.document().execute(command as Command),
    'doc.undo': () => this.projects.document().undo(),
    'doc.redo': () => this.projects.document().redo(),

    'transcript.status': () => this.transcripts.status(),
    'transcript.install': () => {
      this.transcripts.installEngine();
      return { ok: true as const };
    },
    'transcript.start': ({ assetId, language }) => {
      this.transcripts.start(assetId, language);
      return { ok: true as const };
    },
    'transcript.cancel': ({ assetId }) => {
      this.transcripts.cancel(assetId);
      return { ok: true as const };
    },
    'transcript.get': ({ assetId }) => this.transcripts.get(assetId),
    'faces.status': () => this.faces.status(),
    'faces.install': () => {
      this.faces.installEngine();
      return { ok: true as const };
    },
    'faces.start': ({ assetId }) => {
      this.faces.start(assetId);
      return { ok: true as const };
    },
    'faces.cancel': ({ assetId }) => {
      this.faces.cancel(assetId);
      return { ok: true as const };
    },
    'faces.get': ({ assetId }) => this.faces.get(assetId),
    'ai.status': () => this.ai.status(),
    'ai.models': async () => ({ models: await this.ai.models() }),
    'ai.test': () => this.ai.test(),
    'ai.writeStory': ({ genre, idea, seconds }) => this.ai.writeStory(genre, idea, seconds),
    'ai.narrate': ({ title, text, seconds }) => this.ai.narrate(title, text, seconds),
    'voice.status': () => this.voice.status(),
    'voice.install': () => {
      this.voice.installEngine();
      return { ok: true as const };
    },
    'voice.preview': async ({ voice, speed, text }) => ({
      wav: await this.voice.preview(voice, speed, text),
    }),
    'images.status': () => this.images.status(),
    'images.install': () => {
      this.images.startInstall();
      return { ok: true as const };
    },
    'images.cancelInstall': () => {
      this.images.cancelInstall();
      return { ok: true as const };
    },
    'voicehq.status': () => this.voice.human.status(),
    'voicehq.install': () => {
      this.voice.human.start();
      return { ok: true as const };
    },
    'voicehq.cancelInstall': () => {
      this.voice.human.cancel();
      return { ok: true as const };
    },
    'voices.list': () => this.voice.samples(),
    'voices.add': ({ path, name }) => this.voice.addSample(path, name),
    'voices.remove': async ({ id }) => {
      await this.voice.removeSample(id);
      return { ok: true as const };
    },
    'animation.status': () => this.animation.status(),
    'animation.install': () => {
      this.animation.startInstall();
      return { ok: true as const };
    },
    'animation.cancelInstall': () => {
      this.animation.cancelInstall();
      return { ok: true as const };
    },
    'templates.jobs': () => this.templates.list(),
    'templates.story': (input) => ({ jobId: this.templates.story(input) }),
    'templates.talkTest': (input) => ({ jobId: this.templates.talkTest(input) }),
    'templates.episode': (input) => ({ jobId: this.templates.episode(input) }),
    'templates.lowPoly': (input) => ({ jobId: this.templates.lowPolyShort(input) }),
    'lowpoly.ideas': ({ theme }) => this.ai.lowPolyIdeas(theme),
    'lowpoly.frames': async ({ request, frames }) => ({
      ok: await this.lowPoly.frames(request, frames),
    }),
    'lowpoly.finished': ({ request, error }) => {
      this.lowPoly.finished(request, error);
      return { ok: true as const };
    },
    'characters.list': () => this.templates.cast(),
    'characters.remove': async ({ id }) => {
      await this.templates.forget(id);
      return { ok: true as const };
    },
    'templates.cancel': ({ jobId }) => {
      this.templates.cancel(jobId);
      return { ok: true as const };
    },
    'luts.list': () => this.projects.database().listLuts(),
    'luts.import': async ({ path }) => {
      const info = await importLut(this.projects.database(), path);
      this.emit('luts.changed', this.projects.database().listLuts());
      return info;
    },
    'luts.get': ({ id }) => {
      const lut = this.projects.database().loadLut(id);
      if (!lut) return null;
      const { data, ...info } = lut;
      return {
        ...info,
        data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64'),
      };
    },
    'export.target': ({ fileName, directory }) => {
      const dir = directory ?? this.exportDirectory();
      const name = cleanFileName(fileName, '.mp4');
      const path = join(dir, name);
      return { directory: dir, fileName: name, path, exists: existsSync(path) };
    },
    'export.start': ({ sequenceId, path, settings }) =>
      this.startExport(this.sequence(sequenceId), path, settings),
    'export.frame': async ({ sequenceId, time, path }) => {
      const media = this.projects.media();
      const seq = this.sequence(sequenceId);
      await this.exports.frame(
        seq,
        time,
        path,
        () => this.exportToolchain(),
        (id) => media.exportAsset(id),
        this.captionsFor(seq),
        (work) => writeLutFiles(this.projects.database(), seq, work),
      );
      return { ok: true as const };
    },
    'export.cancel': () => {
      this.exports.cancel();
      return { ok: true as const };
    },
    'export.status': () => this.exports.status(),

    'claude.state': () => this.claude.state(),
    'claude.respond': ({ id, allow }) => {
      this.claude.respond(id, allow);
      return { ok: true as const };
    },
    'claude.undoChange': ({ group }) => {
      this.claude.undoChange(group);
      return { ok: true as const };
    },
    'claude.keepChange': ({ group }) => {
      this.claude.keepChange(group);
      return { ok: true as const };
    },
    'claude.clearActivity': () => {
      this.claude.clearActivity();
      return { ok: true as const };
    },
  };

  private startExport(seq: Sequence, path: string, settings: ExportSettings) {
    const media = this.projects.media();
    // Remember the folder so the next export starts there.
    if (isAbsolute(path))
      this.emit('settings.changed', this.settings.update({ exportDirectory: dirname(path) }));
    return this.exports.start(
      seq,
      path,
      settings,
      () => this.exportToolchain(),
      (id) => media.exportAsset(id),
      this.captionsFor(seq),
      (work) => writeLutFiles(this.projects.database(), seq, work),
    );
  }

  /** The open project as Claude's tools see it (ADR-044). */
  private claudeTools(): Omit<ToolContext, 'execute' | 'confirm'> {
    return {
      projectName: () => this.projects.info()?.name ?? null,
      doc: () => {
        const state = this.projects.document().state();
        return { doc: state.doc as ProjectDocument, version: state.version };
      },
      media: () => this.projects.media().list(),
      transcript: (assetId) => this.transcripts.get(assetId)?.words,
      transcribed: () => new Set(this.transcripts.status().transcribed),
      transcriptionAvailable: () => this.transcripts.status().available,
      jobs: () => this.jobLines(),
      frame: async (seq, time, maxSize) => {
        const work = await mkdtemp(join(tmpdir(), 'recit-claude-'));
        try {
          const path = join(work, 'frame.jpg');
          const media = this.projects.media();
          await this.exports.frame(
            seq,
            time,
            path,
            () => this.exportToolchain(),
            (id) => media.exportAsset(id),
            this.captionsFor(seq),
            (dir) => writeLutFiles(this.projects.database(), seq, dir),
            Math.min(1, maxSize / Math.max(seq.width, seq.height)),
          );
          return (await readFile(path)).toString('base64');
        } finally {
          await rm(work, { recursive: true, force: true }).catch(() => {});
        }
      },
      startTranscription: (assetId, language) => this.transcripts.start(assetId, language),
      exportRunning: () => this.exports.status().state === 'running',
      exportPath: (fileName) => {
        const dir = this.exportDirectory();
        const name = cleanFileName(fileName, '.mp4');
        let path = join(dir, name);
        for (let n = 2; existsSync(path) && n < 1000; n++)
          path = join(dir, `${name.slice(0, -4)} (${n}).mp4`);
        return path;
      },
      startExport: (seq, path) => void this.startExport(seq, path, DEFAULT_EXPORT_SETTINGS),
      luts: () => this.projects.database().listLuts(),
      loudness: async (assetId) => {
        const path = this.projects.media().waveformPath(assetId);
        return path ? new Uint8Array(await readFile(path)) : undefined;
      },
    };
  }

  /** Running and recent jobs as short lines for Claude. */
  private jobLines(): string[] {
    const lines: string[] = [];
    const names = new Map(
      this.projects
        .media()
        .list()
        .map((a) => [a.id, a.name]),
    );
    for (const j of this.transcripts.status().jobs) {
      if (j.state === 'cancelled') continue;
      lines.push(
        `Transcription of ${names.get(j.assetId) ?? j.assetId}: ${j.state}${j.state === 'done' || j.state === 'failed' ? '' : ` ${Math.round(j.progress * 100)}%`}${j.error ? ` (${j.error})` : j.message ? ` (${j.message})` : ''}`,
      );
    }
    const e = this.exports.status();
    if (e.state !== 'idle')
      lines.push(
        `Export of ${e.sequenceName ?? 'the sequence'}: ${e.state}${e.state === 'running' ? ` ${Math.round(e.progress * 100)}%` : ''}${e.path ? ` → ${e.path}` : ''}${e.error ? ` (${e.error})` : ''}`,
      );
    for (const j of this.projects.media().jobs())
      if (j.state === 'running' || j.state === 'pending')
        lines.push(`Preparing ${j.assetName} (${j.kind}): ${Math.round(j.progress * 100)}%`);
    return lines;
  }

  /** Serves one renderer over its MessagePort. */
  attach(port: PortLike): void {
    const server = createIpcServer(backendContract, this.handlers, portTransport(port), {
      onError: (error, ctx) =>
        console.error(
          `[ipc] ${ctx.channel ?? ''} ${error instanceof Error ? error.message : String(error)}`,
        ),
    });
    this.servers.add(server);
    // Electron's MessagePortMain emits 'close' when the renderer goes away.
    (port as { on?(event: 'close', listener: () => void): unknown }).on?.('close', () => {
      server.dispose();
      this.servers.delete(server);
    });
  }

  setSecrets(values: Partial<Record<SecretName, string>>): void {
    this.secrets = values;
    this.emit('system.statusChanged', this.status());
  }

  cacheRoot(): string {
    return this.settings.getAll().cacheDirectory ?? join(this.config.userDataDir, 'cache');
  }

  /** Waits for the first FFmpeg check, then returns binaries and the proxy encoder. */
  async toolchain(): Promise<Toolchain> {
    await this.ffmpegDetected;
    const encoder = this.ffmpeg.state === 'ok' ? chooseEncoder(this.ffmpeg) : null;
    if (!encoder) {
      throw new Error(
        this.ffmpeg.message ??
          'FFmpeg is not available. Run "pnpm fetch-ffmpeg" and restart Rec-It.',
      );
    }
    return { bins: this.ffmpegBins, encoder, tonemap: this.ffmpeg.hasZimg };
  }

  /** Last export folder if it still exists, else the user's Videos folder, else home. */
  exportDirectory(): string {
    const last = this.settings.getAll().exportDirectory;
    if (last && existsSync(last)) return last;
    const videos = join(homedir(), 'Videos');
    return existsSync(videos) ? videos : homedir();
  }

  /** FFmpeg binaries plus what export needs to choose an encoder. */
  async exportToolchain(): Promise<ExportToolchain> {
    const { bins, tonemap } = await this.toolchain();
    return { bins, tonemap, ffmpeg: this.ffmpeg };
  }

  /** Burned-in captions for an export, built exactly as the preview builds them (ADR-032). */
  private captionsFor(seq: Sequence): CaptionsInput | null {
    const fontsDir = this.config.fontsDir;
    // Caption clips on caption tracks (ADR-033); the same function feeds the preview.
    const ass = sequenceCaptionsAss(seq);
    if (!ass) return null;
    if (!fontsDir || !existsSync(fontsDir))
      throw new Error('The caption fonts are missing from this installation.');
    return { ass, fontsDir };
  }

  private sequence(sequenceId: string): Sequence {
    const seq = this.projects
      .document()
      .state()
      .doc.sequences.find((s) => s.id === sequenceId);
    if (!seq) throw new Error('That sequence no longer exists.');
    return seq as Sequence;
  }

  status(): SystemStatus {
    return {
      backend: {
        version: BACKEND_VERSION,
        startedAt: this.startedAt,
        nodeVersion: process.versions.node,
        electronVersion: this.config.electronVersion,
        platform: process.platform,
        arch: process.arch,
      },
      database: { path: this.db.path, schemaVersion: this.db.schemaVersion },
      ffmpeg: this.ffmpeg,
      sidecar: this.sidecarStatus,
      secrets: Object.fromEntries(
        SECRET_NAMES.map((name) => {
          const value = this.secrets[name];
          return [name, value ? { set: true, fingerprint: fingerprint(value) } : { set: false }];
        }),
      ),
    };
  }

  /** Runs the FFmpeg and sidecar checks (concurrent callers share one run). */
  refresh(): Promise<SystemStatus> {
    this.refreshing ??= (async () => {
      const ffmpegCheck = detectFfmpeg(this.ffmpegBins).then((result) => {
        this.ffmpeg = result;
        this.resolveFfmpegDetected();
        this.emit('system.statusChanged', this.status());
      });
      const sidecarCheck = checkSidecar(this.sidecar).then(async (result) => {
        this.sidecarStatus = result;
        this.emit('system.statusChanged', this.status());
        await Promise.all([
          this.transcripts.refresh(),
          this.faces.refresh(),
          this.voice.refresh(),
          this.images.refresh(),
          this.animation.refresh(),
        ]);
      });
      await Promise.all([ffmpegCheck, sidecarCheck]);
      return this.status();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async dispose(): Promise<void> {
    await this.claude.close();
    this.exports.cancel();
    this.transcripts.reset();
    this.faces.reset();
    this.templates.reset();
    await this.projects.close().catch(() => {});
    for (const server of this.servers) server.dispose();
    this.servers.clear();
    this.sidecar?.stop();
    this.db.close();
  }

  private emit<K extends EventChannel<BackendContract>>(
    event: K,
    payload: EventPayload<BackendContract, K>,
  ): void {
    for (const server of this.servers) server.emit(event, payload);
  }
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** Makes a safe file name (Windows rules) with the given extension. */
export function cleanFileName(name: string, ext: string): string {
  let base = name
    // eslint-disable-next-line no-control-regex -- control characters are not allowed in file names
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (base.toLowerCase().endsWith(ext)) base = base.slice(0, -ext.length).trim();
  if (!base || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base)) base = 'Export';
  return `${base.slice(0, 200)}${ext}`;
}
