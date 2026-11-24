// "Create a Short" (ADR-046): faceless templates. The story template writes (or tidies) a story
// with the configured AI, voices it on this PC, and builds a finished, editable Short.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Clapperboard,
  MessagesSquare,
  Play,
  Scissors,
  Square,
  Columns2,
  Wand2,
  X,
} from 'lucide-react';
import { create } from 'zustand';
import {
  PICTURE_STYLES,
  SCRIPT_GENRES,
  STORY_GENRES,
  estimateSeconds,
  type PictureStyle,
  type StoryGenre,
} from '@rec-it/ai';
import { DEFAULT_VOICE, VOICES } from '@rec-it/templates';
import type { ImageStatus, StoryShortInput } from '@rec-it/ipc-contract';
import { Button, Dialog, TextField } from '@rec-it/ui';
import { backend, RecitError } from '../api';
import { notify } from '../notifications';
import { useApp } from '../store';

const useCreateDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openCreateDialog = () => useCreateDialog.setState({ open: true });

type TemplateId = 'story' | 'characters' | 'texts' | 'split' | 'clips';
const TEMPLATES: {
  id: TemplateId;
  title: string;
  text: string;
  icon: React.ReactNode;
  ready: boolean;
}[] = [
  {
    id: 'story',
    title: 'Story or topic video',
    text: 'From a topic or your script: AI voice and big captions over AI pictures, motion graphics or gameplay.',
    icon: <BookOpen size={18} />,
    ready: true,
  },
  {
    id: 'characters',
    title: 'Talking characters',
    text: 'Pixar-style 3D characters that say your lines, animated on this PC. Start with a test shot.',
    icon: <Clapperboard size={18} />,
    ready: true,
  },
  {
    id: 'texts',
    title: 'Text conversation',
    text: 'Chat bubbles that pop in as two voices read them.',
    icon: <MessagesSquare size={18} />,
    ready: false,
  },
  {
    id: 'split',
    title: 'Split screen',
    text: 'Your clip on top, satisfying gameplay below.',
    icon: <Columns2 size={18} />,
    ready: false,
  },
  {
    id: 'clips',
    title: 'Find clips',
    text: 'The best moments of a long video, ranked by the clip finder and the AI.',
    icon: <Scissors size={18} />,
    ready: false,
  },
];

const message = (e: unknown) =>
  e instanceof RecitError || e instanceof Error ? e.message : String(e);

export function CreateDialogHost() {
  const open = useCreateDialog((s) => s.open);
  const close = () => useCreateDialog.setState({ open: false });
  return (
    <Dialog open={open} onClose={close} title="Create a Short" closeIcon={<X size={16} />}>
      <CreateBody onDone={close} />
    </Dialog>
  );
}

function CreateBody({ onDone }: { onDone: () => void }) {
  const [template, setTemplate] = useState<TemplateId>('story');
  const project = useApp((s) => s.project);
  return (
    <div className="create" data-testid="create-dialog">
      <nav className="create__templates" aria-label="Templates">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className="create__template"
            data-active={template === t.id}
            disabled={!t.ready}
            onClick={() => setTemplate(t.id)}
          >
            <span className="create__icon">{t.icon}</span>
            <span>
              <strong>{t.title}</strong>
              <small>{t.ready ? t.text : 'Coming next'}</small>
            </span>
          </button>
        ))}
      </nav>
      <div className="create__form">
        {!project ? (
          <p className="create__note">Open or create a project first.</p>
        ) : (
          <>
            {template === 'story' && <StoryForm onDone={onDone} />}
            {template === 'characters' && <CharactersForm onDone={onDone} />}
          </>
        )}
      </div>
    </div>
  );
}

