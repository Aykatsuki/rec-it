import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appMigrations, openAppDatabase } from './app-db';
import { MigrationError, currentVersion, migrate } from './migrations';
import { openDatabase } from './sqlite';
import { SettingsRepository } from './settings-repository';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'recit-db-'));
  dirs.push(d);
  return d;
}

describe('migrations', () => {
  it('applies all migrations once and is idempotent', () => {
    const db = openDatabase(':memory:');
    const first = migrate(db, appMigrations);
    expect(first.from).toBe(0);
    expect(first.to).toBe(appMigrations.at(-1)!.version);
    expect(first.applied).toHaveLength(appMigrations.length);
    const second = migrate(db, appMigrations);
    expect(second.applied).toEqual([]);
  });

  it('rolls back a failing migration and keeps earlier ones', () => {
    const db = openDatabase(':memory:');
    const broken = [
      { version: 1, name: 'ok', up: 'CREATE TABLE a (x INTEGER) STRICT;' },
      { version: 2, name: 'bad', up: 'CREATE TABLE b (x INTEGER) STRICT; THIS IS NOT SQL;' },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(currentVersion(db)).toBe(1);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='b'")
      .all();
    expect(tables).toEqual([]);
  });

  it('refuses a database from a newer version of Rec-It', () => {
    const db = openDatabase(':memory:');
    migrate(db, [{ version: 5, name: 'future', up: 'SELECT 1;' }]);
    expect(() => migrate(db, appMigrations)).toThrow(MigrationError);
  });

  it('rejects out-of-order migration lists', () => {
    const db = openDatabase(':memory:');
    expect(() =>
      migrate(db, [
        { version: 2, name: 'b', up: 'SELECT 1;' },
        { version: 1, name: 'a', up: 'SELECT 1;' },
      ]),
    ).toThrow(MigrationError);
  });
});

describe('app database and settings', () => {
  const schema = z.object({
    theme: z.enum(['dark', 'light']).default('dark'),
    volume: z.number().min(0).max(1).default(1),
  });

  it('persists settings across reopen, with defaults and validation', () => {
    const path = join(tempDir(), 'app.db');
    const app = openAppDatabase(path);
    const repo = new SettingsRepository(app.db, (raw) => schema.parse(raw));
    expect(repo.getAll()).toEqual({ theme: 'dark', volume: 1 });
    repo.update({ volume: 0.5 });
    expect(() => repo.update({ volume: 7 })).toThrow();
    app.close();

    const reopened = openAppDatabase(path);
    const repo2 = new SettingsRepository(reopened.db, (raw) => schema.parse(raw));
    expect(repo2.getAll()).toEqual({ theme: 'dark', volume: 0.5 });
    expect(reopened.schemaVersion).toBe(appMigrations.at(-1)!.version);
    reopened.close();
  });

  it('falls back to defaults for corrupt stored values', () => {
    const app = openAppDatabase(':memory:');
    app.db
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES ('volume', '{not json', 'x')")
      .run();
    const repo = new SettingsRepository(app.db, (raw) => schema.parse(raw));
    expect(repo.getAll().volume).toBe(1);
    app.db.prepare("UPDATE settings SET value = '42' WHERE key = 'volume'").run();
    expect(repo.getAll()).toEqual({ theme: 'dark', volume: 1 });
  });
});
