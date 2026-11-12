import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { shell: false, windowsHide: true, timeout: 5000, encoding: 'utf8' },
      (_e, stdout) => resolve(stdout ?? ''),
    );
  });
}

/** True if `pid` is a running process whose executable is FFmpeg (guards against pid reuse). */
export async function isFfmpegProcess(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (process.platform === 'win32') {
    const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return /^"ffmpeg(\.exe)?",/im.test(out.trim());
  }
  const out = await run('ps', ['-p', String(pid), '-o', 'comm=']);
  return /(^|\/)ffmpeg$/m.test(out.trim());
}

/** Remembers running FFmpeg pids in a small JSON file. */
export function writePidFile(path: string, pids: number[]): void {
  try {
    writeFileSync(path, JSON.stringify(pids));
  } catch {
    // Best effort: losing this file only weakens orphan clean-up.
  }
}

/**
 * Ends FFmpeg processes listed in the pid file by a previous run that crashed, then clears
 * the file. Only processes that are still FFmpeg are touched. Returns the pids it ended.
 */
export async function killOrphanedFfmpeg(pidFile: string): Promise<number[]> {
  if (!existsSync(pidFile)) return [];
  let pids: number[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(pidFile, 'utf8'));
    if (Array.isArray(parsed)) pids = parsed.filter((p): p is number => Number.isSafeInteger(p));
  } catch {
    // corrupt file: nothing to do
  }
  const killed: number[] = [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    if (await isFfmpegProcess(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
        killed.push(pid);
      } catch {
        // already gone
      }
    }
  }
  writePidFile(pidFile, []);
  return killed;
}
