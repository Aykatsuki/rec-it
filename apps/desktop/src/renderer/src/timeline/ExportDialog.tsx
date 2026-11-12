import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { CheckCircle2, FolderOpen, FolderSearch, X } from 'lucide-react';
import type { Sequence } from '@rec-it/core';
import { Button, Dialog } from '@rec-it/ui';
import {
  DEFAULT_EXPORT_SETTINGS,
  exportSettingsSchema,
  type ExportSettings,
} from '@rec-it/ipc-contract';
import { encoderLabel, pickExportEncoder } from '@rec-it/render-plan';
import { backend, shell } from '../api';
import { sequenceSeconds } from '../edit';
import { formatDuration, formatFps } from '../format';
import { useSystemStatus } from '../hooks';
import { notify } from '../notifications';
import { useApp, useSequence } from '../store';

const useExportDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openExportDialog = () => useExportDialog.setState({ open: true });

/** Saves the frame under the playhead as an image, rendered exactly like the export. */
export async function exportFrame(seq: Sequence): Promise<void> {
  const { project, playhead } = useApp.getState();
  if (!project) return;
  const stamp = playhead.toFixed(2).replace('.', '_');
  // Start in the export folder, like video exports.
  const target = await backend.invoke('export.target', { fileName: `${seq.name} ${stamp}s` });
  const { path } = await shell.invoke('dialog.saveImage', {
    defaultPath: target.path.replace(/\.mp4$/i, '.png'),
  });
  if (!path) return;
  try {
    await backend.invoke('export.frame', { sequenceId: seq.id, time: playhead, path });
    notify(`Saved frame to ${path}`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}

type Quality = ExportSettings['quality'];
const QUALITY: Record<Quality, string> = {
  draft: 'Draft — fast, smaller file',
  standard: 'Standard — recommended for YouTube',
  high: 'High — larger file, best detail',
};

const PRESETS: { id: string; label: string; hint: string; settings: ExportSettings }[] = [
  {
    id: 'youtube',
    label: 'YouTube Short',
    hint: 'H.264, full size, −14 LUFS: what YouTube recommends.',
    settings: DEFAULT_EXPORT_SETTINGS,
  },
  {
    id: 'high',
    label: 'High quality',
    hint: 'More detail for fast motion and fine textures. Bigger file.',
    settings: { ...DEFAULT_EXPORT_SETTINGS, quality: 'high', audioBitrate: 256 },
  },
  {
    id: 'small',
    label: 'Smaller file',
    hint: 'H.265 (HEVC): about a third smaller at the same quality. Plays on recent phones and computers.',
    settings: { ...DEFAULT_EXPORT_SETTINGS, codec: 'hevc' },
  },
  {
    id: 'draft',
    label: 'Draft',
    hint: 'Half size, fast encoding, no loudness pass. For checking your edit.',
    settings: {
      ...DEFAULT_EXPORT_SETTINGS,
      scale: 0.5,
      quality: 'draft',
      audioBitrate: 128,
      loudness: null,
    },
  },
];

const SCALES = [1, 0.75, 2 / 3, 0.5];
const LOUDNESS: { value: number | null; label: string }[] = [
  { value: -14, label: 'YouTube standard (−14 LUFS)' },
  { value: -11, label: 'Louder (−11 LUFS)' },
  { value: -16, label: 'Podcast / speech (−16 LUFS)' },
  { value: -23, label: 'Broadcast (−23 LUFS)' },
  { value: null, label: 'Off — keep original levels' },
];
/** Rough average video bitrates (Mbit/s) at 1080×1920 for the size estimate. */
const MBPS: Record<Quality, number> = { draft: 4, standard: 10, high: 18 };

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
const sameSettings = (a: ExportSettings, b: ExportSettings) =>
  (Object.keys(a) as (keyof ExportSettings)[]).every((k) => a[k] === b[k]);

function loadSettings(): ExportSettings {
  try {
    const raw = localStorage.getItem('recit.exportSettings');
    if (raw) {
      const parsed = exportSettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }
  } catch {
    // Storage unavailable or corrupt: use the defaults.
  }
  return DEFAULT_EXPORT_SETTINGS;
}
function saveSettings(settings: ExportSettings): void {
  try {
    localStorage.setItem('recit.exportSettings', JSON.stringify(settings));
  } catch {
    // Not remembered; harmless.
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e8 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function ExportDialogHost() {
  const open = useExportDialog((s) => s.open);
  const seq = useSequence();
  if (!open) return null;
  return <ExportForm seq={seq} onClose={() => useExportDialog.setState({ open: false })} />;
}

function ExportForm({ seq, onClose }: { seq: Sequence | null; onClose: () => void }) {
  const exportState = useApp((s) => s.exportState);
  const project = useApp((s) => s.project);
  const { status } = useSystemStatus();
  const [settings, setSettingsState] = useState<ExportSettings>(loadSettings);
  const setSettings = (patch: Partial<ExportSettings>) =>
    setSettingsState((s) => {
      const next = { ...s, ...patch };
      saveSettings(next);
      return next;
    });
  const duration = sequenceSeconds(seq);
  const running = exportState.state === 'running';
  const preset = PRESETS.find((p) => sameSettings(p.settings, settings));
  const ffmpeg = status?.ffmpeg ?? { encoders: {}, nvencUsable: null };
  const pick = (pref: ExportSettings['encoder']) => pickExportEncoder(settings.codec, pref, ffmpeg);
  const chosen = pick(settings.encoder);
  const gpu = pick('gpu');
  const w = seq ? even(seq.width * settings.scale) : 0;
  const h = seq ? even(seq.height * settings.scale) : 0;
  const pixels = (w * h) / (1080 * 1920);
  const videoMbps =
    MBPS[settings.quality] * Math.max(0.15, pixels) * (settings.codec === 'hevc' ? 0.65 : 1);
  const estimate = ((videoMbps * 1e6 + settings.audioBitrate * 1e3) / 8) * duration;

  // Destination: last export folder (remembered by the backend) + an editable file name.
  const [fileName, setFileName] = useState(() => `${seq?.name ?? 'Short'}.mp4`);
  const [directory, setDirectory] = useState<string | undefined>(undefined);
  const [target, setTarget] = useState<{ directory: string; path: string; exists: boolean } | null>(
    null,
  );
  const doneAt = exportState.state === 'done' ? exportState.finishedAt : undefined;
  useEffect(() => {
    let cancelled = false;
    const name = fileName.trim() || 'Short';
    void backend
      .invoke('export.target', { fileName: name, ...(directory ? { directory } : {}) })
      .then((t) => {
        if (!cancelled) setTarget(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // doneAt: after an export the file exists, so the "replace" warning should appear.
  }, [fileName, directory, doneAt]);

  const changeFolder = async () => {
    const { path } = await shell.invoke('dialog.chooseFolder', {
      defaultPath: target?.directory ?? '',
      title: 'Choose export folder',
    });
    if (path) setDirectory(path);
  };

  const start = async () => {
    if (!seq || !project || !target) return;
    try {
      await backend.invoke('export.start', { sequenceId: seq.id, path: target.path, settings });
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error');
    }
  };

  return (
    <Dialog open onClose={onClose} title="Export video" closeIcon={<X size={16} />}>
      <div className="export" data-testid="export-dialog">
        {seq ? (
          <dl className="export__summary">
            <div>
              <dt>Sequence</dt>
              <dd>
                {seq.name} · {formatDuration(duration)}
              </dd>
            </div>
            <div>
              <dt>Output</dt>
              <dd data-testid="export-output">
                {w}×{h} · {formatFps(seq.fps)} fps · {settings.codec === 'hevc' ? 'H.265' : 'H.264'}{' '}
                + AAC (MP4)
              </dd>
            </div>
            <div>
              <dt>Encoder</dt>
              <dd>{chosen ? encoderLabel(chosen) : 'None available for this codec'}</dd>
            </div>
            <div>
              <dt>Estimated size</dt>
              <dd>about {formatBytes(estimate)}</dd>
            </div>
          </dl>
        ) : (
          <p>There is no sequence to export yet.</p>
        )}
        <div
          className="segmented segmented--wide export__presets"
          role="radiogroup"
          aria-label="Preset"
        >
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={preset?.id === p.id}
              title={p.hint}
              disabled={running}
              onClick={() => setSettings(p.settings)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="form__hint">{preset ? preset.hint : 'Custom settings.'}</p>
        <div className="export__grid">
          <div className="form__field export__wide">
            <span>Save to</span>
            <div className="export__dest">
              <span
                className="export__folder"
                title={target?.directory}
                data-testid="export-folder"
              >
                {target?.directory ?? '…'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<FolderOpen size={13} />}
                disabled={running}
                onClick={() => void changeFolder()}
              >
                Change…
              </Button>
            </div>
          </div>
          <label className="form__field export__wide">
            <span>File name</span>
            <input
              className="ui-input"
              value={fileName}
              disabled={running}
              aria-label="File name"
              onChange={(e) => setFileName(e.target.value)}
            />
            {target?.exists && exportState.state !== 'running' && (
              <span className="form__hint form__hint--warn" data-testid="export-exists">
                A file called {target.path.split(/[\\/]/).pop()} is already in this folder.
                Exporting replaces it.
              </span>
            )}
          </label>
          <label className="form__field">
            <span>Resolution</span>
            <select
              className="ui-input"
              value={SCALES.find((v) => Math.abs(v - settings.scale) < 0.001) ?? 1}
              disabled={running || !seq}
              onChange={(e) => setSettings({ scale: Number(e.target.value) })}
            >
              {SCALES.map((v) => (
                <option key={v} value={v}>
                  {seq ? `${even(seq.width * v)}×${even(seq.height * v)}` : ''}
                  {v === 1 ? ' (sequence size)' : ` (${Math.round(v * 100)}%)`}
                </option>
              ))}
            </select>
          </label>
          <label className="form__field">
            <span>Video format</span>
            <select
              className="ui-input"
              value={settings.codec}
              disabled={running}
              onChange={(e) => setSettings({ codec: e.target.value as ExportSettings['codec'] })}
            >
              <option value="h264">H.264 — plays everywhere</option>
              <option value="hevc">H.265 (HEVC) — smaller file</option>
            </select>
          </label>
          <label className="form__field">
            <span>Encoder</span>
            <select
              className="ui-input"
              value={settings.encoder}
              disabled={running}
              onChange={(e) =>
                setSettings({ encoder: e.target.value as ExportSettings['encoder'] })
              }
            >
              <option value="auto">
                Automatic{pick('auto') ? ` (${encoderLabel(pick('auto')!)})` : ''}
              </option>
              <option value="gpu" disabled={!gpu}>
                Graphics card{gpu ? ` (${encoderLabel(gpu)})` : ' (not available)'}
              </option>
              <option value="cpu">Software — slower, very consistent</option>
            </select>
          </label>
          <label className="form__field">
            <span>Audio</span>
            <select
              className="ui-input"
              value={settings.audioBitrate}
              disabled={running}
              onChange={(e) =>
                setSettings({
                  audioBitrate: Number(e.target.value) as ExportSettings['audioBitrate'],
                })
              }
            >
              {[128, 192, 256, 320].map((k) => (
                <option key={k} value={k}>
                  AAC {k} kbit/s{k === 192 ? ' (recommended)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="form__field export__wide">
            <span>Loudness</span>
            <select
              className="ui-input"
              value={settings.loudness === null ? 'off' : String(settings.loudness)}
              disabled={running}
              onChange={(e) =>
                setSettings({ loudness: e.target.value === 'off' ? null : Number(e.target.value) })
              }
            >
              {LOUDNESS.map((l) => (
                <option key={l.label} value={l.value === null ? 'off' : String(l.value)}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {duration > 180 && seq && seq.height > seq.width && (
          <p className="form__hint">
            YouTube treats vertical videos up to 3 minutes long as Shorts. This one is longer.
          </p>
        )}
        <fieldset className="export__quality" disabled={running}>
          <legend>Quality</legend>
          {(Object.keys(QUALITY) as Quality[]).map((q) => (
            <label key={q}>
              <input
                type="radio"
                name="quality"
                checked={settings.quality === q}
                onChange={() => setSettings({ quality: q })}
              />
              {QUALITY[q]}
            </label>
          ))}
        </fieldset>

        {exportState.state !== 'idle' && (
          <div
            className="export__status"
            data-state={exportState.state}
            data-testid="export-status"
          >
            {exportState.state === 'running' && (
              <>
                <div className="progress">
                  <div
                    className="progress__bar"
                    style={{ width: `${Math.round(exportState.progress * 100)}%` }}
                  />
                </div>
                <span>
                  {exportState.phase === 'analysing'
                    ? 'Measuring loudness…'
                    : `Exporting with ${exportState.encoder ?? 'FFmpeg'}…`}{' '}
                  {Math.round(exportState.progress * 100)}%
                </span>
              </>
            )}
            {exportState.state === 'done' && (
              <span>
                <CheckCircle2 size={15} /> Exported to {exportState.path}
                {exportState.sizeBytes ? ` (${formatBytes(exportState.sizeBytes)})` : ''}
                {exportState.startedAt && exportState.finishedAt
                  ? ` in ${Math.max(1, Math.round((exportState.finishedAt - exportState.startedAt) / 1000))} s`
                  : ''}
              </span>
            )}
            {exportState.state === 'failed' && (
              <span className="form__error">Export failed: {exportState.error}</span>
            )}
            {exportState.state === 'cancelled' && <span>Export cancelled.</span>}
            {exportState.note && <span className="form__hint">{exportState.note}</span>}
          </div>
        )}

        <div className="dialog-actions">
          {exportState.state === 'done' && exportState.path && (
            <Button
              variant="ghost"
              icon={<FolderSearch size={14} />}
              onClick={() =>
                void shell.invoke('shell.showItemInFolder', { path: exportState.path! })
              }
            >
              Show in folder
            </Button>
          )}
          {running ? (
            <Button variant="danger" onClick={() => void backend.invoke('export.cancel', {})}>
              Cancel export
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="primary"
                disabled={!seq || duration <= 0 || !target}
                onClick={() => void start()}
              >
                {target?.exists ? 'Replace and export' : 'Export'}
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
