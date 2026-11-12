import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openAppDatabase } from './app-db';
import { ProjectDatabase, ProjectFileError } from './project-db';
import { RecentProjects } from './recent-projects';

const dirs: string[] = [];
const open: { close(): void }[] = [];
afterEach(() => {
  for (const o of open.splice(0)) o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'recit-proj-'));
  dirs.push(d);
  return d;
}

const asset = (id: string, hash: string) => ({
  id,
  name: `${id}.mp4`,
  kind: null,
  originalPath: `/media/${id}.mp4`,
  contentHash: hash,
  sizeBytes: 100,
  mtimeMs: 1,
  probe: null,
  rights: { source: 'own-recording', userAttested: true },
  jobs: { probe: { state: 'pending', progress: 0 } },
  derived: {},
  importedAt: '2026-11-12T00:00:00Z',
});

describe('ProjectDatabase', () => {
  it('creates, reopens and stores assets durably', () => {
    const path = join(tempDir(), 'My project.recit');
    const created = ProjectDatabase.create(path, {
      id: 'project_1',
      name: 'My project',
      createdAt: 'now',
    });
    created.insertAsset(asset('asset_a', 'h1'));
    created.insertAsset(asset('asset_b', 'h2'));
    created.updateAsset('asset_a', {
      kind: 'video',
      probe: { durationSec: 3 },
      jobs: { probe: { state: 'done', progress: 1 } },
    });
    created.close();

    const reopened = ProjectDatabase.open(path);
    open.push(reopened);
    expect(reopened.meta()).toEqual({ id: 'project_1', name: 'My project', createdAt: 'now' });
    const assets = reopened.listAssets();
    expect(assets.map((a) => a.id)).toEqual(['asset_a', 'asset_b']);
    expect(assets[0]).toMatchObject({
      kind: 'video',
      probe: { durationSec: 3 },
      jobs: { probe: { state: 'done' } },
    });
    expect(reopened.findByHash('h2')?.id).toBe('asset_b');
  });

  it('enforces unique content and refuses to overwrite files', () => {
    const dir = tempDir();
    const path = join(dir, 'p.recit');
    const db = ProjectDatabase.create(path, { id: 'p', name: 'p', createdAt: 'now' });
    open.push(db);
    db.insertAsset(asset('a', 'same'));
    expect(() => db.insertAsset(asset('b', 'same'))).toThrow();
    expect(() => ProjectDatabase.create(path, { id: 'x', name: 'x', createdAt: 'now' })).toThrow(
      ProjectFileError,
    );
  });

  it('rejects files that are not Rec-It projects', () => {
    const dir = tempDir();
    const text = join(dir, 'notes.recit');
    writeFileSync(text, 'hello');
    expect(() => ProjectDatabase.open(text)).toThrow(ProjectFileError);
    const app = openAppDatabase(join(dir, 'other.db'));
    app.close();
    expect(() => ProjectDatabase.open(join(dir, 'other.db'))).toThrow(ProjectFileError);
  });

  it('copies itself for Save As', () => {
    const dir = tempDir();
    const db = ProjectDatabase.create(join(dir, 'a.recit'), {
      id: 'p',
      name: 'A',
      createdAt: 'now',
    });
    open.push(db);
    db.insertAsset(asset('a', 'h'));
    db.copyTo(join(dir, 'b.recit'));
    const copy = ProjectDatabase.open(join(dir, 'b.recit'));
    open.push(copy);
    expect(copy.listAssets()).toHaveLength(1);
  });
});

describe('RecentProjects', () => {
  it('orders by last opened and reports missing files', async () => {
    const dir = tempDir();
    const app = openAppDatabase(join(dir, 'app.db'));
    open.push(app);
    const recent = new RecentProjects(app.db);
    const real = join(dir, 'real.recit');
    writeFileSync(real, '');
    recent.touch(join(dir, 'gone.recit'), 'Gone');
    await new Promise((r) => setTimeout(r, 5));
    recent.touch(real, 'Real');
    expect(recent.list().map((r) => [r.name, r.exists])).toEqual([
      ['Real', true],
      ['Gone', false],
    ]);
    recent.forget(real);
    expect(recent.list()).toHaveLength(1);
  });
});
