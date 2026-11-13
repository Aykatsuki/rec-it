import { useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { EmptyState, Tabs } from '@rec-it/ui';
import { AssetDetails } from '../media/AssetDetails';
import { primaryClip } from '../edit';
import { useApp, useSelectedAsset, useSequence } from '../store';
import { ClipInspector } from '../timeline/ClipInspector';
import { TranscriptPanel } from '../timeline/TranscriptPanel';
import { CaptionInspector } from '../timeline/CaptionInspector';
import { CaptionsPanel } from '../timeline/CaptionsPanel';

type RightTab = 'inspector' | 'transcript' | 'captions';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'captions', label: 'Captions' },
] as const;

export function RightPanel() {
  const [tab, setTab] = useState<RightTab>('inspector');
  const asset = useSelectedAsset();
  const seq = useSequence();
  const focus = useApp((s) => s.focus);
  const selectedItems = useApp((s) => s.selectedItemIds);
  const assets = useApp((s) => s.assets);
  const clip = focus === 'timeline' ? primaryClip(seq, selectedItems) : null;
  // Selecting a caption clip while the Captions tab is open shows its inspector (its words and
  // position live there). Adjusted during render, not in an effect.
  const captionId = clip?.item.caption ? clip.item.id : null;
  const [lastCaption, setLastCaption] = useState<string | null>(null);
  if (captionId !== lastCaption) {
    setLastCaption(captionId);
    if (captionId && tab === 'captions') setTab('inspector');
  }
  return (
    <section className="panel" data-region="right-panel" aria-label="Details">
      <header className="panel__header">
        <Tabs items={TABS} value={tab} onChange={setTab} label="Details" />
      </header>
      <div className="panel__body" role="tabpanel">
        {tab === 'inspector' && clip && seq && clip.item.caption && (
          <CaptionInspector seq={seq} track={clip.track} item={clip.item} />
        )}
        {tab === 'inspector' && clip && seq && !clip.item.caption && (
          <ClipInspector
            seq={seq}
            track={clip.track}
            item={clip.item}
            asset={assets.find((a) => a.id === clip.item.assetId)}
          />
        )}
        {tab === 'inspector' && !clip && asset && <AssetDetails asset={asset} />}
        {tab === 'inspector' && !clip && !asset && (
          <EmptyState icon={<MousePointerClick size={20} />} title="Nothing selected">
            Select a media item to see its details. Clip settings arrive with the timeline in Phase
            2.
          </EmptyState>
        )}
        {tab === 'transcript' && <TranscriptPanel />}
        {tab === 'captions' && <CaptionsPanel />}
      </div>
    </section>
  );
}
