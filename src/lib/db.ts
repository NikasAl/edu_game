import Dexie, { type Table } from 'dexie';
import type {
  Attempt,
  ChatMessage,
  CoursePayload,
  IdeaEdge,
  IdeaNode,
  LLMProvider,
  Material,
  MetaRec,
  NodeDraft,
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
  drafts!: Table<NodeDraft, string>;
  chatMessages!: Table<ChatMessage, string>;
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
    // v3: черновики ответов пользователя (сохраняются даже неверные)
    this.version(3).stores({
      drafts: 'nodeId, materialId, updatedAt',
    });
    // v4: обсуждения идей с ИИ (история переписки по узлу)
    this.version(4).stores({
      chatMessages: 'id, nodeId, materialId, createdAt',
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
    version: 4,
    exportedAt: new Date().toISOString(),
    materials: await db.materials.toArray(),
    regions: await db.regions.toArray(),
    nodes: await db.nodes.toArray(),
    edges: await db.edges.toArray(),
    tasks: await db.tasks.toArray(),
    attempts: await db.attempts.toArray(),
    progress: await db.progress.toArray(),
    drafts: await db.drafts.toArray(),
    chatMessages: await db.chatMessages.toArray(),
    providers: await db.providers.toArray(),
  };
  return JSON.stringify(payload, null, 2);
}

/** Ключи с датами у каждой таблицы — для оживления ISO-строк из JSON-бэкапа */
const DATE_KEYS: Record<string, string[]> = {
  materials: ['createdAt'],
  nodes: ['createdAt'],
  tasks: ['createdAt'],
  attempts: ['createdAt'],
  progress: ['updatedAt', 'masteredAt', 'srsDue'],
  drafts: ['updatedAt'],
  chatMessages: ['createdAt'],
  providers: ['createdAt', 'updatedAt'],
};

/**
 * Оживить записи после JSON.parse: даты приходят строками в ISO-формате,
 * а код приложения вызывает .getTime() и арифметику дат — без ревива
 * после импорта бэкапа крашится рендер карты/узла.
 */
export function reviveRows<T>(rows: unknown, table: string): T[] {
  if (!Array.isArray(rows)) return [];
  const keys = DATE_KEYS[table] ?? [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row as T;
    const o = { ...(row as Record<string, unknown>) };
    for (const k of keys) {
      const v = o[k];
      if (typeof v === 'string' || typeof v === 'number') {
        const d = new Date(v);
        if (!Number.isNaN(d.getTime())) o[k] = d;
      }
    }
    return o as T;
  });
}

/** bulkPut порциями, с уступкой событийного цикла — крупный бэкап не блокирует UI надолго */
export async function chunkedPut(table: Table, rows: unknown[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await table.bulkPut(rows.slice(i, i + CHUNK) as never[]);
    await new Promise((r) => setTimeout(r, 0));
  }
}

