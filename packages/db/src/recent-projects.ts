import { existsSync } from 'node:fs';
import type { Database } from './sqlite';

export interface RecentProjectRow {
  path: string;
  name: string;
  openedAt: string;
  exists: boolean;
}

/** Recently opened projects, kept in app.db (most recent first, at most 20). */
export class RecentProjects {
  constructor(private readonly db: Database) {}

  touch(path: string, name: string): void {
    this.db
      .prepare(
        `INSERT INTO recent_projects (path, name, opened_at) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, opened_at = excluded.opened_at`,
      )
      .run(path, name, new Date().toISOString());
    this.db
      .prepare(
        'DELETE FROM recent_projects WHERE path NOT IN (SELECT path FROM recent_projects ORDER BY opened_at DESC LIMIT 20)',
      )
      .run();
  }

  list(): RecentProjectRow[] {
    const rows = this.db
      .prepare('SELECT path, name, opened_at FROM recent_projects ORDER BY opened_at DESC')
      .all() as {
      path: string;
      name: string;
      opened_at: string;
    }[];
    return rows.map((r) => ({
      path: r.path,
      name: r.name,
      openedAt: r.opened_at,
      exists: existsSync(r.path),
    }));
  }

  forget(path: string): void {
    this.db.prepare('DELETE FROM recent_projects WHERE path = ?').run(path);
  }
}
