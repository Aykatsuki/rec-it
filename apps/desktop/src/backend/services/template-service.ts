// Faceless templates (ADR-046): a story becomes a finished Short. The AI voice reads the title
// and story; a title card is drawn; both are imported into the project as ordinary media (rights
// "Made in Rec-It"), the voice's word times become its transcript, and packages/templates builds
// the sequence as one undoable batch of commands.
import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createId } from '@rec-it/core';
import type { MediaAsset, TemplateJob } from '@rec-it/ipc-contract';
import { storyShortSchema } from '@rec-it/ipc-contract';
import { PICTURE_STYLES, type ScenePlan } from '@rec-it/ai';
import {
  fallbackScenes,
  normaliseScenes,
  randomStart,
  sceneCount,
  speakable,
  splitSentences,
  storyShort,
  type Scene,
} from '@rec-it/templates';
import type { ImageService } from './image-service';
import type { z } from 'zod';
import type { ProjectService } from './project-service';
import type { VoiceService } from './voice-service';

type StoryInput = z.output<typeof storyShortSchema>;

export interface TemplateDeps {
  projects: ProjectService;
  voice: VoiceService;
  images: ImageService;
  /** The AI's scene plan, or null when no AI is set up or it fails (a plain grouping is used). */
  planScenes: (title: string, sentences: string[], count: number) => Promise<ScenePlan | null>;
  /** Frees the graphics card (unloads Ollama's models) before the picture engine runs. */
  releaseGpu?: () => Promise<unknown>;
  /** A transcript was stored outside transcription (the voiceover's). */
  onTranscript: () => void;
  onChange: (jobs: TemplateJob[]) => void;
  /** Milliseconds between readiness checks of imported media. */
  pollMs?: number;
}

export class Cancelled extends Error {}

export class TemplateService {
  private jobs: TemplateJob[] = [];
  private controllers = new Map<string, AbortController>();

  constructor(private readonly d: TemplateDeps) {}

  list(): TemplateJob[] {
    return this.jobs;
  }