export async function importAll(json: string): Promise<{ ok: boolean; message: string }> {
  try {
    const data = JSON.parse(json) as Record<string, unknown>;
    if (data?.app !== 'edu_game' || !Array.isArray(data.nodes)) {
      return { ok: false, message: 'Неверный формат файла: ожидается бэкап edu_game' };
    }

    // Это файл курса (экспорт с вкладки «Карты»), а не полный бэкап —
    // импортируем как курс: копия с новыми id, без прогресса
    if (data.kind === 'course') {
      const { importCoursePayload } = await import('./course-bundle');
      const r = await importCoursePayload(data as unknown as CoursePayload);
      return {
        ok: true,
        message: `Курс «${r.title}» добавлен: карт: ${r.materials}, идей: ${r.nodes}, задач: ${r.tasks}`,
      };
    }

    // Нормализация под дерево карт (бэкапы версии 1 не содержат parentId)
    const materials = reviveRows<Material>(data.materials, 'materials').map((m) => ({
      ...m,
      parentId: m.parentId ?? null,
      orderIndex: m.orderIndex ?? 0,
    }));
    const regions = reviveRows<Region>(data.regions, 'regions');
    const nodes = reviveRows<IdeaNode>(data.nodes, 'nodes');
    const edges = reviveRows<IdeaEdge>(data.edges, 'edges');
    const tasks = reviveRows<Task>(data.tasks, 'tasks');
    const attempts = reviveRows<Attempt>(data.attempts, 'attempts');
    const progress = reviveRows<NodeProgressRec>(data.progress, 'progress');
    const drafts = reviveRows<NodeDraft>(data.drafts, 'drafts').map((d) => ({
      nodeId: d.nodeId,
      materialId: d.materialId ?? '',
      feynmanText: d.feynmanText ?? '',
      taskAnswers: d.taskAnswers ?? {},
      taskChoices: d.taskChoices ?? {},
      ownTaskText: d.ownTaskText ?? '',
      updatedAt: d.updatedAt ?? new Date(),
    }));
    const chatMessages = reviveRows<ChatMessage>(data.chatMessages, 'chatMessages').map((m) => ({
      id: m.id,
      nodeId: m.nodeId,
      materialId: m.materialId ?? '',
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content ?? '',
      createdAt: m.createdAt ?? new Date(),
    }));
    const providers = reviveRows<LLMProvider>(data.providers, 'providers');

    // Порционная запись без общей транзакции: уступаем UI между порциями
    // (крупный бэкап на Android иначе блокирует/убивает WebView-рендерер)
    if (materials.length) await chunkedPut(db.materials, materials);
    if (regions.length) await chunkedPut(db.regions, regions);
    if (nodes.length) await chunkedPut(db.nodes, nodes);
    if (edges.length) await chunkedPut(db.edges, edges);
    if (tasks.length) await chunkedPut(db.tasks, tasks);
    if (attempts.length) await chunkedPut(db.attempts, attempts);
    if (progress.length) await chunkedPut(db.progress, progress);
    if (drafts.length) await chunkedPut(db.drafts, drafts);
    if (chatMessages.length) await chunkedPut(db.chatMessages, chatMessages);
    if (providers.length) await chunkedPut(db.providers, providers);

    const counts = `карт: ${materials.length}, узлов: ${nodes.length}, задач: ${tasks.length}, попыток: ${attempts.length}`;
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
    // drafts/chatMessages обязаны входить в область транзакции — иначе обращения
    // к ним внутри падают с «The specified object store was not found» и карта не удаляется
    [db.materials, db.regions, db.nodes, db.edges, db.tasks, db.attempts, db.progress, db.drafts, db.chatMessages],
    async () => {
      await db.materials.bulkDelete(ids);
      for (const mid of ids) {
        await db.regions.where('materialId').equals(mid).delete();
        await db.nodes.where('materialId').equals(mid).delete();
        await db.edges.where('materialId').equals(mid).delete();
        await db.tasks.where('materialId').equals(mid).delete();
        await db.attempts.where('materialId').equals(mid).delete();
        await db.progress.where('materialId').equals(mid).delete();
        await db.drafts.where('materialId').equals(mid).delete();
        await db.chatMessages.where('materialId').equals(mid).delete();
      }
    }
  );
  return ids.length;
}

// ============ Черновики ответов ============

/**
 * Дописать часть черновика узла. Поля feynmanText/ownTaskText заменяются,
 * taskAnswers/taskChoices сливаются по ключам — три испытания узла пишут
 * в одну запись независимо друг от друга (UI дебаунсит ввод).
 */
export async function saveDraftPatch(
  nodeId: string,
  materialId: string,
  patch: Partial<Pick<NodeDraft, 'feynmanText' | 'taskAnswers' | 'taskChoices' | 'ownTaskText'>>
): Promise<void> {
  const cur = await db.drafts.get(nodeId);
  const next: NodeDraft = {
    nodeId,
    materialId,
    feynmanText: cur?.feynmanText ?? '',
    taskAnswers: { ...(cur?.taskAnswers ?? {}) },
    taskChoices: { ...(cur?.taskChoices ?? {}) },
    ownTaskText: cur?.ownTaskText ?? '',
    updatedAt: new Date(),
  };
  if (patch.feynmanText !== undefined) next.feynmanText = patch.feynmanText;
  if (patch.ownTaskText !== undefined) next.ownTaskText = patch.ownTaskText;
  if (patch.taskAnswers) next.taskAnswers = { ...next.taskAnswers, ...patch.taskAnswers };
  if (patch.taskChoices) next.taskChoices = { ...next.taskChoices, ...patch.taskChoices };
  await db.drafts.put(next);
}

/**
 * Убрать ответы на конкретную задачу из черновика узла.
 * Используется при изменении ответа задачи в редакторе: набранный
 * ответ по старой постановке больше не имеет смысла.
 */
export async function clearTaskDraft(nodeId: string, taskId: string): Promise<void> {
  const d = await db.drafts.get(nodeId);
  if (!d) return;
  if (!(taskId in d.taskAnswers) && !(taskId in d.taskChoices)) return;
  const taskAnswers = { ...d.taskAnswers };
  const taskChoices = { ...d.taskChoices };
  delete taskAnswers[taskId];
  delete taskChoices[taskId];
  await db.drafts.put({ ...d, taskAnswers, taskChoices, updatedAt: new Date() });
}

/**
 * Сбросить прогресс узла: удалить все попытки и черновик ответов.
 * Используется после ручной правки узла, когда старые зачёты
 * (например, по исправленной задаче) больше не отражают знания.
 */
export async function resetNodeProgress(nodeId: string): Promise<void> {
  await db.transaction('rw', db.attempts, db.drafts, async () => {
    await db.attempts.where('nodeId').equals(nodeId).delete();
    await db.drafts.delete(nodeId);
  });
}

/** Очистить обсуждение идеи (история чата узла) */
export async function clearNodeChat(nodeId: string): Promise<void> {
  await db.chatMessages.where('nodeId').equals(nodeId).delete();
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
