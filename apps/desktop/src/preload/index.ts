import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IpcError,
  backendContract,
  createIpcClient,
  portTransport,
  shellContract,
  zodIssues,
  type BackendContract,
  type IpcClient,
} from '@rec-it/ipc-contract';
import { IPC, type BridgeResult, type RecitBridge } from '../shared/bridge';

// The preload is the only code with access to Electron APIs in the renderer process.
// It exposes a narrow, validated surface on window.recit and nothing else (ADR-001).

let client: IpcClient<BackendContract> | null = null;
let waiters: ((c: IpcClient<BackendContract>) => void)[] = [];
const eventListeners = new Map<string, Set<(payload: unknown) => void>>();
const connectionListeners = new Set<(connected: boolean) => void>();

function setConnected(connected: boolean) {
  for (const l of connectionListeners) l(connected);
}

ipcRenderer.on(IPC.backendPort, (event) => {
  const [port] = event.ports;
  if (!port) return;
  client?.dispose('Backend reconnected');
  const next = createIpcClient(backendContract, portTransport(port), { timeoutMs: 60_000 });
  for (const name of Object.keys(backendContract.events) as (keyof BackendContract['events'])[]) {
    next.on(name, (payload) => {
      for (const l of eventListeners.get(name) ?? []) l(payload);
    });
  }
  client = next;
  for (const w of waiters) w(next);
  waiters = [];
  setConnected(true);
});

ipcRenderer.on(IPC.backendDisconnected, () => {
  client?.dispose('Backend stopped');
  client = null;
  setConnected(false);
});

ipcRenderer.send(IPC.requestBackendPort);

function backendClient(): Promise<IpcClient<BackendContract>> {
  return client ? Promise.resolve(client) : new Promise((resolve) => waiters.push(resolve));
}

function toResult(error: unknown): BridgeResult {
  if (error instanceof IpcError) return { ok: false, error: error.toShape() };
  return {
    ok: false,
    error: {
      code: 'HANDLER_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

const bridge: RecitBridge = {
  backend: {
    async invoke(channel, input) {
      try {
        const c = await backendClient();
        return { ok: true, result: await c.bridge.invoke(channel, input) };
      } catch (error) {
        return toResult(error);
      }
    },
    on(event, listener) {
      if (!Object.hasOwn(backendContract.events, event))
        throw new Error(`Unknown event "${event}"`);
      let set = eventListeners.get(event);
      if (!set) eventListeners.set(event, (set = new Set()));
      set.add(listener);
      return () => set.delete(listener);
    },
    onConnectionChange(listener) {
      connectionListeners.add(listener);
      listener(client !== null);
      return () => connectionListeners.delete(listener);
    },
  },
  files: {
    pathForFile: (file) => webUtils.getPathForFile(file),
  },
  shell: {
    async invoke(channel, input) {
      // Validate here too, so malformed calls never reach the main process.
      const def = Object.hasOwn(shellContract.requests, channel)
        ? shellContract.requests[channel as keyof typeof shellContract.requests]
        : undefined;
      if (!def)
        return {
          ok: false,
          error: { code: 'UNKNOWN_CHANNEL', message: `Unknown channel "${channel}"` },
        };
      const checked = def.input.safeParse(input);
      if (!checked.success) {
        return {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: `Invalid input for "${channel}"`,
            issues: zodIssues(checked.error),
          },
        };
      }
      try {
        return (await ipcRenderer.invoke(IPC.shell, {
          channel,
          payload: checked.data,
        })) as BridgeResult;
      } catch (error) {
        return toResult(error);
      }
    },
  },
};

contextBridge.exposeInMainWorld('recit', bridge);
