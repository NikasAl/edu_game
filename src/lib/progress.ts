/**
 * Логика графа знаний: состояния узлов, топологический порядок,
 * «золотой путь» (рекомендация следующего узла), гибридные гейты.
 */
import type {
  Attempt,
  IdeaEdge,
  IdeaNode,
  NodeState,
  NodeStatus,
  Task,
} from './types';

/** Матрица смежности: deps[nodeId] = [{ id, kind }] — от чего зависит узел */
function buildDeps(edges: IdeaEdge[]): Map<string, { id: string; kind: 'hard' | 'soft' }[]> {
  const deps = new Map<string, { id: string; kind: 'hard' | 'soft' }[]>();
  for (const e of edges) {
    const list = deps.get(e.toNodeId) ?? [];
    list.push({ id: e.fromNodeId, kind: e.kind });
    deps.set(e.toNodeId, list);
  }
  return deps;
}

export interface ComputeInput {
  nodes: IdeaNode[];
  edges: IdeaEdge[];
  tasks: Task[];
  attempts: Attempt[];
}

/**
 * Вычислить состояние всех узлов по попыткам.
 * Зачёт узла = фейнман пройден + все задачи узла пройдены + своя задача пройдена.
 */
export function computeNodeStates(input: ComputeInput): Map<string, NodeState> {
  const { nodes, edges, tasks, attempts } = input;
  const deps = buildDeps(edges);

  // Последняя попытка по ключу (nodeId, kind, taskId)
  const latest = new Map<string, Attempt>();
  const sorted = [...attempts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const a of sorted) {
    const key = `${a.nodeId}|${a.kind}|${a.taskId ?? ''}`;
    latest.set(key, a);
  }

  const tasksByNode = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = tasksByNode.get(t.nodeId) ?? [];
    list.push(t);
    tasksByNode.set(t.nodeId, list);
  }

  const mastered = new Set<string>();
  const states = new Map<string, NodeState>();

  // Первый проход: какие узлы зачтены (по попыткам, без учёта графа)
  for (const n of nodes) {
    const feynmanPassed = latest.get(`${n.id}|feynman|`)?.verdict === 'pass';
    const ownPassed = latest.get(`${n.id}|own|`)?.verdict === 'pass';
    const nodeTasks = tasksByNode.get(n.id) ?? [];
    let tasksPassed = 0;
    for (const t of nodeTasks) {
      if (latest.get(`${n.id}|task|${t.id}`)?.verdict === 'pass') tasksPassed++;
    }
    const allTrialsPassed =
      feynmanPassed && ownPassed && nodeTasks.length > 0 && tasksPassed === nodeTasks.length;
    if (allTrialsPassed) mastered.add(n.id);
    states.set(n.id, {
      status: 'available',
      risky: false,
      missingHard: [],
      missingSoft: [],
      feynmanPassed,
      tasksPassed,
      tasksTotal: nodeTasks.length,
      ownPassed,
      trialsDone: (feynmanPassed ? 1 : 0) + (tasksPassed === nodeTasks.length && nodeTasks.length > 0 ? 1 : 0) + (ownPassed ? 1 : 0),
    });
  }

  // Второй проход: гейты по рёбрам
  for (const n of nodes) {
    const st = states.get(n.id)!;
    const nodeDeps = deps.get(n.id) ?? [];
    for (const d of nodeDeps) {
      if (!mastered.has(d.id)) {
        if (d.kind === 'hard') st.missingHard.push(d.id);
        else st.missingSoft.push(d.id);
      }
    }
    st.risky = st.missingHard.length === 0 && st.missingSoft.length > 0;

    let status: NodeStatus;
    if (st.missingHard.length > 0) status = 'locked';
    else if (mastered.has(n.id)) status = 'mastered';
    else if (
      st.feynmanPassed ||
      st.ownPassed ||
      (st.tasksTotal > 0 && st.tasksPassed > 0)
    )
      status = 'in_progress';
    else status = 'available';
    st.status = status;
  }

  return states;
}

/**
 * Глубина в графе hard-зависимостей (длина самого длинного пути от корня).
 * Используется для послойной раскладки карты и «золотого пути».
 */
