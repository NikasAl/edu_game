import { describe, it, expect } from 'vitest';
import {
  instantiateTask,
  checkAnswer,
  taskProblems,
  isParametric,
  normalizeCodeAnswer,
  codeAnswerVariants,
  shuffledOrder,
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
    return { taskId: 't', values: { a: 1 }, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer, answerError: error };
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
    expect(checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: 'ель' }, spec, 'ЕЛЬ').verdict).toBe(
      'pass'
    );
  });

  it('альтернативные эталоны засчитываются', () => {
    expect(
      checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: 'ель' }, spec, 'Ель обыкновенная').verdict
    ).toBe('pass');
  });

  it('неверный — показывает эталон', () => {
    const r = checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: 'ель' }, spec, 'сосна');
    expect(r.verdict).toBe('fail');
    expect(r.correctAnswer).toBe('Ель');
  });
});

describe('checkAnswer — code_output / code_fill', () => {
  const spec = { kind: 'code' as const, value: '1\n2\n3' };

  const inst = { taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: '1\n2\n3' };

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
  const inst = { taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: '2' };

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
    const r = checkAnswer({ taskId: 't', values: {}, renderedPrompt: '?', renderedHints: [], renderedExplanation: '', answer: '' }, spec, 'текст');
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

describe('shuffledOrder — перемешивание показа вариантов choice', () => {
  it('возвращает перестановку [0..n-1]: те же элементы без повторов и потерь', () => {
    for (const n of [0, 1, 2, 3, 5, 8]) {
      const order = shuffledOrder(n);
      expect(order).toHaveLength(n);
      expect([...order].sort((a, b) => a - b)).toEqual(Array.from({ length: n }, (_, i) => i));
    }
  });

  it('детерминирован при подменённом rng', () => {
    const seq = [0.9, 0.1, 0.65, 0.4, 0.3];
    const makeRng = () => {
      let i = 0;
      return () => seq[i++ % seq.length];
    };
    const a = shuffledOrder(4, makeRng());
    const b = shuffledOrder(4, makeRng());
    expect(a).toEqual(b);
    expect(a).not.toEqual([0, 1, 2, 3]); // выбранный ГПСЧ реально тасует
  });

  it('тасует честно: на большом числе прогонов правильный вариант бывает на каждой позиции', () => {
    const n = 4;
    const firstPosCounts = new Array(n).fill(0);
    for (let t = 0; t < 4000; t++) {
      const order = shuffledOrder(n);
      // правильный ответ записан первым (correctIndex = 0) — где он показан?
      firstPosCounts[order.indexOf(0)]++;
    }
    for (const c of firstPosCounts) {
      expect(c).toBeGreaterThan(600); // ~1000 ожидается; < 600 — перекос
    }
  });

  it('краевые случаи: n=0 и отрицательное n — пустой массив', () => {
    expect(shuffledOrder(0)).toEqual([]);
    expect(shuffledOrder(-3)).toEqual([]);
    expect(shuffledOrder(1)).toEqual([0]);
  });
});

// ============ Подстановка шаблонов в подсказки и разбор ============

describe('substituteTemplates / instantiateTask — шаблоны в hints и explanation', () => {
  it('имена параметров подставляются в подсказки и разбор', () => {
    const task = mkTask({
      prompt: 'Группа из {{n}} человек.',
      hints: ['Всего {{n}} студентов.', ''],
      explanation: 'Копируют всех, кроме одного.',
      params: [{ name: 'n', choices: [25] }],
      answerSpec: { kind: 'numeric', expr: 'n - 1' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedHints).toEqual(['Всего 25 студентов.']);
    expect(inst.renderedExplanation).toBe('Копируют всех, кроме одного.');
  });

  it('выражения над параметрами вычисляются: {{n - 1}} → 24', () => {
    const task = mkTask({
      prompt: 'В группе {{n}} студентов.',
      explanation: 'то копируют ${{n}} - 1 = {{n - 1}}$ студентов',
      params: [{ name: 'n', choices: [25] }],
      answerSpec: { kind: 'numeric', expr: 'n - 1' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedPrompt).toContain('группе 25 студентов');
    expect(inst.renderedExplanation).toContain('$25 - 1 = 24$');
  });

  it('функции вычислителя работают в шаблонах: round(minutes * ratio / 100)', () => {
    const task = mkTask({
      prompt: 'Тема изучалась {{minutes}} минут.',
      hints: ['Минимум {{round(minutes * ratio / 100)}} минут.'],
      explanation: '$$\\frac{{{minutes}} \\cdot {{ratio}}}{100} = {{minutes * ratio / 100}}$$',
      params: [
        { name: 'minutes', choices: [60] },
        { name: 'ratio', choices: [40] },
      ],
      answerSpec: { kind: 'numeric', expr: 'round(minutes * ratio / 100)' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedHints).toEqual(['Минимум 24 минут.']);
    // {{minutes}} внутри LaTeX-скобок \frac{...} подставляется, скобки остаются
    expect(inst.renderedExplanation).toBe('$$\\frac{60 \\cdot 40}{100} = 24$$');
  });

  it('битое выражение и неизвестный параметр остаются как есть (рендер не падает)', () => {
    const task = mkTask({
      prompt: 'Вопрос {{n}} {{foo}} {{n +}}?',
      explanation: 'Разбор {{n / 0 см}} и {{foo - 1}}',
      params: [{ name: 'n', choices: [5] }],
      answerSpec: { kind: 'numeric', expr: 'n' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedPrompt).toContain('Вопрос 5 {{foo}} {{n +}}?');
    expect(inst.renderedExplanation).toContain('Разбор {{n / 0 см}} и {{foo - 1}}');
  });

  it('дробный результат выражения форматируется с запятой', () => {
    const task = mkTask({
      prompt: 'q',
      explanation: 'Получили {{n / 4}}',
      params: [{ name: 'n', choices: [3] }],
      answerSpec: { kind: 'numeric', expr: 'n' },
    });
    expect(instantiateTask(task).renderedExplanation).toBe('Получили 0,75');
  });

  it('пустые подсказки выбрасываются, промпт без шаблонов не трогается', () => {
    const task = mkTask({
      prompt: 'Простой вопрос?',
      hints: ['', '   '],
      explanation: '',
      params: [{ name: 'n', choices: [1] }],
      answerSpec: { kind: 'numeric', expr: 'n' },
    });
    const inst = instantiateTask(task);
    expect(inst.renderedHints).toEqual([]);
    expect(inst.renderedExplanation).toBe('');
    expect(inst.renderedPrompt).toBe('Простой вопрос?');
  });
});
