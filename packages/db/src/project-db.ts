import { existsSync } from 'node:fs';
import type { Migration } from './migrations';
import { currentVersion, migrate } from './migrations';
import { openDatabase, transaction, type Database } from './sqlite';

export const PROJECT_FILE_EXTENSION = '.recit';
const PROJECT_KIND = 'rec-it-project';

/**
 * Schema for a .recit project file (ARCHITECTURE §17, ADR-022). Assets are rows that are
 * committed immediately, so a crash loses nothing that was already written. The timeline
 * document and its command journal are added in Phase 2.
 */
export const projectMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'meta_and_assets',
    up: `CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT,
      original_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      probe TEXT,
      rights TEXT NOT NULL,
      jobs TEXT NOT NULL,
      derived TEXT NOT NULL DEFAULT '{}',
      imported_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX assets_content_hash ON assets (content_hash);`,
  },
  {
    version: 2,
    name: 'document',
    // The timeline document (sequences, tracks, clips) as one JSON value, rewritten after each
    // edit. It is small (tens of KB), so a whole-value write is simpler than a journal (ADR-025).
    up: `CREATE TABLE document (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`,
  },
  {
    version: 3,
    name: 'transcripts',
    // One word-timed transcript per media file (ARCHITECTURE §6.5). Deleting the media deletes it.
    up: `CREATE TABLE transcripts (
      asset_id TEXT PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      model TEXT NOT NULL,
      json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;`,
  },
];

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
}

/** Asset row with JSON columns decoded. The backend validates their shapes. */
export interface AssetRow {
  id: string;
  name: string;
  kind: string | null;
  originalPath: string;
  contentHash: string;
  sizeBytes: number;
  mtimeMs: number;
  probe: unknown;
  rights: unknown;
  jobs: unknown;
  derived: unknown;
  importedAt: string;
  sortOrder: number;
}

export class ProjectFileError extends Error {
  override name = 'ProjectFileError';
}

interface RawAssetRow {
  id: string;
  name: string;
  kind: string | null;
  original_path: string;
  content_hash: string;
  size_bytes: number;
  mtime_ms: number;
  probe: string | null;
  rights: string;
  jobs: string;
  derived: string;
  imported_at: string;
  sort_order: number;
}

const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = (text: string | null): unknown =>
  text === null ? null : (JSON.parse(text) as unknown);

function decode(row: RawAssetRow): AssetRow {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    originalPath: row.original_path,
    contentHash: row.content_hash,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    probe: parse(row.probe),
    rights: parse(row.rights),
    jobs: parse(row.jobs),
    derived: parse(row.derived),
    importedAt: row.imported_at,
    sortOrder: row.sort_order,
  };
}

export class ProjectDatabase {
  private constructor(
    readonly db: Database,
    readonly path: string,
  ) {}

  /** Creates a new project file. Fails if the file already exists. */
  static create(path: string, meta: ProjectMeta): ProjectDatabase {
    if (existsSync(path)) throw new ProjectFileError(`A file already exists at ${path}`);
    const db = openDatabase(path);
    try {
      migrate(db, projectMigrations);
      const set = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      transaction(db, () => {
        set.run('kind', PROJECT_KIND);
        set.run('id', meta.id);
        set.run('name', meta.name);
        set.run('createdAt', meta.createdAt);
      });
    } catch (error) {
      db.close();
      throw error;
    }
    return new ProjectDatabase(db, path);
  }

  /** Opens an existing project file, migrating it if it was written by an older Rec-It. */
  static open(path: string): ProjectDatabase {
    if (!existsSync(path)) throw new ProjectFileError(`Project file not found: ${path}`);
    let db: Database;
    try {
      db = openDatabase(path);
    } catch {
      throw new ProjectFileError('This file is not a Rec-It project.');
    }
    try {
      db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
    } catch {
      db.close();
      throw new ProjectFileError('This file is not a Rec-It project.');
    }
    try {
      const hasMeta = db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='meta'")
        .get();
      const kind = hasMeta
        ? (
            db.prepare("SELECT value FROM meta WHERE key='kind'").get() as
              { value: string } | undefined
          )?.value
        : undefined;
      if (kind !== PROJECT_KIND) throw new ProjectFileError('This file is not a Rec-It project.');
      migrate(db, projectMigrations);
    } catch (error) {
      db.close();
      throw error;
    }
    return new ProjectDatabase(db, path);
  }

  get schemaVersion(): number {
    return currentVersion(this.db);
  }

  meta(): ProjectMeta {
    const rows = this.db.prepare('SELECT key, value FROM meta').all() as {
      key: string;
      value: string;
    }[];
    const map = new Map(rows.map((r) => [r.key, r.value]));
    return {
      id: map.get('id') ?? '',
      name: map.get('name') ?? 'Untitled',
      createdAt: map.get('createdAt') ?? '',
    };
  }

