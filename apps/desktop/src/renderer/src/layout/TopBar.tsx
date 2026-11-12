import { Download, Redo2, Settings, Sparkles, Undo2 } from 'lucide-react';
import { Button, IconButton } from '@rec-it/ui';
import { useSettings } from '../hooks';
import { redo, sequenceSeconds, undo } from '../edit';
import { useApp, useSequence } from '../store';
import { openExportDialog } from '../timeline/ExportDialog';
import { ProjectMenu } from '../project/ProjectMenu';

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { settings } = useSettings();
  const project = useApp((s) => s.project);
  const docState = useApp((s) => s.docState);
  const exportState = useApp((s) => s.exportState);
  const seq = useSequence();
  const canExport = !!project && sequenceSeconds(seq) > 0;
  return (
    <header className="topbar" data-region="topbar">
      <div className="topbar__brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Rec-It</span>
        <span className="topbar__divider" aria-hidden />
        <ProjectMenu />
      </div>
      <div className="topbar__actions">
        <IconButton label="Undo (Ctrl+Z)" disabled={!docState?.canUndo} onClick={() => void undo()}>
          <Undo2 size={16} />
        </IconButton>
        <IconButton
          label="Redo (Ctrl+Shift+Z)"
          disabled={!docState?.canRedo}
          onClick={() => void redo()}
        >
          <Redo2 size={16} />
        </IconButton>
        <span className="topbar__divider" aria-hidden />
        <span
          className="claude-pill"
          data-enabled={settings?.aiEnabled ?? true}
          title="Claude connects through your Claude desktop app (Phase 6)"
        >
          <Sparkles size={13} />
          Claude · not connected
        </span>
        <IconButton label="Settings" onClick={onOpenSettings}>
          <Settings size={16} />
        </IconButton>
        <Button
          variant="primary"
          icon={<Download size={15} />}
          disabled={!canExport && exportState.state !== 'running'}
          title={canExport ? 'Export an MP4 (Ctrl+E)' : 'Add clips to the timeline to export'}
          onClick={openExportDialog}
          data-testid="export-button"
        >
          {exportState.state === 'running'
            ? `Exporting ${Math.round(exportState.progress * 100)}%`
            : 'Export'}
        </Button>
      </div>
    </header>
  );
}
