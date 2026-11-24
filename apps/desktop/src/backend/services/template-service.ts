// Faceless templates (ADR-046): a story becomes a finished Short. The AI voice reads the title
// and story; a title card is drawn; both are imported into the project as ordinary media (rights
// "Made in Rec-It"), the voice's word times become its transcript, and packages/templates builds
// the sequence as one undoable batch of commands.
import { mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createId } from '@rec-it/core';
import type { MediaAsset, TemplateJob } from '@rec-it/ipc-contract';
import { storyShortSchema } from '@rec-it/ipc-contract';
import { randomStart, speakable, storyShort } from '@rec-it/templates';
import type { z } from 'zod';
import type { ProjectService } from './project-service';
import type { VoiceService } from './voice-service';

type StoryInput = z.output<typeof storyShortSchema>;

export interface TemplateDeps {
  projects: ProjectService;
  voice: VoiceService;
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
    const bg = this.d.projects.media().get(input.backgroundAssetId);
    if (bg.kind !== 'video' || !bg.probe?.durationSec)
      throw new Error('Choose a video for the background (gameplay, satisfying clips…).');
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

      // 1. Voiceover: the title, then the story, with word times.
      this.update(id, { stage: 'Recording the voiceover…', progress: 0.02 });
      const voicePath = join(folder, `voice ${stamp}.wav`);
      const spoken = await this.d.voice.speak(
        [
          { id: 'title', text: title },
          { id: 'story', text: story },
        ],
        {
          voice: input.voice,
          speed: input.speed,
          out: voicePath,
          signal,
          onProgress: (p, message) =>
            this.update(id, { progress: 0.02 + 0.68 * p, ...(message ? { stage: message } : {}) }),
        },
      );
      check();
      const titleSeg = spoken.segments.find((s) => s.id === 'title')!;

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
      const paths = [voicePath, ...(cardPath ? [cardPath] : [])];
      const result = await media().import(paths, {
        source: 'made-in-rec-it',
        notes: 'AI voice (Kokoro-82M) and title card made by Rec-It.',
        userAttested: true,
      });
      if (result.skipped.length)
        throw new Error(`Could not add the generated files: ${result.skipped[0]!.reason}`);
      const [voiceId, cardId] = result.imported;
      const ready = await this.waitReady(media, result.imported, signal);
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
      const bg = media().get(input.backgroundAssetId);
      const music = input.musicAssetId ? media().get(input.musicAssetId) : undefined;
      const voiceLength = voiceAsset.probe?.durationSec ?? spoken.duration;
      const bgLength = bg.probe?.durationSec ?? 0;
      const sequenceId = createId('sequence');
      const { command } = storyShort({
        sequenceId,
        name: shortName(input.title),
        voice: { assetId: voiceId!, duration: voiceLength, words, titleEnd: titleSeg.end },
        ...(cardId ? { card: { assetId: cardId } } : {}),
        background: {
          assetId: bg.id,
          duration: bgLength,
          start: input.backgroundStart ?? randomStart(bgLength, voiceLength + 1),
          keepSound: input.keepBackgroundSound,
        },
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
