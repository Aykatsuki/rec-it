import { create } from 'zustand';
import type { JobSummary, MediaAsset, ProjectInfo } from '@rec-it/ipc-contract';
import { backend } from './api';

interface AppState {
  connected: boolean;
  /** undefined until the backend has answered; null when no project is open. */
  project: ProjectInfo | null | undefined;
  assets: MediaAsset[];
  jobs: JobSummary[];
  selectedAssetId: string | null;
  mediaView: 'grid' | 'list';
  select(id: string | null): void;
  setMediaView(view: 'grid' | 'list'): void;
}

export const useApp = create<AppState>((set) => ({
  connected: false,
  project: undefined,
  assets: [],
  jobs: [],
  selectedAssetId: null,
  mediaView: (localStorage.getItem('recit.mediaView') as 'grid' | 'list' | null) ?? 'grid',
  select: (id) => set({ selectedAssetId: id }),
  setMediaView: (view) => {
    try {
      localStorage.setItem('recit.mediaView', view);
    } catch {
      // Storage can be unavailable; the view simply is not remembered.
    }
    set({ mediaView: view });
  },
}));

export const useSelectedAsset = () =>
  useApp((s) => s.assets.find((a) => a.id === s.selectedAssetId) ?? null);

/** Connects the store to backend events once, at start-up. */
export function startBackendSync(): () => void {
  const load = async () => {
    const [project, assets, jobs] = await Promise.all([
      backend.invoke('project.current', {}),
      backend.invoke('media.list', {}),
      backend.invoke('jobs.list', {}),
    ]);
    useApp.setState({ project, assets, jobs });
  };
  const offs = [
    backend.onConnectionChange((connected) => {
      useApp.setState({ connected });
      if (connected) void load();
    }),
    backend.on('project.changed', (project) => useApp.setState({ project, selectedAssetId: null })),
    backend.on('media.changed', (assets) =>
      useApp.setState((s) => ({
        assets,
        selectedAssetId: assets.some((a) => a.id === s.selectedAssetId) ? s.selectedAssetId : null,
      })),
    ),
    backend.on('jobs.changed', (jobs) => useApp.setState({ jobs })),
  ];
  return () => offs.forEach((off) => off());
}
