// Faceless templates (ADR-046): a story becomes a finished Short. The AI voice reads the title
// and story; a title card is drawn; both are imported into the project as ordinary media (rights
// "Made in Rec-It"), the voice's word times become its transcript, and packages/templates builds
// the sequence as one undoable batch of commands.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { createId } from '@rec-it/core';
import type { MediaAsset, TemplateJob } from '@rec-it/ipc-contract';
import {
  episodeSchema,
  lowPolySchema,
  storyShortSchema,
  talkTestSchema,
} from '@rec-it/ipc-contract';
import {
  beatTimes,
  modelSchema,
  mouthFrames,
  normaliseModel,
  normalisePlan,
  renderSpecSchema,
  splitBeats,
  type CastMember,
  type Model,
  type RenderSpec,
} from '@rec-it/lowpoly';
import {
  PICTURE_STYLES,
  type EpisodePlan,
  type LowPolyBoard,
  type LowPolyScript,
  type ScenePlan,
} from '@rec-it/ai';
import {
  fallbackScenes,
  normaliseScenes,
  randomStart,
  sceneCount,
  speakable,
  splitSentences,
  storyShort,
  castVoices,
  normaliseEpisode,
  TAIL,
  referencePrompt,
  facePrompt,
  shotPrompt,
  shotReferences,
  parseScript,
  numberedScript,
  applyScript,
  withCast,
  type Episode,
  characterPrompt,
  talkingShot,
  type Scene,
} from '@rec-it/templates';
import type { AnimationService } from './animation-service';
import { CharacterStore, type CharacterFiles } from './character-store';
import type { ImageService } from './image-service';
import type { LowPolyService } from './lowpoly-service';
import type { z } from 'zod';
import type { ProjectService } from './project-service';
import type { SpokenSegment, VoiceService } from './voice-service';

type StoryInput = z.output<typeof storyShortSchema>;
type TalkInput = z.output<typeof talkTestSchema>;
type EpisodeInput = z.output<typeof episodeSchema>;
type LowPolyInput = z.output<typeof lowPolySchema>;

export interface TemplateDeps {
  projects: ProjectService;
  voice: VoiceService;
  images: ImageService;
  animation: AnimationService;
  /** The AI's scene plan, or null when no AI is set up or it fails (a plain grouping is used). */
  planScenes: (title: string, sentences: string[], count: number) => Promise<ScenePlan | null>;
  /** The AI's episode plan from a brief (ADR-052); rejects when no AI is set up. */
  planEpisode?: (
    brief: string,
    seconds: number,
    extra?: { script?: string; cast?: readonly { id: string; name: string; look: string }[] },
  ) => Promise<EpisodePlan>;
  /** Low-poly 3D Shorts (ADR-054): the renderer-backed filmer and the AI's script and storyboard. */
  lowPoly?: LowPolyService;
  lowPolyScript?: (
    topic: string,
    seconds: number,
    style?: 'ps1' | 'blocky',
  ) => Promise<LowPolyScript>;
  lowPolyBoard?: (title: string, beats: string[], cast: CastMember[]) => Promise<LowPolyBoard>;
  lowPolyModels?: (names: string[]) => Promise<Record<string, unknown>[]>;
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
  /** The project's remembered characters (ADR-053). */
  readonly characters = new CharacterStore(() => this.generatedFolder());
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
            notes: `AI voice (${voiceEngine(input.voice)}), title card and scene pictures (Z-Image Turbo) or backdrops made by Rec-It.`,
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

  /**
   * One talking-character shot (ADR-048), to measure speed and quality on this PC before longer
   * Shorts: the character's picture, the line in an AI voice, the animation, then a sequence.
   */
  talkTest(raw: unknown): string {
    const input = talkTestSchema.parse(raw);
    if (!this.d.projects.info()) throw new Error('Open or create a project first.');
    if (!this.d.images.status().available) throw new Error('Install the AI picture engine first.');
    if (!this.d.animation.status().available)
      throw new Error('Install the mouth-shape engine first.');
    const id = createId('tpl');
    this.jobs = [
      ...this.jobs.filter((j) => j.state === 'running'),
      {
        id,
        kind: 'talk-test',
        title: input.character.slice(0, 80),
        state: 'running',
        stage: 'Starting…',
        progress: 0,
      },
    ];
    this.d.onChange(this.jobs);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.runTalkTest(id, input, controller.signal).finally(() => this.controllers.delete(id));
    return id;
  }

