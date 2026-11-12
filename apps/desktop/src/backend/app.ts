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
import { SettingsRepository, openAppDatabase, type AppDatabase } from '@rec-it/db';
import { detectFfmpeg, resolveFfmpegBinaries } from '@rec-it/ffmpeg';
import type { BackendConfig } from '../shared/backend-messages';
import { SidecarClient, checkSidecar } from './services/sidecar';

const BACKEND_VERSION = '0.0.1';

/** All backend state and services. One instance per backend process. */
export class BackendApp {
  readonly startedAt = Date.now();
  private readonly db: AppDatabase;
  private readonly settings: SettingsRepository<Settings>;
  private readonly sidecar: SidecarClient | null;
  private readonly servers = new Set<IpcServer<BackendContract>>();
  private secrets: Partial<Record<SecretName, string>> = {};
  private ffmpeg: FfmpegStatus = {
    state: 'checking',
    encoders: {},
    hwaccels: [],
    nvencUsable: null,
    hasLibass: false,
  };
  private sidecarStatus: SidecarStatus = { state: 'checking', gpus: [] };
  private refreshing: Promise<SystemStatus> | null = null;

  constructor(private readonly config: BackendConfig) {
    mkdirSync(config.userDataDir, { recursive: true });
    this.db = openAppDatabase(join(config.userDataDir, 'app.db'));
    this.settings = new SettingsRepository(this.db.db, (raw) => settingsSchema.parse(raw));
    this.sidecar = config.sidecar
      ? new SidecarClient(config.sidecar, (l) => console.info(`[sidecar] ${l}`))
      : null;
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
      this.emit('settings.changed', next);
      return next;
    },
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
      const ffmpegCheck = detectFfmpeg(
        resolveFfmpegBinaries({
          envPath: this.config.ffmpeg.envPath,
          bundledDir: this.config.ffmpeg.bundledDir,
        }),
      ).then((result) => {
        this.ffmpeg = result;
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

  dispose(): void {
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
