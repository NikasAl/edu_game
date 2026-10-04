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
import NodeEditor from '@/components/app/NodeEditor';

export default function Home() {
  const hydrated = useAppStore((s) => s.hydrated);
  const init = useAppStore((s) => s.init);
  const activeTab = useAppStore((s) => s.activeTab);
  const openNodeId = useAppStore((s) => s.openNodeId);
  const editNodeId = useAppStore((s) => s.editNodeId);

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
        {/*
          Импорт НЕ выгружается при уходе на другую вкладку, а скрывается CSS:
          долгие операции (разбор на атомы, OCR PDF, генерация задач) продолжают
          идти в фоне, и при возврате виден актуальный прогресс, а не сброшенная
          форма. PDF-документ при этом живёт, пока пользователь работает с ним
          (закрывается вручную или по завершении OCR).
        */}
        <div className={activeTab === 'import' ? '' : 'hidden'}>
          <ImportPanel />
        </div>
        {activeTab === 'settings' && <SettingsPanel />}
      </main>
      <BottomNav />
      {openNodeId && <NodeView nodeId={openNodeId} />}
      {editNodeId && <NodeEditor />}
    </div>
  );
}
