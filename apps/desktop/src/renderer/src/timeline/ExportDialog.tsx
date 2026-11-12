import { useState } from 'react';
import { create } from 'zustand';
import { CheckCircle2, FolderSearch, X } from 'lucide-react';
import type { Sequence } from '@rec-it/core';
import { Button, Dialog } from '@rec-it/ui';
import { backend, shell } from '../api';
import { sequenceSeconds } from '../edit';
import { formatDuration, formatFps } from '../format';
import { useSystemStatus } from '../hooks';
import { notify } from '../notifications';
import { useApp, useSequence } from '../store';

const useExportDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openExportDialog = () => useExportDialog.setState({ open: true });

type Quality = 'draft' | 'standard' | 'high';
const QUALITY: Record<Quality, string> = {
  draft: 'Draft — fast, smaller file',
  standard: 'Standard — recommended for YouTube',
  high: 'High — larger file, best detail',
};

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
  const [quality, setQuality] = useState<Quality>('standard');
  const duration = sequenceSeconds(seq);
  const running = exportState.state === 'running';
  const encoder = status?.ffmpeg.nvencUsable
    ? 'NVIDIA NVENC (GPU)'
    : status?.ffmpeg.encoders.libx264
      ? 'x264 (CPU)'
      : 'available encoder';

  const start = async () => {
    if (!seq || !project) return;
    const folder = project.path.replace(/[\\/][^\\/]*$/, '');
    const sep = project.path.includes('\\') ? '\\' : '/';
    const { path } = await shell.invoke('dialog.saveExport', {
      defaultPath: `${folder}${sep}${seq.name}.mp4`,
    });
    if (!path) return;
    try {
      await backend.invoke('export.start', { sequenceId: seq.id, path, quality });
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
              <dd>{seq.name}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>
                {seq.width}×{seq.height} · {formatFps(seq.fps)} fps
              </dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{formatDuration(duration)}</dd>
            </div>
            <div>
              <dt>Encoder</dt>
              <dd>{encoder} · H.264 + AAC (MP4)</dd>
            </div>
          </dl>
        ) : (
          <p>There is no sequence to export yet.</p>
        )}
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
                checked={quality === q}
                onChange={() => setQuality(q)}
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
                <span>Exporting… {Math.round(exportState.progress * 100)}%</span>
              </>
            )}
            {exportState.state === 'done' && (
              <span>
                <CheckCircle2 size={15} /> Exported to {exportState.path}
                {exportState.startedAt && exportState.finishedAt
                  ? ` in ${Math.max(1, Math.round((exportState.finishedAt - exportState.startedAt) / 1000))} s`
                  : ''}
              </span>
            )}
            {exportState.state === 'failed' && (
              <span className="form__error">Export failed: {exportState.error}</span>
            )}
            {exportState.state === 'cancelled' && <span>Export cancelled.</span>}
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
                disabled={!seq || duration <= 0}
                onClick={() => void start()}
              >
                Export…
              </Button>
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}
