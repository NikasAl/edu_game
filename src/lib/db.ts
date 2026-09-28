import Dexie, { type Table } from 'dexie';
import type {
  Attempt,
  IdeaEdge,
  IdeaNode,
  LLMProvider,
  Material,
  MetaRec,
  NodeProgressRec,
  Region,
  Task,
} from './types';
import { DEMO_MATERIAL, DEMO_EDGES, DEMO_NODES, DEMO_REGIONS, DEMO_TASKS, DEMO_MATERIAL_ID } from './demo-course';

export class EduGameDexie extends Dexie {
  providers!: Table<LLMProvider, string>;
  materials!: Table<Material, string>;
  regions!: Table<Region, string>;
  nodes!: Table<IdeaNode, string>;
  edges!: Table<IdeaEdge, string>;
  tasks!: Table<Task, string>;
  attempts!: Table<Attempt, string>;
  progress!: Table<NodeProgressRec, string>;
  meta!: Table<MetaRec, string>;

  constructor() {
    super('EduGameDB');
    this.version(1).stores({
      providers: 'id, name, type, isActive',
      materials: 'id, createdAt',
      regions: 'id, materialId, orderIndex',
      nodes: 'id, materialId, regionId, orderIndex',
      edges: 'id, materialId, fromNodeId, toNodeId',
      tasks: 'id, nodeId, materialId, orderIndex',
      attempts: 'id, materialId, nodeId, kind, createdAt',
      progress: 'nodeId, materialId, status',
      meta: 'key',
    });
    // v2: карты образуют дерево (parentId + orderIndex).
    // Существующие материалы становятся корневыми картами.
    this.version(2)
      .stores({
        materials: 'id, createdAt, parentId, orderIndex',
      })
      .upgrade(async (tx) => {
        await tx.table('materials').toCollection().modify((m: { parentId?: string | null; orderIndex?: number }) => {
          if (m.parentId === undefined) m.parentId = null;
          if (m.orderIndex === undefined) m.orderIndex = 0;
        });
      });
  }
}

export const db = new EduGameDexie();

// ============ Meta helpers ============

export async function getMeta(key: string): Promise<string | null> {
  const rec = await db.meta.get(key);
  return rec?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}

// ============ Seeding ============

/** Засеять демо-курс при первом запуске. Возвращает true, если посеяли. */
export async function seedDemoIfFirstRun(): Promise<boolean> {
  const seeded = await getMeta('seededDemo');
  if (seeded === 'true') return false;

  await db.transaction(
    'rw',
    db.materials,
    db.regions,
    db.nodes,
    db.edges,
    db.tasks,
    async () => {
      const exists = await db.materials.get(DEMO_MATERIAL_ID);
      if (exists) return;
      await db.materials.put(DEMO_MATERIAL);
      await db.regions.bulkPut(DEMO_REGIONS);
      await db.nodes.bulkPut(DEMO_NODES);
      await db.edges.bulkPut(DEMO_EDGES);
      await db.tasks.bulkPut(DEMO_TASKS);
    }
  );

  // активный материал + «продолжить» = первый узел золотого пути
  const hasActive = await getMeta('activeMaterialId');
  if (!hasActive) await setMeta('activeMaterialId', DEMO_MATERIAL_ID);
  await setMeta('lastNodeId', DEMO_NODES[0].id);
  await setMeta('seededDemo', 'true');
  return true;
}

// ============ Импорт/экспорт ============

export async function exportAll(): Promise<string> {
  const payload = {
    app: 'edu_game',
    version: 2,
    exportedAt: new Date().toISOString(),
    materials: await db.materials.toArray(),
    regions: await db.regions.toArray(),
    nodes: await db.nodes.toArray(),
    edges: await db.edges.toArray(),
    tasks: await db.tasks.toArray(),
    attempts: await db.attempts.toArray(),
    progress: await db.progress.toArray(),
    providers: await db.providers.toArray(),
  };
  return JSON.stringify(payload, null, 2);
}

export async function importAll(json: string): Promise<{ ok: boolean; message: string }> {
  try {
    const data = JSON.parse(json);
    if (data?.app !== 'edu_game' || !Array.isArray(data.nodes)) {
      return { ok: false, message: 'Неверный формат файла: ожидается бэкап edu_game' };
    }
    await db.transaction('rw', [db.materials, db.regions, db.nodes, db.edges, db.tasks, db.attempts, db.progress, db.providers], async () => {
        // нормализация под дерево карт (бэкапы версии 1 не содержат parentId)
        if (data.materials)
          await db.materials.bulkPut(
            (data.materials as Material[]).map((m) => ({
              ...m,
              parentId: m.parentId ?? null,
              orderIndex: m.orderIndex ?? 0,
            }))
          );
        if (data.regions) await db.regions.bulkPut(data.regions);
        if (data.nodes) await db.nodes.bulkPut(data.nodes);
        if (data.edges) await db.edges.bulkPut(data.edges);
        if (data.tasks) await db.tasks.bulkPut(data.tasks);
        if (data.attempts) await db.attempts.bulkPut(data.attempts);
        if (data.progress) await db.progress.bulkPut(data.progress);
        if (data.providers) await db.providers.bulkPut(data.providers);
    });
    const counts = `узлов: ${data.nodes.length}, задач: ${data.tasks?.length ?? 0}, попыток: ${data.attempts?.length ?? 0}`;
    return { ok: true, message: `Импортировано (${counts})` };
  } catch (e) {
    return { ok: false, message: `Ошибка импорта: ${e instanceof Error ? e.message : 'неизвестная'}` };
  }
}

/** Сброс прогресса демо-курса (попытки + прогресс), материалы остаются */
export async function resetMaterialProgress(materialId: string): Promise<void> {
  await db.transaction('rw', db.attempts, db.progress, async () => {
    await db.attempts.where('materialId').equals(materialId).delete();
    await db.progress.where('materialId').equals(materialId).delete();
  });
}

/**
 * Удалить карту вместе со всеми вложенными картами и их содержимым
 * (регионы, атомы, рёбра, задачи, попытки, прогресс).
 * Возвращает количество удалённых карт.
 */
export async function deleteMapCascade(rootId: string): Promise<number> {
  const all = await db.materials.toArray();
  const ids = collectSubtreeIds(all, rootId);
  await db.transaction(
    'rw',
    [db.materials, db.regions, db.nodes, db.edges, db.tasks, db.attempts, db.progress],
    async () => {
      await db.materials.bulkDelete(ids);
      for (const mid of ids) {
        await db.regions.where('materialId').equals(mid).delete();
        await db.nodes.where('materialId').equals(mid).delete();
        await db.edges.where('materialId').equals(mid).delete();
        await db.tasks.where('materialId').equals(mid).delete();
        await db.attempts.where('materialId').equals(mid).delete();
        await db.progress.where('materialId').equals(mid).delete();
      }
    }
  );
  return ids.length;
}

/** id карты + id всех её потомков (защита от циклов включена) */
export function collectSubtreeIds(materials: Material[], rootId: string): string[] {
  const byParent = new Map<string | null, Material[]>();
  for (const m of materials) {
    const p = m.parentId ?? null;
    const list = byParent.get(p) ?? [];
    list.push(m);
    byParent.set(p, list);
  }
  const out: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    for (const c of byParent.get(id) ?? []) stack.push(c.id);
  }
  return out;
}
