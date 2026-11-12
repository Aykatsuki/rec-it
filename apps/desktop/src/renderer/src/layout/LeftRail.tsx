import { useState, type ReactNode } from 'react';
import { Clapperboard, FileVideo, LayoutTemplate, Search, Sparkles, Upload } from 'lucide-react';
import { Button, EmptyState, IconButton } from '@rec-it/ui';

type RailTab = 'media' | 'research' | 'highlights' | 'templates';

const TABS: { id: RailTab; label: string; icon: ReactNode }[] = [
  { id: 'media', label: 'Media', icon: <FileVideo size={18} /> },
  { id: 'research', label: 'Research', icon: <Search size={18} /> },
  { id: 'highlights', label: 'Highlights', icon: <Sparkles size={18} /> },
  { id: 'templates', label: 'Templates', icon: <LayoutTemplate size={18} /> },
];

export function LeftRail() {
  const [tab, setTab] = useState<RailTab>('media');
  const current = TABS.find((t) => t.id === tab)!;
  return (
    <section className="panel left-rail" data-region="left-rail" aria-label="Library">
      <nav
        className="left-rail__icons"
        role="tablist"
        aria-label="Library sections"
        aria-orientation="vertical"
      >
        {TABS.map((t) => (
          <IconButton
            key={t.id}
            label={t.label}
            role="tab"
            aria-selected={t.id === tab}
            onClick={() => setTab(t.id)}
          >
            {t.icon}
          </IconButton>
        ))}
      </nav>
      <div className="left-rail__content" role="tabpanel" aria-label={current.label}>
        <header className="panel__header">
          <h2 className="panel__title">{current.label}</h2>
        </header>
        <div className="panel__body">{content(tab)}</div>
      </div>
    </section>
  );
}

function content(tab: RailTab) {
  switch (tab) {
    case 'media':
      return (
        <EmptyState
          icon={<Clapperboard size={20} />}
          title="No media yet"
          action={
            <Button icon={<Upload size={14} />} disabled title="Importing arrives in Phase 1">
              Import footage
            </Button>
          }
        >
          Drag video, audio or images here. Rec-It makes fast preview copies and keeps your
          originals for export.
        </EmptyState>
      );
    case 'research':
      return (
        <EmptyState icon={<Search size={20} />} title="YouTube research">
          Search topics and see what is working in your niche. Arrives in Phase 8.
        </EmptyState>
      );
    case 'highlights':
      return (
        <EmptyState icon={<Sparkles size={20} />} title="Highlights">
          Ranked moments from long videos that would make good Shorts. Arrives in Phase 7.
        </EmptyState>
      );
    case 'templates':
      return (
        <EmptyState icon={<LayoutTemplate size={20} />} title="Shorts templates">
          Reusable caption, framing and music settings for batch Shorts. Arrives in Phase 9.
        </EmptyState>
      );
  }
}