  private async runTalkTest(id: string, input: TalkInput, signal: AbortSignal): Promise<void> {
    const started = Date.now();
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
      const line = speakable(input.line);
      if (!line) throw new Error('The line needs some words.');

      // 1. The voice, with a time for every sound: it drives the mouth.
      this.update(id, { stage: 'Recording the line…', progress: 0.02 });
      const voicePath = join(folder, `line ${stamp}.wav`);
      const spoken = await this.d.voice.speak([{ id: 'line', text: line }], {
        voice: input.voice,
        speed: 1,
        out: voicePath,
        signal,
      });
      check();
      const sounds = spoken.segments.flatMap((s) => s.sounds ?? []);

      // 2. The character, mouth closed (frees the GPU from Ollama first).
      this.update(id, { stage: 'Freeing the graphics card…', progress: 0.05 });
      await this.d.releaseGpu?.().catch(() => undefined);
      check();
      const seed = Math.floor(Math.random() * 1_000_000);
      const charDir = join(folder, `character ${stamp}`);
      const [picture] = await this.d.images.generate(
        [
          characterPrompt(input.character, {
            style: input.style,
            setting: input.setting,
            mood: input.mood,
          }),
        ],
        {
          outDir: charDir,
          seed,
          ...CHARACTER_SIZE,
          signal,
          onProgress: (p) =>
            this.update(id, { stage: 'Drawing the character…', progress: 0.06 + 0.12 * p }),
        },
      );
      check();

      // 3. Its mouth shapes and blink (the slow part, once per character).
      const shapesStart = Date.now();
      const shapes = await this.d.animation.shapes({
        base: picture!,
        outDir: join(charDir, 'shapes'),
        seed,
        signal,
        onProgress: (p, message) =>
          this.update(id, {
            progress: 0.18 + 0.62 * p,
            ...(message ? { stage: `${message} ${elapsed(shapesStart)}` } : {}),
          }),
      });
      const shapesSeconds = (Date.now() - shapesStart) / 1000;
      check();

      // 4. The mouth in time with the voice.
      this.update(id, { stage: 'Animating the mouth…', progress: 0.82 });
      const clip = await this.d.animation.render({
        shapes,
        sounds,
        audio: voicePath,
        liveliness: input.liveliness,
        duration: spoken.duration,
        out: join(folder, `talking ${stamp}.mp4`),
        seed,
        signal,
      });
      check();

      // 5. Import and build a small sequence.
      this.update(id, { stage: 'Adding the shot to the project…', progress: 0.9 });
      const paths = [clip.video, voicePath, picture!];
      const existing = await Promise.all(paths.map((p) => media().findSame(p)));
      const fresh = paths.filter((_, i) => !existing[i]);
      const result = fresh.length
        ? await media().import(fresh, {
            source: 'made-in-rec-it',
            notes: `Talking character made by Rec-It: picture (Z-Image Turbo), mouth shapes (FLUX.2 Klein), voice (${voiceEngine(input.voice)}).`,
            userAttested: true,
          })
        : { imported: [], skipped: [] };
      if (result.skipped.length)
        throw new Error(`Could not add the generated files: ${result.skipped[0]!.reason}`);
      const queue = [...result.imported];
      const ids = existing.map((x) => x ?? queue.shift()!);
      const ready = await this.waitReady(media, ids, signal);
      const [videoId, voiceId] = ids;
      const sequenceId = createId('sequence');
      this.d.projects.document().execute(
        talkingShot({
          sequenceId,
          name: shortName(`Talking test: ${input.character}`),
          video: {
            assetId: videoId!,
            duration: ready.get(videoId!)?.probe?.durationSec ?? clip.seconds,
          },
          voice: {
            assetId: voiceId!,
            duration: ready.get(voiceId!)?.probe?.durationSec ?? spoken.duration,
          },
          ids: { video: createId('item'), voice: createId('item') },
        }),
      );
      const drawn = Object.keys(shapes).filter((k) => k !== 'base' && shapes[k] !== shapes.base);
      this.update(id, {
        state: 'done',
        stage: `Done in ${duration((Date.now() - started) / 1000)}; the mouth shapes took ${duration(shapesSeconds)} (${new Set(drawn.map((k) => shapes[k])).size} of 7 drawn).`,
        progress: 1,
        sequenceId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted || error instanceof Cancelled || /cancel/i.test(message))
        this.update(id, { state: 'cancelled', stage: 'Cancelled' });
      else this.update(id, { state: 'failed', stage: 'Failed', error: message });
    }
  }