  private update(id: string, patch: Partial<TemplateJob>): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
    this.d.onChange(this.jobs);
  }

  cancel(jobId: string): void {
    this.controllers.get(jobId)?.abort();
  }

  reset(): void {
    for (const c of this.controllers.values()) c.abort();
    this.jobs = [];
    this.d.onChange(this.jobs);
  }

  /** Starts a story Short; returns at once with the job id. */
  story(raw: unknown): string {
    const input = storyShortSchema.parse(raw);
    const info = this.d.projects.info();
    if (!info) throw new Error('Open or create a project first.');
    if (input.visuals === 'footage') {
      if (!input.backgroundAssetId)
        throw new Error('Choose a video for the background (gameplay, satisfying clips…).');
      const bg = this.d.projects.media().get(input.backgroundAssetId);
      if (bg.kind !== 'video' || !bg.probe?.durationSec)
        throw new Error('Choose a video for the background (gameplay, satisfying clips…).');
    }
    if (input.visuals === 'pictures' && !this.d.images.status().available)
      throw new Error('Install the AI picture engine first.');
    if (input.musicAssetId) {
      const m = this.d.projects.media().get(input.musicAssetId);
      if (!m.probe?.audioStreamCount) throw new Error('The music has no sound.');
    }
    const id = createId('tpl');
    this.jobs = [
      ...this.jobs.filter((j) => j.state === 'running'),
      {
        id,
        kind: 'story',
        title: input.title.slice(0, 80),
        state: 'running',
        stage: 'Starting…',
        progress: 0,
      },
    ];
    this.d.onChange(this.jobs);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.runStory(id, input, controller.signal).finally(() => this.controllers.delete(id));
    return id;
  }

  private async runStory(id: string, input: StoryInput, signal: AbortSignal): Promise<void> {
    try {
      const projectId = this.d.projects.info()!.id;
      const media = () => {
        const p = this.d.projects.info();
        if (!p || p.id !== projectId) throw new Error('The project was closed.');
        return this.d.projects.media();
      };
      const check = () => {
        if (signal.aborted) throw new Cancelled();
      };
      const folder = await this.generatedFolder();
      const stamp = id.replace(/^tpl[_-]?/, '').slice(-10);
      const title = speakable(input.title);
      const story = speakable(input.story);
      if (!title || !story) throw new Error('The title and story need some words.');

      // Generated visuals: the AI storyboards the script into scenes first.
      const generated = input.visuals !== 'footage';
      let scenes: Scene[] = [];
      if (generated) {
        this.update(id, { stage: 'Planning the scenes…', progress: 0.02 });
        const sentences = splitSentences(story);
        const count = sceneCount((title.length + story.length) / 15 / input.speed);
        const plan = await this.d.planScenes(title, sentences, count).catch(() => null);
        scenes = plan ? normaliseScenes(plan.scenes, sentences) : fallbackScenes(sentences, count);
        check();
      }
      const share = generated ? 0.3 : 0.68;

      // 1. Voiceover: the title, then the story (one part per scene), with word times.
      this.update(id, { stage: 'Recording the voiceover…', progress: 0.05 });
      const voicePath = join(folder, `voice ${stamp}.wav`);
      const spoken = await this.d.voice.speak(
        [
          { id: 'title', text: title },
          ...(generated
            ? scenes.map((sc, i) => ({ id: `scene${i}`, text: sc.text }))
            : [{ id: 'story', text: story }]),
        ],
        {
          voice: input.voice,
          speed: input.speed,
          out: voicePath,
          signal,
          onProgress: (p, message) =>
            this.update(id, { progress: 0.05 + share * p, ...(message ? { stage: message } : {}) }),
        },
      );
      check();
      const titleSeg = spoken.segments.find((s) => s.id === 'title')!;

      // 1b. Pictures or motion-graphics backdrops, one per scene.
      let scenePaths: string[] = [];
      if (input.visuals === 'pictures') {
        const style = PICTURE_STYLES[input.pictureStyle].prompt;
        this.update(id, { stage: 'Freeing the graphics card…', progress: 0.36 });
        await this.d.releaseGpu?.().catch(() => undefined);
        check();
        scenePaths = await this.d.images.generate(
          scenes.map((sc) => `${sc.picture}. ${style}, vertical 9:16 composition, no text`),
          {
            outDir: join(folder, `pictures ${stamp}`),
            seed: Math.floor(Math.random() * 1_000_000),
            signal,
            onProgress: (p, message) =>
              this.update(id, {
                progress: 0.36 + 0.36 * p,
                ...(message ? { stage: message } : {}),
              }),
          },
        );
      } else if (input.visuals === 'graphics') {
        this.update(id, { stage: 'Designing the backgrounds…', progress: 0.5 });
        scenePaths = await this.d.images.backgrounds(
          scenes.map((sc, i) => ({
            out: join(folder, `backdrop ${stamp}-${i + 1}.png`),
            palette: sc.palette,
            seed: `${stamp}-${i}`,
          })),
        );
      }
      check();

      // 2. Title card.
      let cardPath: string | undefined;
      if (input.card) {
        this.update(id, { stage: 'Drawing the title card…', progress: 0.72 });
        cardPath = join(folder, `card ${stamp}.png`);
        await this.d.voice.card({
          out: cardPath,
          title: input.title,
          community: input.community,
          username: input.username,
          upvotes: input.upvotes,
          comments: input.comments,
          theme: input.theme,
        });
        check();
      }

      // 3. Import both as ordinary media and wait until they can go on the timeline.
      this.update(id, { stage: 'Adding the voiceover to the project…', progress: 0.76 });
      const paths = [voicePath, ...(cardPath ? [cardPath] : []), ...scenePaths];
      // A file made before with the same content (same story, voice and speed) is reused.
      const existing = await Promise.all(paths.map((p) => media().findSame(p)));
      const fresh = paths.filter((_, i) => !existing[i]);
      const result = fresh.length
        ? await media().import(fresh, {
            source: 'made-in-rec-it',
            notes:
              'AI voice (Kokoro-82M), title card and scene pictures (Z-Image Turbo) or backdrops made by Rec-It.',
            userAttested: true,
          })
        : { imported: [], skipped: [] };
      if (result.skipped.length)
        throw new Error(`Could not add the generated files: ${result.skipped[0]!.reason}`);
      const queue = [...result.imported];
      const ids = existing.map((id) => id ?? queue.shift()!);
      const [voiceId, ...rest] = ids;
      const cardId = cardPath ? rest.shift() : undefined;
      const sceneIds = rest;
      const ready = await this.waitReady(media, ids, signal);
      const voiceAsset = ready.get(voiceId!)!;

      // The voiceover's words are its transcript: captions, the transcript panel and Claude use it.
      // The voice is certain of its own words (confidence 1).
      const words = spoken.segments.flatMap((s) => s.words.map((w) => ({ ...w, p: 1 })));
      this.d.projects
        .database()
        .saveTranscript(
          voiceId!,
          'en',
          'kokoro',
          JSON.stringify({ language: 'en', model: 'kokoro', words }),
        );
      this.d.onTranscript();

      // 4. Build the Short in one undoable step.
      this.update(id, { stage: 'Building the Short…', progress: 0.92 });
      const music = input.musicAssetId ? media().get(input.musicAssetId) : undefined;
      const voiceLength = voiceAsset.probe?.durationSec ?? spoken.duration;
      const sequenceId = createId('sequence');
      const { command } = storyShort({
        sequenceId,
        name: shortName(input.title),
        voice: { assetId: voiceId!, duration: voiceLength, words, titleEnd: titleSeg.end },
        ...(cardId ? { card: { assetId: cardId } } : {}),
        background: generated
          ? {
              kind: 'scenes',
              scenes: scenes.map((sc, i) => {
                const seg = spoken.segments.find((s) => s.id === `scene${i}`)!;
                return { assetId: sceneIds[i]!, start: seg.start, end: seg.end, motion: sc.motion };
              }),
            }
          : this.footage(input, voiceLength),
        ...(music?.probe
          ? {
              music: {
                assetId: music.id,
                duration: music.probe.durationSec,
                volume: input.musicVolume,
              },
            }
          : {}),
        captions: { style: input.captionStyle },
        ids: {
          voice: createId('item'),
          card: createId('item'),
          background: () => createId('item'),
          music: createId('item'),
        },
      });
      check();
      this.d.projects.document().execute(command);
      this.update(id, { state: 'done', stage: 'Done', progress: 1, sequenceId });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted || error instanceof Cancelled || /cancel/i.test(message))
        this.update(id, { state: 'cancelled', stage: 'Cancelled' });
      else this.update(id, { state: 'failed', stage: 'Failed', error: message });
    }
  }

  private footage(input: StoryInput, voiceLength: number) {
    const bg = this.d.projects.media().get(input.backgroundAssetId!);
    const length = bg.probe?.durationSec ?? 0;
    return {
      assetId: bg.id,
      duration: length,
      start: input.backgroundStart ?? randomStart(length, voiceLength + 1),
      keepSound: input.keepBackgroundSound,
    };
  }

  /** Generated files live next to the project file, in "<project> media". */
  private async generatedFolder(): Promise<string> {
    const info = this.d.projects.info()!;
    const dir = join(dirname(info.path), `${basename(info.path, extname(info.path))} media`);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  private async waitReady(
    media: () => ReturnType<ProjectService['media']>,
    ids: string[],
    signal: AbortSignal,
  ): Promise<Map<string, MediaAsset>> {
    const until = Date.now() + 120_000;
    for (;;) {
      if (signal.aborted) throw new Cancelled();
      const all = new Map(
        media()
          .list()
          .map((a) => [a.id, a]),
      );
      const assets = ids.map((i) => all.get(i));
      const failed = assets.find((a) => !a || a.status === 'failed' || a.status === 'missing');
      if (failed) throw new Error(`Could not prepare ${failed?.name ?? 'a generated file'}.`);
      if (assets.every((a) => a!.status === 'ready' && a!.probe))
        return new Map(assets.map((a) => [a!.id, a!]));
      if (Date.now() > until) throw new Error('Preparing the generated files took too long.');
      await new Promise((r) => setTimeout(r, this.d.pollMs ?? 100));
    }
  }
}

/** "AITA for refusing to…" → a short sequence name. */
function shortName(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t;
}
