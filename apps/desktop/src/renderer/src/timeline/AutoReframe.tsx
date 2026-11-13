import { Download, ScanFace, X } from 'lucide-react';
import { hasKeyframes, type Sequence, type TimelineItem, type Track } from '@rec-it/core';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { Button, IconButton } from '@rec-it/ui';
import { backend } from '../api';
import { autoReframeClip, edit } from '../edit';
import { notify } from '../notifications';
import { useApp } from '../store';

const call = (run: () => Promise<unknown>) =>
  run().catch((e: unknown) => notify(e instanceof Error ? e.message : String(e), 'warn'));

/** Inspector section: follow faces automatically (ADR-035). */
export function AutoReframe({
  seq,
  track,
  item,
  asset,
}: {
  seq: Sequence;
  track: Track;
  item: TimelineItem;
  asset: MediaAsset;
}) {
  const faces = useApp((s) => s.faces);
  const waiting = useApp((s) => (s.pendingReframe[asset.id] ?? []).includes(item.id));
  const job = faces?.jobs.find((j) => j.assetId === asset.id);
  const running = job && (job.state === 'queued' || job.state === 'running');
  const reframed = hasKeyframes(item, 'x');

  let body;
  if (!faces || faces.available === null) {
    body = <p className="transcript__hint">Checking face detection…</p>;
  } else if (faces.blocked) {
    body = <p className="transcript__hint">{faces.blocked}</p>;
  } else if (!faces.available) {
    const installing = faces.install.state === 'running';
    body = (
      <>
        <p className="transcript__hint">
          Follows faces by sliding the picture sideways. Needs a one-time download of face detection
          (about 60 MB); everything runs on this computer.
        </p>
        <Button
          size="sm"
          icon={<Download size={14} />}
          disabled={installing}
          onClick={() => void call(() => backend.invoke('faces.install', {}))}
        >
          {installing ? 'Installing…' : 'Install face detection'}
        </Button>
        {faces.install.message && (
          <p className="transcript__log" data-state={faces.install.state}>
            {faces.install.message}
          </p>
        )}
      </>
    );
  } else {
    body = (
      <>
        {running ? (
          <div className="transcript__row">
            <span className="transcript__name">Finding faces…</span>
            <div className="progress" aria-label="Finding faces">
              <div
                className="progress__bar"
                style={{ width: `${Math.round(job.progress * 100)}%` }}
              />
            </div>
            <span className="transcript__pct">{Math.round(job.progress * 100)}%</span>
            <IconButton
              size="sm"
              label="Cancel"
              onClick={() => void call(() => backend.invoke('faces.cancel', { assetId: asset.id }))}
            >
              <X size={14} />
            </IconButton>
          </div>
        ) : (
          <div className="inspector__crop">
            <Button
              size="sm"
              icon={<ScanFace size={14} />}
              disabled={track.locked || waiting}
              onClick={() => void autoReframeClip(item.id)}
              data-testid="auto-reframe"
            >
              {reframed ? 'Reframe again' : 'Auto reframe'}
            </Button>
            {reframed && (
              <Button
                size="sm"
                disabled={track.locked}
                onClick={() =>
                  void edit({
                    type: 'keyframe.clear',
                    sequenceId: seq.id,
                    itemId: item.id,
                    property: 'x',
                    t: item.sourceIn,
                  })
                }
              >
                Remove
              </Button>
            )}
          </div>
        )}
        {job?.state === 'failed' && (
          <p className="transcript__detail transcript__detail--error">{job.error}</p>
        )}
        <p className="transcript__hint">
          Keeps the main face in frame: holds still for small moves, pans for bigger ones and cuts
          when the face jumps. The result is keyframes on Position X that you can adjust.
        </p>
      </>
    );
  }
  return (
    <section data-testid="auto-reframe-section">
      <h4>Auto reframe</h4>
      {body}
    </section>
  );
}
