import { describe, it, expect } from 'vitest';
import { gradeEssayLocal, gradeFeynmanLocal } from '@/lib/llm-ops';

// Смягчённые локальные рубрики (пункт 4 продуктового анализа):
// суть важнее дословных формулировок.

describe('gradeEssayLocal — смягчённый порог 60%', () => {
  const expectation = [
    'производная это скорость изменения функции',
    'геометрический смысл это наклон касательной',
    'производная константы равна нулю',
  ];

  it('раскрыто 2 из 3 пунктов (~67%) — зачёт (раньше был провал при 70%)', () => {
    const answer =
      'Производная показывает скорость изменения функции. А ещё это наклон касательной к графику в точке.';
    const g = gradeEssayLocal(expectation, answer);
    expect(g.score).toBeCloseTo(2 / 3, 5);
    expect(g.verdict).toBe('pass');
  });

  it('раскрыт 1 из 3 пунктов (~33%) — провал', () => {
    const answer = 'Производная это скорость изменения функции, и всё.';
    expect(gradeEssayLocal(expectation, answer).verdict).toBe('fail');
  });
});

describe('gradeFeynmanLocal — смягчённый зачёт', () => {
  const node = {
    title: 'Производная',
    formulation: 'Производная — скорость изменения функции в точке.',
    sourceQuote: 'Производная — скорость изменения функции в точке. Геометрически — наклон касательной.',
    keyTerms: ['скорость изменения', 'касательной'],
  };

  it('мелкая неточность (accuracy=1) при раскрытой сути — зачёт', () => {
    // короткий осмысленный текст (< 80 знаков нормализованных) → accuracy = 1
    const answer = 'Производная — это примерно скорость изменения функции';
    const g = gradeFeynmanLocal(node, answer);
    expect(g.accuracy).toBe(1);
    expect(g.completeness).toBeGreaterThanOrEqual(1);
    expect(g.verdict).toBe('pass');
  });

  it('дословный пересказ эталона не проваливает (ownWords=0), но остаётся замечанием', () => {
    const answer =
      'Производная — это скорость изменения функции в точке. Геометрически это наклон касательной к графику. Например, если тело едет, производная пути — это скорость.';
    const g = gradeFeynmanLocal(node, answer);
    expect(g.ownWords).toBe(0);
    expect(g.accuracy).toBe(2);
    expect(g.completeness).toBe(2);
    expect(g.verdict).toBe('pass');
    expect(g.feedback).toContain('своими словами');
  });

  it('не названы ключевые компоненты — провал', () => {
    const answer =
      'Ну, это такая штука из матанализа, которую проходят в школе на алгебре, и она вроде как что-то дифференцирует.';
    const g = gradeFeynmanLocal(node, answer);
    expect(g.completeness).toBe(0);
    expect(g.verdict).toBe('fail');
  });

  it('слишком короткий ответ — провал с подсказкой развернуть', () => {
    const g = gradeFeynmanLocal(node, 'производная это скорость');
    expect(g.verdict).toBe('fail');
    expect(g.feedback).toContain('Слишком коротко');
  });
});
