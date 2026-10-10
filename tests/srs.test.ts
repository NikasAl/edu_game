import { describe, it, expect } from 'vitest';
import {
  computeSrsForNode,
  dueReviews,
  nextUpcomingReview,
  intervalFor,
  SRS_LADDER_DAYS,
} from '@/lib/srs';
import type { Attempt, IdeaNode, Task } from '@/lib/types';

// ============ Фабрики ============

const BASE = new Date('2026-10-01T12:00:00');
const at = (days: number, hours = 0) =>
  new Date(BASE.getTime() + days * 86_400_000 + hours * 3_600_000);

let seq = 0;
function mkNode(overrides: Partial<IdeaNode> = {}): IdeaNode {
  return {
    id: `node-${++seq}`,
    materialId: 'm1',
    regionId: 'r1',
    title: 'Идея',
    formulation: 'Суть',
    example: 'Пример',
    feynmanQuestion: 'Объясни',
    keyTerms: [],
    orderIndex: seq,
    createdAt: BASE,
    ...overrides,
  };
}

function mkTask(nodeId: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${nodeId}`,
    nodeId,
    materialId: 'm1',
    type: 'exact',
    prompt: 'Вопрос',
    answerSpec: { kind: 'exact', value: '42' },
    explanation: 'Разбор',
    hints: [],
    orderIndex: 0,
    createdAt: BASE,
    ...overrides,
  };
}

function mkAttempt(
  nodeId: string,
  kind: Attempt['kind'],
  verdict: Attempt['verdict'],
  createdAt: Date,
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
    createdAt,
  };
}

/** Освоить узел: фейнман + все задачи + своя задача, всё за день 0 */
function masterAttempts(nodeId: string, taskIds: string[], day = 0): Attempt[] {
  return [
    mkAttempt(nodeId, 'feynman', 'pass', at(day, 1)),
    ...taskIds.map((t) => mkAttempt(nodeId, 'task', 'pass', at(day, 2), t)),
    mkAttempt(nodeId, 'own', 'pass', at(day, 3)),
  ];
}

// ============ Применимость повторений ============

describe('computeSrsForNode — когда повторение неприменимо', () => {
  it('нет задач — узел не освоиваем', () => {
    const n = mkNode();
    expect(computeSrsForNode(n, [], [], at(0))).toBeNull();
  });

  it('фейнман не сдан', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'fail', at(0, 1)),
      mkAttempt(n.id, 'task', 'pass', at(0, 2), t.id),
      mkAttempt(n.id, 'own', 'pass', at(0, 3)),
    ];
    expect(computeSrsForNode(n, [t], attempts, at(0))).toBeNull();
  });

  it('своя задача не сдана', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(0, 1)),
      mkAttempt(n.id, 'task', 'pass', at(0, 2), t.id),
      mkAttempt(n.id, 'own', 'fail', at(0, 3)),
    ];
    expect(computeSrsForNode(n, [t], attempts, at(0))).toBeNull();
  });

  it('одна из задач провалена', () => {
    const n = mkNode();
    const t1 = mkTask(n.id);
    const t2 = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(0, 1)),
      mkAttempt(n.id, 'task', 'pass', at(0, 2), t1.id),
      mkAttempt(n.id, 'task', 'fail', at(0, 2), t2.id),
      mkAttempt(n.id, 'own', 'pass', at(0, 3)),
    ];
    expect(computeSrsForNode(n, [t1, t2], attempts, at(0))).toBeNull();
  });
});

// ============ Лестница интервалов ============

describe('intervalFor — лестница 1→3→7→16→35→70', () => {
  it('ступени соответствуют SRS_LADDER_DAYS', () => {
    expect(intervalFor(0)).toBe(1);
    expect(intervalFor(1)).toBe(3);
    expect(intervalFor(2)).toBe(7);
    expect(intervalFor(3)).toBe(16);
    expect(intervalFor(4)).toBe(35);
    expect(intervalFor(5)).toBe(70);
  });

  it('выше вершины лестницы не растёт', () => {
    expect(intervalFor(10)).toBe(SRS_LADDER_DAYS[SRS_LADDER_DAYS.length - 1]);
  });
});

// ============ Расчёт состояния ============

describe('computeSrsForNode — расписание', () => {
  it('только что освоенный узел: повторение через 1 день, пока не пора', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const info = computeSrsForNode(n, [t], masterAttempts(n.id, [t.id]), at(0, 5));
    expect(info).not.toBeNull();
    expect(info!.reviewsDone).toBe(0);
    expect(info!.intervalDays).toBe(1);
    expect(info!.due).toBe(false);
    expect(info!.dueAt.getTime()).toBe(at(1, 3).getTime()); // masteredAt (+3 ч) + 1 день
    expect(info!.masteredAt.getTime()).toBe(at(0, 3).getTime()); // последняя зачётная попытка
  });

  it('прошёл срок — пора повторять', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const info = computeSrsForNode(n, [t], masterAttempts(n.id, [t.id]), at(2));
    expect(info!.due).toBe(true);
  });

  it('после одного зачёта интервал 3 дня от даты повторения', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      ...masterAttempts(n.id, [t.id]),
      mkAttempt(n.id, 'review', 'pass', at(1, 1)),
    ];
    const info = computeSrsForNode(n, [t], attempts, at(2));
    expect(info!.reviewsDone).toBe(1);
    expect(info!.intervalDays).toBe(3);
    expect(info!.lastReviewAt!.getTime()).toBe(at(1, 1).getTime());
    expect(info!.dueAt.getTime()).toBe(at(4, 1).getTime()); // at(1,1) + 3 дня
    expect(info!.due).toBe(false);
  });

  it('повторения прошлых циклов (до переосвоения) не считаются', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      ...masterAttempts(n.id, [t.id], 0), // цикл 1
      mkAttempt(n.id, 'review', 'pass', at(1)), // повторение цикла 1
      mkAttempt(n.id, 'task', 'fail', at(2), t.id), // провал → узел в работу
      ...masterAttempts(n.id, [t.id], 3), // переосвоение (цикл 2)
    ];
    const info = computeSrsForNode(n, [t], attempts, at(4));
    expect(info!.reviewsDone).toBe(0); // старое повторение не в счёт
    expect(info!.masteredAt.getTime()).toBe(at(3, 3).getTime());
  });

  it('провальные review-попытки не двигают лестницу', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      ...masterAttempts(n.id, [t.id]),
      mkAttempt(n.id, 'review', 'fail', at(1)),
    ];
    const info = computeSrsForNode(n, [t], attempts, at(1, 2));
    expect(info!.reviewsDone).toBe(0);
  });

  it('вершина лестницы: 6 зачётов — интервал 70 дней', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      ...masterAttempts(n.id, [t.id]),
      ...[1, 2, 3, 4, 5, 6].map((d) => mkAttempt(n.id, 'review', 'pass', at(d))),
    ];
    const info = computeSrsForNode(n, [t], attempts, at(7));
    expect(info!.reviewsDone).toBe(6);
    expect(info!.intervalDays).toBe(70);
  });
});

// ============ Выборки ============

describe('dueReviews / nextUpcomingReview', () => {
  it('dueReviews: только просроченные, сортировка по срочности', () => {
    const n1 = mkNode({ orderIndex: 2 });
    const n2 = mkNode({ orderIndex: 1 });
    const t1 = mkTask(n1.id);
    const t2 = mkTask(n2.id);
    const attempts = [
      // n2 освоен раньше → срок раньше
      ...masterAttempts(n1.id, [t1.id], 2),
      ...masterAttempts(n2.id, [t2.id], 0),
    ];
    const due = dueReviews([n1, n2], [t1, t2], attempts, at(10));
    expect(due.map((d) => d.node.id)).toEqual([n2.id, n1.id]);
  });

  it('nextUpcomingReview: ближайшее будущее повторение', () => {
    const n1 = mkNode();
    const n2 = mkNode();
    const t1 = mkTask(n1.id);
    const t2 = mkTask(n2.id);
    const attempts = [
      ...masterAttempts(n1.id, [t1.id], 1), // срок at(2)
      ...masterAttempts(n2.id, [t2.id], 3), // срок at(4)
    ];
    const next = nextUpcomingReview([n1, n2], [t1, t2], attempts, at(1, 12));
    expect(next!.node.id).toBe(n1.id);
    expect(next!.info.due).toBe(false);
  });

  it('dueReviews не включает неосвоенные узлы', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [mkAttempt(n.id, 'feynman', 'pass', at(0))];
    expect(dueReviews([n], [t], attempts, at(30))).toHaveLength(0);
  });
});

// ============ Режимы сложности ============

describe('computeSrsForNode — режимы сложности', () => {
  it('Обычный: без зачтённой своей задачи повторение доступно', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(-10, 1)),
      mkAttempt(n.id, 'task', 'pass', at(-10, 2), t.id),
    ];
    const info = computeSrsForNode(n, [t], attempts, at(0), 'normal');
    expect(info).not.toBeNull();
    expect(info!.masteredAt.getTime()).toBe(at(-10, 2).getTime());
    expect(info!.due).toBe(true); // интервал 1 день давно прошёл
  });

  it('Полный (по умолчанию): без своей задачи повторения нет — прежнее правило', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(-10, 1)),
      mkAttempt(n.id, 'task', 'pass', at(-10, 2), t.id),
    ];
    expect(computeSrsForNode(n, [t], attempts, at(0))).toBeNull();
    expect(computeSrsForNode(n, [t], attempts, at(0), 'full')).toBeNull();
  });

  it('Лёгкий: эссе не обязательно — узел с непройденным эссе повторяется', () => {
    const n = mkNode();
    const essay: Task = {
      ...mkTask(n.id),
      id: 'e1',
      type: 'essay',
      answerSpec: { kind: 'essay', expectation: ['пункт'] },
    };
    const exact: Task = { ...mkTask(n.id), id: 'x1' };
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(-10, 1)),
      mkAttempt(n.id, 'task', 'pass', at(-10, 2), exact.id),
    ];
    expect(computeSrsForNode(n, [essay, exact], attempts, at(0), 'easy')).not.toBeNull();
    // в Обычном эссе обязательно — повторения нет
    expect(computeSrsForNode(n, [essay, exact], attempts, at(0), 'normal')).toBeNull();
  });

  it('dueReviews/nextUpcomingReview принимают режим сложности', () => {
    const n = mkNode();
    const t = mkTask(n.id);
    // освоен сегодня: интервал 1 день ещё не вышел → повторение «впереди»
    const attempts = [
      mkAttempt(n.id, 'feynman', 'pass', at(0, 1)),
      mkAttempt(n.id, 'task', 'pass', at(0, 2), t.id),
    ];
    expect(dueReviews([n], [t], attempts, at(0, 3), 'normal')).toHaveLength(0);
    expect(dueReviews([n], [t], attempts, at(0, 3), 'full')).toHaveLength(0);
    expect(nextUpcomingReview([n], [t], attempts, at(0, 3), 'normal')).not.toBeNull();
    expect(nextUpcomingReview([n], [t], attempts, at(0, 3), 'full')).toBeNull();
  });
});
