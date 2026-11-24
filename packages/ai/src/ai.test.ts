import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AiClient,
  AiError,
  extractJson,
  narrationPrompt,
  storySchema,
  writeStoryPrompt,
  type FetchLike,
} from './index';

function fakeServer(replies: (string | { status: number; body: string })[], models = ['qwen3:8b']) {
  const calls: { url: string; body?: Record<string, unknown>; headers: Record<string, string> }[] =
    [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/models'))
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: models.map((id) => ({ id })) }),
      };
    const next = replies.shift()!;
    if (typeof next !== 'string')
      return { ok: false, status: next.status, text: async () => next.body };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: next } }] }),
    };
  };
  return { fetch, calls };
}

describe('AiClient', () => {
  it('uses the first model Ollama lists and asks for JSON', async () => {
    const s = fakeServer([
      '<think>hmm</think>{"title":"A title here","story":"' + 'x '.repeat(30) + '"}',
    ]);
    const ai = new AiClient(
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1/', model: '' },
      s.fetch,
    );
    const story = await ai.json(storySchema, writeStoryPrompt({ genre: 'aita', seconds: 60 }));
    expect(story.title).toBe('A title here');
    const chat = s.calls.find((c) => c.url.endsWith('/chat/completions'))!;
    expect(chat.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(chat.body).toMatchObject({
      model: 'qwen3:8b',
      response_format: { type: 'json_object' },
    });
    expect(chat.headers.authorization).toBeUndefined();
  });

  it('sends the key to Kimi and needs one', async () => {
    const s = fakeServer(['{"ok":true}']);
    const noKey = new AiClient(
      { provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3' },
      s.fetch,
    );
    await expect(noKey.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/API key/);
    const ai = new AiClient(
      {
        provider: 'kimi',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'kimi-k3',
        apiKey: 'sk-test',
      },
      s.fetch,
    );
    await ai.chat([{ role: 'user', content: 'hi' }]);
    expect(s.calls.at(-1)!.headers.authorization).toBe('Bearer sk-test');
    expect(s.calls.at(-1)!.body?.model).toBe('kimi-k3');
    expect(s.calls.at(-1)!.body?.reasoning_effort).toBeUndefined();
  });

  it('sends a bad answer back once with the problem', async () => {
    const s = fakeServer(['{"title":"x"}', 'Sure! ```json\n{"n": 3}\n```']);
    const ai = new AiClient({ provider: 'custom', baseUrl: 'http://x/v1', model: 'm' }, s.fetch);
    const r = await ai.json(z.object({ n: z.number() }), [{ role: 'user', content: 'give n' }]);
    expect(r.n).toBe(3);
    const retry = s.calls.at(-1)!.body!.messages as { content: string }[];
    expect(retry.at(-1)!.content).toMatch(/does not fit/);
  });

  it('explains common failures', async () => {
    const refused: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const ollama = new AiClient(
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: 'm' },
      refused,
    );
    await expect(ollama.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/Start Ollama/);
    const s = fakeServer([{ status: 401, body: '{"error":{"message":"bad key"}}' }]);
    const kimi = new AiClient(
      { provider: 'kimi', baseUrl: 'https://k/v1', model: 'm', apiKey: 'k' },
      s.fetch,
    );
    await expect(kimi.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(AiError);
    const empty = fakeServer([], []);
    await expect(
      new AiClient({ provider: 'ollama', baseUrl: 'http://o/v1', model: '' }, empty.fetch).model(),
    ).rejects.toThrow(/ollama pull/);
  });
});

describe('AiClient.release', () => {
  it('unloads every model Ollama has loaded, so the picture engine gets the GPU', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
      const body = url.endsWith('/api/ps') ? { models: [{ name: 'qwen3:8b' }] } : {};
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    const ai = new AiClient(
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1/', model: '' },
      fetch,
    );
    expect(await ai.release()).toEqual(['qwen3:8b']);
    expect(calls).toEqual([
      { url: 'http://localhost:11434/api/ps', body: undefined },
      {
        url: 'http://localhost:11434/api/generate',
        body: { model: 'qwen3:8b', keep_alive: 0 },
      },
    ]);
  });

  it('does nothing for cloud providers and never throws', async () => {
    const kimi = new AiClient(
      { provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', apiKey: 'k' },
      async () => {
        throw new Error('should not be called');
      },
    );
    expect(await kimi.release()).toEqual([]);
    const down = new AiClient(
      { provider: 'ollama', baseUrl: 'http://localhost:11434/v1', model: '' },
      async () => {
        throw new Error('ECONNREFUSED');
      },
    );
    expect(await down.release()).toEqual([]);
  });
});

describe('prompts', () => {
  it('sizes the story for the length and keeps rules for narration', () => {
    const [system, user] = writeStoryPrompt({
      genre: 'revenge',
      idea: 'a noisy neighbour',
      seconds: 60,
    });
    expect(system!.content).toContain('r/pettyrevenge');
    expect(system!.content).toMatch(/no emojis/i);
    expect(user!.content).toContain('about 156 words');
    expect(user!.content).toContain('noisy neighbour');
    expect(
      narrationPrompt({ title: 't', text: 'x'.repeat(20000), seconds: 30 })[1]!.content.length,
    ).toBeLessThan(12200);
  });

  it('extracts JSON from wrapped replies', () => {
    expect(extractJson('Here you go: {"a": 1} thanks')).toEqual({ a: 1 });
    expect(() => extractJson('no json')).toThrow(AiError);
  });
});
