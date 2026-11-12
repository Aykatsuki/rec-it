import { app } from 'electron';
import { join, resolve } from 'node:path';

/** Repository root in development (out/main → apps/desktop → repo). */
export function repoRoot(): string {
  return resolve(__dirname, '../../../..');
}

export function bundledFfmpegDir(): string {
  const platformDir = `${process.platform}-${process.arch}`;
  return app.isPackaged
    ? join(process.resourcesPath, 'ffmpeg', platformDir)
    : join(repoRoot(), 'resources', 'ffmpeg', platformDir);
}

export interface SidecarCommand {
  command: string;
  args: string[];
  cwd: string;
}

/** How to start the Python sidecar. Packaged builds get a bundled runtime in Phase 10. */
export function sidecarCommand(): SidecarCommand {
  const project = join(repoRoot(), 'services', 'media-ai');
  return {
    command: process.env.RECIT_UV_PATH ?? 'uv',
    args: ['run', '--project', project, '--quiet', 'python', '-m', 'recit_media_ai'],
    cwd: project,
  };
}
