import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createId } from '@rec-it/core';
import { PROJECT_FILE_EXTENSION, ProjectDatabase, type RecentProjects } from '@rec-it/db';
import type { DocumentState, JobSummary, MediaAsset, ProjectInfo } from '@rec-it/ipc-contract';
import { DocumentService } from './document-service';
import { uniquePath } from './files';
import { MediaService, type Toolchain } from './media-service';

export interface ProjectServiceOptions {
  recent: RecentProjects;
  defaultDirectory: string;
  cacheRoot: () => string;
  toolchain: () => Promise<Toolchain>;
  onProjectChanged: (project: ProjectInfo | null) => void;
  onAssetsChanged: (assets: MediaAsset[]) => void;
  onJobsChanged: (jobs: JobSummary[]) => void;
  onDocumentChanged: (state: DocumentState) => void;
}

interface OpenProject {
  db: ProjectDatabase;
  media: MediaService;
  document: DocumentService;
  info: ProjectInfo;
}

/** Owns the currently open project (one at a time) and its media service. */
export class ProjectService {
  private current: OpenProject | null = null;

  constructor(private readonly o: ProjectServiceOptions) {}

  info(): ProjectInfo | null {
    return this.current?.info ?? null;
  }

  /** The open project's media service; throws if no project is open. */
  media(): MediaService {
    if (!this.current) throw new Error('No project is open.');
    return this.current.media;
  }

  /** The open project's timeline; throws if no project is open. */
  document(): DocumentService {
    if (!this.current) throw new Error('No project is open.');
    return this.current.document;
  }

  get defaultDirectory(): string {
    return this.o.defaultDirectory;
  }

  async create(name: string, directory = this.o.defaultDirectory): Promise<ProjectInfo> {
    mkdirSync(directory, { recursive: true });
    const path = uniquePath(directory, name, PROJECT_FILE_EXTENSION);
    const db = ProjectDatabase.create(path, {
      id: createId('project'),
      name: name.trim(),
      createdAt: new Date().toISOString(),
    });
    return this.activate(db);
  }

  async open(path: string): Promise<ProjectInfo> {
    if (this.current?.info.path === path) return this.current.info;
    const db = ProjectDatabase.open(path);
    return this.activate(db);
  }

  /** Copies the project to `path` and switches to the copy (Save As). */
  async saveAs(path: string): Promise<ProjectInfo> {
    const current = this.require();
    const target = path.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
      ? path
      : `${path}${PROJECT_FILE_EXTENSION}`;
    mkdirSync(dirname(target), { recursive: true });
    current.db.copyTo(target);
    const copy = ProjectDatabase.open(target);
    // The copy keeps the same project id, so it shares the media cache: nothing is re-processed.
    return this.activate(copy);
  }

  rename(name: string): ProjectInfo {
    const current = this.require();
    current.db.rename(name.trim());
    current.info = { ...current.info, name: name.trim() };
    this.o.recent.touch(current.info.path, current.info.name);
    this.o.onProjectChanged(current.info);
    return current.info;
  }

  async close(): Promise<void> {
    const current = this.current;
    if (!current) return;
    this.current = null;
    await current.media.close();
    current.db.close();
    this.o.onProjectChanged(null);
    this.o.onAssetsChanged([]);
    this.o.onJobsChanged([]);
  }

  /** Reopens the most recently used project if it still exists. */
  async reopenLast(): Promise<void> {
    const last = this.o.recent.list().find((r) => r.exists);
    if (!last) return;
    try {
      await this.open(last.path);
    } catch (error) {
      console.warn(
        `could not reopen ${last.path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private require(): OpenProject {
    if (!this.current) throw new Error('No project is open.');
    return this.current;
  }

  private async activate(db: ProjectDatabase): Promise<ProjectInfo> {
    await this.close();
    const meta = db.meta();
    const cacheDir = join(this.o.cacheRoot(), meta.id);
    const info: ProjectInfo = {
      id: meta.id,
      name: meta.name,
      path: db.path,
      createdAt: meta.createdAt,
      cacheDir,
    };
    const media = new MediaService({
      project: db,
      projectId: meta.id,
      cacheDir,
      toolchain: this.o.toolchain,
      onAssetsChanged: (assets) => {
        if (this.current?.db === db) this.o.onAssetsChanged(assets);
      },
      onJobsChanged: (jobs) => {
        if (this.current?.db === db) this.o.onJobsChanged(jobs);
      },
    });
    const document = new DocumentService(
      db,
      (id) => media.assetInfo(id),
      (state) => {
        if (this.current?.db === db) this.o.onDocumentChanged(state);
      },
    );
    this.current = { db, media, document, info };
    this.o.recent.touch(db.path, meta.name);
    this.o.onProjectChanged(info);
    this.o.onDocumentChanged(document.state());
    await media.resume();
    return info;
  }
}
