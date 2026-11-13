import { useState } from 'react';
import { MousePointerClick } from 'lucide-react';
import { EmptyState, Tabs } from '@rec-it/ui';
import { AssetDetails } from '../media/AssetDetails';
import { primaryClip } from '../edit';
import { useApp, useSelectedAsset, useSequence } from '../store';
import { ClipInspector } from '../timeline/ClipInspector';
import { TranscriptPanel } from '../timeline/TranscriptPanel';
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
  return (
    <section className="panel" data-region="right-panel" aria-label="Details">
      <header className="panel__header">
        <Tabs items={TABS} value={tab} onChange={setTab} label="Details" />
      </header>
      <div className="panel__body" role="tabpanel">
        {tab === 'inspector' && clip && seq && (
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
