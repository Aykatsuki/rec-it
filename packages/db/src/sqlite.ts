// node:sqlite ships with Node 24 and with Electron 45's Node, so no native module is needed (ADR-020).
import { DatabaseSync } from 'node:sqlite';

export type Database = DatabaseSync;

export interface OpenOptions {
  /** Open read-only (used by diagnostics). */
  readOnly?: boolean;
}

/** Opens a SQLite database with the pragmas Rec-It relies on. Use ":memory:" in tests. */
export function openDatabase(path: string, options: OpenOptions = {}): Database {
  const db = new DatabaseSync(path, { readOnly: options.readOnly ?? false });
  db.exec('PRAGMA foreign_keys = ON;');
  if (path !== ':memory:' && !options.readOnly) {
    // WAL gives crash safety and lets readers proceed during writes (ARCHITECTURE §17).
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA synchronous = NORMAL;');
  }
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}

/** Runs `fn` inside a transaction, rolling back on error. */
export function transaction<T>(db: Database, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}