  /** Starts a low-poly 3D Short (ADR-054); returns at once with the job id. */
  lowPolyShort(raw: unknown): string {
    const input = lowPolySchema.parse(raw);
    if (!this.d.projects.info()) throw new Error('Open or create a project first.');
    if (!this.d.lowPoly || !this.d.lowPolyBoard)
      throw new Error('3D Shorts are not available here.');
    if (!input.script && !this.d.lowPolyScript)
      throw new Error('Writing a script needs the AI (Settings → AI).');
    if (input.musicAssetId) {
      const m = this.d.projects.media().get(input.musicAssetId);
      if (!m.probe?.audioStreamCount) throw new Error('The music has no sound.');
    }
    const id = createId('tpl');
    this.jobs = [
      ...this.jobs.filter((j) => j.state === 'running'),
      { id, kind: 'lowpoly', title: '3D Short', state: 'running', stage: 'Starting…', progress: 0 },
    ];
    this.d.onChange(this.jobs);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.runLowPoly(id, input, controller.signal).finally(() => this.controllers.delete(id));
    return id;
  }

  private async runLowPoly(id: string, input: LowPolyInput, signal: AbortSignal): Promise<void> {
    const started = Date.now();
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
      const seed = Math.floor(Math.random() * 100_000);

      // 1. The script: yours as written, or the AI's in the genre's style.
      let title =
        input.topic
          .split(/[.!?\n]/)[0]!
          .trim()
          .slice(0, 80) || '3D Short';
      let script = input.script;
      if (!script) {
        this.update(id, { stage: 'Writing the script…', progress: 0.02 });
        const written = await this.d.lowPolyScript!(input.topic, input.seconds, input.style);
        title = written.title.trim() || title;
        script = written.script;
      }
      const text = speakable(script);
      const beats = splitBeats(text);
      if (!beats.length) throw new Error('The script has nothing to say.');
      this.update(id, { title: title.slice(0, 80) });
      check();

      // 2. The narration, with a time for every word and sound.
      this.update(id, { stage: 'Recording the narration…', progress: 0.08 });
      const voicePath = join(folder, `3d voice ${stamp}.wav`);
      const spoken = await this.d.voice.speak([{ id: 'all', text }], {
        voice: input.narrator,
        speed: input.speed,
        out: voicePath,
        signal,
        onProgress: (p) => this.update(id, { progress: 0.08 + 0.12 * p }),
      });
      const words = spoken.segments.flatMap((s) => s.words);
      const sounds = spoken.segments.flatMap((s) => s.sounds ?? []);
      const times = beatTimes(beats, words, spoken.duration);
      check();

      // 3. The storyboard: one shot per beat, from the kit's vocabulary.
      this.update(id, { stage: 'Planning the shots…', progress: 0.2 });
      const board = await this.d.lowPolyBoard!(title, beats, []);
      const plan = normalisePlan(board, beats, { script: text });
      check();

      // 3b. Things the kit has no prop for are designed by the AI from simple shapes, once per
      // project (kept in "<project> media/lowpoly-models.json").
      const models = await this.lowPolyModels(folder, plan.models, (stage) =>
        this.update(id, { stage }),
      );
      const has = (p: string) => !p.startsWith('m:') || !!models[p.slice(2)];
      for (const sh of plan.shots) {
        sh.props = sh.props.filter(has);
        if (!has(sh.subject)) sh.subject = sh.props[0] ?? 'none';
      }
      check();

      // 4. Film it in the renderer, frame by frame.
      const fps = 30;
      const length = spoken.duration + TAIL;
      const spec: RenderSpec = renderSpecSchema.parse({
        width: 1080,
        height: 1920,
        fps,
        // PS1: the low pass's height. Blocky: the render height (draft, fast, full HD).
        pixelHeight:
          input.style === 'blocky'
            ? { chunky: 720, classic: 1280, clean: 1920 }[input.pixels]
            : { chunky: 320, classic: 480, clean: 720 }[input.pixels],
        cast: plan.cast,
        brand: input.brand,
        brandOpacity: input.brandOpacity,
        style: input.style,
        classicSkin: input.style === 'blocky' && input.classicSkin,
        models: Object.fromEntries(
          Object.entries(models).filter(([m]) =>
            plan.shots.some((sh) => sh.subject === `m:${m}` || sh.props.includes(`m:${m}`)),
          ),
        ),
        shots: plan.shots.map((sh, i) => {
          const start = times[i]!.start;
          const end = i + 1 < times.length ? times[i + 1]!.start : length;
          return {
            ...sh,
            start,
            end,
            mouth: sh.speaker ? mouthFrames(sounds, start, end, fps) : [],
            seed: seed + i * 17,
          };
        }),
      });
      this.update(id, { stage: `Filming ${spec.shots.length} shots in 3D…`, progress: 0.22 });
      const videoPath = join(folder, `3d ${stamp}.mp4`);
      // The plan next to the film: what the AI answered and what was built from it.
      await writeFile(
        join(folder, `3d ${stamp} plan.json`),
        JSON.stringify(
          {
            title,
            beats,
            board,
            cast: plan.cast,
            shots: spec.shots.map(({ mouth: _m, ...sh }) => sh),
            models: Object.keys(spec.models),
          },
          null,
          2,
        ),
      ).catch(() => undefined);
      await this.d.lowPoly!.render(spec, videoPath, {
        signal,
        onProgress: (p) =>
          this.update(id, {
            stage: `Filming ${spec.shots.length} shots in 3D… ${Math.round(p * 100)}% ${elapsed(started)}`,
            progress: 0.22 + 0.63 * p,
          }),
      });
      check();

      // 5. Import and build the Short in one undoable step.
      this.update(id, { stage: 'Adding the Short to the project…', progress: 0.88 });
      const paths = [voicePath, videoPath];
      const existing = await Promise.all(paths.map((p) => media().findSame(p)));
      const fresh = paths.filter((_, i) => !existing[i]);
      const result = fresh.length
        ? await media().import(fresh, {
            source: 'made-in-rec-it',
            notes: `3D Short made by Rec-It: voice (${voiceEngine(input.narrator)}), ${input.style === 'blocky' ? 'blocky' : 'low-poly'} 3D filmed by Rec-It.`,
            userAttested: true,
          })
        : { imported: [], skipped: [] };
      if (result.skipped.length)
        throw new Error(`Could not add the generated files: ${result.skipped[0]!.reason}`);
      const queue = [...result.imported];
      const ids = existing.map((x) => x ?? queue.shift()!);
      const ready = await this.waitReady(media, ids, signal);
      const [voiceId, videoId] = ids;
      const voiceWords = words.map((w) => ({ ...w, p: 1 }));
      this.d.projects
        .database()
        .saveTranscript(
          voiceId!,
          'en',
          'rec-it-voice',
          JSON.stringify({ language: 'en', model: 'rec-it-voice', words: voiceWords }),
        );
      this.d.onTranscript();
      const music = input.musicAssetId ? media().get(input.musicAssetId) : undefined;
      const sequenceId = createId('sequence');
      const { command } = storyShort({
        sequenceId,
        name: shortName(title),
        voice: {
          assetId: voiceId!,
          duration: ready.get(voiceId!)?.probe?.durationSec ?? spoken.duration,
          words: voiceWords,
          titleEnd: 0,
        },
        background: {
          kind: 'footage',
          assetId: videoId!,
          // The film covers the whole Short (frame-rounded); never let rounding add a sliver.
          duration: Math.max(ready.get(videoId!)?.probe?.durationSec ?? 0, length),
          start: 0,
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
        captions: {
          style: input.captionStyle,
          ...(input.captionStyle === 'retro' ? { position: 0.68, uppercase: false } : {}),
          ...(input.captionStyle === 'game' ? { position: 0.62, uppercase: false } : {}),
        },
        ids: {
          voice: createId('item'),
          card: createId('item'),
          background: () => createId('item'),
          music: createId('item'),
        },
      });
      check();
      this.d.projects.document().execute(command);
      this.update(id, {
        state: 'done',
        stage: `Done in ${duration((Date.now() - started) / 1000)}: ${spec.shots.length} shots, ${duration(length)} long.`,
        progress: 1,
        sequenceId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal.aborted || error instanceof Cancelled || /cancel/i.test(message))
        this.update(id, { state: 'cancelled', stage: 'Cancelled' });
      else this.update(id, { state: 'failed', stage: 'Failed', error: message });
    }
  }

  /** Designs (or reuses) primitive models for objects the 3D kit lacks; missing ones are skipped. */
  private async lowPolyModels(
    folder: string,
    wanted: { id: string; name: string }[],
    stage: (s: string) => void,
  ): Promise<Record<string, Model>> {
    const file = join(folder, 'lowpoly-models.json');
    const cache: Record<string, Model> = {};
    try {
      const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        const m = modelSchema.safeParse(v);
        if (m.success) cache[k] = m.data;
      }
    } catch {
      // No models yet.
    }
    const missing = wanted.filter((w) => !cache[w.id]);
    if (missing.length && this.d.lowPolyModels) {
      stage(
        `Building ${missing.length === 1 ? 'a 3D model' : `${missing.length} 3D models`}: ${missing.map((m) => m.name).join(', ')}…`,
      );
      try {
        const answer = await this.d.lowPolyModels(missing.map((m) => m.name));
        missing.forEach((w, i) => {
          const named = answer.find(
            (a) =>
              typeof a.name === 'string' && a.name.trim().toLowerCase() === w.name.toLowerCase(),
          );
          const m = normaliseModel(named ?? answer[i], w.name);
          if (m) cache[w.id] = m;
        });
        await writeFile(file, JSON.stringify(cache, null, 2)).catch(() => undefined);
      } catch {
        // Without the models the shots simply leave those things out.
      }
    }
    return Object.fromEntries(wanted.filter((w) => cache[w.id]).map((w) => [w.id, cache[w.id]!]));
  }

