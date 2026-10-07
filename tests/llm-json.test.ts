import { describe, it, expect } from 'vitest';
import { extractJson, rawSnippet } from '@/lib/llm-json';

describe('extractJson — прямой JSON', () => {
  it('объект как есть', () => {
    expect(extractJson<{ a: number }>('{"a": 1}')).toEqual({ a: 1 });
  });

  it('массив как есть', () => {
    expect(extractJson<number[]>('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('пробелы и переводы строк вокруг', () => {
    expect(extractJson<{ ok: boolean }>('  \n{"ok": true}\n  ')).toEqual({ ok: true });
  });
});

describe('extractJson — обёртки и мусор вокруг JSON', () => {
  it('markdown-забор ```json', () => {
    const raw = 'Вот результат:\n```json\n{"x": 5}\n```\nГотово.';
    expect(extractJson<{ x: number }>(raw)).toEqual({ x: 5 });
  });

  it('проза вокруг объекта', () => {
    const raw = 'Конечно! Вот JSON: {"title": "атом"} — дальше пояснения.';
    expect(extractJson<{ title: string }>(raw)).toEqual({ title: 'атом' });
  });

  it('скобки внутри строк не ломают баланс', () => {
    const raw = '{"expr": "a[0] + {b}", "n": 2}';
    expect(extractJson<{ expr: string; n: number }>(raw)).toEqual({ expr: 'a[0] + {b}', n: 2 });
  });

  it('два объекта без think-маркеров — берётся первый валидный', () => {
    const raw = '{"first": 1} а тут ещё {"second": 2}';
    expect(extractJson<{ first: number }>(raw)).toEqual({ first: 1 });
  });

  it('обрезанный хвост не мешает первому валидному объекту', () => {
    const raw = '{"a": 1} {"b": 2';
    expect(extractJson<{ a: number }>(raw)).toEqual({ a: 1 });
  });

  it('массив в прозе, если объектов нет', () => {
    const raw = 'Ответ: [1, 2, 3] конец';
    expect(extractJson<number[]>(raw)).toEqual([1, 2, 3]);
  });
});

describe('extractJson — reasoning-модели', () => {
  it('закрытый <think>-блок с валидным JSON внутри отбрасывается', () => {
    const raw =
      '<think>Поразмышляю: {"wrong": 1} — не то.</think>\n\nОтвет: {"right": true}';
    expect(extractJson<{ right: boolean }>(raw)).toEqual({ right: true });
  });

  it('закрытый <reasoning>-блок тоже отбрасывается', () => {
    const raw = '<reasoning>{"a": "рассуждение"}</reasoning>{"final": 42}';
    expect(extractJson<{ final: number }>(raw)).toEqual({ final: 42 });
  });

  it('незакрытый think-маркер: два объекта — берётся последний (финальный ответ)', () => {
    // reasoning-модель выдала черновик и финал, блок размышлений не закрыла
    const raw = '{"first": 1} размышляю дальше <think> и вот итог {"second": 2}';
    expect(extractJson<{ second: number }>(raw)).toEqual({ second: 2 });
  });
});

describe('extractJson — починка битого JSON', () => {
  it('сырые переводы строк внутри строковых значений', () => {
    // JSON.parse такое не принимает, repairControlChars чинит
    const raw = '{\n  "text": "строка первая\nстрока вторая"\n}';
    expect(extractJson<{ text: string }>(raw)).toEqual({ text: 'строка первая\nстрока вторая' });
  });

  it('сырые табуляции внутри строк', () => {
    const raw = '{"code": "if (x) {\n\treturn 1;\n}"}';
    expect(extractJson<{ code: string }>(raw)).toEqual({ code: 'if (x) {\n\treturn 1;\n}' });
  });
});

describe('extractJson — ошибки', () => {
  it('null/undefined — понятная ошибка', () => {
    // рантайм обрабатывает мусор, хотя тип параметра string
    expect(() => extractJson(null as unknown as string)).toThrow('пустой ответ');
    expect(() => extractJson(undefined as unknown as string)).toThrow('пустой ответ');
  });

  it('пустая строка — понятная ошибка', () => {
    expect(() => extractJson('   ')).toThrow('пустой ответ');
  });

  it('текст без JSON — ошибка с фрагментом ответа', () => {
    expect(() => extractJson('никакого JSON тут нет')).toThrow('некорректный JSON');
  });
});

describe('rawSnippet', () => {
  it('короткая строка возвращается целиком', () => {
    expect(rawSnippet('привет')).toBe('привет');
  });

  it('длинная — обрезается с многоточием', () => {
    const s = 'x'.repeat(300);
    const out = rawSnippet(s, 180);
    expect(out.length).toBe(181); // 180 + '…'
    expect(out.endsWith('…')).toBe(true);
  });

  it('переводы строк схлопываются', () => {
    expect(rawSnippet('a\n\n  b')).toBe('a b');
  });
});
