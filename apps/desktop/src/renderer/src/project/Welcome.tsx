import { useEffect, useState } from 'react';
import { FolderOpen, Plus, X } from 'lucide-react';
import type { RecentProject } from '@rec-it/ipc-contract';
import { Button, TextField } from '@rec-it/ui';
import { backend } from '../api';
import { openProject, openProjectWithDialog } from '../actions';
import { notify } from '../notifications';

export function Welcome() {
  const [name, setName] = useState('');
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [folder, setFolder] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void backend.invoke('project.recent', {}).then(setRecent);
    void backend.invoke('project.defaultDirectory', {}).then((r) => setFolder(r.path));
  }, []);

  const create = async () => {
    setBusy(true);
    try {
      await backend.invoke('project.create', { name: name.trim() || 'Untitled project' });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="welcome" data-region="welcome">
      <section className="welcome__panel">
        <div className="welcome__brand">
          <span className="brand-mark" aria-hidden />
          <h1>Rec-It</h1>
        </div>
        <p className="welcome__lead">Make YouTube Shorts from your footage.</p>

        <form
          className="welcome__create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label htmlFor="project-name">New project</label>
          <div className="welcome__row">
            <TextField
              id="project-name"
              placeholder="Untitled project"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              maxLength={120}
            />
            <Button type="submit" variant="primary" icon={<Plus size={15} />} disabled={busy}>
              Create
            </Button>
          </div>
          <small>Saved automatically in {folder || 'Documents\\Rec-It Projects'}</small>
        </form>

        <div className="welcome__open">
          <Button icon={<FolderOpen size={15} />} onClick={() => void openProjectWithDialog()}>
            Open project…
          </Button>
        </div>
      </section>

      <section className="welcome__recent" aria-label="Recent projects">
        <h2>Recent</h2>
        {recent.length === 0 && (
          <p className="welcome__empty">Projects you open will appear here.</p>
        )}
        <ul>
          {recent.map((r) => (
            <li key={r.path} data-exists={r.exists}>
              <button
                type="button"
                className="welcome__item"
                disabled={!r.exists}
                onClick={() => void openProject(r.path)}
                title={r.path}
              >
                <span className="welcome__item-name">{r.name}</span>
                <span className="welcome__item-path">{r.exists ? r.path : 'File not found'}</span>
              </button>
              <button
                type="button"
                className="welcome__forget"
                aria-label={`Remove ${r.name} from recent projects`}
                onClick={() =>
                  void backend
                    .invoke('project.forgetRecent', { path: r.path })
                    .then(() => setRecent((list) => list.filter((x) => x.path !== r.path)))
                }
              >
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
