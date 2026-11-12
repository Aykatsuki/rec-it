import { useState } from 'react';
import { Captions, MousePointerClick, Sparkles } from 'lucide-react';
import { EmptyState, Tabs } from '@rec-it/ui';

type RightTab = 'inspector' | 'claude' | 'captions';

const TABS = [
  { id: 'inspector', label: 'Inspector' },
  { id: 'claude', label: 'Claude' },
  { id: 'captions', label: 'Captions' },
] as const;

export function RightPanel() {
  const [tab, setTab] = useState<RightTab>('inspector');
  return (
    <section className="panel" data-region="right-panel" aria-label="Details">
      <header className="panel__header">
        <Tabs items={TABS} value={tab} onChange={setTab} label="Details" />
      </header>
      <div className="panel__body" role="tabpanel">
        {tab === 'inspector' && (
          <EmptyState icon={<MousePointerClick size={20} />} title="Nothing selected">
            Select a clip on the timeline to adjust its position, scale, volume and framing.
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
