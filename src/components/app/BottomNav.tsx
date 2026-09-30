'use client';

import { FolderTree, Home, Map, PlusCircle, Settings } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import type { TabId } from '@/lib/types';

const TABS: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'map', label: 'Карта', icon: Map },
  { id: 'maps', label: 'Карты', icon: FolderTree },
  { id: 'import', label: 'Импорт', icon: PlusCircle },
  { id: 'settings', label: 'Настройки', icon: Settings },
];

export default function BottomNav() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80"
      aria-label="Основная навигация"
    >
      <div className="mx-auto grid max-w-lg grid-cols-5 pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex min-h-[56px] flex-col items-center justify-center gap-0.5 px-0.5 text-[10px] leading-tight transition-colors ${
                active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'
              }`}
              aria-current={active ? 'page' : undefined}
            >
              <Icon className={`h-5 w-5 ${active ? 'stroke-[2.2]' : ''}`} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
