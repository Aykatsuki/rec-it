import { create } from 'zustand';
import type { Sequence, TimelineItem, TrackKind, Transform } from '@rec-it/core';
import type {
  DocumentState,
  ExportState,
  JobSummary,
  MediaAsset,
  ProjectInfo,
  Transcript,
  TranscriptionStatus,
} from '@rec-it/ipc-contract';
import { backend } from './api';

interface AppState {
  connected: boolean;
  /** undefined until the backend has answered; null when no project is open. */
  project: ProjectInfo | null | undefined;
  assets: MediaAsset[];
  jobs: JobSummary[];
  docState: DocumentState | null;
  exportState: ExportState;

  selectedAssetId: string | null;
  selectedItemIds: string[];
  /** Which part of the UI keyboard shortcuts (Delete) act on. */
  focus: 'media' | 'timeline';
  /** What the preview shows: the selected media item, or the timeline. */
  monitor: 'source' | 'program';
  /** Timeline playhead in seconds. */
  playhead: number;
  playing: boolean;
  /** Playback speed while playing: 1 normal, 2/4/8 fast forward, negative plays backwards (J/K/L). */
  rate: number;
  /** Timeline zoom in pixels per second. */
  zoom: number;
  snapping: boolean;
  mediaView: 'grid' | 'list';
  /** Preview engine: GPU (WebCodecs + WebGL2, frame-accurate) or the compatible media-element one. */
  previewEngine: 'gpu' | 'compatible';
  /** Set when the GPU preview failed this session; choosing it again clears this. */
  gpuFailed: string | null;
  setPreviewEngine(engine: 'gpu' | 'compatible'): void;
  /** A transform being dragged (preview or inspector) before it is committed as an edit. */
  draftTransform: { itemId: string; transform: Transform } | null;
  /** Clips copied with Ctrl+C, ready to paste. */
  clipboard: ClipboardClip[];
  /** Transcription engine, jobs and which media has a transcript. */
  transcription: TranscriptionStatus | null;
  /** Loaded transcripts by asset id. */
  transcripts: Record<string, Transcript>;

  select(id: string | null): void;
  selectItems(ids: string[]): void;
  setPlayhead(seconds: number): void;
  setPlaying(playing: boolean): void;
  setZoom(pps: number): void;
  setMediaView(view: 'grid' | 'list'): void;
  setDraftTransform(draft: { itemId: string; transform: Transform } | null): void;
}

export interface ClipboardClip {
  assetId: string;
  /** Track index among tracks of the same kind (0 = top video / first audio). */
  trackKind: TrackKind;
  /** Caption clips: their words, in flicks from the clip's start. */
  caption?: { text: string; start: number; end: number }[];
  trackIndex: number;
  /** Offset from the earliest copied clip, in flicks. */
  offset: number;
  sourceIn: number;
  duration: number;
  volume: number;
  muted: boolean;
  transform: Transform;
  keyframes?: TimelineItem['keyframes'];
  /** Original link id, so pasted linked clips are linked to each other. */
  linkKey?: string;
}

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the setting simply is not remembered.
  }
};

export const useApp = create<AppState>((set) => ({
  connected: false,
  project: undefined,
  assets: [],
  jobs: [],
  docState: null,
  exportState: { state: 'idle', progress: 0 },
  selectedAssetId: null,
  selectedItemIds: [],
  focus: 'media',
  monitor: 'program',
  playhead: 0,
  playing: false,
  rate: 1,
  zoom: Number(stored('recit.zoom')) || 80,
  snapping: true,
  mediaView: (stored('recit.mediaView') as 'grid' | 'list' | null) ?? 'grid',
  draftTransform: null,
  clipboard: [],
  transcription: null,
  transcripts: {},
  previewEngine: stored('recit.previewEngine') === 'compatible' ? 'compatible' : 'gpu',
  gpuFailed: null,
  setPreviewEngine: (previewEngine) => {
    store('recit.previewEngine', previewEngine);
    set({ previewEngine, gpuFailed: null });
  },
  setDraftTransform: (draftTransform) => set({ draftTransform }),
  select: (id) =>
    set({
      selectedAssetId: id,
      focus: 'media',
      monitor: id ? 'source' : 'program',
      playing: false,
    }),
  selectItems: (ids) => set({ selectedItemIds: ids, focus: 'timeline', monitor: 'program' }),
  setPlayhead: (seconds) => set({ playhead: Math.max(0, seconds), monitor: 'program' }),
  setPlaying: (playing) =>
    set({ playing, ...(playing ? { monitor: 'program' as const } : { rate: 1 }) }),
  setZoom: (pps) => {
    const zoom = Math.min(600, Math.max(4, pps));
    store('recit.zoom', String(zoom));
    set({ zoom });
  },
  setMediaView: (view) => {
    store('recit.mediaView', view);
    set({ mediaView: view });
  },
}));

