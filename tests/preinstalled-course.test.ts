import { describe, it, expect } from 'vitest';
import { safeEvalExpr } from '@/lib/safeMath';
import { remapCoursePayload } from '@/lib/course-bundle';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Проверка предустановленных курсов настоящим кодом приложения.
 * Берём все комплекты из манифеста public/preinstalled/index.json:
 * 1) numeric-expr считаются safeEvalExpr при всех комбинациях choices;
 * 2) remapCoursePayload (путь importCoursePayload → preinstall) переносит
 *    ВСЁ содержимое без потерь и без висячих ссылок.
 * (Эссе-задачи произвольного курса не обязаны быть «зеркалами»
 * feynmanQuestion — это проверялось только в переработанном курсе.)
 */
const dir = join(process.cwd(), 'public/preinstalled');
const manifest = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
  bundles: { file: string }[];
};
const files = manifest.bundles.map((b) => b.file).filter((f) => !f.includes('/') && !f.includes('..'));

describe('preinstalled courses — манифест непуст и читается', () => {
  it('в манифесте есть хотя бы один комплект, и все файлы существуют', () => {
    expect(files.length).toBeGreaterThanOrEqual(1);
    for (const f of files) {
      const course = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      expect(course.app).toBe('edu_game');
      expect(course.kind).toBe('course');
      expect(Array.isArray(course.materials) && course.materials.length > 0).toBe(true);
    }
  });
});

for (const file of files) {
  const course = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
    title: string;
    tasks: {
      id: string;
      type: string;
      prompt: string;
      answerSpec: { kind: string; expr?: string };
      params?: { name: string; choices: number[] }[];
    }[];
    nodes: { id: string; feynmanQuestion: string }[];
  } & Parameters<typeof remapCoursePayload>[0];

  describe(`preinstalled course «${course.title}» (${file}) — numeric exprs`, () => {
    const numerics = course.tasks.filter((t) => t.type === 'numeric');

    it('numeric-задачи присутствуют', () => {
      expect(numerics.length).toBeGreaterThanOrEqual(5);
    });

    for (const t of numerics) {
      it(`${t.id}: ${t.answerSpec.expr}`, () => {
        const params = t.params ?? [];
        const values = Object.fromEntries(params.map((p) => [p.name, p.choices[0]]));
        const r = safeEvalExpr(t.answerSpec.expr!, values);
        expect(r.ok, `expr не вычислился: ${r.ok ? '' : r.error}`).toBe(true);
        if (r.ok) expect(Number.isFinite(r.value)).toBe(true);
        // все комбинации choices тоже должны считаться (до 256 комбинаций)
        const combos = params.reduce((acc, p) => acc * p.choices.length, 1);
        const limit = Math.min(combos, 256);
        for (let mask = 0; mask < limit; mask++) {
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
      });
    }
  });

  describe(`preinstalled course «${course.title}» (${file}) — remapCoursePayload`, () => {
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
  });
}

// защита от расхождения манифеста с файлами: в каталоге не должно быть
// «мусорных» *.json, которых нет в index.json (кроме самого манифеста)
describe('preinstalled dir — манифест покрывает все комплекты', () => {
  it('каждый *.json в каталоге присутствует в index.json', () => {
    const all = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    expect(all.sort()).toEqual([...files].sort());
  });
});
