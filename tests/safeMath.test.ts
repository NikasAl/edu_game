import { describe, it, expect } from 'vitest';
import {
  evalExpr,
  safeEvalExpr,
  numericEquals,
  parseUserNumber,
  normalizeText,
} from '@/lib/safeMath';

describe('evalExpr — арифметика и приоритеты', () => {
  it('базовые операции', () => {
    expect(evalExpr('2+3*4')).toBe(14);
    expect(evalExpr('(2+3)*4')).toBe(20);
    expect(evalExpr('10/4')).toBe(2.5);
    expect(evalExpr('7-2-3')).toBe(2); // левоассоциативность
  });

  it('степень правоассоциативна', () => {
    expect(evalExpr('2^3^2')).toBe(512); // 2^(3^2), а не (2^3)^2
    expect(evalExpr('2^-1')).toBe(0.5); // унарный минус в показателе
  });

  it('унарный минус', () => {
    expect(evalExpr('-5 + 3')).toBe(-2);
    expect(evalExpr('2 * -3')).toBe(-6);
  });

  it('параметры подставляются', () => {
    expect(evalExpr('2*a*t0', { a: 3, t0: 2 })).toBe(12);
    expect(evalExpr('v0 + a*t', { v0: 5, a: 2, t: 3 })).toBe(11);
  });
});

describe('evalExpr — нормализация «человеческой» записи LLM', () => {
  it('проценты', () => {
    expect(evalExpr('50%')).toBe(0.5);
    expect(evalExpr('a*50%', { a: 200 })).toBe(100);
  });

  it('юникодные знаки умножения/деления/минуса', () => {
    expect(evalExpr('2×3')).toBe(6);
    expect(evalExpr('10÷2')).toBe(5);
    expect(evalExpr('5−3')).toBe(2); // U+2212
    expect(evalExpr('2**3')).toBe(8); // ** как степень
  });

  it('√ (юникодный корень)', () => {
    expect(evalExpr('√9')).toBe(3);
    expect(evalExpr('√(16)')).toBe(4);
    expect(evalExpr('√a', { a: 25 })).toBe(5);
  });

  it('десятичная запятая как разделитель дробной части', () => {
    expect(evalExpr('2,5 + 1')).toBe(3.5);
  });

  it('невидимые/юникодные пробелы вычищаются', () => {
    expect(evalExpr('2\u00A0+\u20093')).toBe(5);
  });
});

describe('evalExpr — функции и константы', () => {
  it('функции', () => {
    expect(evalExpr('sqrt(9)')).toBe(3);
    expect(evalExpr('abs(-7)')).toBe(7);
    expect(evalExpr('min(3, 1, 2)')).toBe(1);
    expect(evalExpr('max(3, 1, 2)')).toBe(3);
    expect(evalExpr('round(2.6)')).toBe(3);
    expect(evalExpr('floor(2.9)')).toBe(2);
    expect(evalExpr('ceil(2.1)')).toBe(3);
    expect(evalExpr('sign(-5)')).toBe(-1);
    expect(evalExpr('log(100)')).toBe(2); // десятичный
    expect(evalExpr('log2(8)')).toBe(3);
    expect(evalExpr('ln(e)')).toBeCloseTo(1, 10);
    expect(evalExpr('exp(0)')).toBe(1);
  });

  it('константы pi и e, если имя не совпало с параметром', () => {
    expect(evalExpr('2*pi')).toBeCloseTo(Math.PI * 2, 12);
    expect(evalExpr('e')).toBe(Math.E);
  });

  it('параметр приоритетнее константы-тёзки', () => {
    expect(evalExpr('pi * 2', { pi: 1 })).toBe(2);
  });
});

describe('evalExpr — ошибки', () => {
  it('неизвестная функция', () => {
    expect(() => evalExpr('foo(1)')).toThrow('Неизвестная функция');
  });

  it('неизвестный параметр', () => {
    expect(() => evalExpr('a + b', { a: 1 })).toThrow('Неизвестный параметр');
  });

  it('лишние символы в конце', () => {
    expect(() => evalExpr('2 + 3 )')).toThrow();
  });

  it('незакрытая скобка', () => {
    expect(() => evalExpr('sqrt(4')).toThrow('закрывающая скобка');
  });

  it('деление на ноль — не конечное число', () => {
    expect(() => evalExpr('1/0')).toThrow('не является конечным');
  });

  it('недопустимый символ', () => {
    expect(() => evalExpr('2 @ 3')).toThrow('Недопустимый символ');
  });
});

describe('safeEvalExpr — не бросает исключений', () => {
  it('валидное выражение', () => {
    const r = safeEvalExpr('2*x', { x: 5 });
    expect(r).toEqual({ ok: true, value: 10 });
  });

  it('битое выражение — ошибка текстом', () => {
    const r = safeEvalExpr('2*', {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
  });
});

describe('numericEquals — допуск', () => {
  it('в пределах допуска', () => {
    expect(numericEquals(3.1415, Math.PI, 0.01)).toBe(true);
    expect(numericEquals(3.2, Math.PI, 0.01)).toBe(false);
  });

  it('относительный допуск для больших чисел (0.1%)', () => {
    expect(numericEquals(1_000_050, 1_000_000, 0)).toBe(true); // 50 < 1000
    expect(numericEquals(1_001_100, 1_000_000, 0)).toBe(false); // 1100 > 1000
  });
});

describe('parseUserNumber — ввод пользователя', () => {
  it('принимает запятую как десятичный разделитель', () => {
    expect(parseUserNumber('3,14')).toBeCloseTo(3.14, 12);
  });

  it('принимает пробелы и экспоненту', () => {
    expect(parseUserNumber(' 1 000 ')).toBe(1000);
    expect(parseUserNumber('2e3')).toBe(2000);
    expect(parseUserNumber('-1.5')).toBe(-1.5);
  });

  it('отклоняет мусор', () => {
    expect(parseUserNumber('abc')).toBeNull();
    expect(parseUserNumber('')).toBeNull();
    expect(parseUserNumber('12,3,4')).toBeNull();
    expect(parseUserNumber('--5')).toBeNull();
  });
});

describe('normalizeText — сравнение exact-ответов', () => {
  it('регистр и ё/е не различаются', () => {
    expect(normalizeText('Ёлка')).toBe(normalizeText('елка'));
  });

  it('кавычки и пунктуация вычищаются', () => {
    expect(normalizeText('«Привет», мир!')).toBe(normalizeText('привет мир'));
  });

  it('пробелы схлопываются', () => {
    expect(normalizeText('  много    пробелов ')).toBe('много пробелов');
  });
});