  rename(name: string): void {
    this.db.prepare("UPDATE meta SET value = ? WHERE key = 'name'").run(name);
  }

  listAssets(): AssetRow[] {
    return (
      this.db.prepare('SELECT * FROM assets ORDER BY sort_order').all() as unknown as RawAssetRow[]
    ).map(decode);
  }

  getAsset(id: string): AssetRow | null {
    const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as unknown as
      RawAssetRow | undefined;
    return row ? decode(row) : null;
  }

  findByHash(hash: string): AssetRow | null {
    const row = this.db
      .prepare('SELECT * FROM assets WHERE content_hash = ?')
      .get(hash) as unknown as RawAssetRow | undefined;
    return row ? decode(row) : null;
  }

  insertAsset(asset: Omit<AssetRow, 'sortOrder'>): AssetRow {
    const next = (
      this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM assets').get() as {
        n: number;
      }
    ).n;
    this.db
      .prepare(
        `INSERT INTO assets (id, name, kind, original_path, content_hash, size_bytes, mtime_ms, probe, rights, jobs,
          derived, imported_at, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        asset.id,
        asset.name,
        asset.kind,
        asset.originalPath,
        asset.contentHash,
        asset.sizeBytes,
        asset.mtimeMs,
        asset.probe === null ? null : json(asset.probe),
        json(asset.rights),
        json(asset.jobs),
        json(asset.derived),
        asset.importedAt,
        next,
      );
    return { ...asset, sortOrder: next };
  }

  /** Updates the given fields of one asset. */
  updateAsset(id: string, patch: Partial<Omit<AssetRow, 'id' | 'sortOrder' | 'importedAt'>>): void {
    const columns: Record<string, (v: unknown) => unknown> = {
      name: (v) => v,
      kind: (v) => v,
      originalPath: (v) => v,
      contentHash: (v) => v,
      sizeBytes: (v) => v,
      mtimeMs: (v) => v,
      probe: (v) => (v === null ? null : json(v)),
      rights: json,
      jobs: json,
      derived: json,
    };
    const names: Record<string, string> = {
      originalPath: 'original_path',
      contentHash: 'content_hash',
      sizeBytes: 'size_bytes',
      mtimeMs: 'mtime_ms',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      const encode = columns[key];
      if (!encode || value === undefined) continue;
      sets.push(`${names[key] ?? key} = ?`);
      values.push(encode(value));
    }
    if (!sets.length) return;
    this.db
      .prepare(`UPDATE assets SET ${sets.join(', ')} WHERE id = ?`)
      .run(...(values as never[]), id);
  }

  deleteAssets(ids: readonly string[]): void {
    const del = this.db.prepare('DELETE FROM assets WHERE id = ?');
    transaction(this.db, () => {
      for (const id of ids) del.run(id);
    });
  }

  /** Writes a consistent copy of the whole project to another file (Save As). */
  copyTo(path: string): void {
    if (existsSync(path)) throw new ProjectFileError(`A file already exists at ${path}`);
    this.db.prepare('VACUUM INTO ?').run(path);
  }

  /** The stored timeline document, or null if the project has none yet. */
  loadDocument(): unknown {
    const row = this.db.prepare('SELECT json FROM document WHERE id = 1').get() as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as unknown) : null;
  }

  saveDocument(doc: unknown): void {
    this.db
      .prepare(
        `INSERT INTO document (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(doc), new Date().toISOString());
  }

  /** The stored transcript of a media file (its JSON), or null. */
  loadTranscript(assetId: string): { language: string; model: string; json: string } | null {
    const row = this.db
      .prepare('SELECT language, model, json FROM transcripts WHERE asset_id = ?')
      .get(assetId) as { language: string; model: string; json: string } | undefined;
    return row ?? null;
  }

  /** Ids of media files that have a transcript. */
  transcribedAssets(): string[] {
    return (
      this.db.prepare('SELECT asset_id FROM transcripts').all() as { asset_id: string }[]
    ).map((r) => r.asset_id);
  }

  saveTranscript(assetId: string, language: string, model: string, json: string): void {
    this.db
      .prepare(
        `INSERT INTO transcripts (asset_id, language, model, json, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET language = excluded.language, model = excluded.model,
           json = excluded.json, created_at = excluded.created_at`,
      )
      .run(assetId, language, model, json, new Date().toISOString());
  }

  deleteTranscript(assetId: string): void {
    this.db.prepare('DELETE FROM transcripts WHERE asset_id = ?').run(assetId);
  }

  close(): void {
    this.db.close();
  }
}
