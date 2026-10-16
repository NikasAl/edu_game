import { describe, it, expect } from 'vitest';
import { computePeriodSummary, computeStats, periodStart, type StatsPeriod } from '@/lib/stats';
import { computeNodeStates } from '@/lib/progress';
import { computeSrsForNode } from '@/lib/srs';
import type { Attempt, IdeaNode, Task } from '@/lib/types';

// ============ Фабрики ============

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
    createdAt: new Date('2026-09-01T12:00:00'),
    ...overrides,
  };
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
    createdAt: new Date('2026-09-01T12:00:00'),
  };
}

function mkAttempt(
  nodeId: string,
  kind: Attempt['kind'],
  verdict: Attempt['verdict'],
  createdAt: Date,
  extra: Partial<Attempt> = {}
): Attempt {
  return {
    id: `a-${++seq}`,
    materialId: 'm1',
    nodeId,
    kind,
    ...(kind === 'task' ? { taskId: extra.taskId ?? `task-${nodeId}` } : {}),
    userAnswer: 'ответ',
    verdict,
    createdAt,
    ...extra,
  };
}

// «Сегодня» = фиксированный момент для всех проверок периода
const NOW = new Date('2026-10-10T15:00:00');

function daysAgo(n: number, hours = 12): Date {
  const d = new Date(NOW);
  d.setDate(d.getDate() - n);
  d.setHours(hours, 0, 0, 0);
  return d;
}

describe('periodStart', () => {
  it('«Всё время» — null (без фильтра)', () => {
    expect(periodStart('all', NOW)).toBeNull();
  });

  it('«Сегодня» — начало текущего дня', () => {
    const s = periodStart('today', NOW)!;
    expect(s.getFullYear()).toBe(2026);
    expect(s.getMonth()).toBe(9);
    expect(s.getDate()).toBe(10);
    expect(s.getHours()).toBe(0);
  });

  it('«Неделя» — 7 календарных дней, включая сегодня (4 октября 00:00)', () => {
    const s = periodStart('week', NOW)!;
    expect(s.getDate()).toBe(4);
    expect(s.getHours()).toBe(0);
  });
});

