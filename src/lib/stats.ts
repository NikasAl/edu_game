/**
 * Статистика прохождения: агрегаты, активность по дням и прогноз освоения.
 *
 * Вся логика чистая (без обращения к БД) — проверяется node-тестом.
 * Зачёт узла повторяет правила computeNodeStates с учётом режима сложности:
 * фейнман pass + обязательные задачи pass (и хотя бы одна задача есть)
 * + в «Полном» ещё и своя задача pass, причём каждая попытка сравнивается
 * с ПОСЛЕДНЕЙ попыткой этого испытания — провал после зачёта снимает
 * освоенность. Дата освоения узла = дата последнего из этих зачётных
 * «последних попыток» (момент, когда закрылась последняя дырка).
 */
import type { Attempt, IdeaEdge, IdeaNode, NodeState, Region, Task } from './types';
import {
  computeNodeStates,
  countsForState,
  isOwnRequired,
  isTaskRequired,
  type DifficultyMode,
} from './progress';

export interface DayActivity {
  dayKey: string; // YYYY-MM-DD (локальная зона)
  label: string; // DD.MM
  attempts: number; // попыток в этот день
  passes: number; // зачётов в этот день
  mastered: number; // узлов, финально освоившихся в этот день
}

export interface Forecast {
  remaining: number; // сколько осваиваемых узлов осталось
  pacePerDay: number; // текущий темп, узлов/день
  paceSource: 'recent' | 'alltime'; // окно 14 дней или среднее за всё время
  etaDays: number | null; // null — темпа нет (done или нет данных)
  etaDate: Date | null;
  done: boolean; // осваиваемые узлы закрыты
}

export interface TrialStats {
  attempts: number;
  passes: number;
}

export interface RegionProgress {
  id: string;
  title: string;
  nodes: number;
  mastered: number;
}

export interface StatsBundle {
  nodes: IdeaNode[];
  edges: IdeaEdge[];
  tasks: Task[];
  attempts: Attempt[];
  regions?: Region[]; // если заданы — заполняется regionProgress
}

// ============ Периоды («за сегодня», «за неделю», «за всё время») ============

export type StatsPeriod = 'today' | 'week' | 'all';

export const STATS_PERIOD_META: Record<StatsPeriod, { label: string }> = {
  today: { label: 'Сегодня' },
  week: { label: 'Неделя' },
  all: { label: 'Всё время' },
};

/** Начало периода (включительно) или null для «Всё время» */
export function periodStart(period: StatsPeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const today = startOfDay(now);
  // «Неделя» = 7 календарных дней, включая сегодня
  return period === 'today' ? today : addDays(today, -6);
}

export interface PeriodSummary {
  attempts: number;
  passes: number;
  fails: number;
  accuracy: number; // pass / (pass+fail); 0 если попыток нет
  trials: { feynman: TrialStats; task: TrialStats; own: TrialStats };
  /** узлов, ФИНАЛЬНО освоившихся в период (дата освоения внутри периода) */
  masteredNodes: number;
}

/**
 * Сводка активности за период («Сегодня»/«Неделя»/«Всё время»).
 * Состояния узлов кумулятивны по природе, поэтому здесь только то, что
 * честно измеряется попытками: попытки/зачёты/точность, разбивка по
 * испытаниям и узлы, доведённые до зачёта в этот период.
 */
export function computePeriodSummary(input: {
  nodes: IdeaNode[];
  tasks: Task[];
  attempts: Attempt[];
  difficulty?: DifficultyMode;
  period: StatsPeriod;
  now?: Date;
}): PeriodSummary {
  const difficulty = input.difficulty ?? 'full';
  const now = input.now ?? new Date();
  const from = periodStart(input.period, now);
  const scoped = from ? input.attempts.filter((a) => a.createdAt >= from) : input.attempts;

  let passes = 0;
  let fails = 0;
  const trials: { feynman: TrialStats; task: TrialStats; own: TrialStats } = {
    feynman: { attempts: 0, passes: 0 },
    task: { attempts: 0, passes: 0 },
    own: { attempts: 0, passes: 0 },
  };
  for (const a of scoped) {
    if (a.verdict === 'pass') passes++;
    else if (a.verdict === 'fail') fails++;
    // 'review' — SRS-повторение, в разбивку испытаний не входит
    const tr = a.kind === 'review' ? undefined : trials[a.kind];
    if (tr) {
      tr.attempts++;
      if (a.verdict === 'pass') tr.passes++;
    }
  }

  // Узлы, освоившиеся именно в период: те же правила даты освоения, что в computeStats
  let masteredNodes = 0;
  const states = computeNodeStates({
    nodes: input.nodes,
    edges: [],
    tasks: input.tasks,
    attempts: input.attempts,
    difficulty,
  });
  const latest = latestAttemptsMap(input.attempts);
  const dates = masteredDatesFrom(input.nodes, tasksByNodeMap(input.tasks), latest, states, difficulty);
  for (const n of input.nodes) {
    if (states.get(n.id)?.status !== 'mastered') continue;
    const d = dates.get(n.id);
    if (from ? d !== undefined && d >= from : d !== undefined) masteredNodes++;
  }

  return {
    attempts: scoped.length,
    passes,
    fails,
    accuracy: passes + fails > 0 ? passes / (passes + fails) : 0,
    trials,
    masteredNodes,
  };
}

