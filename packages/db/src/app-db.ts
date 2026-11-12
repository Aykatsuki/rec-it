import type { Migration } from './migrations';
import { migrate, currentVersion } from './migrations';
import { openDatabase, type Database } from './sqlite';

/** Schema for app.db (ARCHITECTURE §17). Project files get their own migrations in Phase 1. */
export const appMigrations: readonly Migration[] = [
  {
    version: 1,
    name: 'settings',
    up: `CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;`,
  },
  {
    version: 2,
    name: 'recent_projects',
    up: `CREATE TABLE recent_projects (
      path TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      opened_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX recent_projects_opened_at ON recent_projects (opened_at DESC);`,
  },
];

export interface AppDatabase {
  db: Database;
  path: string;
  schemaVersion: number;
  close(): void;
}

export function openAppDatabase(path: string): AppDatabase {
  const db = openDatabase(path);
  try {
    migrate(db, appMigrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return { db, path, schemaVersion: currentVersion(db), close: () => db.close() };
}
