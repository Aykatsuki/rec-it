import { FolderSearch, Pencil, RotateCcw } from 'lucide-react';
import type { MediaAsset } from '@rec-it/ipc-contract';
import { Button } from '@rec-it/ui';
import { backend, shell } from '../api';
import { locateAsset, updateRights } from '../actions';
import { formatBytes, formatDuration, formatFps, JOB_LABELS, RIGHTS_LABELS } from '../format';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="details__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function AssetDetails({ asset }: { asset: MediaAsset }) {
  const p = asset.probe;
  const v = p?.video;
  const a = p?.audio;
  const r = asset.rights;
  return (
    <div className="details" data-testid="asset-details">
      <h3 className="details__title" title={asset.name}>
        {asset.name}
      </h3>
      <section>
        <h4>File</h4>
        <dl>
          <Row label="Location">
            <span className="details__path" title={asset.originalPath}>
              {asset.originalPath}
            </span>
          </Row>
          <Row label="Size">{formatBytes(asset.sizeBytes)}</Row>
          {p && (
            <Row label="Duration">
              {p.kind === 'image' ? 'Still image' : formatDuration(p.durationSec)}
            </Row>
          )}
          {p && <Row label="Container">{p.container.split(',')[0]}</Row>}
        </dl>
        <div className="details__actions">
          {asset.missing ? (
            <Button size="sm" onClick={() => void locateAsset(asset.id, asset.name)}>
              Locate file…
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderSearch size={13} />}
              onClick={() =>
                void shell.invoke('shell.showItemInFolder', { path: asset.originalPath })
              }
            >
              Show in folder
            </Button>
          )}
        </div>
      </section>
      {v && (
        <section>
          <h4>Video</h4>
          <dl>
            <Row label="Frame">
              {v.displayWidth} × {v.displayHeight}
              {v.rotation ? ` (rotated ${v.rotation}°)` : ''}
            </Row>
            <Row label="Codec">
              {v.codec}
              {v.profile ? ` · ${v.profile}` : ''}
            </Row>
            {p?.kind === 'video' && (
              <Row label="Frame rate">
                {formatFps(v.isVfr ? v.avgFps : v.fps)} fps{v.isVfr ? ' average (variable)' : ''}
              </Row>
            )}
            <Row label="Colour">
              {v.bitDepth}-bit {v.pixFmt}
              {v.hdr ? ` · HDR (${v.colorTransfer === 'arib-std-b67' ? 'HLG' : 'PQ'})` : ''}
            </Row>
          </dl>
        </section>
      )}
      {a && (
        <section>
          <h4>Audio</h4>
          <dl>
            <Row label="Codec">{a.codec}</Row>
            <Row label="Format">
              {(a.sampleRate / 1000).toFixed(1)} kHz ·{' '}
              {a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} channels`}
            </Row>
          </dl>
        </section>
      )}
      <section>
        <h4>Usage rights</h4>
        <dl>
          <Row label="Source">{RIGHTS_LABELS[r.source]}</Row>
          {r.licence && <Row label="Licence">{r.licence}</Row>}
          {r.author && <Row label="Creator">{r.author}</Row>}
          {r.attributionText && <Row label="Credit">{r.attributionText}</Row>}
          <Row label="Confirmed">{r.userAttested ? 'Yes' : 'No'}</Row>
        </dl>
        <div className="details__actions">
          <Button
            size="sm"
            variant="ghost"
            icon={<Pencil size={13} />}
            onClick={() => void updateRights(asset.id, r)}
          >
            Edit rights
          </Button>
        </div>
      </section>
      <section>
        <h4>Processing</h4>
        <dl>
          {(Object.keys(JOB_LABELS) as (keyof typeof JOB_LABELS)[]).map((k) => {
            const j = asset.jobs[k];
            return (
              <Row key={k} label={JOB_LABELS[k]}>
                <span data-state={j.state} className="details__job">
                  {j.state === 'running'
                    ? `${Math.round(j.progress * 100)}%`
                    : j.state === 'skipped'
                      ? 'not needed'
                      : j.state}
                </span>
                {j.error && <div className="details__error">{j.error}</div>}
              </Row>
            );
          })}
        </dl>
        {(asset.status === 'failed' ||
          Object.values(asset.jobs).some((j) => j.state === 'cancelled')) &&
          !asset.missing && (
            <div className="details__actions">
              <Button
                size="sm"
                icon={<RotateCcw size={13} />}
                onClick={() => void backend.invoke('media.retry', { assetId: asset.id })}
              >
                Retry
              </Button>
            </div>
          )}
      </section>
    </div>
  );
}
