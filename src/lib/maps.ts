/**
 * Дерево карт: Material.parentId образует иерархию.
 * Карта — контейнер связанных идей; в её графе дочерние карты
 * отображаются узлами-порталами, внутрь можно войти.
 * Все операции защищены от циклов и висячих ссылок.
 */
import { v4 as uuid } from 'uuid';
import { db, collectSubtreeIds, deleteMapCascade } from './db';
import type { Material } from './types';

/** Дочерние карты указанного родителя (null — корневые), в порядке orderIndex */
export function childrenOf(materials: Material[], parentId: string | null): Material[] {
  return materials
    .filter((m) => (m.parentId ?? null) === (parentId ?? null))
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.getTime() - b.createdAt.getTime());
}

/** Путь от корневой карты до указанной (для хлебных крошек) */
export function getPathToRoot(materials: Material[], id: string | null): Material[] {
  const byId = new Map(materials.map((m) => [m.id, m]));
  const path: Material[] = [];
  let cur = id ? byId.get(id) : undefined;
  let guard = 0;
  while (cur && guard < 50) {
    path.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    guard++;
  }
  return path.reverse();
}

/** Свободный orderIndex для новой дочерней карты */
export function nextOrderIndex(materials: Material[], parentId: string | null): number {
  return childrenOf(materials, parentId).length;
}

/**
 * Создать карту (корневую или подраздел).
 * parentId должен существовать либо быть null — иначе ошибка.
 */
export async function createMap(input: {
  title: string;
  parentId: string | null;
  description?: string;
}): Promise<Material> {
  const title = input.title.trim();
  if (title.length < 1) throw new Error('Укажи название карты');
  if (input.parentId) {
    const parent = await db.materials.get(input.parentId);
    if (!parent) throw new Error('Родительская карта не найдена');
  }
  const all = await db.materials.toArray();
  const material: Material = {
    id: uuid(),
    title,
    parentId: input.parentId ?? null,
    orderIndex: nextOrderIndex(all, input.parentId ?? null),
    description: input.description,
    createdAt: new Date(),
  };
  await db.materials.put(material);
  return material;
}

/** Переименовать карту */
export async function renameMap(id: string, title: string): Promise<void> {
  const t = title.trim();
  if (t.length < 1) throw new Error('Название не может быть пустым');
  await db.materials.update(id, { title: t });
}

/**
 * Переместить карту под нового родителя (null — в корень).
 * Запрещает перемещение внутрь себя и своих потомков.
 */
export async function moveMap(id: string, newParentId: string | null): Promise<void> {
  if (newParentId === id) throw new Error('Карта не может быть родителем самой себя');
  const all = await db.materials.toArray();
  if (newParentId && !all.some((m) => m.id === newParentId)) {
    throw new Error('Родительская карта не найдена');
  }
  if (newParentId && collectSubtreeIds(all, id).includes(newParentId)) {
    throw new Error('Нельзя переместить карту внутрь её собственной ветви');
  }
  const orderIndex = nextOrderIndex(
    all.filter((m) => m.id !== id),
    newParentId
  );
  await db.materials.update(id, { parentId: newParentId ?? null, orderIndex });
}

export { deleteMapCascade, collectSubtreeIds };
