import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { CheckCircle2, Download, FileText, RotateCcw, Scissors, X } from 'lucide-react';
import {
  cutWordsCommands,
  sequenceWords,
  wordAt,
  type Sequence,
  type SequenceWord,
} from '@rec-it/core';
import type { MediaAsset, TranscriptionJob } from '@rec-it/ipc-contract';
import { Button, EmptyState, IconButton } from '@rec-it/ui';
import { backend } from '../api';
import { edit } from '../edit';
import { notify } from '../notifications';
import { useApp, useSequence } from '../store';

/** Whisper language codes offered in the picker ("auto" lets Whisper detect it). */
const LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically'],
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
  ['de', 'German'],
  ['it', 'Italian'],
  ['pt', 'Portuguese'],
  ['nl', 'Dutch'],
  ['ru', 'Russian'],
  ['tr', 'Turkish'],
  ['ar', 'Arabic'],
  ['hi', 'Hindi'],
  ['ur', 'Urdu'],
  ['id', 'Indonesian'],
  ['ja', 'Japanese'],
  ['ko', 'Korean'],
  ['zh', 'Chinese'],
];

const ACTIVE: TranscriptionJob['state'][] = ['queued', 'extracting', 'transcribing'];

const storedLanguage = () => {
  try {
    return localStorage.getItem('recit.transcriptLanguage') ?? 'auto';
  } catch {
    return 'auto';
  }
};

async function call(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'warn');
  }
}