function StoryForm({ onDone }: { onDone: () => void }) {
  const assets = useApp((s) => s.assets);
  const voiceStatus = useApp((s) => s.voice);
  const imageStatus = useApp((s) => s.images);
  const jobs = useApp((s) => s.templateJobs);
  const videos = assets.filter((a) => a.kind === 'video' && a.status === 'ready');
  const sounds = assets.filter(
    (a) =>
      a.status === 'ready' &&
      a.rights.source !== 'made-in-rec-it' &&
      (a.kind === 'audio' || (a.kind === 'video' && a.probe?.audioStreamCount)),
  );

  const [mode, setMode] = useState<'ai' | 'paste'>('ai');
  const [genre, setGenre] = useState<StoryGenre>('aita');
  const [idea, setIdea] = useState('');
  const [seconds, setSeconds] = useState(60);
  const [title, setTitle] = useState('');
  const [story, setStory] = useState('');
  const [community, setCommunity] = useState<string>(STORY_GENRES.aita.community);
  const [username, setUsername] = useState('');
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  const [speed, setSpeed] = useState(1.1);
  const [chosenBackground, setBackground] = useState('');
  // The first video until the user picks one (media may finish importing while this is open).
  const background = chosenBackground || videos[0]?.id || '';
  const [randomStart, setRandomStart] = useState(true);
  const [music, setMusic] = useState('');
  const [visuals, setVisuals] = useState<'footage' | 'pictures' | 'graphics'>('pictures');
  const [pictureStyle, setPictureStyle] = useState<PictureStyle>('cinematic');
  const [captionStyle, setCaptionStyle] =
    useState<NonNullable<StoryShortInput['captionStyle']>>('pop');
  const [card, setCard] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => audio.current?.pause(), []);

  const job = jobs.find((j) => j.id === jobId);
  useEffect(() => {
    if (job?.state === 'done') {
      // Show the new Short from the start, not whatever media was selected.
      useApp.setState({
        selectedAssetId: null,
        selectedItemIds: [],
        monitor: 'program',
        playhead: 0,
        playing: false,
      });
      notify('Your Short is ready on the timeline.', 'info');
      onDone();
    }
  }, [job?.state, onDone]);

  const length = useMemo(
    () => (story ? estimateSeconds(`${title} ${story}`, speed) : 0),
    [title, story, speed],
  );

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const write = () =>
    run('Writing…', async () => {
      const r = await backend.invoke('ai.writeStory', {
        genre,
        ...(idea.trim() ? { idea: idea.trim() } : {}),
        seconds,
      });
      setTitle(r.title);
      setStory(r.story);
      if (r.username) setUsername(r.username);
      setCommunity(STORY_GENRES[genre].community);
    });

  const fit = () =>
    run('Fitting…', async () => {
      const r = await backend.invoke('ai.narrate', { title, text: story, seconds });
      setTitle(r.title);
      setStory(r.story);
    });

  const preview = () =>
    run('Speaking…', async () => {
      const { wav } = await backend.invoke('voice.preview', { voice, speed });
      const bytes = Uint8Array.from(atob(wav), (c) => c.charCodeAt(0));
      audio.current?.pause();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
      const player = new Audio(url);
      player.onended = () => URL.revokeObjectURL(url);
      audio.current = player;
      await player.play();
    });

  const start = () =>
    run('Starting…', async () => {
      const r = await backend.invoke('templates.story', {
        title,
        story,
        community,
        username,
        voice,
        speed,
        visuals,
        pictureStyle,
        backgroundAssetId: visuals === 'footage' ? background : null,
        backgroundStart: randomStart ? null : 0,
        musicAssetId: music || null,
        captionStyle,
        card,
        theme,
        upvotes: 1000 + Math.round(Math.random() * 40000),
        comments: 100 + Math.round(Math.random() * 3000),
      });
      setJobId(r.jobId);
    });

  const voiceReady = voiceStatus?.available === true;
  const running = job?.state === 'running';
  const visualsReady =
    visuals === 'footage' ? !!background : visuals === 'pictures' ? !!imageStatus?.available : true;
  const canCreate = !!title.trim() && !!story.trim() && visualsReady && voiceReady && !running;

  return (
    <form
      className="create__story"
      onSubmit={(e) => {
        e.preventDefault();
        if (canCreate) void start();
      }}
    >
      <section className="create__section">
        <h3>Story</h3>
        <div
          className="create__segmented"
          role="radiogroup"
          aria-label="Where the story comes from"
        >
          <button type="button" data-active={mode === 'ai'} onClick={() => setMode('ai')}>
            Write with AI
          </button>
          <button type="button" data-active={mode === 'paste'} onClick={() => setMode('paste')}>
            Paste a script
          </button>
        </div>
        {mode === 'ai' && (
          <div className="create__row">
            <label>
              Kind
              <select
                className="ui-input"
                value={genre}
                onChange={(e) => {
                  const g = e.target.value as StoryGenre;
                  setGenre(g);
                  setCard(!SCRIPT_GENRES.includes(g));
                }}
              >
                {(Object.keys(STORY_GENRES) as StoryGenre[]).map((g) => (
                  <option key={g} value={g}>
                    {STORY_GENRES[g].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="create__grow">
              {SCRIPT_GENRES.includes(genre) ? 'Topic' : 'Idea (optional)'}
              <TextField
                value={idea}
                placeholder={
                  SCRIPT_GENRES.includes(genre)
                    ? 'e.g. why octopuses have three hearts'
                    : 'e.g. my roommate labels every egg in the fridge'
                }
                onChange={(e) => setIdea(e.target.value)}
              />
            </label>
          </div>
        )}
        <div className="create__row">
          <label className="create__grow">
            Length: about {seconds} s
            <input
              type="range"
              min={30}
              max={120}
              step={5}
              value={seconds}
              onChange={(e) => setSeconds(Number(e.target.value))}
            />
          </label>
          {mode === 'ai' ? (
            <Button
              icon={<Wand2 size={14} />}
              disabled={!!busy}
              onClick={() => void write()}
              data-testid="story-write"
            >
              {busy === 'Writing…' ? 'Writing…' : title ? 'Write another' : 'Write it'}
            </Button>
          ) : (
            <Button
              icon={<Wand2 size={14} />}
              disabled={!!busy || !story.trim()}
              onClick={() => void fit()}
              title="Tidy the post for narration and cut it to length"
            >
              {busy === 'Fitting…' ? 'Fitting…' : 'Fit to length with AI'}
            </Button>
          )}
        </div>
        <label>
          Title
          <TextField
            value={title}
            placeholder="AITA for refusing to…"
            onChange={(e) => setTitle(e.target.value)}
            data-testid="story-title"
          />
        </label>
        <label>
          Story
          <textarea
            className="ui-input create__text"
            value={story}
            rows={7}
            placeholder={
              mode === 'paste' ? 'Paste the post here…' : 'The AI writes it here; you can edit it.'
            }
            onChange={(e) => setStory(e.target.value)}
            data-testid="story-text"
          />
        </label>
        {story && (
          <small className="create__hint">
            About {Math.round(length)} s when read
            {length > 180 ? ' (Shorts can be up to 3 minutes; consider cutting it)' : ''}.
          </small>
        )}
      </section>

      <section className="create__section">
        <h3>Voice</h3>
        {!voiceReady ? (
          <div className="create__note">
            {voiceStatus?.install.state === 'running' ? (
              <>Installing the AI voice… {voiceStatus.install.message}</>
            ) : (
              <>
                The AI voice runs on your PC and is installed once (about 300 MB).{' '}
                <Button
                  size="sm"
                  disabled={!!voiceStatus?.blocked}
                  onClick={() => void backend.invoke('voice.install', {})}
                >
                  Install voice
                </Button>
                {voiceStatus?.blocked && <div className="create__error">{voiceStatus.blocked}</div>}
                {voiceStatus?.install.state === 'failed' && (
                  <div className="create__error">{voiceStatus.install.message}</div>
                )}
              </>
            )}
          </div>
        ) : null}
        <div className="create__row">
          <label className="create__grow">
            Voice
            <select
              className="ui-input"
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              data-testid="story-voice"
            >
              {VOICES.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label} · {v.gender}, {v.accent} · {v.note}
                </option>
              ))}
            </select>
          </label>
          <label>
            Speed {speed.toFixed(2)}×
            <input
              type="range"
              min={0.8}
              max={1.4}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(Number(e.target.value))}
            />
          </label>
          <Button
            icon={<Play size={14} />}
            disabled={!voiceReady || !!busy}
            onClick={() => void preview()}
          >
            {busy === 'Speaking…' ? 'Speaking…' : 'Listen'}
          </Button>
        </div>
      </section>

      <section className="create__section">
        <h3>Visuals</h3>
        <div
          className="create__segmented"
          role="radiogroup"
          aria-label="What is behind the captions"
        >
          <button
            type="button"
            data-active={visuals === 'pictures'}
            onClick={() => setVisuals('pictures')}
            data-testid="visuals-pictures"
          >
            AI pictures
          </button>
          <button
            type="button"
            data-active={visuals === 'graphics'}
            onClick={() => setVisuals('graphics')}
            data-testid="visuals-graphics"
          >
            Motion graphics
          </button>
          <button
            type="button"
            data-active={visuals === 'footage'}
            onClick={() => setVisuals('footage')}
            data-testid="visuals-footage"
          >
            Gameplay footage
          </button>
        </div>
        {visuals === 'pictures' && (
          <>
            <small className="create__hint">
              The AI splits the script into scenes and draws one picture per scene on your PC
              (Z-Image Turbo); Rec-It animates them with slow zooms and pans.
            </small>
            {!imageStatus?.available && <PictureEngine />}
            <label>
              Picture style
              <select
                className="ui-input"
                value={pictureStyle}
                onChange={(e) => setPictureStyle(e.target.value as PictureStyle)}
                data-testid="picture-style"
              >
                {(Object.keys(PICTURE_STYLES) as PictureStyle[]).map((k) => (
                  <option key={k} value={k}>
                    {PICTURE_STYLES[k].label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {visuals === 'graphics' && (
          <small className="create__hint">
            Designed, animated backgrounds in colours the AI picks for each scene. Instant; no
            picture engine needed.
          </small>
        )}
        {visuals === 'footage' && (
          <div className="create__row">
            <label className="create__grow">
              Background video
              <select
                className="ui-input"
                value={background}
                onChange={(e) => setBackground(e.target.value)}
                data-testid="story-background"
              >
                {!videos.length && <option value="">Import gameplay footage first</option>}
                {videos.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="create__check">
              <input
                type="checkbox"
                checked={randomStart}
                onChange={(e) => setRandomStart(e.target.checked)}
              />
              Random start
            </label>
          </div>
        )}
      </section>

      <section className="create__section">
        <h3>Look</h3>
        <div className="create__row">
          <label className="create__grow">
            Music (optional)
            <select className="ui-input" value={music} onChange={(e) => setMusic(e.target.value)}>
              <option value="">None</option>
              {sounds.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Captions
            <select
              className="ui-input"
              value={captionStyle}
              onChange={(e) => setCaptionStyle(e.target.value as typeof captionStyle)}
            >
              <option value="pop">Pop (one word at a time)</option>
              <option value="highlight">Highlight</option>
              <option value="karaoke">Karaoke</option>
              <option value="caps">Bold caps</option>
              <option value="bebas">Bebas</option>
              <option value="clean">Clean box</option>
            </select>
          </label>
        </div>
        <div className="create__row">
          <label className="create__check">
            <input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} />
            Title card
          </label>
          {card && (
            <>
              <label className="create__grow">
                Community
                <TextField value={community} onChange={(e) => setCommunity(e.target.value)} />
              </label>
              <label className="create__grow">
                Username
                <TextField
                  value={username}
                  placeholder="throwaway"
                  onChange={(e) => setUsername(e.target.value)}
                />
              </label>
              <label>
                Card
                <select
                  className="ui-input"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value as 'light' | 'dark')}
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </>
          )}
        </div>
      </section>

      {error && (
        <div className="create__error" role="alert">
          {error}
        </div>
      )}
      {job && job.state !== 'done' && (
        <div className="create__progress" data-testid="story-progress">
          <span>{job.state === 'failed' ? `Failed: ${job.error}` : job.stage}</span>
          {job.state === 'running' && (
            <>
              <progress value={job.progress} max={1} />
              <Button
                size="sm"
                variant="ghost"
                icon={<Square size={12} />}
                onClick={() => void backend.invoke('templates.cancel', { jobId: job.id })}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
      <footer className="create__footer">
        <small>
          Voices and title cards are added to the project as media marked “Made in Rec-It”.
        </small>
        <Button type="submit" variant="primary" disabled={!canCreate} data-testid="story-create">
          {running ? 'Creating…' : 'Create Short'}
        </Button>
      </footer>
    </form>
  );
}

/** Status and install button for the AI picture engine (about 7 GB, downloaded once). */
function PictureEngine() {
  const status = useApp((s) => s.images);
  return (
    <EngineNote
      status={status}
      testId="picture-engine"
      what="AI pictures"
      engine="the picture engine: Z-Image Turbo, run on your graphics card (about 7 GB, downloaded once)"
      button="Install picture engine"
      install={() => void backend.invoke('images.install', {})}
      cancel={() => void backend.invoke('images.cancelInstall', {})}
    />
  );
}

/** Status and install button for the talking-character engine (about 17 GB; ADR-048). */
function AnimationEngine() {
  const status = useApp((s) => s.animation);
  return (
    <EngineNote
      status={status}
      testId="animation-engine"
      what="Talking characters"
      engine="the animation engine: Wan 2.2 S2V, run on your graphics card and memory (about 17 GB, downloaded once)"
      button="Install animation engine"
      install={() => void backend.invoke('animation.install', {})}
      cancel={() => void backend.invoke('animation.cancelInstall', {})}
    />
  );
}

function EngineNote(p: {
  status: ImageStatus | null;
  testId: string;
  what: string;
  engine: string;
  button: string;
  install: () => void;
  cancel: () => void;
}) {
  const { status } = p;
  if (!status) return null;
  if (status.install.state === 'running')
    return (
      <div className="create__note" data-testid={p.testId}>
        {status.install.message ?? 'Installing…'}
        <progress value={status.install.progress ?? 0} max={1} />
        <Button size="sm" variant="ghost" onClick={p.cancel}>
          Cancel
        </Button>
      </div>
    );
  return (
    <div className="create__note" data-testid={p.testId}>
      {status.installable ? (
        <>
          {p.what} need {p.engine}.{' '}
          <Button size="sm" onClick={p.install}>
            {p.button}
          </Button>
        </>
      ) : (
        <>
          {p.what} are not available on this computer. {status.reason}
        </>
      )}
      {status.install.state === 'failed' && (
        <div className="create__error">{status.install.message}</div>
      )}
      {status.blocked && <div className="create__error">{status.blocked}</div>}
    </div>
  );
}

/**
 * Talking characters (ADR-048), first step: one test shot. Draws the character, records the line
 * and animates the character saying it, so speed and quality can be judged on this PC.
 */
function CharactersForm({ onDone }: { onDone: () => void }) {
  const voiceStatus = useApp((s) => s.voice);
  const imageStatus = useApp((s) => s.images);
  const animationStatus = useApp((s) => s.animation);
  const jobs = useApp((s) => s.templateJobs);
  const [character, setCharacter] = useState('a cheerful orange fox in a green scarf');
  const [line, setLine] = useState('Hi! I was made on your own computer. Pretty cool, right?');
  const [voice, setVoice] = useState<string>(DEFAULT_VOICE);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = jobs.find((j) => j.id === jobId);
  const running = job?.state === 'running';

  useEffect(() => {
    if (job?.state === 'done') {
      useApp.setState({
        selectedAssetId: null,
        selectedItemIds: [],
        monitor: 'program',
        playhead: 0,
        playing: false,
      });
      notify(job.stage, 'info');
      onDone();
    }
  }, [job?.state, job?.stage, onDone]);

  const words = line.trim().split(/\s+/).filter(Boolean).length;
  const ready =
    voiceStatus?.available === true && !!imageStatus?.available && !!animationStatus?.available;
  const canStart = ready && character.trim().length >= 3 && words > 0 && words <= 14 && !running;

  const start = async () => {
    setError(null);
    try {
      const r = await backend.invoke('templates.talkTest', { character, line, voice });
      setJobId(r.jobId);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <form
      className="create__story"
      onSubmit={(e) => {
        e.preventDefault();
        if (canStart) void start();
      }}
    >
      <section className="create__section">
        <h3>Test one shot</h3>
        <p className="create__hint">
          One character says one line (up to about 5 seconds). This shows how long a shot takes on
          your PC and how it looks, before full talking-character Shorts.
        </p>
        {!imageStatus?.available && <PictureEngine />}
        {!animationStatus?.available && <AnimationEngine />}
        <label>
          Character
          <TextField
            value={character}
            placeholder="e.g. a grumpy old robot with a tiny umbrella"
            onChange={(e) => setCharacter(e.target.value)}
            data-testid="talk-character"
          />
        </label>
        <label>
          Line ({words} of 14 words)
          <TextField
            value={line}
            onChange={(e) => setLine(e.target.value)}
            data-testid="talk-line"
          />
        </label>
        <label>
          Voice
          <select className="ui-input" value={voice} onChange={(e) => setVoice(e.target.value)}>
            {VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label} · {v.gender}, {v.accent} · {v.note}
              </option>
            ))}
          </select>
        </label>
      </section>
      {error && (
        <div className="create__error" role="alert">
          {error}
        </div>
      )}
      {job && job.state !== 'done' && (
        <div className="create__progress" data-testid="talk-progress">
          <span>{job.state === 'failed' ? `Failed: ${job.error}` : job.stage}</span>
          {running && (
            <>
              <progress value={job.progress} max={1} />
              <Button
                size="sm"
                variant="ghost"
                icon={<Square size={12} />}
                onClick={() => void backend.invoke('templates.cancel', { jobId: job.id })}
              >
                Cancel
              </Button>
            </>
          )}
        </div>
      )}
      <footer className="create__footer">
        <small>
          The first shot is slow while the engine loads; on an 8 GB card expect several minutes.
        </small>
        <Button type="submit" variant="primary" disabled={!canStart} data-testid="talk-create">
          {running ? 'Animating…' : 'Test one shot'}
        </Button>
      </footer>
    </form>
  );
}
