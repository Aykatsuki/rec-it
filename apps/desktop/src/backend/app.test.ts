import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { backendContract, createIpcClient, portTransport } from '@rec-it/ipc-contract';
import { BackendApp, fingerprint } from './app';

const cleanups: (() => void)[] = [];
afterEach(() => {
  // Reverse order: close databases before deleting their folders (Windows keeps open files locked).
  for (const c of cleanups.splice(0).reverse()) c();
});

function start(dir = mkdtempSync(join(tmpdir(), 'recit-backend-'))) {
  const app = new BackendApp({
    userDataDir: dir,
    projectsDir: join(dir, 'projects'),
    appVersion: '0.0.0-test',
    electronVersion: 'test',
    ffmpeg: { envPath: join(dir, 'no-ffmpeg', 'ffmpeg'), bundledDir: join(dir, 'none') },
    sidecar: null,
  });
  const channel = new MessageChannel();
  app.attach(channel.port1);
  const client = createIpcClient(backendContract, portTransport(channel.port2), {
    timeoutMs: 5000,
  });
  cleanups.push(() => {
    client.dispose();
    channel.port1.close();
    channel.port2.close();
    app.dispose();
  });
  return { app, client, dir };
}

describe('BackendApp over IPC', () => {
  it('answers ping', async () => {
    const { client } = start();
    const sentAt = Date.now();
    const reply = await client.invoke('app.ping', { sentAt });
    expect(reply.sentAt).toBe(sentAt);
    expect(reply.receivedAt).toBeGreaterThanOrEqual(sentAt);
  });

  it('persists settings and broadcasts changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recit-backend-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const first = start(dir);
    const changed = new Promise((resolve) => first.client.on('settings.changed', resolve));
    await first.client.invoke('settings.update', { transcriptionDevice: 'cuda' });
    await expect(changed).resolves.toMatchObject({ transcriptionDevice: 'cuda' });
    await expect(
      first.client.invoke('settings.update', { transcriptionDevice: 'tpu' as 'cpu' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    cleanups.pop()!();

    const second = start(dir);
    await expect(second.client.invoke('settings.get', {})).resolves.toMatchObject({
      transcriptionDevice: 'cuda',
    });
  });

  it('reports secrets by fingerprint only', async () => {
    const { app, client } = start();
    app.setSecrets({ testSecret: 'correct horse battery staple' });
    const status = await client.invoke('system.getStatus', {});
    expect(status.secrets.testSecret).toEqual({
      set: true,
      fingerprint: fingerprint('correct horse battery staple'),
    });
    expect(status.secrets.youtubeApiKey).toEqual({ set: false });
    expect(JSON.stringify(status)).not.toContain('correct horse');
  });

  it('reports missing ffmpeg and a disabled sidecar after refresh', async () => {
    const { client } = start();
    const status = await client.invoke('system.refresh', {});
    expect(status.ffmpeg.state).toBe('missing');
    expect(status.sidecar.state).toBe('missing');
    expect(status.database.schemaVersion).toBeGreaterThan(0);
  });
});
