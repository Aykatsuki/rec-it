import { MessageChannel } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createIpcClient } from './client';
import { defineContract } from './define';
import { IpcError } from './errors';
import { portTransport } from './port-transport';
import { createIpcServer } from './server';
import { backendContract } from './backend-contract';
import { settingsPatchSchema, settingsSchema } from './schemas/settings';

const contract = defineContract({
  requests: {
    'math.add': {
      input: z.object({ a: z.number(), b: z.number() }).strict(),
      output: z.object({ sum: z.number() }),
    },
    'math.broken': { input: z.object({}).strict(), output: z.object({ sum: z.number() }) },
    'math.fail': { input: z.object({}).strict(), output: z.object({}) },
    'math.slow': { input: z.object({}).strict(), output: z.object({}) },
  },
  events: { 'math.tick': z.object({ n: z.number() }) },
});

const channels: MessageChannel[] = [];
afterEach(() => {
  for (const c of channels.splice(0)) {
    c.port1.close();
    c.port2.close();
  }
});

function setup(timeoutMs = 1000) {
  const channel = new MessageChannel();
  channels.push(channel);
  const errors: unknown[] = [];
  const server = createIpcServer(
    contract,
    {
      'math.add': ({ a, b }) => ({ sum: a + b }),
      // @ts-expect-error deliberately returns the wrong shape
      'math.broken': () => ({ sum: 'nope' }),
      'math.fail': () => {
        throw new Error('boom');
      },
      'math.slow': () => new Promise(() => {}),
    },
    portTransport(channel.port1),
    { onError: (e) => errors.push(e) },
  );
  const client = createIpcClient(contract, portTransport(channel.port2), { timeoutMs });
  return { server, client, errors, rawPort: channel.port2 };
}

describe('IPC contract', () => {
  it('round-trips a valid request', async () => {
    const { client } = setup();
    await expect(client.invoke('math.add', { a: 2, b: 3 })).resolves.toEqual({ sum: 5 });
  });

  it('rejects invalid input on the client before sending', async () => {
    const { client } = setup();
    // @ts-expect-error wrong type on purpose
    const error = await client.invoke('math.add', { a: '2', b: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IpcError);
    expect((error as IpcError).code).toBe('INVALID_INPUT');
  });

  it('rejects invalid input on the server even if a client skips validation', async () => {
    const { rawPort } = setup();
    const reply = new Promise((resolve) => rawPort.once('message', resolve));
    rawPort.postMessage({
      kind: 'request',
      id: 7,
      channel: 'math.add',
      payload: { a: 1, b: 2, extra: true },
    });
    expect(await reply).toMatchObject({
      kind: 'response',
      id: 7,
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
  });

  it('rejects unknown channels', async () => {
    const { rawPort, client } = setup();
    const reply = new Promise((resolve) => rawPort.once('message', resolve));
    rawPort.postMessage({ kind: 'request', id: 1, channel: 'fs.readFile', payload: {} });
    expect(await reply).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
    // @ts-expect-error not part of the contract
    await expect(client.invoke('fs.readFile', {})).rejects.toMatchObject({
      code: 'UNKNOWN_CHANNEL',
    });
  });

  it('refuses prototype keys as channel names', async () => {
    const { rawPort } = setup();
    const reply = new Promise((resolve) => rawPort.once('message', resolve));
    rawPort.postMessage({ kind: 'request', id: 2, channel: 'constructor', payload: {} });
    expect(await reply).toMatchObject({ ok: false, error: { code: 'UNKNOWN_CHANNEL' } });
  });

  it('ignores malformed messages without crashing', async () => {
    const { rawPort, client, errors } = setup();
    rawPort.postMessage('not an envelope');
    rawPort.postMessage({ kind: 'request', id: -1, channel: '', payload: null });
    await expect(client.invoke('math.add', { a: 1, b: 1 })).resolves.toEqual({ sum: 2 });
    expect(errors.length).toBe(2);
  });

  it('reports handler errors and invalid handler output', async () => {
    const { client } = setup();
    await expect(client.invoke('math.fail', {})).rejects.toMatchObject({
      code: 'HANDLER_ERROR',
      message: 'boom',
    });
    await expect(client.invoke('math.broken', {})).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    });
  });

  it('times out and rejects pending requests on dispose', async () => {
    const { client } = setup(50);
    await expect(client.invoke('math.slow', {})).rejects.toMatchObject({ code: 'TIMEOUT' });
    const pending = client.invoke('math.slow', {});
    client.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' });
  });

  it('delivers validated events and drops invalid ones', async () => {
    const { server, client } = setup();
    const received: number[] = [];
    const done = new Promise<void>((resolve) =>
      client.on('math.tick', ({ n }) => {
        received.push(n);
        if (n === 2) resolve();
      }),
    );
    server.emit('math.tick', { n: 1 });
    // @ts-expect-error invalid payload on purpose
    server.emit('math.tick', { n: 'x' });
    server.emit('math.tick', { n: 2 });
    await done;
    expect(received).toEqual([1, 2]);
  });
});

describe('contracts', () => {
  it('fills settings defaults and rejects unknown patch keys', () => {
    expect(settingsSchema.parse({})).toEqual({
      aiEnabled: true,
      reduceMotion: false,
      transcriptionDevice: 'auto',
      cacheDirectory: null,
      reopenLastProject: true,
      exportDirectory: null,
    });
    expect(settingsPatchSchema.safeParse({ aiEnabled: false }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ isAdmin: true }).success).toBe(false);
  });

  it('defines every backend channel with input and output schemas', () => {
    for (const [name, def] of Object.entries(backendContract.requests)) {
      expect(def.input, name).toBeDefined();
      expect(def.output, name).toBeDefined();
    }
  });
});
