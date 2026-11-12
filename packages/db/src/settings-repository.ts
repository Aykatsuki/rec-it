import type { Database } from './sqlite';
import { transaction } from './sqlite';

/**
 * Generic key/value store for settings. Values are JSON. The caller supplies a parse
 * function (normally a zod schema) so stored data is always validated on the way out.
 */
export class SettingsRepository<T extends Record<string, unknown>> {
  constructor(
    private readonly db: Database,
    private readonly parse: (raw: Record<string, unknown>) => T,
  ) {}

  getAll(): T {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as {
      key: string;
      value: string;
    }[];
    const raw: Record<string, unknown> = {};
    for (const row of rows) {
      try {
        raw[row.key] = JSON.parse(row.value);
      } catch {
        // A corrupt value falls back to its default instead of breaking start-up.
      }
    }
    try {
      return this.parse(raw);
    } catch {
      // Drop any individually invalid value (e.g. written by a newer version) and use its default.
      for (const key of Object.keys(raw)) {
        try {
          this.parse({ [key]: raw[key] });
        } catch {
          delete raw[key];
        }
      }
      return this.parse(raw);
    }
  }

  /** Validates the merged result before writing, so an invalid patch changes nothing. */
  update(patch: Partial<T>): T {
    const next = this.parse({ ...this.getAll(), ...patch });
    const now = new Date().toISOString();
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    transaction(this.db, () => {
      for (const key of Object.keys(patch)) {
        upsert.run(key, JSON.stringify(next[key]), now);
      }
    });
    return next;
  }
}
