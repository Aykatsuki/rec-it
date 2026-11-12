// User actions shared by menus, buttons and keyboard shortcuts.
import type { RightsInput } from '@rec-it/ipc-contract';
import { backend, shell } from './api';
import { requestRights } from './media/RightsDialog';
import { notify } from './notifications';
import { useApp } from './store';

export async function importFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  if (!useApp.getState().project) {
    notify('Create or open a project first.', 'warn');
    return;
  }
  const rights = await requestRights(paths.length);
  if (!rights) return;
  const result = await backend.invoke('media.import', { paths, rights });
  if (result.skipped.length) {
    const first = result.skipped[0]!;
    const name = first.path.split(/[\\/]/).pop();
    notify(
      result.skipped.length === 1
        ? `Skipped ${name}: ${first.reason}`
        : `Skipped ${result.skipped.length} files (e.g. ${name}: ${first.reason})`,
      'warn',
    );
  }
  if (result.imported.length) useApp.getState().select(result.imported[0]!);
}

export async function importWithDialog(): Promise<void> {
  const { paths } = await shell.invoke('dialog.importMedia', {});
  await importFiles(paths);
}

export async function openProjectWithDialog(): Promise<void> {
  const { path } = await shell.invoke('dialog.openProject', {});
  if (path) await openProject(path);
}

export async function openProject(path: string): Promise<void> {
  try {
    await backend.invoke('project.open', { path });
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}

export async function saveProjectAs(): Promise<void> {
  const project = useApp.getState().project;
  if (!project) return;
  const defaultPath = project.path.replace(/\.recit$/i, ' copy.recit');
  const { path } = await shell.invoke('dialog.saveProjectAs', { defaultPath });
  if (path) {
    await backend.invoke('project.saveAs', { path });
    notify('Saved a copy and switched to it.');
  }
}

export async function updateRights(assetId: string, current: RightsInput): Promise<void> {
  const rights = await requestRights(1, current);
  if (rights) await backend.invoke('media.updateRights', { assetId, rights });
}

export async function locateAsset(assetId: string, name: string): Promise<void> {
  const { path } = await shell.invoke('dialog.locateFile', { name });
  if (!path) return;
  try {
    await backend.invoke('media.relink', { assetId, path });
    notify(`Found ${name}.`);
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error');
  }
}
