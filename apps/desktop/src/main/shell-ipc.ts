import { app, ipcMain } from 'electron';
import {
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
  const handlers: Handlers<ShellContract> = {
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
      const handler = handlers[key] as (input: unknown) => unknown;
      const output = def.output.parse(await handler(input.data));
      return { ok: true, result: output };
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
