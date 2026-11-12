import { useState } from 'react';
import { Captions, MousePointerClick, Sparkles } from 'lucide-react';
import { EmptyState, Tabs } from '@rec-it/ui';
import { AssetDetails } from '../media/AssetDetails';
import { findItem } from '../edit';
import { useApp, useSelectedAsset, useSequence } from '../store';
import { ClipInspector } from '../timeline/ClipInspector';

type RightTab = 'inspector' | 'claude' | 'captions';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'claude', label: 'Claude' },
  { id: 'captions', label: 'Captions' },
] as const;

export function RightPanel() {
  const [tab, setTab] = useState<RightTab>('inspector');
  const asset = useSelectedAsset();
  const seq = useSequence();
  const focus = useApp((s) => s.focus);
  const selectedItems = useApp((s) => s.selectedItemIds);
  const assets = useApp((s) => s.assets);
  const clip =
    focus === 'timeline' && selectedItems.length === 1 ? findItem(seq, selectedItems[0]!) : null;
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
        {tab === 'claude' && (
          <EmptyState icon={<Sparkles size={20} />} title="Claude activity">
            In Phase 6 you will connect Claude from your Claude desktop app. Every edit Claude makes
            will appear here and can be undone in one step.
          </EmptyState>
        )}
        {tab === 'captions' && (
          <EmptyState icon={<Captions size={20} />} title="Captions">
            Word-timed transcription runs locally on your GPU. Animated caption styles arrive in
            Phase 4.
          </EmptyState>
        )}
      </div>
    </section>
  );
}
