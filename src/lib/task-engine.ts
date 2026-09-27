/**
 * Движок заданий: инстанцирование параметрических шаблонов и автопроверка.
 * Автопроверка детерминирована и не требует LLM.
 */
import type { AnswerSpec, Task, TaskInstance } from './types';
import { evalExpr, normalizeText, numericEquals, parseUserNumber } from './safeMath';

/** Выбрать значение параметра (рандом из допустимых) */
function pick(choices: number[]): number {
  return choices[Math.floor(Math.random() * choices.length)];
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
  if (spec.kind === 'numeric') {
    answer = evalExpr(spec.expr, values);
  } else if (spec.kind === 'exact') {
    answer = spec.value;
  } else {
    answer = String(spec.correctIndex);
  }
  return { taskId: task.id, values, renderedPrompt, answer };
}

export interface CheckResult {
  verdict: 'pass' | 'fail';
  correctAnswer?: string; // показывается после неверного ответа (опция)
}

/** Проверить ответ пользователя на экземпляр задачи */
export function checkAnswer(instance: TaskInstance, spec: AnswerSpec, userInput: string): CheckResult {
  if (spec.kind === 'numeric') {
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
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100).replace('.', ',');
}

/** Есть ли у задачи параметризация (показать кнопку «другой вариант») */
export function isParametric(task: Task): boolean {
  return (task.params?.length ?? 0) > 0;
}
