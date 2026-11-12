import { transaction, type Database } from './sqlite';

export interface Migration {
  /** Strictly increasing integer, never reused. */
  version: number;
  name: string;
  up: string;
}

export interface MigrationResult {
  from: number;
  to: number;
  applied: string[];
}

export class MigrationError extends Error {
  override name = 'MigrationError';
}

/**
 * Applies pending migrations in order, each in its own transaction.
 * Refuses to open a database written by a newer version of Rec-It.
 */
export function migrate(db: Database, migrations: readonly Migration[]): MigrationResult {
  validate(migrations);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;`);

  const from = currentVersion(db);
  const latest = migrations.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new MigrationError(
      `Database schema version ${from} is newer than this version of Rec-It supports (${latest}). Update Rec-It.`,
    );
  }

  const applied: string[] = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const m of migrations) {
    if (m.version <= from) continue;
    transaction(db, () => {
      db.exec(m.up);
      record.run(m.version, m.name, new Date().toISOString());
    });
    applied.push(`${m.version}_${m.name}`);
  }
  return { from, to: currentVersion(db), applied };
}

export function currentVersion(db: Database): number {
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    { v: number | null } | undefined;
  return row?.v ?? 0;
}

function validate(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version <= previous) {
      throw new MigrationError(
        `Migrations must have strictly increasing integer versions (at "${m.name}")`,
      );
    }
    previous = m.version;
  }
}
