import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, tempUserData } from './helpers';

test.describe('renderer security', () => {
  test('has no Node access and only the narrow bridge', async () => {
    const { app, page } = await launch(tempUserData());
    try {
      const globals = await page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        process: typeof (window as unknown as { process?: unknown }).process,
        module: typeof (window as unknown as { module?: unknown }).module,
        bridgeKeys: Object.keys(window.recit).sort(),
        backendKeys: Object.keys(window.recit.backend).sort(),
      }));
      expect(globals).toEqual({
        require: 'undefined',
        process: 'undefined',
        module: 'undefined',
        bridgeKeys: ['backend', 'files', 'shell'],
        backendKeys: ['invoke', 'on', 'onConnectionChange'],
      });

      // With context isolation the preload's own variables (e.g. ipcRenderer) are not reachable.
      const leaked = await page.evaluate(() =>
        ['ipcRenderer', 'contextBridge', 'electron'].filter(
          (k) => k in (window as unknown as Record<string, unknown>),
        ),
      );
      expect(leaked).toEqual([]);

      const csp = await page
        .locator('meta[http-equiv="Content-Security-Policy"]')
        .getAttribute('content');
      expect(csp).toContain("script-src 'self'");
      // JavaScript eval stays forbidden; only WebAssembly compilation (the caption renderer,
      // ADR-032) is allowed.
      expect(csp).not.toMatch(/'unsafe-eval'/);
      expect(csp).toContain("'wasm-unsafe-eval'");
    } finally {
      await app.close();
    }
  });

  test('blocks new windows and navigation away from the app', async () => {
    const { app, page } = await launch(tempUserData());
    try {
      const urlBefore = page.url();
      await page.evaluate(() => window.open('https://example.com'));
      await page.evaluate(() => {
        window.location.href = 'https://example.com';
      });
      await page.waitForTimeout(500);
      expect(app.windows()).toHaveLength(1);
      expect(page.url()).toBe(urlBefore);
    } finally {
      await app.close();
    }
  });

  test('rejects invalid and unknown IPC calls', async () => {
    const { app, page } = await launch(tempUserData());
    try {
      const results = await page.evaluate(async () => [
        await window.recit.backend.invoke('settings.update', { isAdmin: true }),
        await window.recit.backend.invoke('fs.readFile', { path: '/etc/passwd' }),
        await window.recit.shell.invoke('secrets.set', { name: 'anthropicApiKey', value: 'x' }),
      ]);
      expect(results.map((r) => (r.ok ? 'ok' : r.error.code))).toEqual([
        'INVALID_INPUT',
        'UNKNOWN_CHANNEL',
        'INVALID_INPUT',
      ]);
    } finally {
      await app.close();
    }
  });

  test('stores secrets encrypted, survives restart, and never returns them to the renderer', async () => {
    const userData = tempUserData();
    const secret = `rec-it-e2e-${Date.now()}-secret`;
    const expected = createHash('sha256').update(secret).digest('hex').slice(0, 12);

    let { app, page } = await launch(userData);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'Keys' }).click();
    const form = page.getByTestId('secret-testSecret');
    await form.getByLabel('Test secret').fill(secret);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('fingerprint-testSecret')).toHaveText(expected);
    await app.close();

    const onDisk = readFileSync(join(userData, 'secrets.json'), 'utf8');
    expect(onDisk).not.toContain(secret);

    ({ app, page } = await launch(userData));
    try {
      const status = await page.evaluate(() => window.recit.backend.invoke('system.getStatus', {}));
      expect(status).toMatchObject({
        ok: true,
        result: { secrets: { testSecret: { set: true, fingerprint: expected } } },
      });
      const everything = await page.evaluate(async () =>
        JSON.stringify([
          await window.recit.backend.invoke('system.getStatus', {}),
          await window.recit.shell.invoke('secrets.status', {}),
          document.documentElement.outerHTML,
        ]),
      );
      expect(everything).not.toContain(secret);
    } finally {
      await app.close();
    }
  });
});