export const useSelectedAsset = () =>
  useApp((s) => s.assets.find((a) => a.id === s.selectedAssetId) ?? null);

export function activeSequence(state: Pick<AppState, 'docState'>): Sequence | null {
  const doc = state.docState?.doc;
  if (!doc) return null;
  return (doc.sequences.find((s) => s.id === doc.activeSequenceId) ??
    doc.sequences[0] ??
    null) as Sequence | null;
}
export const useSequence = () => useApp((s) => activeSequence(s));

/** Connects the store to backend events once, at start-up. */
export function startBackendSync(): () => void {
  const load = async () => {
    const [project, assets, jobs, exportState] = await Promise.all([
      backend.invoke('project.current', {}),
      backend.invoke('media.list', {}),
      backend.invoke('jobs.list', {}),
      backend.invoke('export.status', {}),
    ]);
    const docState = project ? await backend.invoke('doc.get', {}) : null;
    useApp.setState({ project, assets, jobs, docState, exportState });
    syncTranscripts(await backend.invoke('transcript.status', {}), true);
  };
  const offs = [
    backend.onConnectionChange((connected) => {
      useApp.setState({ connected });
      if (connected) void load();
    }),
    backend.on('project.changed', (project) =>
      useApp.setState((s) =>
        // Updates to the same project (rename, save, recent list) keep the selection and
        // playhead; only opening, creating or closing a project resets them.
        s.project?.id === project?.id && project
          ? { project }
          : {
              project,
              selectedAssetId: null,
              selectedItemIds: [],
              playhead: 0,
              playing: false,
              transcripts: {},
              ...(project ? {} : { docState: null }),
            },
      ),
    ),
    backend.on('media.changed', (assets) =>
      useApp.setState((s) => ({
        assets,
        selectedAssetId: assets.some((a) => a.id === s.selectedAssetId) ? s.selectedAssetId : null,
      })),
    ),
    backend.on('jobs.changed', (jobs) => useApp.setState({ jobs })),
    backend.on('doc.changed', (docState) =>
      useApp.setState((s) => {
        const seq = activeSequence({ docState });
        const alive = new Set(seq?.tracks.flatMap((t) => t.items.map((i) => i.id)) ?? []);
        return { docState, selectedItemIds: s.selectedItemIds.filter((id) => alive.has(id)) };
      }),
    ),
    backend.on('export.changed', (exportState) => useApp.setState({ exportState })),
    backend.on('transcript.changed', (status) => syncTranscripts(status)),
  ];
  return () => offs.forEach((off) => off());
}

/** Stores the transcription status and loads transcripts that are new or were just redone. */
function syncTranscripts(status: TranscriptionStatus, reload = false): void {
  const before = useApp.getState();
  const wasDone = new Set(
    (before.transcription?.jobs ?? []).filter((j) => j.state === 'done').map((j) => j.assetId),
  );
  const fresh = new Set(
    status.jobs.filter((j) => j.state === 'done' && !wasDone.has(j.assetId)).map((j) => j.assetId),
  );
  const keep = Object.fromEntries(
    Object.entries(before.transcripts).filter(
      ([id]) => status.transcribed.includes(id) && !fresh.has(id) && !reload,
    ),
  );
  useApp.setState({ transcription: status, transcripts: keep });
  for (const assetId of status.transcribed) {
    if (keep[assetId]) continue;
    void backend
      .invoke('transcript.get', { assetId })
      .then((t) => {
        if (t) useApp.setState((s) => ({ transcripts: { ...s.transcripts, [assetId]: t } }));
      })
      .catch(() => {});
  }
}
