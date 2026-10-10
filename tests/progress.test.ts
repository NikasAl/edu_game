import { describe, it, expect } from 'vitest';
import {
  computeNodeStates,
  computeDepths,
  recommendNext,
  hasCycle,
  layoutGraph,
} from '@/lib/progress';
import type { Attempt, IdeaEdge, IdeaNode, Task } from '@/lib/types';

// ============ Фабрики ============

const BASE = new Date('2026-10-01T12:00:00');
let seq = 0;

function mkNode(overrides: Partial<IdeaNode> = {}): IdeaNode {
  return {
    id: `node-${++seq}`,
    materialId: 'm1',
    regionId: 'r1',
    title: `Идея ${seq}`,
    formulation: 'Суть',
    example: 'Пример',
    feynmanQuestion: 'Объясни',
    keyTerms: [],
    orderIndex: seq,
    createdAt: BASE,
    ...overrides,
  };
}

/** ребро: для освоения to нужно from */
function mkEdge(from: string, to: string, kind: 'hard' | 'soft' = 'hard'): IdeaEdge {
  return { id: `edge-${++seq}`, materialId: 'm1', fromNodeId: from, toNodeId: to, kind };
}

function mkTask(nodeId: string, id?: string): Task {
  return {
    id: id ?? `task-${nodeId}`,
    nodeId,
    materialId: 'm1',
    type: 'exact',
    prompt: 'Вопрос',
    answerSpec: { kind: 'exact', value: '42' },
    explanation: 'Разбор',
    hints: [],
    orderIndex: 0,
    createdAt: BASE,
  };
}

function mkAttempt(
  nodeId: string,
  kind: Attempt['kind'],
  verdict: Attempt['verdict'],
  taskId?: string
): Attempt {
  return {
    id: `a-${++seq}`,
    materialId: 'm1',
    nodeId,
    kind,
    taskId,
    userAnswer: '',
    verdict,
    createdAt: new Date(BASE.getTime() + seq * 1000),
  };
}

/** Полный зачёт узла */
function passAll(nodeId: string, taskIds: string[]): Attempt[] {
  return [
    mkAttempt(nodeId, 'feynman', 'pass'),
    ...taskIds.map((t) => mkAttempt(nodeId, 'task', 'pass', t)),
    mkAttempt(nodeId, 'own', 'pass'),
  ];
}

// ============ Состояния узлов ============

describe('computeNodeStates — гейты по рёбрам', () => {
  it('узел без зависимостей доступен', () => {
    const a = mkNode();
    const states = computeNodeStates({ nodes: [a], edges: [], tasks: [], attempts: [] });
    expect(states.get(a.id)!.status).toBe('available');
    expect(states.get(a.id)!.risky).toBe(false);
  });

  it('несосвоённая hard-зависимость закрывает узел', () => {
    const a = mkNode();
    const b = mkNode();
    const states = computeNodeStates({
      nodes: [a, b],
      edges: [mkEdge(a.id, b.id)],
      tasks: [],
      attempts: [],
    });
    expect(states.get(b.id)!.status).toBe('locked');
    expect(states.get(b.id)!.missingHard).toEqual([a.id]);
  });

  it('несосвоённая soft-зависимость — доступен, но «рискованно»', () => {
    const a = mkNode();
    const b = mkNode();
    const states = computeNodeStates({
      nodes: [a, b],
      edges: [mkEdge(a.id, b.id, 'soft')],
      tasks: [],
      attempts: [],
    });
    const st = states.get(b.id)!;
    expect(st.status).toBe('available');
    expect(st.risky).toBe(true);
    expect(st.missingSoft).toEqual([a.id]);
  });

  it('после освоения зависимости узел открывается', () => {
    const a = mkNode();
    const b = mkNode();
    const tA = mkTask(a.id);
    const states = computeNodeStates({
      nodes: [a, b],
      edges: [mkEdge(a.id, b.id)],
      tasks: [tA],
      attempts: passAll(a.id, [tA.id]),
    });
    expect(states.get(a.id)!.status).toBe('mastered');
    expect(states.get(b.id)!.status).toBe('available');
    expect(states.get(b.id)!.missingHard).toHaveLength(0);
  });
});

