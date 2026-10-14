import { describe, expect, it } from 'vitest';
import { orderedMaterialsDfs } from '@/lib/maps';
import type { Material } from '@/lib/types';

function mat(id: string, parentId: string | null, orderIndex: number): Material {
  return {
    id,
    title: id,
    parentId,
    orderIndex,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

describe('orderedMaterialsDfs', () => {
  it('идёт по дереву: ребёнок сразу после родителя, а не после чужих корней', () => {
    // раньше плоская сортировка по глубине давала [a, c, b] — b уезжала в конец
    const materials = [mat('a', null, 0), mat('c', null, 1), mat('b', 'a', 0)];
    const ordered = orderedMaterialsDfs(materials).map((m) => m.id);
    expect(ordered).toEqual(['a', 'b', 'c']);
  });

  it('сортирует детей по orderIndex и обходит вложенность на любую глубину', () => {
    const materials = [
      mat('root', null, 0),
      mat('k2', 'root', 1),
      mat('k1', 'root', 0),
      mat('g1', 'k1', 0),
      mat('gg', 'g1', 0),
    ];
    const ordered = orderedMaterialsDfs(materials).map((m) => m.id);
    expect(ordered).toEqual(['root', 'k1', 'g1', 'gg', 'k2']);
  });

  it('при равном orderIndex сортирует по createdAt', () => {
    const a = mat('a', null, 0);
    const b = mat('b', null, 0);
    b.createdAt = new Date('2026-02-01T00:00:00Z');
    expect(orderedMaterialsDfs([b, a]).map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('не теряет карты, недостижимые от корня (цикл/висячий parentId)', () => {
    const a = mat('a', null, 0);
    const x = mat('x', 'y', 0); // y не существует
    const y = mat('y', 'x', 1); // цикл x ↔ y
    const ordered = orderedMaterialsDfs([y, x, a]).map((m) => m.id);
    expect(ordered).toEqual(['a', 'x', 'y']);
  });

  it('пустой список → пустой результат', () => {
    expect(orderedMaterialsDfs([])).toEqual([]);
  });
});
