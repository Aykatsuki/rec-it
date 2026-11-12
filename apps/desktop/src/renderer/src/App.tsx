import { useEffect, useState } from 'react';
import { Upload } from 'lucide-react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { backend } from './api';
import { importFiles, importWithDialog, openProjectWithDialog, saveProjectAs } from './actions';
import { useSettings } from './hooks';
import { LeftRail } from './layout/LeftRail';
import { Preview } from './layout/Preview';
import { RightPanel } from './layout/RightPanel';
import { StatusBar } from './layout/StatusBar';
import { Timeline } from './layout/Timeline';
import { TopBar } from './layout/TopBar';
import { RightsDialogHost } from './media/RightsDialog';
import { Toasts } from './notifications';
import { Welcome } from './project/Welcome';
import { SettingsDialog, type SettingsTab } from './settings/SettingsDialog';
import { startBackendSync, useApp } from './store';

export function App() {
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const { settings } = useSettings();
  const project = useApp((s) => s.project);

  useEffect(() => startBackendSync(), []);
  useShortcuts();
  const dragging = useFileDrop(!!project);

  return (
    <div className="app" data-reduce-motion={settings?.reduceMotion ?? false}>
      <TopBar onOpenSettings={() => setSettingsTab('system')} />
      {project ? <Workspace /> : project === null ? <Welcome /> : <div className="app__loading" />}
      <StatusBar onOpenSettings={setSettingsTab} />
      <SettingsDialog
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsTab(null)}
      />
      <RightsDialogHost />
      <Toasts />
      {dragging && (
        <div className="drop-overlay" aria-hidden>
          <Upload size={28} />
          <span>Drop to import into {project?.name}</span>
        </div>
      )}
    </div>
  );
}

function Workspace() {
  const vertical = useDefaultLayout({ id: 'recit.layout.vertical', storage: localStorage });
  const horizontal = useDefaultLayout({ id: 'recit.layout.horizontal', storage: localStorage });
  return (
    <Group
      orientation="vertical"
      className="app__workspace"
      defaultLayout={vertical.defaultLayout}
      onLayoutChanged={vertical.onLayoutChanged}
    >
      <Panel id="upper" minSize="35">
        <Group
          orientation="horizontal"
          defaultLayout={horizontal.defaultLayout}
          onLayoutChanged={horizontal.onLayoutChanged}
        >
          <Panel id="left" defaultSize="24" minSize={260} maxSize="40">
            <LeftRail />
          </Panel>
          <Separator className="sep sep--col" />
          <Panel id="preview" minSize="28">
            <Preview />
          </Panel>
          <Separator className="sep sep--col" />
          <Panel id="right" defaultSize="22" minSize={270} maxSize="38">
            <RightPanel />
          </Panel>
        </Group>
      </Panel>
      <Separator className="sep sep--row" />
      <Panel id="timeline" defaultSize="32" minSize={160}>
        <Timeline />
      </Panel>
    </Group>
  );
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const inField = !!(e.target as HTMLElement).closest(
        'input, textarea, select, [contenteditable]',
      );
      const mod = e.ctrlKey || e.metaKey;
      const { project, selectedAssetId } = useApp.getState();
      if (mod && e.key.toLowerCase() === 'i' && project) {
        e.preventDefault();
        void importWithDialog();
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProjectWithDialog();
      } else if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void backend.invoke('project.close', {});
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProjectAs();
      } else if (!inField && (e.key === 'Delete' || e.key === 'Backspace') && selectedAssetId) {
        e.preventDefault();
        void backend.invoke('media.remove', { assetIds: [selectedAssetId] });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Accepts files dragged from Explorer anywhere in the window. */
function useFileDrop(enabled: boolean): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      if (enabled) setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      if (!enabled) return;
      const paths = [...(e.dataTransfer?.files ?? [])]
        .map((f) => window.recit.files.pathForFile(f))
        .filter(Boolean);
      void importFiles(paths);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  return dragging;
}
