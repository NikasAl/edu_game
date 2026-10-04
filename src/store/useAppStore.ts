import { create } from 'zustand';
import { v4 as uuid } from 'uuid';
import { db, getMeta, setMeta } from '@/lib/db';
import type { IngestResult, LLMProvider, ProviderType, TabId } from '@/lib/types';

export type Theme = 'light' | 'dark';

/** Максимальное число сохранённых моделей у одного провайдера */
const MAX_SAVED_MODELS = 12;

/**
 * Нормализация списка моделей провайдера: строки без мусора, без дублей,
 * активная модель (model) всегда в списке первой. Если список уже в норме —
 * возвращается ПРЕЖНИЙ массив по ссылке, чтобы ленивая миграция в loadProviders
 * не переписывала базу при каждом запуске.
 */
function normalizeModels(p: LLMProvider): string[] {
  const clean: string[] = [];
  for (const m of Array.isArray(p.models) ? p.models : []) {
    if (typeof m === 'string' && m.trim() && !clean.includes(m.trim())) clean.push(m.trim());
  }
  if (typeof p.model === 'string' && p.model.trim() && !clean.includes(p.model.trim())) {
    clean.unshift(p.model.trim());
  }
  const capped = clean.slice(0, MAX_SAVED_MODELS);
  if (
    Array.isArray(p.models) &&
    p.models.length === capped.length &&
    p.models.every((m, i) => m === capped[i])
  ) {
    return p.models;
  }
  return capped;
}

interface AppState {
  // Навигация
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
  openNodeId: string | null; // экран узла — оверлей поверх вкладок
  openNode: (id: string) => void;
  closeNode: () => void;
  editNodeId: string | null; // редактор узла — оверлей над экраном узла
  openNodeEditor: (id: string) => void;
  closeNodeEditor: () => void;
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
  addProvider: (p: { name: string; type: ProviderType; baseUrl: string; apiKey: string; model: string; models?: string[] }) => Promise<void>;
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
  setActiveTab: (tab) => set({ activeTab: tab, openNodeId: null, editNodeId: null }),
  openNodeId: null,
  openNode: (id) => set({ openNodeId: id }),
  closeNode: () => set({ openNodeId: null }),
  editNodeId: null,
  openNodeEditor: (id) => set({ editNodeId: id }),
  closeNodeEditor: () => set({ editNodeId: null }),
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
    // Ленивая миграция: у записей до введения списка моделей нет поля models —
    // досоздаём его и сохраняем обратно в базу (однократно; normalizeModels
    // возвращает прежний массив по ссылке, если менять нечего)
    const migrated: LLMProvider[] = [];
    for (const p of providers) {
      const models = normalizeModels(p);
      if (models !== p.models) {
        const fixed = { ...p, models };
        await db.providers.put(fixed);
        migrated.push(fixed);
      } else {
        migrated.push(p);
      }
    }
    set({ providers: migrated });
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
