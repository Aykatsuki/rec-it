import { expect, test } from '@playwright/test';
import { launch, tempUserData } from './helpers';

test.describe('Phase 0 shell', () => {
  test('opens the dark editor layout and connects to the backend', async () => {
    const { app, page } = await launch(tempUserData());
    try {
      await expect(page).toHaveTitle('Rec-It');
      for (const region of [
        'topbar',
        'left-rail',
        'preview',
        'right-panel',
        'timeline',
        'statusbar',
      ]) {
        await expect(page.locator(`[data-region="${region}"]`)).toBeVisible();
      }
      await expect(page.getByTestId('status-backend')).toContainText(/Backend · \d/);
      await expect(page.getByTestId('status-ffmpeg')).not.toContainText('Checking');

      const ping = await page.evaluate(async () =>
        window.recit.backend.invoke('app.ping', { sentAt: Date.now() }),
      );
      expect(ping).toMatchObject({ ok: true, result: { backendVersion: expect.any(String) } });

      const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(background).toBe('rgb(11, 12, 15)');
    } finally {
      await app.close();
    }
  });

  test('settings persist across restarts', async () => {
    const userData = tempUserData();
    let { app, page } = await launch(userData);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('tab', { name: 'General' }).click();
    await page.getByLabel('Transcription device').or(page.locator('select')).selectOption('cpu');
    await expect(page.locator('select')).toHaveValue('cpu');
    await app.close();

    ({ app, page } = await launch(userData));
    try {
      const result = await page.evaluate(() => window.recit.backend.invoke('settings.get', {}));
      expect(result).toMatchObject({ ok: true, result: { transcriptionDevice: 'cpu' } });
    } finally {
      await app.close();
    }
  });
});
