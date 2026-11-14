// The Claude connector end to end (ADR-044): a real MCP client starts the built bridge
// (apps/mcp/dist), which finds the running app, edits the project live, and the user sees the
// change card, undoes it in one step and answers a confirmation.
import { expect, test } from '@playwright/test';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { findTestFfmpeg, makeFixtures, type Fixtures } from '../../../packages/ffmpeg/src/testing';
import { createProject, launch, mockOpenDialog, tempUserData } from './helpers';

const bins = findTestFfmpeg();
const bridge = resolve(__dirname, '../../mcp/dist/recit-mcp.js');
let fx: Fixtures;

type Result = { content: { type: string; text?: string }[]; isError?: boolean };
const textOf = (r: unknown) =>
  (r as Result).content.map((c) => (c.type === 'text' ? c.text : '')).join('');

test.describe('Claude connector', () => {
  test.skip(!bins, 'FFmpeg is not available (run pnpm fetch-ffmpeg)');
  test.skip(!existsSync(bridge), 'The MCP bridge is not built (run pnpm build:mcp)');
  test.beforeAll(() => {
    fx = makeFixtures(bins!.ffmpeg, { longSeconds: 3 });
  });
  test.afterAll(() => {
    if (fx) rmSync(fx.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  test('Claude edits the open project; the user undoes it and declines an export', async () => {
    const userData = tempUserData();
    const { app, page } = await launch(
      userData,
      bins!.source === 'path' ? {} : { RECIT_FFMPEG_PATH: bins!.ffmpeg },
    );
    const client = new Client({ name: 'E2E Claude', version: '1.0' });
    try {
      await createProject(page, 'Claude e2e');
      await mockOpenDialog(app, [fx.h264]);
      await page.getByRole('button', { name: 'Import footage' }).click();
      await page.getByLabel(/I have the right/).check();
      await page.getByRole('button', { name: 'Import' }).last().click();
      await expect(page.locator('[data-testid=asset-card][data-status=ready]')).toHaveCount(1, {
        timeout: 60_000,
      });

      await expect(page.getByTestId('claude-pill')).toHaveText(/not connected/);
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [bridge],
          env: { ...process.env, RECIT_USER_DATA: userData } as Record<string, string>,
        }),
      );
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('remove_ranges');
      await expect(page.getByTestId('claude-pill')).toHaveText('Claude · connected', {
        timeout: 15_000,
      });
      await page.getByRole('tab', { name: 'Claude' }).click();
      await expect(page.getByTestId('claude-panel')).toContainText('Connected: E2E Claude 1.0');

      const summary = JSON.parse(
        textOf(await client.callTool({ name: 'get_project_summary', arguments: {} })),
      ) as { version: number; media: { id: string }[] };
      const added = await client.callTool({
        name: 'add_clip',
        arguments: { assetId: summary.media[0]!.id, version: summary.version },
      });
      expect(textOf(added)).toContain('Added clip h264.mp4');
      await client.callTool({
        name: 'remove_ranges',
        arguments: { ranges: [{ start: 1, end: 1.5 }] },
      });
      // The timeline shows Claude's edits live.
      await expect(page.getByTestId('timeline-item')).toHaveCount(2);

      const card = page.getByTestId('claude-change');
      await expect(card).toContainText('Claude made 3 changes');
      await expect(card).toContainText('Cut 1 range');
      await expect(page.getByTestId('claude-activity').locator('li')).toHaveCount(3);
      await card.getByRole('button', { name: 'Undo all' }).click();
      await expect(page.getByTestId('timeline-item')).toHaveCount(0);
      await expect(card).toHaveCount(0);

      // Heavy tools wait for the user: decline an export.
      await client.callTool({ name: 'add_clip', arguments: { assetId: summary.media[0]!.id } });
      const exporting = client.callTool({ name: 'export_sequence', arguments: {} });
      const confirm = page.getByTestId('claude-confirm');
      await expect(confirm).toContainText('Export video');
      await confirm.getByRole('button', { name: 'Decline' }).click();
      expect(textOf(await exporting)).toContain('declined');
      await expect(page.getByTestId('claude-activity')).toContainText('Declined by you');
    } finally {
      await client.close().catch(() => {});
      await app.close();
    }
  });
});
