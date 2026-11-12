import { Download, Redo2, Settings, Sparkles, Undo2 } from 'lucide-react';
import { Button, IconButton } from '@rec-it/ui';
import { useSettings } from '../hooks';
import { ProjectMenu } from '../project/ProjectMenu';

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { settings } = useSettings();
  return (
    <header className="topbar" data-region="topbar">
      <div className="topbar__brand">
        <span className="brand-mark" aria-hidden />
        <span className="brand-name">Rec-It</span>
        <span className="topbar__divider" aria-hidden />
        <ProjectMenu />
      </div>
      <div className="topbar__actions">
        <IconButton label="Undo (arrives with the timeline in Phase 2)" disabled>
          <Undo2 size={16} />
        </IconButton>
        <IconButton label="Redo (arrives with the timeline in Phase 2)" disabled>
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
          disabled
          title="Export arrives in Phase 3"
        >
          Export
        </Button>
      </div>
    </header>
  );
}
