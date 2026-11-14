// Link with ProDown, the separate downloader app (ADR-040).
// - Videos ProDown sends are offered for import through the normal rights dialog.
// - "Import from ProDown" (Ctrl+Shift+I) lists ProDown's downloads to pick from.
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { create } from 'zustand';
import { ArrowDownToLine, X } from 'lucide-react';
import type { ProDownFile, ProDownLibraryItem, RightsInput } from '@rec-it/ipc-contract';
import { shell } from './api';
import { importFiles } from './actions';
import { notify } from './notifications';
import { useApp } from './store';

const useProDownUi = create<{ open: boolean }>(() => ({ open: false }));

export function openProDownLibrary(): void {
  if (!useApp.getState().project) {
    notify('Create or open a project first.', 'warn');
    return;
  }
  useProDownUi.setState({ open: true });
}

/** Rights dialog suggestion: where the video came from. The user still picks the source. */
function suggestedRights(files: ProDownFile[]): RightsInput {
  const one = files.length === 1 ? files[0] : undefined;
  const notes = one
    ? `Downloaded with ProDown${one.qualityLabel ? ` (${one.qualityLabel})` : ''}.`
    : `Downloaded with ProDown: ${files.map((f) => f.title).join('; ')}`;
  return {
    source: 'unknown',
    userAttested: false,
    notes: notes.slice(0, 2000),
    ...(one?.url ? { originUrl: one.url } : {}),
    ...(one?.channel ? { author: one.channel } : {}),
  };
}

export async function importFromProDown(files: ProDownFile[]): Promise<void> {
  if (!files.length) return;
  await importFiles(
    files.map((f) => f.path),
    suggestedRights(files),
  );
}

/** Mount once. Picks up videos ProDown sends, now or while no project was open. */
export function ProDownHost() {
  const project = useApp((s) => s.project);
  const open = useProDownUi((s) => s.open);

  const check = useCallback(async () => {
    try {
      if (!useApp.getState().project) {
        const { files } = await shell.invoke('prodown.takeIncoming', { peek: true });
        if (files.length)
          notify(
            `ProDown sent ${files.length === 1 ? `“${files[0]!.title}”` : `${files.length} videos`}. Open or create a project to import.`,
          );
        return;
      }
      const { files } = await shell.invoke('prodown.takeIncoming', { peek: false });
      await importFromProDown(files);
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }, []);

  useEffect(() => window.recit.prodown.onIncoming(() => void check()), [check]);
  // A project opening also collects anything that arrived earlier (or while Rec-It was closed).
  const projectKey = project === undefined ? null : (project?.path ?? 'none');
  useEffect(() => {
    if (projectKey !== null) void check();
  }, [projectKey, check]);

  return open ? <ProDownLibrary onClose={() => useProDownUi.setState({ open: false })} /> : null;
}

function formatSize(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)} GB`;
  if (n >= 1_048_576) return `${Math.round(n / 1_048_576)} MB`;
  return n ? `${Math.max(1, Math.round(n / 1024))} KB` : '';
}

function formatDuration(sec: number): string {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function ProDownLibrary({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ installed: boolean; items: ProDownLibraryItem[] } | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');

  useEffect(() => {
    void shell
      .invoke('prodown.library', {})
      .then(setState)
      .catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'error'));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = state?.items ?? [];
    return q
      ? all.filter(
          (i) => i.title.toLowerCase().includes(q) || (i.channel ?? '').toLowerCase().includes(q),
        )
      : all;
  }, [state, query]);

  const toggle = (path: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const doImport = async () => {
    const files = (state?.items ?? []).filter((i) => selected.has(i.path));
    onClose();
    await importFromProDown(files);
  };

  return (
    <div style={styles.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-label="Import from ProDown" style={styles.card}>
        <header style={styles.head}>
          <ArrowDownToLine size={16} />
          <strong style={{ flex: 1 }}>Import from ProDown</strong>
          <button type="button" aria-label="Close" style={styles.iconBtn} onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {!state ? (
          <p style={styles.empty}>Loading…</p>
        ) : !state.installed ? (
          <p style={styles.empty}>ProDown has not been used on this computer yet.</p>
        ) : !state.items.length ? (
          <p style={styles.empty}>No downloads in ProDown yet.</p>
        ) : (
          <>
            <input
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={styles.search}
              autoFocus
            />
            <div style={styles.list}>
              {items.map((i) => (
                <label
                  key={i.path}
                  style={{ ...styles.row, ...(selected.has(i.path) ? styles.rowOn : {}) }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(i.path)}
                    onChange={() => toggle(i.path)}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={styles.title} title={i.path}>
                      {i.title}
                    </span>
                    <span style={styles.sub}>
                      {[
                        i.channel,
                        i.qualityLabel,
                        formatDuration(i.durationSec),
                        formatSize(i.sizeBytes),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
        <footer style={styles.foot}>
          <span style={{ ...styles.sub, flex: 1 }}>
            Ctrl+Shift+I · You confirm the rights next.
          </span>
          <button type="button" style={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnAccent }}
            disabled={!selected.size}
            onClick={() => void doImport()}
          >
            Import {selected.size || ''}
          </button>
        </footer>
      </div>
    </div>
  );
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(5,6,8,0.6)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 1000,
  },
  card: {
    width: 'min(620px, calc(100vw - 40px))',
    maxHeight: 'calc(100vh - 80px)',
    display: 'flex',
    flexDirection: 'column',
    background: '#16181d',
    border: '1px solid #2a2e38',
    borderRadius: 12,
    boxShadow: '0 30px 80px rgba(0,0,0,0.5)',
    color: '#e8eaf0',
  },
  head: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '12px 14px',
    borderBottom: '1px solid #2a2e38',
  },
  iconBtn: {
    background: 'none',
    border: 0,
    color: 'inherit',
    cursor: 'pointer',
    display: 'grid',
    placeItems: 'center',
  },
  empty: { padding: 24, textAlign: 'center', color: '#8b91a1', margin: 0 },
  search: {
    margin: '10px 14px 4px',
    height: 30,
    padding: '0 10px',
    borderRadius: 7,
    border: '1px solid #2a2e38',
    background: '#0e0f12',
    color: 'inherit',
  },
  list: {
    overflowY: 'auto',
    padding: '6px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    minHeight: 120,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '7px 8px',
    borderRadius: 7,
    cursor: 'pointer',
  },
  rowOn: { background: 'rgba(120,140,255,0.12)' },
  title: { display: 'block', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  sub: { display: 'block', fontSize: 12, color: '#8b91a1' },
  foot: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 14px',
    borderTop: '1px solid #2a2e38',
  },
  btn: {
    height: 30,
    padding: '0 12px',
    borderRadius: 7,
    border: '1px solid #2a2e38',
    background: '#1f232b',
    color: 'inherit',
    cursor: 'pointer',
  },
  btnAccent: { background: '#e8eaf0', color: '#0e0f12', border: 0, fontWeight: 600 },
} satisfies Record<string, CSSProperties>;
