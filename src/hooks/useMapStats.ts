'use client';

/**
 * Живая статистика по всем картам: атомы и освоенность напрямую
 * и по всему поддереву (сумма по вложенным картам).
 * Один live-запрос + дерево свертки — подходит для масштаба мобильного приложения.
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/lib/db';
import { computeNodeStates } from '@/lib/progress';
import type { Material } from '@/lib/types';

export interface MapStats {
  directAtoms: number;
  directMastered: number;
  subtreeAtoms: number;
  subtreeMastered: number;
  subtreeMaps: number; // сколько карт внутри (всё поддерево)
}

export interface UseMapStatsResult {
  ready: boolean;
  materials: Material[];
  stats: Map<string, MapStats>;
}

export function useMapStats(): UseMapStatsResult {
  const bundle = useLiveQuery(async () => {
    const [materials, nodes, edges, tasks, attempts] = await Promise.all([
      db.materials.toArray(),
      db.nodes.toArray(),
      db.edges.toArray(),
      db.tasks.toArray(),
      db.attempts.toArray(),
    ]);
    return { materials, nodes, edges, tasks, attempts };
  }, []);

  return useMemo(() => {
    if (!bundle) {
      return { ready: false, materials: [] as Material[], stats: new Map<string, MapStats>() };
    }
    const { materials, nodes, edges, tasks, attempts } = bundle;

    const groupBy = <T extends { materialId: string }>(list: T[]) => {
      const m = new Map<string, T[]>();
      for (const item of list) {
        const arr = m.get(item.materialId) ?? [];
        arr.push(item);
        m.set(item.materialId, arr);
      }
      return m;
    };
    const nodesByMat = groupBy(nodes);
    const edgesByMat = groupBy(edges);
    const tasksByMat = groupBy(tasks);
    const attemptsByMat = groupBy(attempts);

    const byParent = new Map<string | null, Material[]>();
    for (const m of materials) {
      const p = m.parentId ?? null;
      const list = byParent.get(p) ?? [];
      list.push(m);
      byParent.set(p, list);
    }
    const sortSiblings = (list: Material[]) =>
      list.sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt.getTime() - b.createdAt.getTime());

    const stats = new Map<string, MapStats>();
    const visited = new Set<string>();

    const fill = (m: Material): MapStats => {
      visited.add(m.id);
      const mn = nodesByMat.get(m.id) ?? [];
      const states = computeNodeStates({
        nodes: mn,
        edges: edgesByMat.get(m.id) ?? [],
        tasks: tasksByMat.get(m.id) ?? [],
        attempts: attemptsByMat.get(m.id) ?? [],
      });
      const directMastered = mn.filter((n) => states.get(n.id)?.status === 'mastered').length;
      let s: MapStats = {
        directAtoms: mn.length,
        directMastered,
        subtreeAtoms: mn.length,
        subtreeMastered: directMastered,
        subtreeMaps: 0,
      };
      for (const c of sortSiblings(byParent.get(m.id) ?? [])) {
        const cs = fill(c);
        s = {
          ...s,
          subtreeAtoms: s.subtreeAtoms + cs.subtreeAtoms,
          subtreeMastered: s.subtreeMastered + cs.subtreeMastered,
          subtreeMaps: s.subtreeMaps + cs.subtreeMaps + 1,
        };
      }
      stats.set(m.id, s);
      return s;
    };

    for (const root of sortSiblings(byParent.get(null) ?? [])) fill(root);
    // висячие ссылки (родитель удалён вне транзакции) — считаем как корни
    for (const m of materials) if (!visited.has(m.id)) fill(m);

    return { ready: true, materials, stats };
  }, [bundle]);
}
