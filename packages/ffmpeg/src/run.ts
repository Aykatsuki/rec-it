import { execFile } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary with an argument array. Never uses a shell (ARCHITECTURE §21), so
 * file names and user text can never be interpreted as commands.
 */
export function runTool(
  binary: string,
  args: readonly string[],
  options: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        shell: false,
        windowsHide: true,
        timeout: options.timeoutMs ?? 15_000,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(error);
          return;
        }
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}
