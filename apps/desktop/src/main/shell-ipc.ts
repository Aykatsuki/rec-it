import { app, BrowserWindow, dialog, ipcMain, shell, type OpenDialogOptions } from 'electron';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  IMPORT_EXTENSIONS,
  IpcError,
  shellContract,
  zodIssues,
  type Handlers,
  type ShellContract,
} from '@rec-it/ipc-contract';
import { IPC, type BridgeResult } from '../shared/bridge';
import { isAppUrl } from './security';
import type { SecretStore } from './secrets';

/**
 * Handles the small renderer → main surface (shellContract). Every call is checked for
 * origin and validated against the contract before and after the handler runs.
 */
export function registerShellIpc(
  secrets: SecretStore,
  onSecretsChanged: () => Promise<void>,
): void {
  const handlersFor = (win: BrowserWindow | null): Handlers<ShellContract> => {
    const open = (options: OpenDialogOptions) =>
      win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
    return {
      'shell.getInfo': () => ({
        appVersion: app.getVersion(),
        platform: process.platform,
        isPackaged: app.isPackaged,
        versions: {
          electron: process.versions.electron,
          chrome: process.versions.chrome,
          node: process.versions.node,
        },
      }),
      'secrets.set': async ({ name, value }) => {
        await secrets.set(name, value);
        await onSecretsChanged();
        return { ok: true as const };
      },
      'secrets.clear': async ({ name }) => {
        secrets.clear(name);
        await onSecretsChanged();
        return { ok: true as const };
      },
      'secrets.status': async () => ({
        encryptionAvailable: await secrets.encryptionAvailable(),
        secrets: secrets.status(),
      }),
      'dialog.importMedia': async () => {
        const result = await open({
          title: 'Import media',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Video, audio and images', extensions: [...IMPORT_EXTENSIONS] },
            { name: 'All files', extensions: ['*'] },
          ],
        });
        return { paths: result.canceled ? [] : result.filePaths };
      },
      'dialog.openProject': async () => {
        const result = await open({
          title: 'Open project',
          properties: ['openFile'],
          filters: [{ name: 'Rec-It project', extensions: ['recit'] }],
        });
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
      },
      'dialog.saveProjectAs': async ({ defaultPath }) => {
        const options = {
          title: 'Save project as',
          defaultPath,
          filters: [{ name: 'Rec-It project', extensions: ['recit'] }],
        };
        const result = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        return { path: result.canceled ? null : (result.filePath ?? null) };
      },
      'dialog.saveExport': async ({ defaultPath }) => {
        const options = {
          title: 'Export video',
          defaultPath,
          filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
        };
        const result = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { path: null };
        const path = result.filePath.toLowerCase().endsWith('.mp4')
          ? result.filePath
          : `${result.filePath}.mp4`;
        return { path };
      },
      'dialog.saveImage': async ({ defaultPath }) => {
        const options = {
          title: 'Save frame',
          defaultPath,
          filters: [
            { name: 'PNG image', extensions: ['png'] },
            { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
          ],
        };
        const result = win
          ? await dialog.showSaveDialog(win, options)
          : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { path: null };
        const path = /\.(png|jpe?g)$/i.test(result.filePath)
          ? result.filePath
          : `${result.filePath}.png`;
        return { path };
      },
      'dialog.chooseFolder': async ({ defaultPath, title }) => {
        const result = await open({
          title,
          defaultPath: defaultPath || undefined,
          properties: ['openDirectory', 'createDirectory'],
        });
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
      },
      'dialog.locateFile': async ({ name }) => {
        const result = await open({ title: `Locate "${name}"`, properties: ['openFile'] });
        return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
      },
      'shell.showItemInFolder': ({ path }) => {
        if (isAbsolute(path) && existsSync(path)) shell.showItemInFolder(path);
        return { ok: true as const };
      },
    };
  };

  ipcMain.handle(IPC.shell, async (event, message: unknown): Promise<BridgeResult> => {
    const fail = (e: IpcError): BridgeResult => ({ ok: false, error: e.toShape() });
    if (!event.senderFrame || !isAppUrl(event.senderFrame.url)) {
      return fail(
        new IpcError({ code: 'INVALID_MESSAGE', message: 'Request from an unexpected origin' }),
      );
    }
    const { channel, payload } = (message ?? {}) as { channel?: unknown; payload?: unknown };
    if (typeof channel !== 'string' || !Object.hasOwn(shellContract.requests, channel)) {
      return fail(
        new IpcError({ code: 'UNKNOWN_CHANNEL', message: `Unknown channel "${String(channel)}"` }),
      );
    }
    const key = channel as keyof ShellContract['requests'];
    const def = shellContract.requests[key];
    const input = def.input.safeParse(payload);
    if (!input.success) {
      return fail(
        new IpcError({
          code: 'INVALID_INPUT',
          message: `Invalid input for "${channel}"`,
          issues: zodIssues(input.error),
        }),
      );
    }
    try {
      const handler = handlersFor(BrowserWindow.fromWebContents(event.sender))[key] as (
        input: unknown,
      ) => unknown;
      return { ok: true, result: def.output.parse(await handler(input.data)) };
    } catch (error) {
      return fail(
        new IpcError({
          code: 'HANDLER_ERROR',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
}
