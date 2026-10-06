/**
 * Слияние предложений рёбер (ИИ-проход графа) с существующими рёбрами материала.
 * Чистый модуль без Dexie — тестируется в node (scripts/graph-test).
 */
import { hasCycle } from './progress';
import type { EdgeKind, IdeaEdge, IdeaNode } from './types';

/** Результат слияния: что создать и какие soft-рёбра повысить до hard */
export interface GraphMergePlan {
  /** Новые рёбра (в порядке предложений) */
  create: { fromNodeId: string; toNodeId: string; kind: EdgeKind }[];
  /** id существующих soft-рёбер, которые стали hard */
  upgradeToHard: string[];
}

/** Виртуальный id ещё не записанных рёбер внутри плана */
const NEW_ID = '@new';

/**
 * Применить предложения к существующему графу:
 * - неизвестные id, самосвязи отбрасываются (дубль отсеян ещё в buildGraphEdgesLLM,
 *   но merge самостоятелен — проверяем и здесь);
 * - существующая пара: soft + предложение hard → повышение (с проверкой цикла);
 * - встречная пара уже есть → предложение пропускается (взаимная зависимость = артефакт);
 * - новое hard-ребро, создающее цикл в hard-подграфе → понижается до soft
 *   (то же правило, что у needs при ингесте).
 */
export function mergeGraphSuggestions(
  nodes: IdeaNode[],
  existing: IdeaEdge[],
  suggestions: { fromId: string; toId: string; kind: EdgeKind }[]
): GraphMergePlan {
  const valid = new Set(nodes.map((n) => n.id));
  const byPair = new Map<string, IdeaEdge>();
  for (const e of existing) byPair.set(`${e.fromNodeId}->${e.toNodeId}`, e);

  const plan: GraphMergePlan = { create: [], upgradeToHard: [] };
  // hard-подграф для проверок циклов: существующие hard + принятые в этом плане
  const hardEdges: IdeaEdge[] = existing.filter((e) => e.kind === 'hard');

  const cycleWith = (fromId: string, toId: string): boolean =>
    hasCycle(nodes, [...hardEdges, { id: 'probe', materialId: '', fromNodeId: fromId, toNodeId: toId, kind: 'hard' }]);

  for (const s of suggestions) {
    if (!valid.has(s.fromId) || !valid.has(s.toId) || s.fromId === s.toId) continue;
    const key = `${s.fromId}->${s.toId}`;
    const dup = byPair.get(key);

    if (dup) {
      // пара уже есть: повышение soft → hard, если предложение настаивает и цикла нет
      if (dup.kind === 'soft' && s.kind === 'hard' && !cycleWith(s.fromId, s.toId)) {
        if (dup.id === NEW_ID) {
          // ребро создано этим же планом как soft — повышаем в самом плане
          const created = plan.create.find(
            (c) => c.fromNodeId === s.fromId && c.toNodeId === s.toId && c.kind === 'soft'
          );
          if (created) created.kind = 'hard';
        } else {
          plan.upgradeToHard.push(dup.id);
        }
        dup.kind = 'hard';
        hardEdges.push({ ...dup });
      }
      continue;
    }

    // встречная пара уже есть (в любую сторону) — взаимную зависимость не создаём
    if (byPair.has(`${s.toId}->${s.fromId}`)) continue;

    let kind: EdgeKind = s.kind;
    if (kind === 'hard' && cycleWith(s.fromId, s.toId)) kind = 'soft';
    const rec: IdeaEdge = { id: NEW_ID, materialId: '', fromNodeId: s.fromId, toNodeId: s.toId, kind };
    plan.create.push({ fromNodeId: s.fromId, toNodeId: s.toId, kind });
    byPair.set(key, rec);
    if (kind === 'hard') hardEdges.push(rec);
  }

  return plan;
}
