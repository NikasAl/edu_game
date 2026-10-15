import { describe, it, expect } from 'vitest';
import { safeEvalExpr } from '@/lib/safeMath';
import { remapCoursePayload } from '@/lib/course-bundle';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Проверка предустановленного курса Фейнмана настоящим кодом приложения:
 * 1) numeric-expr считаются safeEvalExpr при всех комбинациях choices;
 * 2) remapCoursePayload (путь importCoursePayload → preinstall) переносит
 *    ВСЁ содержимое без потерь и без висячих ссылок.
 */
describe('preinstalled feynman course — numeric exprs', () => {
  const file = join(process.cwd(), 'public/preinstalled/edu-game-course-metod-bloknota-feynmana-2026-10-15.json');
  const course = JSON.parse(readFileSync(file, 'utf8')) as {
    tasks: { id: string; type: string; answerSpec: { kind: string; expr?: string }; params?: { name: string; choices: number[] }[] }[];
  };

  const numerics = course.tasks.filter((t) => t.type === 'numeric');

  it('все numeric-задачи присутствуют', () => {
    expect(numerics.length).toBe(7);
  });

  for (const t of numerics) {
    it(`${t.id}: ${t.answerSpec.expr}`, () => {
      const params = t.params ?? [];
      const values = Object.fromEntries(params.map((p) => [p.name, p.choices[0]]));
      const r = safeEvalExpr(t.answerSpec.expr!, values);
      expect(r.ok, `expr не вычислился: ${r.ok ? '' : r.error}`).toBe(true);
      if (r.ok) expect(Number.isFinite(r.value)).toBe(true);
      // все комбинации choices тоже должны считаться (маленькие наборы)
      if (params.length <= 3) {
        const combos = params.reduce((acc, p) => acc * p.choices.length, 1);
        for (let mask = 0; mask < combos; mask++) {
          let rest = mask;
          const vals: Record<string, number> = {};
          for (const p of params) {
            const idx = rest % p.choices.length;
            rest = Math.floor(rest / p.choices.length);
            vals[p.name] = p.choices[idx];
          }
          const rr = safeEvalExpr(t.answerSpec.expr!, vals);
          expect(rr.ok, `комбинация ${JSON.stringify(vals)}: ${rr.ok ? '' : rr.error}`).toBe(true);
        }
      }
    });
  }
});

describe('preinstalled feynman course — remapCoursePayload', () => {
  const file = join(process.cwd(), 'public/preinstalled/edu-game-course-metod-bloknota-feynmana-2026-10-15.json');
  const raw = readFileSync(file, 'utf8');
  const course = JSON.parse(raw) as Parameters<typeof remapCoursePayload>[0] & {
    materials: { sourceText?: string }[];
  };

  const r = remapCoursePayload(course);

  it('переносит всё содержимое без потерь', () => {
    expect(r.materials).toHaveLength(course.materials.length);
    expect(r.regions).toHaveLength(course.regions.length);
    expect(r.nodes).toHaveLength(course.nodes.length);
    expect(r.edges).toHaveLength(course.edges.length);
    expect(r.tasks).toHaveLength(course.tasks.length);
  });

  it('не оставляет висячих ссылок', () => {
    const mats = new Set(r.materials.map((m) => m.id));
    const regs = new Set(r.regions.map((x) => x.id));
    const nodes = new Set(r.nodes.map((n) => n.id));
    for (const n of r.nodes) {
      expect(mats.has(n.materialId), `узел ${n.id}: materialId`).toBe(true);
      expect(regs.has(n.regionId), `узел ${n.id}: regionId`).toBe(true);
    }
    for (const e of r.edges) {
      expect(mats.has(e.materialId)).toBe(true);
      expect(nodes.has(e.fromNodeId)).toBe(true);
      expect(nodes.has(e.toNodeId)).toBe(true);
    }
    for (const t of r.tasks) {
      expect(mats.has(t.materialId)).toBe(true);
      expect(nodes.has(t.nodeId)).toBe(true);
    }
  });

  it('узел связан с библиотекой текстов device-local — savedTextId не переносится', () => {
    for (const n of r.nodes) expect(n.savedTextId).toBeUndefined();
  });

  it('эссе-зеркала: containment(эссе, feynmanQuestion) >= 0.55 у всех эссе', async () => {
    const { essayDuplicatesFeynman } = await import('@/lib/text-sim');
    const fq = new Map(r.nodes.map((n) => [n.id, n.feynmanQuestion]));
    const essays = r.tasks.filter((t) => t.type === 'essay');
    expect(essays.length).toBe(5);
    for (const t of essays) {
      expect(essayDuplicatesFeynman(t.prompt, fq.get(t.nodeId) ?? ''),
        `эссе ${t.id} не зеркало`).toBe(true);
    }
  });
});