export function TranscriptPanel() {
  const status = useApp((s) => s.transcription);
  const transcripts = useApp((s) => s.transcripts);
  const assets = useApp((s) => s.assets);
  const project = useApp((s) => s.project);
  const seq = useSequence();
  const [language, setLanguage] = useState(storedLanguage);

  const wordsOf = useMemo(() => (id: string) => transcripts[id]?.words, [transcripts]);
  const words = useMemo(() => (seq ? sequenceWords(seq, wordsOf) : []), [seq, wordsOf]);
  const spoken = assets.filter((a) => a.status === 'ready' && a.probe?.audio && a.kind !== 'image');

  if (!project)
    return (
      <EmptyState icon={<FileText size={20} />} title="Transcript">
        Open a project to transcribe its media.
      </EmptyState>
    );

  const chooseLanguage = (value: string) => {
    setLanguage(value);
    try {
      localStorage.setItem('recit.transcriptLanguage', value);
    } catch {
      // Not remembered; harmless.
    }
  };

  return (
    <div className="transcript" data-testid="transcript-panel">
      <EngineStatus />
      {status?.available && (
        <>
          <label className="transcript__language">
            <span>Language</span>
            <select
              className="ui-input"
              value={language}
              onChange={(e) => chooseLanguage(e.target.value)}
            >
              {LANGUAGES.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <ul className="transcript__media" aria-label="Media to transcribe">
            {spoken.length === 0 && <li className="transcript__hint">Import a clip with sound.</li>}
            {spoken.map((asset) => (
              <MediaRow
                key={asset.id}
                asset={asset}
                job={status.jobs.find((j) => j.assetId === asset.id)}
                done={status.transcribed.includes(asset.id)}
                language={language}
              />
            ))}
          </ul>
        </>
      )}
      {seq && words.length > 0 ? (
        <WordEditor seq={seq} words={words} wordsOf={wordsOf} />
      ) : (
        status?.transcribed.length !== 0 &&
        status && (
          <p className="transcript__hint">
            Put a transcribed clip on the timeline to edit it by its words.
          </p>
        )
      )}
    </div>
  );
}

function EngineStatus() {
  const status = useApp((s) => s.transcription);
  if (!status || status.available === null)
    return <p className="transcript__hint">Checking the transcription engine…</p>;
  if (status.available)
    return (
      <p className="transcript__hint">
        Runs on this computer with {status.engine ?? 'Whisper'}. Nothing is uploaded.
      </p>
    );
  if (status.blocked) return <p className="transcript__notice">{status.blocked}</p>;
  const running = status.install.state === 'running';
  return (
    <div className="transcript__notice" data-testid="transcript-install">
      <p>
        Transcription uses Whisper on your own computer (your RTX GPU when available). It needs a
        one-time download of about 1.5 GB; the speech model downloads on first use.
      </p>
      <Button
        variant="primary"
        icon={<Download size={14} />}
        disabled={running}
        onClick={() => void call(() => backend.invoke('transcript.install', {}))}
      >
        {running ? 'Installing…' : 'Install transcription'}
      </Button>
      {status.install.message && (
        <p
          className="transcript__log"
          data-state={status.install.state}
          title={status.install.message}
        >
          {status.install.message}
        </p>
      )}
    </div>
  );
}

function MediaRow({
  asset,
  job,
  done,
  language,
}: {
  asset: MediaAsset;
  job: TranscriptionJob | undefined;
  done: boolean;
  language: string;
}) {
  const active = job && ACTIVE.includes(job.state);
  const start = () =>
    void call(() =>
      backend.invoke('transcript.start', {
        assetId: asset.id,
        language: language === 'auto' ? null : language,
      }),
    );
  return (
    <li className="transcript__row" data-asset={asset.name}>
      <span className="transcript__name" title={asset.name}>
        {asset.name}
      </span>
      {active ? (
        <>
          <div className="progress" aria-label={`Transcribing ${asset.name}`}>
            <div
              className="progress__bar"
              style={{ width: `${Math.round(job.progress * 100)}%` }}
            />
          </div>
          <span className="transcript__pct">
            {job.state === 'queued' ? 'Waiting' : `${Math.round(job.progress * 100)}%`}
          </span>
          <IconButton
            size="sm"
            label="Cancel"
            onClick={() =>
              void call(() => backend.invoke('transcript.cancel', { assetId: asset.id }))
            }
          >
            <X size={14} />
          </IconButton>
        </>
      ) : done ? (
        <>
          <span className="transcript__done">
            <CheckCircle2 size={14} /> Transcribed
          </span>
          <IconButton size="sm" label="Transcribe again" onClick={start}>
            <RotateCcw size={14} />
          </IconButton>
        </>
      ) : (
        <>
          {job?.state === 'failed' && <span className="transcript__failed">Failed</span>}
          <Button size="sm" onClick={start}>
            {job?.state === 'failed' ? 'Try again' : 'Transcribe'}
          </Button>
        </>
      )}
      {active && job.message && <p className="transcript__detail">{job.message}</p>}
      {job?.state === 'failed' && job.error && (
        <p className="transcript__detail transcript__detail--error" data-testid="transcript-error">
          {job.error}
        </p>
      )}
    </li>
  );
}

/** The words the sequence plays. Click to jump; select and delete to cut them out. */
function WordEditor({
  seq,
  words,
  wordsOf,
}: {
  seq: Sequence;
  words: SequenceWord[];
  wordsOf: (assetId: string) => readonly { text: string; start: number; end: number }[] | undefined;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [ripple, setRipple] = useState(true);
  const list = useRef<HTMLDivElement>(null);

  // Keep only words that still exist after edits.
  const keys = useMemo(() => new Set(words.map((w) => w.key)), [words]);
  const live = useMemo(() => new Set([...selected].filter((k) => keys.has(k))), [selected, keys]);

  // Highlights the word under the playhead without re-rendering the list every frame.
  useEffect(() => {
    let current: Element | null = null;
    const show = (t: number, playing: boolean) => {
      const w = wordAt(words, t);
      const el = w ? list.current?.querySelector(`[data-key="${w.key}"]`) : null;
      if (el === current) return;
      current?.classList.remove('is-current');
      current = el ?? null;
      if (current) {
        current.classList.add('is-current');
        if (playing) current.scrollIntoView({ block: 'nearest' });
      }
    };
    const s = useApp.getState();
    show(s.playhead, false);
    return useApp.subscribe((state, prev) => {
      if (state.playhead !== prev.playhead) show(state.playhead, state.playing);
    });
  }, [words]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
    if (!target) return;
    const index = Number(target.dataset.index);
    const word = words[index]!;
    if (e.shiftKey && anchor !== null) {
      const [a, b] = anchor < index ? [anchor, index] : [index, anchor];
      setSelected(new Set(words.slice(a, b + 1).map((w) => w.key)));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(live);
      if (next.has(word.key)) next.delete(word.key);
      else next.add(word.key);
      setSelected(next);
      setAnchor(index);
    } else {
      setSelected(new Set([word.key]));
      setAnchor(index);
    }
    useApp.getState().setPlayhead(word.start + 0.001);
  };

  const cut = async () => {
    if (!live.size) return;
    const commands = cutWordsCommands(seq, words, live, wordsOf, ripple);
    if (!commands.length) {
      notify('Those words are too short to cut.', 'warn');
      return;
    }
    const ok = await edit(commands.length === 1 ? commands[0]! : { type: 'batch', commands });
    if (ok) {
      setSelected(new Set());
      setAnchor(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      e.stopPropagation();
      void cut();
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setSelected(new Set());
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      setSelected(new Set(words.map((w) => w.key)));
    }
  };

  return (
    <div className="transcript__editor">
      <div className="transcript__toolbar">
        <Button
          size="sm"
          icon={<Scissors size={14} />}
          disabled={!live.size}
          onClick={() => void cut()}
          data-testid="cut-words"
        >
          {live.size ? `Cut ${live.size} word${live.size === 1 ? '' : 's'}` : 'Cut words'}
        </Button>
        <label className="transcript__ripple">
          <input type="checkbox" checked={ripple} onChange={(e) => setRipple(e.target.checked)} />
          Close gaps
        </label>
      </div>
      <div
        ref={list}
        className="transcript__words"
        role="listbox"
        aria-label="Transcript"
        aria-multiselectable="true"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-testid="transcript-words"
      >
        <Words words={words} selected={live} />
      </div>
      <p className="transcript__hint">
        Click a word to jump to it. Shift-click to select a stretch, then press Delete to cut it.
      </p>
    </div>
  );
}

const Words = memo(function Words({
  words,
  selected,
}: {
  words: SequenceWord[];
  selected: ReadonlySet<string>;
}) {
  return (
    <>
      {words.map((w, i) => (
        <span
          key={w.key}
          role="option"
          aria-selected={selected.has(w.key)}
          data-key={w.key}
          data-index={i}
          className={(w.p ?? 1) < 0.5 ? 'transcript__word is-unsure' : 'transcript__word'}
          title={(w.p ?? 1) < 0.5 ? 'Whisper was unsure about this word' : undefined}
        >
          {w.text.trim()}{' '}
        </span>
      ))}
    </>
  );
});