describe('computeNodeStates — зачёт и испытания', () => {
  it('полный зачёт: фейнман + все задачи + своя задача', () => {
    const a = mkNode();
    const t1 = mkTask(a.id, 't1');
    const t2 = mkTask(a.id, 't2');
    const states = computeNodeStates({
      nodes: [a],
      edges: [],
      tasks: [t1, t2],
      attempts: passAll(a.id, [t1.id, t2.id]),
    });
    expect(states.get(a.id)!.status).toBe('mastered');
    expect(states.get(a.id)!.trialsDone).toBe(3);
  });

  it('без задач узел не зачитывается (нечем проверять)', () => {
    const a = mkNode();
    const states = computeNodeStates({
      nodes: [a],
      edges: [],
      tasks: [],
      attempts: [mkAttempt(a.id, 'feynman', 'pass'), mkAttempt(a.id, 'own', 'pass')],
    });
    expect(states.get(a.id)!.status).toBe('in_progress');
  });

  it('частичный прогресс — «в работе»', () => {
    const a = mkNode();
    const states = computeNodeStates({
      nodes: [a],
      edges: [],
      tasks: [mkTask(a.id)],
      attempts: [mkAttempt(a.id, 'feynman', 'pass')],
    });
    const st = states.get(a.id)!;
    expect(st.status).toBe('in_progress');
    expect(st.trialsDone).toBe(1);
  });

  it('последняя попытка решает: провал после зачёта снимает освоенность', () => {
    const a = mkNode();
    const t = mkTask(a.id);
    const attempts = [
      ...passAll(a.id, [t.id]),
      mkAttempt(a.id, 'task', 'fail', t.id), // позже по createdAt
    ];
    const states = computeNodeStates({ nodes: [a], edges: [], tasks: [t], attempts });
    expect(states.get(a.id)!.status).toBe('in_progress');
  });

  it('пересдача задачи возвращает зачёт', () => {
    const a = mkNode();
    const t = mkTask(a.id);
    const attempts = [
      mkAttempt(a.id, 'feynman', 'pass'),
      mkAttempt(a.id, 'task', 'fail', t.id),
      mkAttempt(a.id, 'task', 'pass', t.id),
      mkAttempt(a.id, 'own', 'pass'),
    ];
    const states = computeNodeStates({ nodes: [a], edges: [], tasks: [t], attempts });
    expect(states.get(a.id)!.status).toBe('mastered');
  });

  it('review-попытка не влияет на испытания (только на SRS)', () => {
    const a = mkNode();
    const t = mkTask(a.id);
    const attempts = [
      ...passAll(a.id, [t.id]),
      mkAttempt(a.id, 'review', 'fail', t.id),
    ];
    const states = computeNodeStates({ nodes: [a], edges: [], tasks: [t], attempts });
    expect(states.get(a.id)!.status).toBe('mastered');
  });

  it('освоенный узел закрывается, если отвалилась его hard-зависимость', () => {
    const root = mkNode();
    const a = mkNode();
    const tA = mkTask(a.id);
    const states = computeNodeStates({
      nodes: [root, a],
      edges: [mkEdge(root.id, a.id)],
      tasks: [tA],
      attempts: passAll(a.id, [tA.id]),
    });
    // a освоен, но зависимость root не освоена → замок сильнее зачёта
    expect(states.get(a.id)!.status).toBe('locked');
  });
});

// ============ Глубины и рекомендации ============

