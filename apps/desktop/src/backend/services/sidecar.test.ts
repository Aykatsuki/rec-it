import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SidecarClient, checkSidecar } from './sidecar';

const project = resolve(__dirname, '../../../../../services/media-ai');
const python = ['python3', 'python'].find((bin) => {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
});

const clients: SidecarClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.stop();
});

function client(command = python!, args = ['-m', 'recit_media_ai']) {
  const c = new SidecarClient({ command, args, cwd: project }, () => {});
  clients.push(c);
  return c;
}

describe.skipIf(!python)('SidecarClient (needs Python)', () => {
  it('talks JSON-RPC to the real sidecar', async () => {
    const c = client();
    c.start();
    await expect(c.request('ping', { echo: 'hello' })).resolves.toMatchObject({
      pong: true,
      echo: 'hello',
    });
    await expect(c.request('nope')).rejects.toMatchObject({ code: -32601 });
  });

  it('times out slow requests without breaking later ones', async () => {
    const c = client();
    c.start();
    await expect(c.request('debug.sleep', { seconds: 1 }, 100)).rejects.toThrow(/timed out/);
    await expect(c.request('ping')).resolves.toMatchObject({ pong: true });
  });

  it('produces an ok status', async () => {
    const status = await checkSidecar(client());
    expect(status.state).toBe('ok');
    expect(status.version).toBeTruthy();
  });
});

describe('SidecarClient failures', () => {
  it('reports a missing runtime clearly', async () => {
    const status = await checkSidecar(client('definitely-not-uv-xyz', []));
    expect(status.state).toBe('missing');
    expect(status.message).toMatch(/uv/);
  });

  it('rejects pending requests when the process exits', async () => {
    const c = client(python ?? 'node', ['-e', 'process.exit(3)']);
    c.start();
    await expect(c.request('ping', {}, 5000)).rejects.toThrow(/exited|not running/);
  });
});
