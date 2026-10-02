/**
 * Движок заданий: инстанцирование параметрических шаблонов и автопроверка.
 * Автопроверка детерминирована и не требует LLM.
 */
import type { AnswerSpec, Task, TaskInstance } from './types';
import { normalizeText, numericEquals, parseUserNumber, safeEvalExpr } from './safeMath';

/** Выбрать значение параметра (рандом из допустимых; защита от пустых/битых choices) */
function pick(choices: number[]): number {
  const pool = Array.isArray(choices) ? choices.filter((c) => typeof c === 'number' && Number.isFinite(c)) : [];
  const safe = pool.length > 0 ? pool : [1, 2, 3];
  return safe[Math.floor(Math.random() * safe.length)];
}

/**
 * Создать экземпляр задачи: подставить параметры в промпт и вычислить ответ.
 * Для задач без параметров возвращает промпт как есть.
 */
export function instantiateTask(task: Task): TaskInstance {
  const values: Record<string, number> = {};
  for (const p of task.params ?? []) {
    values[p.name] = pick(p.choices);
  }
  const renderedPrompt = task.prompt.replace(/\{\{\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*\}\}/g, (_, name: string) => {
    if (name in values) {
      const v = values[name];
      return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
    }
    return `{{${name}}}`;
  });

  const spec = task.answerSpec;
  let answer: number | string = '';
  let answerError: string | undefined;
  if (spec.kind === 'numeric') {
    // формула из LLM/БД может быть бита — рендер узла не должен падать:
    // ошибка сохраняется в instance.answerError, UI показывает предупреждение
    const r = safeEvalExpr(spec.expr, values);
    if (r.ok) {
      answer = r.value;
    } else {
      answer = NaN;
      answerError = r.error;
    }
  } else if (spec.kind === 'exact') {
    answer = spec.value;
  } else {
    answer = String(spec.correctIndex);
  }
  return answerError ? { taskId: task.id, values, renderedPrompt, answer, answerError } : { taskId: task.id, values, renderedPrompt, answer };
}

export interface CheckResult {
  verdict: 'pass' | 'fail';
  correctAnswer?: string; // показывается после неверного ответа (опция)
}

/** Проверить ответ пользователя на экземпляр задачи */
export function checkAnswer(instance: TaskInstance, spec: AnswerSpec, userInput: string): CheckResult {
  if (spec.kind === 'numeric') {
    if (instance.answerError) return { verdict: 'fail' }; // сломанная формула: ответ не может быть верным
    const num = parseUserNumber(userInput);
    if (num === null) return { verdict: 'fail' };
    const ok = numericEquals(num, instance.answer as number, spec.tolerance ?? 0.01);
    return { verdict: ok ? 'pass' : 'fail', correctAnswer: ok ? undefined : formatNum(instance.answer as number) };
  }
  if (spec.kind === 'exact') {
    const norm = normalizeText(userInput);
    const candidates = [spec.value, ...(spec.alts ?? [])].map(normalizeText);
    return { verdict: candidates.includes(norm) ? 'pass' : 'fail', correctAnswer: spec.value };
  }
  // choice: userInput — индекс строки
  const idx = parseInt(userInput, 10);
  const ok = !Number.isNaN(idx) && idx === Number(instance.answer);
  return {
    verdict: ok ? 'pass' : 'fail',
    correctAnswer: ok ? undefined : spec.options[Number(instance.answer)],
  };
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace('.', ',');
}

/**
 * Проблемы answerSpec, из-за которых задача не может быть решена/проверена.
 * Пустой массив — задача валидна. Используется для предупреждений в UI
 * (битые задачи из LLM не должны ронять экран узла).
 */
export function taskProblems(task: Task): string[] {
  const problems: string[] = [];
  const spec = task.answerSpec;
  if (spec.kind === 'numeric') {
    const vars: Record<string, number> = {};
    for (const p of task.params ?? []) {
      if (p && p.name) vars[p.name] = (p.choices ?? []).find((v) => Number.isFinite(v)) ?? 1;
    }
    const r = safeEvalExpr(spec.expr, vars);
    if (!r.ok) problems.push(`Формула ответа не вычисляется: ${r.error}`);
  } else if (spec.kind === 'choice') {
    const opts = spec.options ?? [];
    if (opts.length < 2) problems.push('Меньше двух вариантов ответа');
    else if (!Number.isInteger(spec.correctIndex) || spec.correctIndex < 0 || spec.correctIndex >= opts.length) {
      problems.push('Верный вариант вне диапазона');
    }
  } else if (spec.kind === 'exact') {
    if (!String(spec.value ?? '').trim()) problems.push('Не заполнен эталонный ответ');
  }
  return problems;
}

/** Есть ли у задачи параметризация (показать кнопку «другой вариант») */
export function isParametric(task: Task): boolean {
  return (task.params?.length ?? 0) > 0;
}
