/**
 * SRS — интервальные повторения освоенных идей.
 *
 * Философия та же, что у computeNodeStates: SRS-состояние не хранится отдельно,
 * а вычисляется по попыткам — безопасно при перезапусках, экспорт/импорт и
 * сброс прогресса работают без дополнительных миграций.
 *
 * События повторений:
 *  - зачёт повторения → попытка kind='review' с taskId повторённой задачи.
 *    Не влияет на испытания (computeNodeStates не смотрит этот вид попыток),
 *    только продвигает лестницу интервалов;
 *  - провал повторения → попытка kind='task' с verdict='fail' по повторённой
 *    задаче: существующее правило «провал после зачёта снимает освоенность»
 *    возвращает узел в работу — забытую идею нужно перепройти.
 *
 * Лестница интервалов (дней): 1 → 3 → 7 → 16 → 35 → 70, дальше не растёт.
 */
import type { Attempt, IdeaNode, Task } from './types';
import { isOwnRequired, isTaskRequired, type DifficultyMode } from './progress';

export const SRS_LADDER_DAYS = [1, 3, 7, 16, 35, 70];

export interface SrsInfo {
  masteredAt: Date; // момент (пере)освоения узла — последний из зачётных «последних попыток»
  dueAt: Date; // когда следующее повторение
  due: boolean; // повторять уже пора (dueAt <= now)
  intervalDays: number; // текущий интервал после последнего события
  reviewsDone: number; // успешных повторений в текущем цикле освоения
  lastReviewAt: Date | null; // последнее успешное повторение (если было)
}

/** Интервал (в днях) после N успешных повторений */
export function intervalFor(reviewsDone: number): number {
  if (reviewsDone <= 0) return SRS_LADDER_DAYS[0];
  return SRS_LADDER_DAYS[Math.min(reviewsDone, SRS_LADDER_DAYS.length - 1)];
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

/** День месяца в виде DD.MM (для подписей повторений) */
export function fmtDay(d: Date): string {
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * SRS-состояние узла или null, если повторение неприменимо:
 * нет задач (узел не освоиваем) или узел сейчас не освоен
 * (в т.ч. только что проваленное повторение).
 */
export function computeSrsForNode(
  node: IdeaNode,
  tasks: Task[],
  attempts: Attempt[],
  now: Date,
  difficulty: DifficultyMode = 'full'
): SrsInfo | null {
  const nodeTasks = tasks.filter((t) => t.nodeId === node.id);
  if (nodeTasks.length === 0) return null;

  // Последняя попытка по ключу испытания — те же правила, что в NodeView/stats
  const sorted = attempts
    .filter((a) => a.nodeId === node.id)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const latest = new Map<string, Attempt>();
  for (const a of sorted) latest.set(`${a.kind}|${a.taskId ?? ''}`, a);

  const feynman = latest.get('feynman|');
  const own = latest.get('own|');
  // правила зачёта — как в computeNodeStates: своя задача и эссе обязательны
  // только в соответствующих режимах сложности
  if (feynman?.verdict !== 'pass') return null;
  if (isOwnRequired(difficulty) && own?.verdict !== 'pass') return null;

  const passingDates: Date[] = [feynman.createdAt];
  if (own?.verdict === 'pass') passingDates.push(own.createdAt);
  for (const t of nodeTasks.filter((t) => isTaskRequired(t, difficulty))) {
    const a = latest.get(`task|${t.id}`);
    if (a?.verdict !== 'pass') return null;
    passingDates.push(a.createdAt);
  }
  // момент освоения = последний из зачётных «последних попыток»
  const masteredAt = passingDates.reduce((m, d) => (d > m ? d : m));

  // Успешные повторения текущего цикла освоения (после момента освоения;
  // повторения прошлых циклов до провала/переосвоения не считаются)
  const reviews = sorted.filter(
    (a) =>
      a.kind === 'review' &&
      a.verdict === 'pass' &&
      a.createdAt.getTime() > masteredAt.getTime()
  );
  const reviewsDone = reviews.length;
  const lastReviewAt = reviews.length > 0 ? reviews[reviews.length - 1].createdAt : null;

  const intervalDays = intervalFor(reviewsDone);
  const dueAt = addDays(lastReviewAt ?? masteredAt, intervalDays);
  return {
    masteredAt,
    dueAt,
    due: dueAt.getTime() <= now.getTime(),
    intervalDays,
    reviewsDone,
    lastReviewAt,
  };
}

/** Узлы, которые пора повторить (отсортированы по срочности, затем по порядку) */
export function dueReviews(
  nodes: IdeaNode[],
  tasks: Task[],
  attempts: Attempt[],
  now: Date,
  difficulty: DifficultyMode = 'full'
): { node: IdeaNode; info: SrsInfo }[] {
  const out: { node: IdeaNode; info: SrsInfo }[] = [];
  for (const n of nodes) {
    const info = computeSrsForNode(n, tasks, attempts, now, difficulty);
    if (info?.due) out.push({ node: n, info });
  }
  out.sort(
    (a, b) =>
      a.info.dueAt.getTime() - b.info.dueAt.getTime() || a.node.orderIndex - b.node.orderIndex
  );
  return out;
}

/** Ближайшее будущее повторение (не просроченное) — подсказка на главной */
export function nextUpcomingReview(
  nodes: IdeaNode[],
  tasks: Task[],
  attempts: Attempt[],
  now: Date,
  difficulty: DifficultyMode = 'full'
): { node: IdeaNode; info: SrsInfo } | null {
  let best: { node: IdeaNode; info: SrsInfo } | null = null;
  for (const n of nodes) {
    const info = computeSrsForNode(n, tasks, attempts, now, difficulty);
    if (!info || info.due) continue;
    if (!best || info.dueAt.getTime() < best.info.dueAt.getTime()) best = { node: n, info };
  }
  return best;
}