  /** The project's remembered characters, for the Make a Short dialog. */
  async cast(): Promise<{ id: string; name: string; look: string }[]> {
    if (!this.d.projects.info()) return [];
    return (await this.characters.list()).map(({ id, name, look }) => ({ id, name, look }));
  }

  /** Forgets a remembered character. */
  async forget(id: string): Promise<void> {
    if (this.d.projects.info()) await this.characters.remove(id);
  }

  /** Starts an episode from a brief (ADR-052); returns at once with the job id. */
  episode(raw: unknown): string {
    const input = episodeSchema.parse(raw);
    if (!this.d.projects.info()) throw new Error('Open or create a project first.');
    if (!this.d.planEpisode) throw new Error('Episodes need the AI (Settings → AI).');
    if (!this.d.images.status().available) throw new Error('Install the AI picture engine first.');
    if (!this.d.animation.status().available)
      throw new Error('Install the mouth-shape engine first.');
    if (input.musicAssetId) {
      const m = this.d.projects.media().get(input.musicAssetId);
      if (!m.probe?.audioStreamCount) throw new Error('The music has no sound.');
    }
    const id = createId('tpl');
    this.jobs = [
      ...this.jobs.filter((j) => j.state === 'running'),
      { id, kind: 'episode', title: 'Episode', state: 'running', stage: 'Starting…', progress: 0 },
    ];
    this.d.onChange(this.jobs);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    void this.runEpisode(id, input, controller.signal).finally(() => this.controllers.delete(id));
    return id;
  }