describe('computePeriodSummary — фильтрация попыток', () => {
  const node = mkNode();
  const task = mkTask(node.id);
  const nodes = [node];
  const tasks = [task];

  const attempts: Attempt[] = [
    // древние (9 дней назад) — в «неделю» не попадают
    mkAttempt(node.id, 'feynman', 'pass', daysAgo(9)),
    mkAttempt(node.id, 'task', 'pass', daysAgo(9)),
    // неделя: 5 дней назад — фейнман провал + задача зачёт
    mkAttempt(node.id, 'feynman', 'fail', daysAgo(5)),
    mkAttempt(node.id, 'task', 'pass', daysAgo(5)),
    // сегодня: фейнман зачёт
    mkAttempt(node.id, 'feynman', 'pass', daysAgo(0, 10)),
  ];

  it('«Сегодня»: только сегодняшние попытки', () => {
    const s = computePeriodSummary({ nodes, tasks, attempts, period: 'today', now: NOW });
    expect(s.attempts).toBe(1);
    expect(s.passes).toBe(1);
    expect(s.fails).toBe(0);
    expect(s.accuracy).toBe(1);
    expect(s.trials.feynman.attempts).toBe(1);
    expect(s.trials.feynman.passes).toBe(1);
    expect(s.trials.task.attempts).toBe(0);
  });

  it('«Неделя»: 7 дней включая сегодня, без древних', () => {
    const s = computePeriodSummary({ nodes, tasks, attempts, period: 'week', now: NOW });
    expect(s.attempts).toBe(3);
    expect(s.passes).toBe(2);
    expect(s.fails).toBe(1);
    expect(s.accuracy).toBeCloseTo(2 / 3, 5);
    expect(s.trials.feynman.attempts).toBe(2);
    expect(s.trials.task.passes).toBe(1);
  });

  it('«Всё время»: все попытки, как в общей статистике', () => {
    const s = computePeriodSummary({ nodes, tasks, attempts, period: 'all', now: NOW });
    expect(s.attempts).toBe(5);
    expect(s.passes).toBe(4);
    expect(s.accuracy).toBeCloseTo(4 / 5, 5);
  });

  it('SRS-повторения не попадают в разбивку по испытаниям, но в счёт попыток', () => {
    const s = computePeriodSummary({
      nodes,
      tasks,
      attempts: [...attempts, mkAttempt(node.id, 'review', 'pass', daysAgo(0, 11))],
      period: 'today',
      now: NOW,
    });
    expect(s.attempts).toBe(2);
    expect(s.passes).toBe(2);
    expect(s.trials.feynman.attempts).toBe(1);
    expect(s.trials.task.attempts).toBe(0);
  });

  it('узел, освоившийся сегодня, считается в «Сегодня» и «Неделю», но не в пустом периоде', () => {
    // финальное освоение — сегодняшним зачётом фейнмана (последняя зачётная попытка)
    const today = computePeriodSummary({ nodes, tasks, attempts, period: 'today', now: NOW, difficulty: 'normal' });
    const week = computePeriodSummary({ nodes, tasks, attempts, period: 'week', now: NOW, difficulty: 'normal' });
    const all = computePeriodSummary({ nodes, tasks, attempts, period: 'all', now: NOW, difficulty: 'normal' });
    expect(today.masteredNodes).toBe(1);
    expect(week.masteredNodes).toBe(1);
    expect(all.masteredNodes).toBe(1);
  });

  it('узел, освоившийся 9 дней назад, виден только во «Всё время»', () => {
    const oldAttempts: Attempt[] = [
      mkAttempt(node.id, 'feynman', 'pass', daysAgo(9)),
      mkAttempt(node.id, 'task', 'pass', daysAgo(9)),
    ];
    expect(computePeriodSummary({ nodes, tasks, attempts: oldAttempts, period: 'today', now: NOW, difficulty: 'normal' }).masteredNodes).toBe(0);
    expect(computePeriodSummary({ nodes, tasks, attempts: oldAttempts, period: 'week', now: NOW, difficulty: 'normal' }).masteredNodes).toBe(0);
    expect(computePeriodSummary({ nodes, tasks, attempts: oldAttempts, period: 'all', now: NOW, difficulty: 'normal' }).masteredNodes).toBe(1);
  });

  it('без попыток — нули без падений', () => {
    const s = computePeriodSummary({ nodes, tasks, attempts: [], period: 'today', now: NOW });
    expect(s.attempts).toBe(0);
    expect(s.accuracy).toBe(0);
    expect(s.masteredNodes).toBe(0);
  });
});

