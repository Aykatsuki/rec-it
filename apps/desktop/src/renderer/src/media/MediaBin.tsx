import { useMemo, useState } from 'react';
import { Clapperboard, LayoutGrid, List, Upload } from 'lucide-react';
import { Button, EmptyState, IconButton, TextField } from '@rec-it/ui';
import { importWithDialog } from '../actions';
import { formatDuration, formatBytes } from '../format';
import { useApp } from '../store';
import { AssetBadges, AssetCard, activeJob } from './AssetCard';

export function MediaBin() {
  const assets = useApp((s) => s.assets);
  const selected = useApp((s) => s.selectedAssetId);
  const select = useApp((s) => s.select);
  const view = useApp((s) => s.mediaView);
  const setView = useApp((s) => s.setMediaView);
  const [query, setQuery] = useState('');

  const filtered = useMemo(
    () =>
      query ? assets.filter((a) => a.name.toLowerCase().includes(query.toLowerCase())) : assets,
    [assets, query],
  );

  if (!assets.length) {
    return (
      <EmptyState
        icon={<Clapperboard size={20} />}
        title="No media yet"
        action={
          <Button icon={<Upload size={14} />} onClick={() => void importWithDialog()}>
            Import footage
          </Button>
        }
      >
        Drag video, audio or images anywhere onto this window, or press Ctrl+I. Rec-It makes fast
        preview copies and keeps your originals for export.
      </EmptyState>
    );
  }

  return (
    <div className="media-bin">
      <div className="media-bin__toolbar">
        <TextField
          placeholder="Search media"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search media"
        />
        <IconButton
          label="Grid view"
          size="sm"
          aria-pressed={view === 'grid'}
          onClick={() => setView('grid')}
        >
          <LayoutGrid size={14} />
        </IconButton>
        <IconButton
          label="List view"
          size="sm"
          aria-pressed={view === 'list'}
          onClick={() => setView('list')}
        >
          <List size={14} />
        </IconButton>
      </div>
      {view === 'grid' ? (
        <div className="media-grid" role="listbox" aria-label="Media">
          {filtered.map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              selected={asset.id === selected}
              onSelect={() => select(asset.id)}
            />
          ))}
        </div>
      ) : (
        <div className="media-list" role="listbox" aria-label="Media">
          {filtered.map((asset) => {
            const job = activeJob(asset);
            return (
              <div
                key={asset.id}
                className="media-row"
                role="option"
                tabIndex={0}
                aria-selected={asset.id === selected}
                data-selected={asset.id === selected}
                data-status={asset.status}
                data-testid="asset-row"
                onClick={() => select(asset.id)}
              >
                <span className="media-row__thumb">
                  {asset.urls.poster && <img src={asset.urls.poster} alt="" />}
                </span>
                <span className="media-row__name" title={asset.name}>
                  {asset.name}
                </span>
                <span className="media-row__chips">
                  <AssetBadges asset={asset} />
                </span>
                <span className="media-row__dur">
                  {asset.probe ? formatDuration(asset.probe.durationSec) : ''}
                </span>
                <span className="media-row__size">{formatBytes(asset.sizeBytes)}</span>
                <span className="media-row__status" data-status={asset.status}>
                  {asset.status === 'processing'
                    ? `${Math.round((job?.progress ?? 0) * 100)}%`
                    : asset.status}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="media-bin__footer">
        {assets.length} item{assets.length === 1 ? '' : 's'} ·{' '}
        {formatBytes(assets.reduce((n, a) => n + a.sizeBytes, 0))}
      </div>
    </div>
  );
}