  private async runEpisode(id: string, input: EpisodeInput, signal: AbortSignal): Promise<void> {
    const started = Date.now();
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
      const work = join(folder, `episode ${stamp}`);
      await mkdir(work, { recursive: true });
      const seed = Math.floor(Math.random() * 1_000_000);

      // 1. The plan: cast, shots, lines and pictures. A written script is spoken exactly as
      // written (the AI only plans the pictures); remembered characters are reused (ADR-053).
      const lines = input.script ? parseScript(input.script) : [];
      if (input.script && !lines.length) throw new Error('The script has no lines to speak.');
      const remembered = await this.characters.list();
      this.update(id, { stage: 'Planning the episode…', progress: 0.01 });
      const plan = await this.d.planEpisode!(input.brief, input.seconds, {
        ...(lines.length ? { script: numberedScript(lines) } : {}),
        cast: remembered.map(({ id: cid, name, look }) => ({ id: cid, name, look })),
      });
      const episode: Episode = withCast(
        lines.length ? applyScript(plan, lines) : normaliseEpisode(plan),
        remembered,
      );
      if (!episode.shots.length) throw new Error('The AI planned no shots; try again.');
      this.update(id, { title: episode.title.slice(0, 80) });
      check();

      // 2. Voices: one recording per voice (narrator, each character), then one track in order.
      const voices = castVoices(
        episode.characters,
        input.narrator,
        this.d.voice.human.available(),
        Object.fromEntries(remembered.flatMap((c) => (c.voice ? [[c.id, c.voice]] : []))),
      );
      const byVoice = new Map<string, number[]>();
      episode.shots.forEach((sh, i) => {
        const v = voices[sh.speaker] ?? input.narrator;
        byVoice.set(v, [...(byVoice.get(v) ?? []), i]);
      });
      const spokenBy = new Map<number, { wav: string; seg: SpokenSegment }>();
      let done = 0;
      for (const [voice, shots] of byVoice) {
        this.update(id, {
          stage: `Recording the voices (${++done} of ${byVoice.size})…`,
          progress: 0.03 + 0.12 * ((done - 1) / byVoice.size),
        });
        const wav = join(work, `voice ${done}.wav`);
        const r = await this.d.voice.speak(
          shots.map((i) => ({ id: `s${i}`, text: episode.shots[i]!.text })),
          { voice, speed: 1, out: wav, signal },
        );
        for (const seg of r.segments) spokenBy.set(Number(seg.id.slice(1)), { wav, seg });
        check();
      }
      const track = await this.d.voice.assemble(
        episode.shots.map((_, i) => {
          const s = spokenBy.get(i)!;
          return { wav: s.wav, start: s.seg.start, end: s.seg.end };
        }),
        join(folder, `episode voice ${stamp}.wav`),
        join(work, 'lines'),
      );
      const placed = track.pieces;
      const shift = (i: number) => placed[i]!.start - spokenBy.get(i)!.seg.start;
      const words = episode.shots.flatMap((_, i) =>
        spokenBy.get(i)!.seg.words.map((w) => ({
          ...w,
          start: w.start + shift(i),
          end: w.end + shift(i),
        })),
      );
      check();

      // 3. Character references: remembered ones are reused; new characters get a full-body
      // design sheet and a face close-up drawn from it, kept for every later episode.
      this.update(id, { stage: 'Freeing the graphics card…', progress: 0.16 });
      await this.d.releaseGpu?.().catch(() => undefined);
      const refs = new Map<string, CharacterFiles>();
      const cast = episode.characters.filter((c) =>
        episode.shots.some((sh) => sh.characters.includes(c.id)),
      );
      for (const [k, c] of cast.entries()) {
        const known = remembered.find((r) => r.id === c.id);
        if (known) {
          refs.set(c.id, known);
          continue;
        }
        const progress = 0.17 + 0.08 * (k / Math.max(1, cast.length));
        this.update(id, { stage: `Designing ${c.name} (${k + 1} of ${cast.length})…`, progress });
        const [sheet] = await this.d.images.generate([referencePrompt(c, episode.style)], {
          outDir: join(work, `ref ${c.id}`),
          seed: seed + k,
          ...CHARACTER_SIZE,
          signal,
        });
        check();
        this.update(id, {
          stage: `Drawing ${c.name}'s face (${k + 1} of ${cast.length})…`,
          progress,
        });
        const face = await this.d.animation.draw({
          refs: [sheet!],
          prompt: facePrompt(c, episode.style),
          out: join(work, `ref ${c.id} face.png`),
          ...FACE_SIZE,
          seed: seed + 50 + k,
          signal,
        });
        check();
        const voice = voices[c.id]?.replace(/^hq:k-/, '');
        refs.set(
          c.id,
          await this.characters.save(
            { ...c, ...(voice && /^[a-z]{2}_[a-z]+$/.test(voice) ? { voice } : {}) },
            { sheet: sheet!, face },
          ),
        );
      }

      // 4. One picture per shot: characters from their references, others from scratch.
      const pictures: string[] = [];
      for (const [i, sh] of episode.shots.entries()) {
        this.update(id, {
          stage: `Drawing shot ${i + 1} of ${episode.shots.length}… ${elapsed(started)}`,
          progress: 0.25 + 0.4 * (i / episode.shots.length),
        });
        const used = shotReferences(sh).filter((r) => refs.get(r.id)?.[r.kind]);
        const shotRefs = used.map((r) => refs.get(r.id)![r.kind]!);
        const prompt = shotPrompt(sh, episode, used);
        pictures.push(
          shotRefs.length
            ? await this.d.animation.draw({
                refs: shotRefs,
                prompt,
                out: join(work, `shot ${i + 1}.png`),
                ...CHARACTER_SIZE,
                seed: seed + 100 + i,
                signal,
              })
            : (
                await this.d.images.generate([prompt], {
                  outDir: join(work, `shot ${i + 1}`),
                  seed: seed + 100 + i,
                  ...CHARACTER_SIZE,
                  signal,
                })
              )[0]!,
        );
        check();
      }

      // 5. Dialogue shots talk: mouth shapes on the shot, timed to that line.
      const length = track.duration + TAIL;
      const visuals = [...pictures];
      const talking = episode.shots
        .map((sh, i) => ({ sh, i }))
        .filter(({ sh }) => sh.speaker !== 'narrator');
      for (const [k, { i }] of talking.entries()) {
        this.update(id, {
          stage: `Animating line ${k + 1} of ${talking.length}… ${elapsed(started)}`,
          progress: 0.65 + 0.2 * (k / Math.max(1, talking.length)),
        });
        const shapes = await this.d.animation.shapes({
          base: pictures[i]!,
          outDir: join(work, `shot ${i + 1} shapes`),
          seed: seed + 200 + i,
          signal,
        });
        const seg = spokenBy.get(i)!.seg;
        // Until the next shot starts, so the clip fills its whole slot.
        const until = i + 1 < placed.length ? placed[i + 1]!.start : length;
        const clip = await this.d.animation.render({
          shapes,
          sounds: (seg.sounds ?? []).map((s) => ({
            ...s,
            start: s.start - seg.start,
            end: s.end - seg.start,
          })),
          audio: placed[i]!.wav,
          liveliness: input.liveliness,
          // A little longer than the slot: frame rounding must never leave it short.
          duration: until - placed[i]!.start + 0.1,
          out: join(folder, `episode ${stamp} line ${k + 1}.mp4`),
          seed: seed + 300 + i,
          signal,
        });
        visuals[i] = clip.video;
        check();
      }

      // 6. Import everything and build the episode in one undoable step.
      this.update(id, { stage: 'Adding the episode to the project…', progress: 0.88 });
      const paths = [join(folder, `episode voice ${stamp}.wav`), ...visuals];
      const existing = await Promise.all(paths.map((p) => media().findSame(p)));
      const fresh = paths.filter((_, i) => !existing[i]);
      const result = fresh.length
        ? await media().import(fresh, {
            source: 'made-in-rec-it',
            notes: `Episode made by Rec-It: voices (${voiceEngine(input.narrator)} and cast), pictures (Z-Image Turbo, FLUX.2 Klein), mouth shapes (FLUX.2 Klein).`,
            userAttested: true,
          })
        : { imported: [], skipped: [] };
      if (result.skipped.length)
        throw new Error(`Could not add the generated files: ${result.skipped[0]!.reason}`);
      const queue = [...result.imported];
      const ids = existing.map((x) => x ?? queue.shift()!);
      const ready = await this.waitReady(media, ids, signal);
      const [voiceId, ...visualIds] = ids;
      const voiceWords = words.map((w) => ({ ...w, p: 1 }));
      this.d.projects
        .database()
        .saveTranscript(
          voiceId!,
          'en',
          'rec-it-voice',
          JSON.stringify({ language: 'en', model: 'rec-it-voice', words: voiceWords }),
        );
      this.d.onTranscript();
      const music = input.musicAssetId ? media().get(input.musicAssetId) : undefined;
      const sequenceId = createId('sequence');
      const { command } = storyShort({
        sequenceId,
        name: shortName(episode.title),
        voice: {
          assetId: voiceId!,
          duration: ready.get(voiceId!)?.probe?.durationSec ?? track.duration,
          words: voiceWords,
          titleEnd: 0,
        },
        background: {
          kind: 'scenes',
          scenes: episode.shots.map((sh, i) => ({
            assetId: visualIds[i]!,
            start: placed[i]!.start,
            end: placed[i]!.end,
            // Talking close-ups push in gently; the rest use the planned camera move.
            motion: sh.speaker === 'narrator' ? sh.motion : 'zoomIn',
          })),
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
      this.update(id, {
        state: 'done',
        stage: `Done in ${duration((Date.now() - started) / 1000)}: ${episode.shots.length} shots, ${talking.length} spoken by characters.`,
        progress: 1,
        sequenceId,
      });
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

/** Characters are drawn larger than scene pictures: they fill the frame and must stay sharp. */
const CHARACTER_SIZE = { width: 768, height: 1344 };
/** A character's face reference: square and small, so a shot with it stays quick. */
const FACE_SIZE = { width: 640, height: 640 };

/** The engine behind a voice id, for the media notes. */
function voiceEngine(voice: string): string {
  if (voice === 'hq:builtin') return 'Chatterbox Turbo, built-in voice';
  if (voice.startsWith('hq:k-'))
    return `Chatterbox Turbo in the tone of Kokoro's ${voice.slice(5)}`;
  if (voice.startsWith('hq:')) return 'Chatterbox Turbo, cloned from your voice sample';
  return 'Kokoro-82M';
}

/** 312 → "5 min 12 s". */
function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

/** "(2 min 5 s so far)" since `start`. */
function elapsed(start: number): string {
  return `(${duration((Date.now() - start) / 1000)} so far)`;
}

/** "AITA for refusing to…" → a short sequence name. */
function shortName(title: string): string {
  const t = title.replace(/\s+/g, ' ').trim();
  return t.length > 48 ? `${t.slice(0, 46).trimEnd()}…` : t;
}
