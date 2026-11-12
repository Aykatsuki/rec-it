import { useState } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import { useSettings } from './hooks';
import { LeftRail } from './layout/LeftRail';
import { Preview } from './layout/Preview';
import { RightPanel } from './layout/RightPanel';
import { StatusBar } from './layout/StatusBar';
import { Timeline } from './layout/Timeline';
import { TopBar } from './layout/TopBar';
import { SettingsDialog, type SettingsTab } from './settings/SettingsDialog';

export function App() {
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const { settings } = useSettings();
  const vertical = useDefaultLayout({ id: 'recit.layout.vertical', storage: localStorage });
  const horizontal = useDefaultLayout({ id: 'recit.layout.horizontal', storage: localStorage });

  return (
    <div className="app" data-reduce-motion={settings?.reduceMotion ?? false}>
      <TopBar onOpenSettings={() => setSettingsTab('system')} />
      <Group
        orientation="vertical"
        className="app__workspace"
        defaultLayout={vertical.defaultLayout}
        onLayoutChanged={vertical.onLayoutChanged}
      >
        <Panel id="upper" minSize="35">
          <Group
            orientation="horizontal"
            defaultLayout={horizontal.defaultLayout}
            onLayoutChanged={horizontal.onLayoutChanged}
          >
            <Panel id="left" defaultSize="21" minSize={240} maxSize="35">
              <LeftRail />
            </Panel>
            <Separator className="sep sep--col" />
            <Panel id="preview" minSize="30">
              <Preview />
            </Panel>
            <Separator className="sep sep--col" />
            <Panel id="right" defaultSize="23" minSize={270} maxSize="38">
              <RightPanel />
            </Panel>
          </Group>
        </Panel>
        <Separator className="sep sep--row" />
        <Panel id="timeline" defaultSize="36" minSize={180}>
          <Timeline />
        </Panel>
      </Group>
      <StatusBar onOpenSettings={setSettingsTab} />
      <SettingsDialog
        tab={settingsTab}
        onTabChange={setSettingsTab}
        onClose={() => setSettingsTab(null)}
      />
    </div>
  );
}
