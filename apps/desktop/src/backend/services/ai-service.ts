// AI text for one-click features (ADR-046): Ollama on this PC or Kimi with the user's own key,
// through packages/ai. The key lives in the secret store and never reaches the renderer.
import {
  episodePlanSchema,
  episodePrompt,
  type EpisodePlan,
  AI_PROVIDERS,
  AiClient,
  narrationPrompt,
  scenePlanPrompt,
  scenePlanSchema,
  type ScenePlan,
  storySchema,
  writeStoryPrompt,
  type FetchLike,
  type StoryGenre,
} from '@rec-it/ai';
import type { AiStatus, Settings } from '@rec-it/ipc-contract';

export interface AiDeps {
  settings: () => Settings;
  apiKey: () => string | undefined;
  fetch?: FetchLike;
}

const nodeFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: init.signal as AbortSignal | undefined });

export class AiService {
  constructor(private readonly d: AiDeps) {}

  client(): AiClient {
    const s = this.d.settings();
    const preset = AI_PROVIDERS[s.aiProvider];
    return new AiClient(
      {
        provider: s.aiProvider,
        baseUrl: s.aiBaseUrl?.trim() || preset.baseUrl,
        model: s.aiModel.trim() || preset.defaultModel,
        ...(this.d.apiKey() ? { apiKey: this.d.apiKey() } : {}),
      },
      this.d.fetch ?? nodeFetch,
    );
  }

  status(): AiStatus {
    const c = this.client().config;
    return {
      provider: c.provider,
      baseUrl: c.baseUrl,
      model: c.model,
      needsKey: AI_PROVIDERS[c.provider].needsKey,
      keySet: !!c.apiKey,
    };
  }

  async models(): Promise<string[]> {
    return this.client().listModels();
  }

  async test(): Promise<{ model: string; reply: string }> {
    const ai = this.client();
    const model = await ai.model();
    const reply = await ai.chat(
      [{ role: 'user', content: 'Reply with exactly: Rec-It is connected.' }],
      { temperature: 0, maxTokens: 400 },
    );
    return { model, reply: reply.slice(0, 200) };
  }

  writeStory(genre: StoryGenre, idea: string | undefined, seconds: number) {
    return this.client().json(storySchema, writeStoryPrompt({ genre, idea, seconds }), {
      temperature: 0.9,
    });
  }

  /** The storyboard for generated visuals (ADR-047). */
  planScenes(title: string, sentences: string[], scenes: number): Promise<ScenePlan> {
    return this.client().json(scenePlanSchema, scenePlanPrompt({ title, sentences, scenes }), {
      temperature: 0.6,
    });
  }

  /** The plan of an episode from a brief: cast, shots, lines and pictures (ADR-052). */
  planEpisode(
    brief: string,
    seconds: number,
    extra: { script?: string; cast?: readonly { id: string; name: string; look: string }[] } = {},
  ): Promise<EpisodePlan> {
    return this.client().json(episodePlanSchema, episodePrompt({ brief, seconds, ...extra }), {
      temperature: 0.7,
    });
  }

  /** Unloads local models so the picture engine has the graphics card (ADR-047). */
  releaseGpu(): Promise<string[]> {
    return this.client().release();
  }

  narrate(title: string, text: string, seconds: number) {
    return this.client().json(
      storySchema.omit({ username: true }),
      narrationPrompt({ title, text, seconds }),
      { temperature: 0.4 },
    );
  }
}