describe('exploratory-попытки не меняют состояние узла', () => {
  it('провал после зачёта (обычная попытка) снимает освоенность, пробная — нет', () => {
    const node = mkNode();
    const task = mkTask(node.id);
    const attempts: Attempt[] = [
      mkAttempt(node.id, 'feynman', 'pass', daysAgo(3)),
      mkAttempt(node.id, 'task', 'pass', daysAgo(3)),
    ];
    const pass = computeNodeStates({ nodes: [node], edges: [], tasks: [task], attempts, difficulty: 'normal' });
    expect(pass.get(node.id)?.status).toBe('mastered');

    // обычный провал — освоенность снята
    const fail = computeNodeStates({
      nodes: [node],
      edges: [],
      tasks: [task],
      attempts: [...attempts, mkAttempt(node.id, 'task', 'fail', daysAgo(1))],
      difficulty: 'normal',
    });
    expect(fail.get(node.id)?.status).not.toBe('mastered');

    // пробный провал — освоенность сохранена
    const explorFail = computeNodeStates({
      nodes: [node],
      edges: [],
      tasks: [task],
      attempts: [...attempts, mkAttempt(node.id, 'task', 'fail', daysAgo(1), { exploratory: true })],
      difficulty: 'normal',
    });
    expect(explorFail.get(node.id)?.status).toBe('mastered');
  });

  it('пробный зачёт не даёт нового (узел без зачёта им не закрыть)', () => {
    const node = mkNode();
    const task = mkTask(node.id);
    const attempts: Attempt[] = [
      mkAttempt(node.id, 'feynman', 'pass', daysAgo(3)),
      // задача провалена, потом «пробный зачёт»
      mkAttempt(node.id, 'task', 'fail', daysAgo(2)),
      mkAttempt(node.id, 'task', 'pass', daysAgo(1), { exploratory: true }),
    ];
    const states = computeNodeStates({ nodes: [node], edges: [], tasks: [task], attempts, difficulty: 'normal' });
    expect(states.get(node.id)?.tasksPassed).toBe(0);
    expect(states.get(node.id)?.status).toBe('in_progress');
  });

  it('SRS: пробный провал не возвращает узел в работу', () => {
    const node = mkNode();
    const task = mkTask(node.id);
    const attempts: Attempt[] = [
      mkAttempt(node.id, 'feynman', 'pass', daysAgo(3)),
      mkAttempt(node.id, 'task', 'pass', daysAgo(3)),
    ];
    const kept = computeSrsForNode(node, [task], [...attempts, mkAttempt(node.id, 'task', 'fail', daysAgo(0, 9), { exploratory: true })], NOW, 'normal');
    expect(kept).not.toBeNull();
    expect(kept!.masteredAt.getDate()).toBe(daysAgo(3).getDate());

    // обычный провал — SRS-состояние сбрасывается (узел не освоен)
    const gone = computeSrsForNode(node, [task], [...attempts, mkAttempt(node.id, 'task', 'fail', daysAgo(0, 9))], NOW, 'normal');
    expect(gone).toBeNull();
  });

  it('статистика: пробные попытки не влияют на дату освоения и состояние узлов', () => {
    const node = mkNode();
    const task = mkTask(node.id);
    const attempts: Attempt[] = [
      mkAttempt(node.id, 'feynman', 'pass', daysAgo(3)),
      mkAttempt(node.id, 'task', 'pass', daysAgo(3)),
      // пробные попытки сегодня (провал и зачёт)
      mkAttempt(node.id, 'task', 'fail', daysAgo(0, 9), { exploratory: true }),
      mkAttempt(node.id, 'task', 'pass', daysAgo(0, 10), { exploratory: true }),
    ];
    const stats = computeStats({ nodes: [node], edges: [], tasks: [task], attempts }, 28, NOW, 'normal');
    expect(stats.nodesMastered).toBe(1);
    // дата освоения — от официальной зачётной попытки (3 дня назад), не от пробной
    expect(stats.daily.find((d) => d.dayKey === '2026-10-07')?.mastered).toBe(1);
    expect(stats.daily.find((d) => d.dayKey === '2026-10-10')?.mastered).toBe(0);
    // но попытки посчитаны честно (4 попытки, 3 зачёта)
    expect(stats.attemptsTotal).toBe(4);
    expect(stats.attemptsPass).toBe(3);
  });
});

// ============ Прогноз освоения: окно темпа от начала работы ============