/** Последняя попытка по ключу (nodeId, kind, taskId); пробные (exploratory) не учитываются */
function latestAttemptsMap(attempts: Attempt[]): Map<string, Attempt> {
  const latest = new Map<string, Attempt>();
  const sorted = [...attempts].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  for (const a of sorted) {
    if (!countsForState(a)) continue;
    latest.set(`${a.nodeId}|${a.kind}|${a.taskId ?? ''}`, a);
  }
  return latest;
}

/** Группировка задач по узлам */
function tasksByNodeMap(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = map.get(t.nodeId) ?? [];
    list.push(t);
    map.set(t.nodeId, list);
  }
  return map;
}

/**
 * Дата финального освоения освоенных узлов: последний из зачётных
 * «последних попыток» (момент, когда закрылась последняя дырка).
 * Обязательные испытания — с учётом режима сложности; добровольно
 * пройденные («своя задача»/эссе в Лёгком) дату не отодвигают.
 */
function masteredDatesFrom(
  nodes: IdeaNode[],
  tasksByNode: Map<string, Task[]>,
  latest: Map<string, Attempt>,
  states: Map<string, NodeState>,
  difficulty: DifficultyMode
): Map<string, Date> {
  const masteredAt = new Map<string, Date>();
  for (const n of nodes) {
    const nodeTasks = tasksByNode.get(n.id) ?? [];
    if (nodeTasks.length === 0) continue; // без задач освоить нельзя
    if (states.get(n.id)?.status !== 'mastered') continue;
    const dates: Date[] = [];
    const fey = latest.get(`${n.id}|feynman|`);
    const own = latest.get(`${n.id}|own|`);
    if (fey?.verdict === 'pass') dates.push(fey.createdAt);
    if (isOwnRequired(difficulty) && own?.verdict === 'pass') dates.push(own.createdAt);
    for (const t of nodeTasks.filter((t) => isTaskRequired(t, difficulty))) {
      const a = latest.get(`${n.id}|task|${t.id}`);
      if (a?.verdict === 'pass') dates.push(a.createdAt);
    }
    if (dates.length > 0) masteredAt.set(n.id, dates.reduce((m, d) => (d > m ? d : m)));
  }
  return masteredAt;
}

export interface StatsResult {
  nodesTotal: number;
  nodesMasterable: number; // узлы с задачами — их можно освоить
  nodesMastered: number;
  nodesWithoutTasks: number; // задач нет — освоить нельзя, нужен доген
  nodesInProgress: number;
  nodesLocked: number;
  nodesAvailable: number;
  attemptsTotal: number;
  attemptsPass: number;
  accuracy: number; // pass / (pass+fail), 0..1; 0 если попыток нет
  activeDays: number; // дней с хотя бы одной попыткой (за всё время)
  streakDays: number; // текущая серия (сегодня или начиная со вчера)
  firstAttemptAt: Date | null;
  trials: { feynman: TrialStats; task: TrialStats; own: TrialStats };
  daily: DayActivity[]; // от старых к новым, windowDays дней, включая сегодня
  forecast: Forecast | null; // null — данных о темпе ещё нет
  regionProgress: RegionProgress[];
}

/** Локальный ключ дня YYYY-MM-DD (не UTC — дни должны совпадать с ощущением пользователя) */
export function dayKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, days: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

