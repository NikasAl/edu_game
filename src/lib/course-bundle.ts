/**
 * Экспорт и импорт курса — карты со всем содержимым (регионы, атомы, рёбра,
 * задачи) и, по желанию, вложенными картами.
 *
 * Прогресс пользователя не переносится: попытки, зачёты и черновики
 * остаются на устройстве. Импорт всегда создаёт копию с новыми id
 * (полный ремап всех ссылок), поэтому один и тот же комплект можно
 * вливать в базу многократно — конфликтов с существующими данными нет.
 *
 * Тот же формат используется для предустановленных курсов (lib/preinstall.ts):
 * файл кладётся в public/preinstalled/ и ставится при первом запуске.
 */
import { v4 as uuid } from 'uuid';
import { db, chunkedPut, reviveRows, collectSubtreeIds } from './db';
import type { CoursePayload, IdeaEdge, IdeaNode, Material, Region, Task } from './types';

const COURSE_VERSION = 1;

export interface CourseStats {
  materials: number;
  regions: number;
  nodes: number;
  edges: number;
  tasks: number;
}

export interface CourseImportResult extends CourseStats {
  title: string;
}

/** Собрать комплект курса: корневая карта (+ всё поддерево) и её содержимое */
export async function buildCourseBundle(
  rootMaterialId: string,
  includeChildren: boolean
): Promise<CoursePayload> {
  const root = await db.materials.get(rootMaterialId);
  if (!root) throw new Error('Карта не найдена');
  const all = await db.materials.toArray();
  const mats = includeChildren
    ? all.filter((m) => collectSubtreeIds(all, rootMaterialId).includes(m.id))
    : [root];
  const ids = mats.map((m) => m.id);
  const [regions, nodes, edges, tasks] = await Promise.all([
    db.regions.where('materialId').anyOf(ids).toArray(),
    db.nodes.where('materialId').anyOf(ids).toArray(),
    db.edges.where('materialId').anyOf(ids).toArray(),
    db.tasks.where('materialId').anyOf(ids).toArray(),
  ]);
  return {
    app: 'edu_game',
    kind: 'course',
    version: COURSE_VERSION,
    bundleId: uuid(),
    exportedAt: new Date().toISOString(),
    title: root.title,
    materials: mats,
    regions,
    nodes,
    edges,
    tasks,
  };
}

/** Проверить и разобрать JSON файла курса (бросает Error с понятным текстом) */
export function parseCoursePayload(json: string): CoursePayload {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Файл не является корректным JSON');
  }
  const d = data as Record<string, unknown>;
  if (d?.app !== 'edu_game' || d?.kind !== 'course' || !Array.isArray(d.materials)) {
    throw new Error('Неверный формат: ожидается файл курса edu_game (экспорт с вкладки «Карты»)');
  }
  if (!Array.isArray(d.nodes)) {
    throw new Error('Файл курса повреждён: отсутствует список идей');
  }
  if (d.materials.length === 0) throw new Error('В файле курса нет ни одной карты');
  return data as CoursePayload;
}

export interface RemappedCourse {
  materials: Material[];
  regions: Region[];
  nodes: IdeaNode[];
  edges: IdeaEdge[];
  tasks: Task[];
}

/**
 * Чистая функция ремапа: все id заменяются на новые, все перекрёстные
 * ссылки (parentId, materialId, regionId, nodeId, from/to) переставляются
 * согласованно. Записи со ссылками на карты вне комплекта отбрасываются
 * или перепривязываются — висячих ссылок после импорта не остаётся.
 */
export function remapCoursePayload(payload: CoursePayload): RemappedCourse {
  const materials = reviveRows<Material>(payload.materials, 'materials');
  const regions = reviveRows<Region>(payload.regions, 'regions');
  const nodes = reviveRows<IdeaNode>(payload.nodes, 'nodes');
  const edges = reviveRows<IdeaEdge>(payload.edges, 'edges');
  const tasks = reviveRows<Task>(payload.tasks, 'tasks');

  const matId = new Map<string, string>();
  for (const m of materials) matId.set(m.id, uuid());
  const regId = new Map<string, string>();
  for (const r of regions) regId.set(r.id, uuid());
  const nodeId = new Map<string, string>();
  for (const n of nodes) nodeId.set(n.id, uuid());

  const newMaterials: Material[] = materials.map((m) => ({
    ...m,
    id: matId.get(m.id)!,
    // родитель вне комплекта (экспорт подмножества дерева) → карта становится корневой
    parentId: m.parentId && matId.has(m.parentId) ? matId.get(m.parentId)! : null,
  }));

  const newRegions: Region[] = [];
  for (const r of regions) {
    const mid = matId.get(r.materialId);
    if (!mid) continue;
    newRegions.push({ ...r, id: regId.get(r.id)!, materialId: mid });
  }
  // первый регион каждой карты — куда привязываются узлы с потерянным regionId
  const firstRegionByMat = new Map<string, string>();
  for (const r of newRegions) {
    if (!firstRegionByMat.has(r.materialId)) firstRegionByMat.set(r.materialId, r.id);
  }

  const newNodes: IdeaNode[] = [];
  for (const n of nodes) {
    const mid = matId.get(n.materialId);
    if (!mid) continue;
    const rid = regId.get(n.regionId) ?? firstRegionByMat.get(mid);
    if (!rid) continue;
    newNodes.push({ ...n, id: nodeId.get(n.id)!, materialId: mid, regionId: rid });
  }

  const newEdges: IdeaEdge[] = [];
  for (const e of edges) {
    const mid = matId.get(e.materialId);
    const from = nodeId.get(e.fromNodeId);
    const to = nodeId.get(e.toNodeId);
    if (!mid || !from || !to) continue;
    newEdges.push({ ...e, id: uuid(), materialId: mid, fromNodeId: from, toNodeId: to });
  }

  const newTasks: Task[] = [];
  for (const t of tasks) {
    const mid = matId.get(t.materialId);
    const nid = nodeId.get(t.nodeId);
    if (!mid || !nid) continue;
    newTasks.push({ ...t, id: uuid(), materialId: mid, nodeId: nid });
  }

  return { materials: newMaterials, regions: newRegions, nodes: newNodes, edges: newEdges, tasks: newTasks };
}

/**
 * Влить комплект курса в базу как копию (с новыми id).
 * Существующие данные не затрагиваются; прогресс не создаётся —
 * все узлы импортированного курса начинают с нуля.
 */
export async function importCoursePayload(payload: CoursePayload): Promise<CourseImportResult> {
  const r = remapCoursePayload(payload);
  if (r.materials.length === 0) throw new Error('В файле курса нет ни одной карты с содержимым');
  await chunkedPut(db.materials, r.materials);
  await chunkedPut(db.regions, r.regions);
  await chunkedPut(db.nodes, r.nodes);
  await chunkedPut(db.edges, r.edges);
  await chunkedPut(db.tasks, r.tasks);
  return {
    title: payload.title || r.materials[0]?.title || 'Курс',
    materials: r.materials.length,
    regions: r.regions.length,
    nodes: r.nodes.length,
    edges: r.edges.length,
    tasks: r.tasks.length,
  };
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** Имя файла экспорта: edu-game-course-<транслит названия>-<дата>.json */
export function courseFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .split('')
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const date = new Date().toISOString().split('T')[0];
  return `edu-game-course-${slug || 'course'}-${date}.json`;
}