describe('computeStats — прогноз: окно не вылезает раньше первой попытки', () => {
  it('карта начата сегодня, 4 узла освоено → темп 4/день, а не 4/14', () => {
    const now = new Date('2026-10-16T15:00:00');
    const nodes = Array.from({ length: 20 }, (_, i) => mkNode({ id: `n${i}`, orderIndex: i }));
    const tasks = nodes.map((n) => mkTask(n.id, `t-${n.id}`));
    // 4 узла закрыты сегодня (фейнман + задача)
    const attempts: Attempt[] = [];
    for (let i = 0; i < 4; i++) {
      attempts.push(mkAttempt(`n${i}`, 'feynman', 'pass', new Date('2026-10-16T10:00:00')));
      attempts.push(mkAttempt(`n${i}`, 'task', 'pass', new Date('2026-10-16T11:00:00'), { taskId: `t-n${i}` }));
    }
    const { forecast } = computeStats({ nodes, edges: [], tasks, attempts }, 28, now, 'normal');
    expect(forecast).not.toBeNull();
    expect(forecast!.done).toBe(false);
    expect(forecast!.paceWindowDays).toBe(1);
    expect(forecast!.paceSource).toBe('recent');
    expect(forecast!.pacePerDay).toBeCloseTo(4, 5);
    expect(forecast!.remaining).toBe(16);
    expect(forecast!.etaDays).toBe(4); // ceil(16 / 4), а не 56
  });

  it('работа 3 дня, 4 узла → окно 3 дня, темп 4/3', () => {
    const now = new Date('2026-10-16T15:00:00');
    const nodes = Array.from({ length: 20 }, (_, i) => mkNode({ id: `n${i}`, orderIndex: i }));
    const tasks = nodes.map((n) => mkTask(n.id, `t-${n.id}`));
    const attempts: Attempt[] = [];
    const days = ['2026-10-14', '2026-10-15', '2026-10-16'];
    for (let i = 0; i < 4; i++) {
      const day = days[i % 3];
      attempts.push(mkAttempt(`n${i}`, 'feynman', 'pass', new Date(`${day}T10:00:00`)));
      attempts.push(mkAttempt(`n${i}`, 'task', 'pass', new Date(`${day}T11:00:00`), { taskId: `t-n${i}` }));
    }
    const { forecast } = computeStats({ nodes, edges: [], tasks, attempts }, 28, now, 'normal');
    expect(forecast!.paceWindowDays).toBe(3);
    expect(forecast!.pacePerDay).toBeCloseTo(4 / 3, 5);
    expect(forecast!.etaDays).toBe(12); // ceil(16 / (4/3))
  });

  it('старая карта (первая попытка 30 дней назад) → окно 14 дней, как раньше', () => {
    const now = new Date('2026-10-16T15:00:00');
    const nodes = Array.from({ length: 10 }, (_, i) => mkNode({ id: `n${i}`, orderIndex: i }));
    const tasks = nodes.map((n) => mkTask(n.id, `t-${n.id}`));
    const attempts: Attempt[] = [];
    for (let i = 0; i < 7; i++) {
      // первая попытка — 30 дней назад, зачёты задач — 6 дней назад (внутри окна)
      attempts.push(mkAttempt(`n${i}`, 'feynman', 'pass', new Date('2026-09-16T10:00:00')));
      attempts.push(mkAttempt(`n${i}`, 'task', 'pass', new Date('2026-10-10T11:00:00'), { taskId: `t-n${i}` }));
    }
    const { forecast } = computeStats({ nodes, edges: [], tasks, attempts }, 28, now, 'normal');
    expect(forecast!.paceWindowDays).toBe(14);
    expect(forecast!.pacePerDay).toBeCloseTo(7 / 14, 5);
    expect(forecast!.etaDays).toBe(6); // ceil(3 / 0.5)
  });

  it('зачёты вне окна (давно, окно 14 дней пусто) → средний темп за всё время', () => {
    const now = new Date('2026-10-16T15:00:00');
    const nodes = Array.from({ length: 10 }, (_, i) => mkNode({ id: `n${i}`, orderIndex: i }));
    const tasks = nodes.map((n) => mkTask(n.id, `t-${n.id}`));
    const attempts: Attempt[] = [];
    for (let i = 0; i < 2; i++) {
      attempts.push(mkAttempt(`n${i}`, 'feynman', 'pass', new Date('2026-09-20T10:00:00')));
      attempts.push(mkAttempt(`n${i}`, 'task', 'pass', new Date('2026-09-20T11:00:00'), { taskId: `t-n${i}` }));
    }
    const { forecast } = computeStats({ nodes, edges: [], tasks, attempts }, 28, now, 'normal');
    expect(forecast!.paceSource).toBe('alltime');
    // 26 дней с первой попытки (20.09..16.10 включительно), 2 узла
    expect(forecast!.pacePerDay).toBeCloseTo(2 / 27, 5);
  });
});