describe('computeDepths — слои по hard-зависимостям', () => {
  it('корень 0, дальше послойно; soft-рёбра не удлиняют путь', () => {
    const a = mkNode();
    const b = mkNode();
    const c = mkNode();
    const depths = computeDepths(
      [a, b, c],
      [mkEdge(a.id, b.id), mkEdge(b.id, c.id), mkEdge(a.id, c.id, 'soft')]
    );
    expect(depths.get(a.id)).toBe(0);
    expect(depths.get(b.id)).toBe(1);
    expect(depths.get(c.id)).toBe(2);
  });

  it('цикл не уводит в бесконечность', () => {
    const a = mkNode();
    const b = mkNode();
    const depths = computeDepths([a, b], [mkEdge(a.id, b.id), mkEdge(b.id, a.id)]);
    expect(Number.isFinite(depths.get(a.id))).toBe(true);
    expect(Number.isFinite(depths.get(b.id))).toBe(true);
  });
});

describe('recommendNext — золотой путь', () => {
  it('минимальная глубина, безопасные выше рискованных, затем порядок', () => {
    const a = mkNode({ orderIndex: 1 });
    const b = mkNode({ orderIndex: 2 });
    const c = mkNode({ orderIndex: 3 });
    // b и c на одной глубине (hard от a); у c мягкая зависимость от узла
    // вне списка — она никогда не покрывается → c всегда «рискованный»
    const edges = [mkEdge(a.id, b.id), mkEdge(a.id, c.id), mkEdge('ghost', c.id, 'soft')];
    const depths = computeDepths([a, b, c], edges);
    const states = computeNodeStates({ nodes: [a, b, c], edges, tasks: [], attempts: [] });

    // всё не освоено → a первый (глубина 0)
    expect(recommendNext([a, b, c], states, depths)!.id).toBe(a.id);

    // после освоения a → b: та же глубина, что и c, но b не рискованный
    const tA = mkTask(a.id, 'ta');
    const states2 = computeNodeStates({
      nodes: [a, b, c],
      edges,
      tasks: [tA],
      attempts: passAll(a.id, [tA.id]),
    });
    expect(states2.get(a.id)!.status).toBe('mastered');
    expect(states2.get(c.id)!.risky).toBe(true);
    expect(recommendNext([a, b, c], states2, depths)!.id).toBe(b.id);
  });

  it('нет доступных (все locked) — null', () => {
    const a = mkNode();
    // зависимость вне списка узлов → не освоена → узел закрыт
    const edges = [mkEdge('ghost', a.id)];
    const states = computeNodeStates({ nodes: [a], edges, tasks: [], attempts: [] });
    expect(states.get(a.id)!.status).toBe('locked');
    expect(recommendNext([a], states, computeDepths([a], edges))).toBeNull();
  });
});

// ============ Ацикличность ============

describe('hasCycle', () => {
  it('ацикличный граф', () => {
    const a = mkNode();
    const b = mkNode();
    const c = mkNode();
    expect(hasCycle([a, b, c], [mkEdge(a.id, b.id), mkEdge(b.id, c.id)])).toBe(false);
  });

  it('цикл из hard-рёбер обнаруживается', () => {
    const a = mkNode();
    const b = mkNode();
    expect(hasCycle([a, b], [mkEdge(a.id, b.id), mkEdge(b.id, a.id)])).toBe(true);
  });

  it('soft-рёбра цикл не образуют (гейтируются только hard)', () => {
    const a = mkNode();
    const b = mkNode();
    expect(hasCycle([a, b], [mkEdge(a.id, b.id, 'soft'), mkEdge(b.id, a.id, 'soft')])).toBe(false);
  });
});

// ============ Раскладка карты ============

