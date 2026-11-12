// Backend entry point, run by Electron as a utilityProcess (ADR-001).
import { killAllFfmpeg } from '@rec-it/ffmpeg';
import type { PortLike, SecretName } from '@rec-it/ipc-contract';
import type { BackendToMain, MainToBackend } from '../shared/backend-messages';
import { BackendApp } from './app';

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: MainToBackend; ports: PortLike[] }) => void): void;
  postMessage(message: BackendToMain): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;
if (!parentPort) {
  console.error('The backend must be started by Electron as a utilityProcess.');
  process.exit(1);
}

let app: BackendApp | null = null;
let pendingSecrets: Partial<Record<SecretName, string>> | null = null;
const pendingPorts: PortLike[] = [];

parentPort.on('message', ({ data, ports }) => {
  switch (data.type) {
    case 'init': {
      if (app) return;
      try {
        app = new BackendApp(data.config, {
          onCacheRoot: (path) => parentPort.postMessage({ type: 'cacheRoot', path }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`failed to start: ${message}`);
        parentPort.postMessage({ type: 'fatal', message });
        process.exit(1);
      }
      if (pendingSecrets) app.setSecrets(pendingSecrets);
      for (const port of pendingPorts.splice(0)) app.attach(port);
      void app.start();
      parentPort.postMessage({ type: 'ready' });
      console.info(`started (Node ${process.versions.node})`);
      break;
    }
    case 'secrets':
      if (app) app.setSecrets(data.values);
      else pendingSecrets = data.values;
      break;
    case 'shutdown':
      void (app?.dispose() ?? Promise.resolve()).finally(() => process.exit(0));
      break;
    case 'connect': {
      const [port] = ports;
      if (!port) return;
      if (app) app.attach(port);
      else pendingPorts.push(port);
      break;
    }
  }
});

process.on('uncaughtException', (error) => {
  console.error(`uncaught exception: ${error.stack ?? error.message}`);
  parentPort.postMessage({ type: 'fatal', message: error.message });
  process.exit(1);
});

process.on('SIGTERM', () => {
  void (app?.dispose() ?? Promise.resolve()).finally(() => process.exit(0));
});

// If the main process dies without shutting us down (a crash, or killed from Task Manager),
// stop FFmpeg and exit. On Windows child processes are not killed with their parent, and
// leftovers would keep files locked and block Rec-It from starting again.
const parentPid = process.ppid;
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    console.error('main process has gone; stopping');
    killAllFfmpeg();
    process.exit(1);
  }
}, 500).unref();

process.on('exit', () => killAllFfmpeg());
