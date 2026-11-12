import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SECRET_NAMES,
  backendContract,
  createIpcServer,
  portTransport,
  settingsSchema,
  type BackendContract,
  type EventChannel,
  type EventPayload,
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
import { ExportService } from './services/export-service';
import { ProjectService } from './services/project-service';
import type { Command } from '@rec-it/core';
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
      onProjectChanged: (p) => this.emit('project.changed', p),
      onAssetsChanged: (a) => this.emit('media.changed', a),
      onJobsChanged: (j) => this.emit('jobs.changed', j),
      onDocumentChanged: (d) => this.emit('doc.changed', d),
    });
    this.exports = new ExportService((state) => this.emit('export.changed', state));
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

    'export.start': ({ sequenceId, path, quality }) => {
      const seq = this.projects
        .document()
        .state()
        .doc.sequences.find((s) => s.id === sequenceId);
      if (!seq) throw new Error('That sequence no longer exists.');
      const media = this.projects.media();
      return this.exports.start(
        seq as never,
        path,
        quality,
        () => this.toolchain(),
        (id) => media.exportAsset(id),
      );
    },
    'export.cancel': () => {
      this.exports.cancel();
      return { ok: true as const };
    },
    'export.status': () => this.exports.status(),
  };

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
      const sidecarCheck = checkSidecar(this.sidecar).then((result) => {
        this.sidecarStatus = result;
        this.emit('system.statusChanged', this.status());
      });
      await Promise.all([ffmpegCheck, sidecarCheck]);
      return this.status();
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  async dispose(): Promise<void> {
    this.exports.cancel();
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
