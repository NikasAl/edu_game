import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db, getMeta, setMeta } from '@/lib/db';
import type { IngestResult, LLMProvider, ProviderType, TabId } from '@/lib/types';

export type Theme = 'light' | 'dark';

interface AppState {
  // Навигация
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  openNodeId: string | null; // экран узла — оверлей поверх вкладок
  openNode: (id: string) => void;
  closeNode: () => void;
  activeMaterialId: string | null;
  setActiveMaterialId: (id: string) => Promise<void>;
  /** Сбросить активную карту (когда её удалили, а других нет) */
  unsetActiveMaterial: () => Promise<void>;
  hydrated: boolean;

  // Тема
  theme: Theme;
  setTheme: (t: Theme) => void;

  // Провайдеры
  providers: LLMProvider[];
  loadProviders: () => Promise<void>;
  addProvider: (p: { name: string; type: ProviderType; baseUrl: string; apiKey: string; model: string }) => Promise<void>;
  updateProvider: (id: string, p: Partial<LLMProvider>) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  activateProvider: (id: string) => Promise<void>;

  // Ингест (черновик между шагами, не персистится)
  ingestResult: IngestResult | null;
  ingestTitle: string;
  ingestSourceText: string;
  setIngestDraft: (title: string, sourceText: string) => void;
  setIngestResult: (r: IngestResult | null) => void;

  init: () => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeTab: 'home',
  setActiveTab: (tab) => set({ activeTab: tab, openNodeId: null }),
  openNodeId: null,
  openNode: (id) => set({ openNodeId: id }),
  closeNode: () => set({ openNodeId: null }),
  activeMaterialId: null,
  hydrated: false,

  // BUGFIX: метод был объявлен в интерфейсе, но не реализован — вызов в конце
  // saveMaterial (ImportPanel) падал с «…is not a function» ПОСЛЕ генерации задач
  setActiveMaterialId: async (id) => {
    await setMeta('activeMaterialId', id);
    set({ activeMaterialId: id });
  },

  unsetActiveMaterial: async () => {
    await setMeta('activeMaterialId', '');
    set({ activeMaterialId: null });
  },

  theme: 'dark',
  setTheme: (t) => {
    set({ theme: t });
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', t === 'dark');
      localStorage.setItem('edu-theme', t);
    }
  },

  providers: [],
  loadProviders: async () => {
    const providers = await db.providers.toArray();
    set({ providers });
  },
  addProvider: async (p) => {
    const now = new Date();
    const provider: LLMProvider = { id: uuid(), isActive: false, createdAt: now, updatedAt: now, ...p };
    await db.providers.put(provider);
    // первый добавленный — активный по умолчанию
    const all = await db.providers.toArray();
    if (!all.some((x) => x.isActive)) {
      provider.isActive = true;
    }
    await db.providers.put(provider);
    await get().loadProviders();
  },
  updateProvider: async (id, p) => {
    const cur = await db.providers.get(id);
    if (!cur) return;
    await db.providers.put({ ...cur, ...p, updatedAt: new Date() });
    await get().loadProviders();
  },
  deleteProvider: async (id) => {
    await db.providers.delete(id);
    await get().loadProviders();
  },
  activateProvider: async (id) => {
    const all = await db.providers.toArray();
    for (const p of all) {
      await db.providers.put({ ...p, isActive: p.id === id, updatedAt: new Date() });
    }
    await get().loadProviders();
  },

  ingestResult: null,
  ingestTitle: '',
  ingestSourceText: '',
  setIngestDraft: (title, sourceText) => set({ ingestTitle: title, ingestSourceText: sourceText }),
  setIngestResult: (r) => set({ ingestResult: r }),

  init: async () => {
    const { seedDemoIfFirstRun } = await import('@/lib/db');
    await seedDemoIfFirstRun();
    let materialId = (await getMeta('activeMaterialId')) ?? null;
    // активная карта могла быть удалена — проверяем и выбираем запасную
    if (materialId && !(await db.materials.get(materialId))) materialId = null;
    if (!materialId) {
      const all = await db.materials.toArray();
      const first = all.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0];
      if (first) {
        materialId = first.id;
        await setMeta('activeMaterialId', materialId);
      }
    }
    set({ activeMaterialId: materialId, hydrated: true });
    await get().loadProviders();
    const savedTheme = (typeof localStorage !== 'undefined' ? localStorage.getItem('edu-theme') : null) as Theme | null;
    if (savedTheme === 'light' || savedTheme === 'dark') get().setTheme(savedTheme);
    else get().setTheme('dark');
    void setMeta;
  },
}));
