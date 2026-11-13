// Optional parts of the Python sidecar (transcription, face detection) are installed on demand
// with `uv sync --extra <name> --inexact` (inexact keeps the other extras that are installed).
import { spawn } from 'node:child_process';
import type { SidecarCommand } from './sidecar';

export type InstallState = { state: 'idle' | 'running' | 'failed'; message?: string };

/**
 * Installs one extra into the sidecar's environment. `onUpdate` receives the progress (the last
 * line uv printed) and finally 'idle' (done) or 'failed'.
 */
export function installExtra(
  cmd: SidecarCommand,
  extra: string,
  onUpdate: (state: InstallState, finished: boolean) => void,
): void {
  onUpdate({ state: 'running', message: 'Starting…' }, false);
  const child = spawn(cmd.command, ['sync', '--project', cmd.cwd, '--extra', extra, '--inexact'], {
    cwd: cmd.cwd,
    shell: false,
    windowsHide: true,
    env: process.env,
  });
  let last = '';
  let failed = false;
  const onData = (chunk: Buffer) => {
    const line = chunk.toString('utf8').trim().split(/\r?\n/).pop();
    if (line) {
      last = line.slice(0, 200);
      onUpdate({ state: 'running', message: last }, false);
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (e) => {
    failed = true;
    onUpdate({ state: 'failed', message: e.message }, false);
  });
  child.on('close', (code) => {
    if (failed) onUpdate({ state: 'failed', message: last }, true);
    else if (code === 0) onUpdate({ state: 'idle' }, true);
    else onUpdate({ state: 'failed', message: last || `uv exited with code ${code}` }, true);
  });
}