describe('layoutGraph — слоёная раскладка', () => {
  it('одинаковая глубина — одна горизонталь, глубина растёт вниз', () => {
    const a = mkNode();
    const b = mkNode({ orderIndex: 2 });
    const c = mkNode();
    const regions = [
      { id: 'r1', orderIndex: 0 },
      { id: 'r2', orderIndex: 1 },
    ];
    const nodes = [a, b, c].map((n) => ({ ...n, regionId: 'r1' }));
    const pos = layoutGraph(nodes, [mkEdge(a.id, c.id)], regions);
    expect(pos.get(a.id)!.y).toBe(0);
    expect(pos.get(c.id)!.y).toBeGreaterThan(pos.get(a.id)!.y);
    // a и b на одном слое, разнесены по X
    expect(pos.get(a.id)!.y).toBe(pos.get(b.id)!.y);
    expect(pos.get(a.id)!.x).not.toBe(pos.get(b.id)!.x);
  });
});

// ============ Режимы сложности ============

describe('computeNodeStates — режимы сложности', () => {
  it('Полный (по умолчанию и явно): без своей задачи узел не зачтён, испытаний 3', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass'),
      mkAttempt(n.id, 'task', 'pass', t.id),
    ];
    for (const difficulty of ['full', undefined] as const) {
      const states = computeNodeStates({ nodes: [n], edges: [], tasks: [t], attempts, difficulty });
      const st = states.get(n.id)!;
      expect(st.status).toBe('in_progress');
      expect(st.trialsTotal).toBe(3);
      expect(st.trialsDone).toBe(2);
    }
  });

  it('Обычный: своя задача не обязательна — узел зачтён, испытаний 2', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass'),
      mkAttempt(n.id, 'task', 'pass', t.id),
      mkAttempt(n.id, 'own', 'fail'),
    ];
    const states = computeNodeStates({ nodes: [n], edges: [], tasks: [t], attempts, difficulty: 'normal' });
    const st = states.get(n.id)!;
    expect(st.status).toBe('mastered');
    expect(st.trialsTotal).toBe(2);
    expect(st.trialsDone).toBe(2); // добровольный провал своей задачи не перебивает
  });

  it('Лёгкий: непройденное эссе не блокирует, обычная задача — блокирует', () => {
    const n = mkNode();
    const essay: Task = {
      ...mkTask(n.id, 'e1'),
      type: 'essay',
      answerSpec: { kind: 'essay', expectation: ['пункт'] },
    };
    const exact = mkTask(n.id, 'x1');
    const attempts = [mkAttempt(n.id, 'feynman', 'pass'), mkAttempt(n.id, 'task', 'pass', exact.id)];
    const states = computeNodeStates({
      nodes: [n],
      edges: [],
      tasks: [essay, exact],
      attempts,
      difficulty: 'easy',
    });
    const st = states.get(n.id)!;
    expect(st.status).toBe('mastered');
    expect(st.tasksTotal).toBe(1); // только обязательные (эссе не считаются)
  });

  it('Лёгкий: узел только с эссе осваивается по Фейнману (задачи в узле есть)', () => {
    const n = mkNode();
    const essay: Task = {
      ...mkTask(n.id, 'e1'),
      type: 'essay',
      answerSpec: { kind: 'essay', expectation: ['пункт'] },
    };
    const states = computeNodeStates({
      nodes: [n],
      edges: [],
      tasks: [essay],
      attempts: [mkAttempt(n.id, 'feynman', 'pass')],
      difficulty: 'easy',
    });
    expect(states.get(n.id)!.status).toBe('mastered');
    // …а в Обычном — нет: эссе обязательно
    const normal = computeNodeStates({
      nodes: [n],
      edges: [],
      tasks: [essay],
      attempts: [mkAttempt(n.id, 'feynman', 'pass')],
      difficulty: 'normal',
    });
    expect(normal.get(n.id)!.status).toBe('in_progress');
  });

  it('Узел без задач не осваивается ни в одном режиме', () => {
    const n = mkNode();
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass'),
      mkAttempt(n.id, 'own', 'pass'),
    ];
    for (const difficulty of ['easy', 'normal', 'full'] as const) {
      const states = computeNodeStates({ nodes: [n], edges: [], tasks: [], attempts, difficulty });
      expect(states.get(n.id)!.status).not.toBe('mastered');
    }
  });
});
