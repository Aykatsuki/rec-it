// AI text for Rec-It's one-click features (ADR-046): an OpenAI-compatible chat client that works
// with Ollama on this PC (free, private) or Kimi (Moonshot's API, the user's own key), plus the
// prompts. No SDK and no Node or DOM APIs: the caller passes `fetch`, so tests can fake it.
import { z } from 'zod';

export const AI_PROVIDERS = {
  ollama: {
    label: 'Ollama (on this PC, free)',
    baseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    defaultModel: '',
    help: 'Install Ollama from ollama.com, then run a model once, e.g. "ollama run qwen3:8b".',
  },
  kimi: {
    label: 'Kimi (Moonshot API key)',
    baseUrl: 'https://api.moonshot.ai/v1',
    needsKey: true,
    defaultModel: 'kimi-k3',
    help: 'Create an API key at platform.kimi.ai (pay as you go).',
  },
  custom: {
    label: 'Other OpenAI-compatible server',
    baseUrl: '',
    needsKey: false,
    defaultModel: '',
    help: 'Any server with an OpenAI-style /v1/chat/completions endpoint.',
  },
} as const;
export type AiProvider = keyof typeof AI_PROVIDERS;

export interface AiConfig {
  provider: AiProvider;
  /** Ends in /v1. */
  baseUrl: string;
  /** Empty: the first model the server lists. */
  model: string;
  apiKey?: string;
}

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: unknown },
) => Promise<FetchResponse>;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask for a JSON object (both Ollama and Kimi support JSON mode). */
  json?: boolean;
  signal?: unknown;
}

export class AiError extends Error {
  override name = 'AiError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Reasoning models (Qwen 3, DeepSeek R1…) may think aloud in <think> tags first. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** The first JSON object in a reply (models sometimes wrap it in ``` fences or prose). */
export function extractJson(text: string): unknown {
  const t = stripThinking(text);
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new AiError('The AI did not reply with JSON.');
  }
}

export class AiClient {
  private resolvedModel: string | undefined;

  constructor(
    readonly config: AiConfig,
    private readonly fetch: FetchLike,
  ) {}

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
    };
  }

  private async send(path: string, body?: unknown, signal?: unknown): Promise<unknown> {
    if (!this.config.baseUrl) throw new AiError('Set the AI server address in Settings.');
    if (AI_PROVIDERS[this.config.provider].needsKey && !this.config.apiKey)
      throw new AiError('Add your API key in Settings → AI.');
    let res: FetchResponse;
    try {
      res = await this.fetch(this.url(path), {
        method: body === undefined ? 'GET' : 'POST',
        headers: this.headers(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      throw new AiError(
        this.config.provider === 'ollama'
          ? `Ollama is not running at ${this.config.baseUrl} (${why}). Start Ollama and try again.`
          : `Could not reach ${this.config.baseUrl} (${why}).`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      let message = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: { message?: string } | string };
        message = typeof j.error === 'string' ? j.error : (j.error?.message ?? message);
      } catch {
        // not JSON
      }
      if (res.status === 401) message = 'The API key was refused. Check it in Settings → AI.';
      if (res.status === 404 && this.config.provider === 'ollama' && /model/i.test(message))
        message = `${message}. Pull it first: ollama pull ${this.config.model}`;
      throw new AiError(message || `The AI server answered ${res.status}.`, res.status);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AiError('The AI server sent something that is not JSON.');
    }
  }

  /** Models the server offers. */
  async listModels(): Promise<string[]> {
    const r = (await this.send('/models')) as { data?: { id?: string }[] };
    return (r.data ?? []).map((m) => m.id).filter((id): id is string => !!id);
  }

  /** The configured model, or the first one the server lists. */
  async model(): Promise<string> {
    if (this.config.model) return this.config.model;
    if (this.resolvedModel) return this.resolvedModel;
    const models = await this.listModels();
    if (!models.length)
      throw new AiError(
        this.config.provider === 'ollama'
          ? 'Ollama has no models yet. Run "ollama pull qwen3:8b" (or another model) first.'
          : 'The server lists no models; choose one in Settings → AI.',
      );
    this.resolvedModel = models[0]!;
    return this.resolvedModel;
  }

  async chat(messages: ChatMessage[], o: ChatOptions = {}): Promise<string> {
    const model = await this.model();
    const r = (await this.send(
      '/chat/completions',
      {
        model,
        messages,
        temperature: o.temperature ?? 0.8,
        ...(o.maxTokens ? { max_tokens: o.maxTokens } : {}),
        ...(o.json ? { response_format: { type: 'json_object' } } : {}),
        // Local reasoning models (Qwen 3, DeepSeek R1…) think at length before answering; stories,
        // titles and scores do not need it, and it can take minutes on a home GPU.
        ...(this.config.provider === 'ollama' ? { reasoning_effort: 'none' } : {}),
        stream: false,
      },
      o.signal,
    )) as { choices?: { message?: { content?: string; reasoning?: string } }[] };
    const content = r.choices?.[0]?.message?.content;
    if (!content?.trim() && r.choices?.[0]?.message?.reasoning)
      throw new AiError(
        'The model only thought and gave no answer. Try again, or pick a non-thinking model in Settings → AI.',
      );
    if (typeof content !== 'string' || !content.trim())
      throw new AiError('The AI sent an empty reply.');
    return stripThinking(content);
  }

  /**
   * Asks for JSON matching `schema`. A reply that does not fit is sent back once with the
   * problem, which small local models usually fix.
   */
  async json<S extends z.ZodType>(
    schema: S,
    messages: ChatMessage[],
    o: ChatOptions = {},
  ): Promise<z.output<S>> {
    const history = [...messages];
    for (let attempt = 0; ; attempt++) {
      const reply = await this.chat(history, { ...o, json: true });
      let problem: string;
      try {
        const parsed = schema.safeParse(extractJson(reply));
        if (parsed.success) return parsed.data;
        problem = z.prettifyError(parsed.error);
      } catch (error) {
        problem = error instanceof Error ? error.message : String(error);
      }
      if (attempt >= 1) throw new AiError(`The AI's answer did not fit: ${problem}`);
      history.push(
        { role: 'assistant', content: reply },
        {
          role: 'user',
          content: `That JSON does not fit: ${problem}\nReply again with only the corrected JSON object.`,
        },
      );
    }
  }
}

export * from './prompts';
