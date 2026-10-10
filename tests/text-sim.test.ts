import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { containment, contentWords, essayDuplicatesFeynman, ESSAY_DUPLICATE_THRESHOLD } from '@/lib/text-sim';

/**
 * Пары «эссе vs феймановский вопрос» — РЕАЛЬНЫЕ, из экспортированного курса
 * матанализа (upload/edu-game-course-matanfull-…). Фикстуру генерирует
 * scripts/gen_sim_fixture.mjs; порог 0.55 откалиброван по этому курсу:
 * дословные/перефразированные дубликаты 0.75–0.84, разные вопросы ≤ 0.53.
 */
interface SimPair {
  essay: string;
  feynman: string;
  title: string;
  sim: number;
  expect: boolean;
}
const fixture: { source: string; pairs: SimPair[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'essay-pairs.json'), 'utf-8')
);

describe('contentWords', () => {
  it('нижний регистр, ё→е, пунктуация и LaTeX-доллары не мешают', () => {
    expect(contentWords('Ёлка, ЁЖИК!')).toEqual(new Set(['елка', 'ежик']));
  });

  it('короткие обрывки ($x^2$ → «x», «2») и слова <3 символов отбрасываются', () => {
    expect(contentWords('на и в пределе $x^2$')).toEqual(new Set(['пределе']));
  });

  it('пустая строка — пустой словарь', () => {
    expect(contentWords('   ').size).toBe(0);
  });
});

describe('containment', () => {
  it('идентичные тексты → 1', () => {
    expect(containment('объясни суть идеи', 'Объясни суть идеи!')).toBe(1);
  });

  it('без общих слов → 0', () => {
    expect(containment('красная таблица', 'синий стул')).toBe(0);
  });

  it('подмножество полностью покрыто → 1 (не штрафуем за длину второго текста)', () => {
    expect(containment('нижняя грань', 'нижняя грань множества и его минимум')).toBe(1);
  });

  it('частичное покрытие — доля словаря меньшего', () => {
    // меньший словарь {нижняя, грань, предел}: покрыты 2 из 3
    expect(containment('нижняя грань предел', 'нижняя грань окрестность')).toBeCloseTo(2 / 3, 5);
  });

  it('пустой аргумент → 0 (без деления на ноль)', () => {
    expect(containment('', 'текст')).toBe(0);
    expect(containment('текст', '')).toBe(0);
  });
});

describe('essayDuplicatesFeynman на реальных парах курса матанализа', () => {
  it(`фикстура из курса: ${fixture.source}`, () => {
    expect(fixture.pairs.length).toBeGreaterThanOrEqual(5);
  });

  for (const p of fixture.pairs) {
    it(`«${p.title}» (sim≈${p.sim.toFixed(2)}) → ${p.expect ? 'дубликат' : 'не дубликат'}`, () => {
      expect(essayDuplicatesFeynman(p.essay, p.feynman)).toBe(p.expect);
    });
  }

  it('порог лежит между реальными дубликатами (≥0.75) и недубликатами (≤0.53)', () => {
    const sims = fixture.pairs.map((p) => p.sim);
    const dups = sims.filter((s) => s >= 0.7);
    const nonDups = sims.filter((s) => s < 0.55);
    expect(dups.length).toBeGreaterThanOrEqual(3);
    expect(nonDups.length).toBeGreaterThanOrEqual(2);
    expect(ESSAY_DUPLICATE_THRESHOLD).toBeGreaterThan(Math.max(...nonDups));
    expect(ESSAY_DUPLICATE_THRESHOLD).toBeLessThan(Math.min(...dups));
  });

  it('пустые строки — не дубликат', () => {
    expect(essayDuplicatesFeynman('', 'вопрос')).toBe(false);
    expect(essayDuplicatesFeynman('эссе', '   ')).toBe(false);
  });
});
