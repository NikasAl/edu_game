'use client';

import React, { useEffect } from 'react';
import { useAppStore } from '@/store/useAppStore';
import BottomNav from '@/components/app/BottomNav';
import HomePanel from '@/components/app/HomePanel';
import MapPanel from '@/components/app/MapPanel';
import MapsPanel from '@/components/app/MapsPanel';
import ImportPanel from '@/components/app/ImportPanel';
import SettingsPanel from '@/components/app/SettingsPanel';
import NodeView from '@/components/app/NodeView';

export default function Home() {
  const hydrated = useAppStore((s) => s.hydrated);
  const init = useAppStore((s) => s.init);
  const activeTab = useAppStore((s) => s.activeTab);
  const openNodeId = useAppStore((s) => s.openNodeId);

  useEffect(() => {
    void init();
  }, [init]);

  if (!hydrated) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          <p className="text-sm text-muted-foreground">Загрузка карты знаний…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] bg-background flex flex-col">
      <main className="flex-1 min-h-0 overflow-y-auto mx-auto w-full max-w-lg px-4 pt-4 pb-24 thin-scroll">
        {activeTab === 'home' && <HomePanel />}
        {activeTab === 'map' && <MapPanel />}
        {activeTab === 'maps' && <MapsPanel />}
        {activeTab === 'import' && <ImportPanel />}
        {activeTab === 'settings' && <SettingsPanel />}
      </main>
      <BottomNav />
      {openNodeId && <NodeView nodeId={openNodeId} />}
    </div>
  );
}
