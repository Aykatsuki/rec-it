import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const appDir = resolve(__dirname, '..');

export function tempUserData(): string {
  return mkdtempSync(join(tmpdir(), 'recit-e2e-'));
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

/** Launches the built app (run `electron-vite build` first) with an isolated profile. */
export async function launch(
  userData: string,
  env: Record<string, string> = {},
): Promise<Launched> {
  const app = await electron.launch({
    // Chromium checks --no-sandbox before any app code runs, so it must be a real argument.
    args: [appDir, ...(process.platform === 'linux' && process.env.CI ? ['--no-sandbox'] : [])],
    env: {
      ...process.env,
      RECIT_E2E: '1',
      RECIT_USER_DATA: userData,
      // The sidecar is covered by its own tests; disabling it keeps e2e fast and offline.
      RECIT_DISABLE_SIDECAR: '1',
      ...(process.platform === 'linux' && process.env.CI ? { RECIT_NO_OS_SANDBOX: '1' } : {}),
      ...env,
    } as Record<string, string>,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}
