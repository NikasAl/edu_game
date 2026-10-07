import { describe, it, expect } from 'vitest';
import {
  instantiateTask,
  checkAnswer,
  taskProblems,
  isParametric,
  normalizeCodeAnswer,
  codeAnswerVariants,
} from '@/lib/task-engine';
import type { Task } from '@/lib/types';

// ============ Фабрики ============

let seq = 0;

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${++seq}`,
    nodeId: 'n1',
    materialId: 'm1',
    type: 'exact',
    prompt: 'Вопрос?',
    answerSpec: { kind: 'exact', value: 'ответ' },
    explanation: 'Разбор',
    hints: [],
    orderIndex: 0,
    createdAt: new Date('2026-10-01T12:00:00'),
    ...overrides,
  };
}

// ============ Инстанцирование ============

describe('instantiateTask — параметрические задачи', () => {
  it('параметры подставляются в промпт, ответ вычисляется от них', () => {
    const task = mkTask({
      prompt: 'При a = {{a}} найди a^2.',
      params: [{ name: 'a', choices: [2, 3, 4] }],
      answerSpec: { kind: 'numeric', expr: 'a*a' },
    });
    const inst = instantiateTask(task);
    const a = inst.values.a;
    expect([2, 3, 4]).toContain(a);
    expect(inst.renderedPrompt).toContain(`a = ${a}`);
    expect(inst.answer).toBe(a * a);
  });

  it('дробные значения подставляются с запятой (русская запись)', () => {
    const task = mkTask({
      prompt: 'Скорость {{v}} м/с',
      params: [{ name: 'v', choices: [2.5] }],
      answerSpec: { kind: 'numeric', expr: 'v' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedPrompt).toContain('2,5');
  });

  it('неизвестный параметр в промпте остаётся как есть', () => {
    const task = mkTask({
      prompt: 'Формула {{unknown}}',
      params: [{ name: 'a', choices: [1] }],
      answerSpec: { kind: 'numeric', expr: 'a' },
    });
    expect(instantiateTask(task).renderedPrompt).toContain('{{unknown}}');
  });

  it('битая формула ответа не роняет рендер — answerError', () => {
    const task = mkTask({
      answerSpec: { kind: 'numeric', expr: 'a + (не_вычислить' },
      params: [{ name: 'a', choices: [1] }],
    });
    const inst = instantiateTask(task);
    expect(inst.answerError).toBeTruthy();
  });

  it('не-numeric эталоны пробрасываются как есть', () => {
    expect(instantiateTask(mkTask({ answerSpec: { kind: 'exact', value: 'X' } })).answer).toBe('X');
    expect(
      instantiateTask(mkTask({ answerSpec: { kind: 'choice', options: ['а', 'б'], correctIndex: 1 } }))
        .answer
    ).toBe('1');
    expect(instantiateTask(mkTask({ answerSpec: { kind: 'code', value: 'print()' } })).answer).toBe(
      'print()'
    );
    expect(instantiateTask(mkTask({ answerSpec: { kind: 'essay', expectation: ['пункт'] } })).answer).toBe(
      ''
    );
  });
});

// ============ Автопроверка ============

describe('checkAnswer — numeric', () => {
  const spec = { kind: 'numeric' as const, expr: 'a*2', tolerance: 0.01 };

  function instanceOf(answer: number, error?: string) {
    return { taskId: 't', values: { a: 1 }, renderedPrompt: '?', answer, answerError: error };
  }

  it('верный ответ с допуском', () => {
    const r = checkAnswer(instanceOf(10), spec, '9.995');
    expect(r.verdict).toBe('pass');
  });

  it('запятая как десятичный разделитель принимается', () => {
    expect(checkAnswer(instanceOf(3.14), { ...spec, expr: 'pi' }, '3,14').verdict).toBe('pass');
  });

  it('неверный ответ показывает правильный (в русском формате)', () => {
    const r = checkAnswer(instanceOf(2.5), spec, '3');
    expect(r.verdict).toBe('fail');
    expect(r.correctAnswer).toBe('2,5');
  });

  it('нечисло — провал', () => {
    expect(checkAnswer(instanceOf(5), spec, 'пять').verdict).toBe('fail');
  });

  it('сломанная формула — всегда провал', () => {
    expect(checkAnswer(instanceOf(5, 'не вычисляется'), spec, '5').verdict).toBe('fail');
  });
});

describe('checkAnswer — exact', () => {
  const spec = { kind: 'exact' as const, value: 'Ель', alts: ['ель обыкновенная'] };

  it('регистр и падежные мелочи прощаются', () => {
    expect(checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', answer: 'ель' }, spec, 'ЕЛЬ').verdict).toBe(
      'pass'
    );
  });

  it('альтернативные эталоны засчитываются', () => {
    expect(
      checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', answer: 'ель' }, spec, 'Ель обыкновенная').verdict
    ).toBe('pass');
  });

  it('неверный — показывает эталон', () => {
    const r = checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', answer: 'ель' }, spec, 'сосна');
    expect(r.verdict).toBe('fail');
    expect(r.correctAnswer).toBe('Ель');
  });
});

describe('checkAnswer — code_output / code_fill', () => {
  const spec = { kind: 'code' as const, value: '1\n2\n3' };

  const inst = { taskId: 't', values: {}, renderedPrompt: '?', answer: '1\n2\n3' };

  it('точное совпадение', () => {
    expect(checkAnswer(inst, spec, '1\n2\n3').verdict).toBe('pass');
  });

  it('хвостовые точки с запятой и пустые строки прощаются', () => {
    expect(checkAnswer(inst, spec, '1;\n2;\n3;\n').verdict).toBe('pass');
  });

  it('многострочный вывод сворачивается в строку', () => {
    expect(checkAnswer(inst, spec, '1 2 3').verdict).toBe('pass');
  });

  it('регистр и внутренние пробелы значимы', () => {
    expect(checkAnswer(inst, spec, '1  2 3').verdict).toBe('fail');
    expect(checkAnswer(inst, { ...spec, value: 'Hello' }, 'hello').verdict).toBe('fail');
  });

  it('альтернативные эталоны работают', () => {
    const specAlts = { ...spec, value: 'yes', alts: ['да'] };
    expect(checkAnswer(inst, specAlts, 'да').verdict).toBe('pass');
  });
});

describe('checkAnswer — choice', () => {
  const spec = { kind: 'choice' as const, options: ['Вода', 'Лёд', 'Пар'], correctIndex: 2 };
  const inst = { taskId: 't', values: {}, renderedPrompt: '?', answer: '2' };

  it('верный индекс', () => {
    expect(checkAnswer(inst, spec, '2').verdict).toBe('pass');
  });

  it('неверный — показывает текст верного варианта', () => {
    const r = checkAnswer(inst, spec, '0');
    expect(r.verdict).toBe('fail');
    expect(r.correctAnswer).toBe('Пар');
  });
});

describe('checkAnswer — essay (заглушка, проверка в NodeView)', () => {
  it('всегда fail без correctAnswer', () => {
    const spec = { kind: 'essay' as const, expectation: ['п1', 'п2'] };
    const r = checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', answer: '' }, spec, 'текст');
    expect(r.verdict).toBe('fail');
    expect(r.correctAnswer).toBeUndefined();
  });
});

// ============ Нормализация кода ============

describe('normalizeCodeAnswer / codeAnswerVariants', () => {
  it('CR вычищается, пустые строки выбрасываются, края обрезаны', () => {
    expect(normalizeCodeAnswer('a = 1\r\n\r\nb = 2\r\n')).toBe('a = 1\nb = 2');
  });

  it('варианты: базовый / без «;» / свёрнутый в строку', () => {
    const v = codeAnswerVariants('1;\n2;');
    expect(v).toContain('1;\n2;');
    expect(v).toContain('1\n2');
    expect(v).toContain('1 2');
  });

  it('пустой ввод — нет вариантов', () => {
    expect(codeAnswerVariants('  \n ')).toEqual([]);
  });
});

// ============ Валидация задач ============

describe('taskProblems — битые answerSpec', () => {
  it('валидная задача — пустой список', () => {
    expect(taskProblems(mkTask())).toEqual([]);
  });

  it('numeric: формула не вычисляется', () => {
    const p = taskProblems(mkTask({ answerSpec: { kind: 'numeric', expr: '2 +' } }));
    expect(p[0]).toMatch(/не вычисляется/);
  });

  it('choice: меньше двух вариантов', () => {
    const p = taskProblems(
      mkTask({ answerSpec: { kind: 'choice', options: ['один'], correctIndex: 0 } })
    );
    expect(p[0]).toMatch(/двух вариантов/);
  });

  it('choice: верный индекс вне диапазона', () => {
    const p = taskProblems(
      mkTask({ answerSpec: { kind: 'choice', options: ['а', 'б'], correctIndex: 5 } })
    );
    expect(p[0]).toMatch(/вне диапазона/);
  });

  it('exact: пустой эталон', () => {
    const p = taskProblems(mkTask({ answerSpec: { kind: 'exact', value: '  ' } }));
    expect(p[0]).toMatch(/эталон/);
  });

  it('essay: меньше двух ключевых пунктов', () => {
    const p = taskProblems(mkTask({ answerSpec: { kind: 'essay', expectation: ['один'] } }));
    expect(p[0]).toMatch(/минимум 2/);
  });

  it('code: нет эталона и нет листинга', () => {
    const p = taskProblems(mkTask({ answerSpec: { kind: 'code', value: '' }, code: undefined }));
    expect(p.some((x) => x.match(/эталон/))).toBe(true);
    expect(p.some((x) => x.match(/листинга/))).toBe(true);
  });
});

describe('isParametric', () => {
  it('есть params → true, нет → false', () => {
    expect(isParametric(mkTask({ params: [{ name: 'a', choices: [1] }] }))).toBe(true);
    expect(isParametric(mkTask())).toBe(false);
  });
});