export function computeDepths(nodes: IdeaNode[], edges: IdeaEdge[]): Map<string, number> {
  const deps = buildDeps(edges);
  const depths = new Map<string, number>();
  const visiting = new Set<string>();

  function depth(id: string, fallback: number): number {
    if (depths.has(id)) return depths.get(id)!;
    if (visiting.has(id)) return fallback; // цикл — разрываем
    visiting.add(id);
    const nodeDeps = deps.get(id) ?? [];
    let d = 0;
    for (const dep of nodeDeps) {
      if (dep.kind === 'hard') d = Math.max(d, depth(dep.id, fallback + 1) + 1);
    }
    visiting.delete(id);
    depths.set(id, d);
    return d;
  }

  for (const n of nodes) depth(n.id, 0);
  return depths;
}

/**
 * Рекомендация следующего узла («золотой путь»):
 * среди доступных (не закрытых гейтами) неосвоенных — минимальная глубина,
 * при равенстве — не рискованный, затем по порядку в материале.
 */
export function recommendNext(
  nodes: IdeaNode[],
  states: Map<string, NodeState>,
  depths: Map<string, number>
): IdeaNode | null {
  const candidates = nodes.filter((n) => {
    const st = states.get(n.id);
    return st && (st.status === 'available' || st.status === 'in_progress');
  });
  if (candidates.length === 0) return null;
  const safe = candidates.filter((n) => !states.get(n.id)!.risky);
  const pool = safe.length > 0 ? safe : candidates;
  pool.sort((a, b) => {
    const da = depths.get(a.id) ?? 0;
    const db = depths.get(b.id) ?? 0;
    if (da !== db) return da - db;
    return a.orderIndex - b.orderIndex;
  });
  return pool[0];
}

export const LAYER_H = 210; // вертикальный шаг между слоями
export const COL_W = 225; // горизонтальный шаг внутри слоя

/**
 * Сгенерировать позиции узлов для карты: вертикальные слои по глубине
 * (сверху вниз, как карта пути в Slay the Spire), внутри слоя — по горизонтали.
 * Возвращает map nodeId -> {x, y}.
 */
export function layoutGraph(
  nodes: IdeaNode[],
  edges: IdeaEdge[],
  regions: { id: string; orderIndex: number }[]
): Map<string, { x: number; y: number }> {
  const depths = computeDepths(nodes, edges);
  const regionOrder = new Map(regions.map((r) => [r.id, r.orderIndex]));
  const byLayer = new Map<number, IdeaNode[]>();
  for (const n of nodes) {
    const d = depths.get(n.id) ?? 0;
    const list = byLayer.get(d) ?? [];
    list.push(n);
    byLayer.set(d, list);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [d, list] of byLayer) {
    // сортировка внутри слоя: регион, затем orderIndex
    list.sort(
      (a, b) =>
        (regionOrder.get(a.regionId) ?? 0) - (regionOrder.get(b.regionId) ?? 0) ||
        a.orderIndex - b.orderIndex
    );
    const width = (list.length - 1) * COL_W;
    list.forEach((n, i) => {
      positions.set(n.id, { x: i * COL_W - width / 2, y: d * LAYER_H });
    });
  }
  return positions;
}

/** Проверка ацикличности графа hard-рёбер (для валидации при ингесте) */
export function hasCycle(nodes: IdeaNode[], edges: IdeaEdge[]): boolean {
  try {
    const depths = new Map<string, number>();
    const deps = buildDeps(edges);
    const visiting = new Set<string>();
    const done = new Set<string>();
    function visit(id: string): boolean {
      if (done.has(id)) return false;
      if (visiting.has(id)) return true;
      visiting.add(id);
      for (const dep of deps.get(id) ?? []) {
        if (dep.kind === 'hard' && visit(dep.id)) return true;
      }
      visiting.delete(id);
      done.add(id);
      return false;
    }
    for (const n of nodes) {
      if (visit(n.id)) return true;
      void depths;
    }
    return false;
  } catch {
    return false;
  }
}
