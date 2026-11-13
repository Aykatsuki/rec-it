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
import { Timeline } from './timeline/Timeline';
import { ExportDialogHost, openExportDialog } from './timeline/ExportDialog';
import { CropDialog } from './timeline/CropDialog';
import { SequenceSettingsHost } from './timeline/SequenceSettings';
import { shuttle, stepFrames, togglePlay } from './timeline/ProgramMonitor';
import { ContextMenuHost } from './ui/ContextMenu';
import {
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  paste,
  redo,
  selectAll,
  sequenceSeconds,
  splitAtPlayhead,
  undo,
} from './edit';
import { activeSequence } from './store';
import { TopBar } from './layout/TopBar';
import { RightsDialogHost } from './media/RightsDialog';
import { notify, Toasts } from './notifications';
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
      <SequenceSettingsHost />
      <ExportDialogHost />
      <CropDialog />
      <ContextMenuHost />
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
      const target = e.target as HTMLElement;
      const inField = !!target.closest(
        'input:not([type=range]), textarea, select, [contenteditable], dialog',
      );
      const mod = e.ctrlKey || e.metaKey;
      // A focused slider uses the arrow keys, Home and End itself.
      if (
        target.matches('input[type=range]') &&
        [
          'ArrowLeft',
          'ArrowRight',
          'ArrowUp',
          'ArrowDown',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(e.key)
      )
        return;
      const key = e.key.toLowerCase();
      const state = useApp.getState();
      const { project, selectedAssetId, selectedItemIds, focus, monitor } = state;
      const seq = activeSequence(state);

      if (mod && key === 'i' && project) {
        e.preventDefault();
        void importWithDialog();
      } else if (mod && key === 'o') {
        e.preventDefault();
        void openProjectWithDialog();
      } else if (mod && key === 'n') {
        e.preventDefault();
        void backend.invoke('project.close', {});
      } else if (mod && e.shiftKey && key === 's') {
        e.preventDefault();
        void saveProjectAs();
      } else if (mod && key === 'e' && project && sequenceSeconds(seq) > 0) {
        e.preventDefault();
        openExportDialog();
      } else if (inField) {
        return;
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        void redo();
      } else if (mod && key === 'z') {
        e.preventDefault();
        void undo();
      } else if (mod && key === 'c' && focus === 'timeline') {
        if (copySelected()) e.preventDefault();
      } else if (mod && key === 'x' && focus === 'timeline') {
        e.preventDefault();
        void cutSelected();
      } else if (mod && key === 'v' && seq) {
        e.preventDefault();
        void paste();
      } else if (mod && key === 'd' && focus === 'timeline') {
        e.preventDefault();
        void duplicateSelected();
      } else if (mod && key === 'a' && focus === 'timeline' && seq) {
        e.preventDefault();
        selectAll();
      } else if (e.key === 'Escape' && focus === 'timeline') {
        state.selectItems([]);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (focus === 'timeline' && selectedItemIds.length) void deleteSelected(e.shiftKey);
        else if (selectedAssetId)
          void backend
            .invoke('media.remove', { assetIds: [selectedAssetId] })
            .catch((err: unknown) => notify(String((err as Error).message ?? err), 'warn'));
      } else if (!seq || monitor === 'source') {
        return;
      } else if (e.code === 'Space') {
        e.preventDefault();
        togglePlay(seq);
      } else if (key === 's' && !mod) {
        e.preventDefault();
        void splitAtPlayhead();
      } else if ((key === 'j' || key === 'k' || key === 'l') && !mod) {
        e.preventDefault();
        shuttle(seq, key);
      } else if (key === 'n' && !mod) {
        useApp.setState({ snapping: !state.snapping });
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepFrames(seq, e.shiftKey ? -10 : -1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepFrames(seq, e.shiftKey ? 10 : 1);
      } else if (e.key === 'Home') {
        state.setPlayhead(0);
      } else if (e.key === 'End') {
        state.setPlayhead(sequenceSeconds(seq));
      } else if (e.key === '+' || e.key === '=') {
        state.setZoom(state.zoom * 1.5);
      } else if (e.key === '-') {
        state.setZoom(state.zoom / 1.5);
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