export function computeStats(
  bundle: StatsBundle,
  windowDays = 28,
  now = new Date(),
  difficulty: DifficultyMode = 'full'
): StatsResult {
  const { nodes, edges, tasks, attempts } = bundle;

  // --- состояния узлов (статусы и освоенность) — те же правила, что в UI ---
  const states = computeNodeStates({ nodes, edges, tasks, attempts, difficulty });

  // --- последняя попытка по испытанию (nodeId, kind, taskId); пробные не учитываются ---
  const latest = latestAttemptsMap(attempts);

  const tasksByNode = tasksByNodeMap(tasks);

  // --- дата финального освоения каждого освоенного узла ---
  const masteredAt = masteredDatesFrom(nodes, tasksByNode, latest, states, difficulty);
  let nodesMasterable = 0;
  for (const n of nodes) {
    if ((tasksByNode.get(n.id) ?? []).length === 0) continue; // без задач освоить нельзя
    nodesMasterable++;
  }

  // --- счётчики узлов ---
  let nodesMastered = 0;
  let nodesInProgress = 0;
  let nodesLocked = 0;
  let nodesAvailable = 0;
  for (const n of nodes) {
    const s = states.get(n.id)?.status;
    if (s === 'mastered') nodesMastered++;
    else if (s === 'in_progress') nodesInProgress++;
    else if (s === 'locked') nodesLocked++;
    else nodesAvailable++;
  }

  // --- попытки ---
  let attemptsPass = 0;
  let attemptsFail = 0;
  const trials: { feynman: TrialStats; task: TrialStats; own: TrialStats } = {
    feynman: { attempts: 0, passes: 0 },
    task: { attempts: 0, passes: 0 },
    own: { attempts: 0, passes: 0 },
  };
  let firstAttemptAt: Date | null = null;
  const activeDaySet = new Set<string>();
  for (const a of attempts) {
    if (a.verdict === 'pass') attemptsPass++;
    else if (a.verdict === 'fail') attemptsFail++;
    // 'review' — SRS-повторение, в статистику испытаний не входит
    const tr = a.kind === 'review' ? undefined : trials[a.kind];
    if (tr) {
      tr.attempts++;
      if (a.verdict === 'pass') tr.passes++;
    }
    if (!firstAttemptAt || a.createdAt < firstAttemptAt) firstAttemptAt = a.createdAt;
    activeDaySet.add(dayKeyOf(a.createdAt));
  }
  const attemptsTotal = attempts.length;
  const accuracy = attemptsPass + attemptsFail > 0 ? attemptsPass / (attemptsPass + attemptsFail) : 0;

  // --- серия занятий ---
  let streakDays = 0;
  {
    const today = startOfDay(now);
    let cursor = activeDaySet.has(dayKeyOf(today)) ? today : addDays(today, -1);
    while (activeDaySet.has(dayKeyOf(cursor))) {
      streakDays++;
      cursor = addDays(cursor, -1);
    }
  }

  // --- активность по дням (окно windowDays, включая сегодня) ---
  const todayStart = startOfDay(now);
  const windowStart = addDays(todayStart, -(windowDays - 1));
  const dayIndex = new Map<string, number>();
  const daily: DayActivity[] = [];
  for (let i = 0; i < windowDays; i++) {
    const d = addDays(windowStart, i);
    const key = dayKeyOf(d);
    dayIndex.set(key, i);
    daily.push({
      dayKey: key,
      label: `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`,
      attempts: 0,
      passes: 0,
      mastered: 0,
    });
  }
  for (const a of attempts) {
    const i = dayIndex.get(dayKeyOf(a.createdAt));
    if (i === undefined) continue;
    daily[i].attempts++;
    if (a.verdict === 'pass') daily[i].passes++;
  }
  for (const d of masteredAt.values()) {
    const i = dayIndex.get(dayKeyOf(d));
    if (i !== undefined) daily[i].mastered++;
  }

  // --- прогноз освоения ---
  const remaining = Math.max(0, nodesMasterable - nodesMastered);
  let forecast: Forecast | null = null;
  if (nodesMasterable > 0) {
    if (remaining === 0) {
      forecast = { remaining: 0, pacePerDay: 0, paceSource: 'recent', etaDays: null, etaDate: null, done: true };
    } else {
      const recentStart = addDays(todayStart, -13); // окно 14 дней
      let masteredInWindow = 0;
      for (const d of masteredAt.values()) if (d >= recentStart) masteredInWindow++;
      let pace = masteredInWindow / 14;
      let source: 'recent' | 'alltime' = 'recent';
      if (pace <= 0 && nodesMastered > 0 && firstAttemptAt) {
        const daysSpan = Math.max(1, Math.round((todayStart.getTime() - startOfDay(firstAttemptAt).getTime()) / 86_400_000) + 1);
        pace = nodesMastered / daysSpan;
        source = 'alltime';
      }
      if (pace > 0) {
        const etaDays = Math.ceil(remaining / pace);
        forecast = {
          remaining,
          pacePerDay: pace,
          paceSource: source,
          etaDays,
          etaDate: addDays(todayStart, etaDays),
          done: false,
        };
      }
    }
  }

  // --- регионы (для конкретной карты) ---
  const regionProgress: RegionProgress[] = (bundle.regions ?? []).map((r) => {
    const rn = nodes.filter((n) => n.regionId === r.id);
    return {
      id: r.id,
      title: r.title,
      nodes: rn.length,
      mastered: rn.filter((n) => states.get(n.id)?.status === 'mastered').length,
    };
  });

  return {
    nodesTotal: nodes.length,
    nodesMasterable,
    nodesMastered,
    nodesWithoutTasks: nodes.length - nodesMasterable,
    nodesInProgress,
    nodesLocked,
    nodesAvailable,
    attemptsTotal,
    attemptsPass,
    accuracy,
    activeDays: activeDaySet.size,
    streakDays,
    firstAttemptAt,
    trials,
    daily,
    forecast,
    regionProgress,
  };
}
