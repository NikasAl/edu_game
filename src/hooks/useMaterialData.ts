'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '@/lib/db';
import { computeNodeStates, computeDepths, recommendNext } from '@/lib/progress';
import { useAppStore } from '@/store/useAppStore';
import type { IdeaNode, NodeState } from '@/lib/types';

/**
 * Живые данные активного материала: узлы, рёбра, задачи, попытки,
 * вычисленные состояния и рекомендация следующего узла.
 */
export function useMaterialData(materialId: string | null) {
  const difficulty = useAppStore((s) => s.difficulty);
  const bundle = useLiveQuery(async () => {
    if (!materialId) return null;
    const [nodes, edges, tasks, attempts, regions, material] = await Promise.all([
      db.nodes.where('materialId').equals(materialId).toArray(),
      db.edges.where('materialId').equals(materialId).toArray(),
      db.tasks.where('materialId').equals(materialId).toArray(),
      db.attempts.where('materialId').equals(materialId).toArray(),
      db.regions.where('materialId').equals(materialId).toArray(),
      db.materials.get(materialId),
    ]);
    return { nodes, edges, tasks, attempts, regions: regions.sort((a, b) => a.orderIndex - b.orderIndex), material };
  }, [materialId]);

  return useMemo(() => {
    if (!bundle) {
      // типизированные пустые Map: иначе в union-типе states деградирует до any
      return { ready: false as const, nodes: [] as IdeaNode[], regions: [], material: null, states: new Map<string, NodeState>(), depths: new Map<string, number>(), nextNode: null, tasks: [], edges: [], attempts: [] };
    }
    const { nodes, edges, tasks, attempts, regions, material } = bundle;
    const states = computeNodeStates({ nodes, edges, tasks, attempts, difficulty });
    const depths = computeDepths(nodes, edges);
    const nextNode = recommendNext(nodes, states, depths);
    return { ready: true as const, nodes, regions, material, states, depths, nextNode, tasks, edges, attempts };
  }, [bundle, difficulty]);
}
