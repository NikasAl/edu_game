/**
 * Dexie-слой ИИ-прохода графа: собрать атомы материала, получить предложения
 * рёбер у LLM (llm-ops.buildGraphEdgesLLM), слить с существующими рёбрами
 * (graph-build.mergeGraphSuggestions) и записать в БД.
 */
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { mergeGraphSuggestions } from './graph-build';
import { buildGraphEdgesLLM } from './llm-ops';
import type { LLMProvider } from './types';

export interface GraphEnrichResult {
  added: number; // создано новых рёбер
  upgraded: number; // soft-рёбер повышено до hard
  total: number; // всего рёбер у материала после обогащения
  batches: number; // сколько батчей обработал LLM
}

/**
 * Достроить граф материала связями между атомами.
 * Существующие рёбра (в т.ч. из needs при ингесте) сохраняются; добавляется
 * недостающая структура — в первую очередь межфрагментные связи.
 * Не изменяет задачи/прогресс, безопасно запускать повторно.
 */
export async function enrichGraph(
  provider: LLMProvider,
  materialId: string,
  opts: { onProgress?: (msg: string) => void } = {}
): Promise<GraphEnrichResult> {
  const [nodes, existing] = await Promise.all([
    db.nodes.where('materialId').equals(materialId).toArray(),
    db.edges.where('materialId').equals(materialId).toArray(),
  ]);
  if (nodes.length < 2) {
    return { added: 0, upgraded: 0, total: existing.length, batches: 0 };
  }

  let batches = 0;
  const suggestions = await buildGraphEdgesLLM(
    provider,
    nodes.map((n) => ({ id: n.id, title: n.title, formulation: n.formulation })),
    {
      onProgress: (done, total) => {
        batches = total;
        opts.onProgress?.(`ИИ-проход графа: пакет ${done}/${total}`);
      },
    }
  );

  const plan = mergeGraphSuggestions(nodes, existing, suggestions);
  if (plan.create.length === 0 && plan.upgradeToHard.length === 0) {
    return { added: 0, upgraded: 0, total: existing.length, batches };
  }

  await db.transaction('rw', db.edges, async () => {
    if (plan.create.length > 0) {
      await db.edges.bulkPut(plan.create.map((c) => ({ id: uuid(), materialId, ...c })));
    }
    for (const id of plan.upgradeToHard) {
      const e = await db.edges.get(id);
      if (e && e.materialId === materialId) await db.edges.put({ ...e, kind: 'hard' });
    }
  });

  return {
    added: plan.create.length,
    upgraded: plan.upgradeToHard.length,
    total: existing.length + plan.create.length,
    batches,
  };
}
