import { useState } from 'react';
import { Plus, Sparkles } from 'lucide-react';
import { generateCaptions } from '@rec-it/captions';
import { type Sequence, type TranscriptEdits } from '@rec-it/core';
import { Button } from '@rec-it/ui';
import { edit, toFlicks } from '../edit';
import { useApp } from '../store';

/** Builds caption clips from the transcript, or adds one by hand (ADR-033). */
export function CaptionsGenerate({ seq }: { seq: Sequence }) {
  const transcripts = useApp((s) => s.transcripts);
  const edits = useApp((s) => s.docState?.doc.transcriptEdits) as TranscriptEdits | undefined;
  const [confirming, setConfirming] = useState(false);
  const track = seq.tracks.find((t) => t.kind === 'caption');
  const existing = track?.items.length ?? 0;
  const generated = generateCaptions(seq, (id) => transcripts[id]?.words, edits);

  const generate = async () => {
    setConfirming(false);
    const ok = await edit({
      type: 'captions.generate',
      sequenceId: seq.id,
      ...(track ? { trackId: track.id } : {}),
      captions: generated,
    });
    if (ok) useApp.setState({ selectedItemIds: [] });
  };

  const addAtPlayhead = async () => {
    const at = toFlicks(useApp.getState().playhead);
    const id = `item_${crypto.randomUUID()}`;
    const trackId = track?.id ?? `track_${crypto.randomUUID()}`;
    const ok = await edit({
      type: 'batch',
      commands: [
        ...(track
          ? []
          : [
              {
                type: 'track.add' as const,
                sequenceId: seq.id,
                kind: 'caption' as const,
                id: trackId,
              },
            ]),
        {
          type: 'caption.add',
          sequenceId: seq.id,
          trackId,
          id,
          start: at,
          duration: toFlicks(2),
          text: 'New caption',
        },
      ],
    });
    if (ok) useApp.setState({ selectedItemIds: [id], focus: 'timeline' });
  };

  return (
    <div className="captions__generate" data-testid="captions-generate">
      {confirming ? (
        <div className="captions__confirm" role="alert">
          <p>
            Replace the {existing} caption{existing === 1 ? '' : 's'} on {track?.name} with new ones
            from the transcript? Ctrl+Z undoes it.
          </p>
          <div className="captions__buttons">
            <Button size="sm" variant="primary" onClick={() => void generate()}>
              Replace captions
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="captions__buttons">
          <Button
            variant="primary"
            icon={<Sparkles size={14} />}
            disabled={!generated.length}
            onClick={() => (existing ? setConfirming(true) : void generate())}
          >
            {existing ? 'Generate again' : 'Generate captions'}
          </Button>
          <Button icon={<Plus size={14} />} onClick={() => void addAtPlayhead()}>
            Add caption
          </Button>
        </div>
      )}
      <p className="transcript__hint">
        {existing
          ? `${existing} caption clip${existing === 1 ? '' : 's'} on track ${track?.name}.`
          : generated.length
            ? 'Captions become clips on a caption track above the video, timed to the spoken words.'
            : 'Transcribe the clips on your timeline (Transcript tab) to generate captions from their words.'}
      </p>
    </div>
  );
}
