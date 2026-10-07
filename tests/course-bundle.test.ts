import { describe, it, expect } from 'vitest';
import {
  remapCoursePayload,
  parseCoursePayload,
  courseFileName,
  type RemappedCourse,
} from '@/lib/course-bundle';
import type { CoursePayload, IdeaEdge, IdeaNode, Material, Region, Task } from '@/lib/types';

// ============ Фабрики записей курса ============

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function mat(overrides: Partial<Material> = {}): Material {
  return {
    id: nextId('m'),
    title: 'Карта',
    parentId: null,
    orderIndex: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function region(materialId: string, orderIndex = 0): Region {
  return { id: nextId('r'), materialId, title: 'Глава', orderIndex };
}

function node(materialId: string, regionId: string, overrides: Partial<IdeaNode> = {}): IdeaNode {
  return {
    id: nextId('n'),
    materialId,
    regionId,
    title: 'Идея',
    formulation: 'Суть идеи',
    example: 'Пример',
    feynmanQuestion: 'Объясни своими словами',
    keyTerms: ['термин'],
    orderIndex: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function edge(materialId: string, fromNodeId: string, toNodeId: string): IdeaEdge {
  return { id: nextId('e'), materialId, fromNodeId, toNodeId, kind: 'hard' };
}

function task(materialId: string, nodeId: string): Task {
  return {
    id: nextId('t'),
    materialId,
    nodeId,
    type: 'exact',
    prompt: 'Вопрос?',
    answerSpec: { kind: 'exact', value: '42' },
    explanation: 'Разбор',
    hints: ['Подсказка'],
    orderIndex: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

function payload(overrides: Partial<CoursePayload> = {}): CoursePayload {
  const root = mat({ title: 'Корень' });
  const child = mat({ title: 'Вложенная', parentId: root.id, orderIndex: 1 });
  const r1 = region(root.id);
  const r2 = region(child.id);
  const n1 = node(root.id, r1.id);
  const n2 = node(child.id, r2.id);
  return {
    app: 'edu_game',
    kind: 'course',
    version: 1,
    bundleId: 'bundle-1',
    exportedAt: '2026-01-01T00:00:00.000Z',
    title: 'Корень',
    materials: [root, child],
    regions: [r1, r2],
    nodes: [n1, n2],
    edges: [edge(root.id, n1.id, n2.id)],
    tasks: [task(root.id, n1.id)],
    ...overrides,
  };
}

// ============ Ремап ============

describe('remapCoursePayload — согласованность ссылок', () => {
  const out: RemappedCourse = remapCoursePayload(payload());

  it('все id новые (копия, а не перезапись)', () => {
    const src = payload();
    for (const m of src.materials) {
      expect(out.materials.some((x) => x.id === m.id)).toBe(false);
    }
    for (const n of src.nodes) {
      expect(out.nodes.some((x) => x.id === n.id)).toBe(false);
    }
  });

  it('дерево карт сохраняется: parentId указывает на нового родителя', () => {
    expect(out.materials).toHaveLength(2);
    const newRoot = out.materials.find((m) => m.title === 'Корень')!;
    const newChild = out.materials.find((m) => m.title === 'Вложенная')!;
    expect(newRoot.parentId).toBeNull();
    expect(newChild.parentId).toBe(newRoot.id);
  });

  it('узлы перепривязаны к новым materialId/regionId', () => {
    const matIds = new Set(out.materials.map((m) => m.id));
    const regIds = new Set(out.regions.map((r) => r.id));
    for (const n of out.nodes) {
      expect(matIds.has(n.materialId)).toBe(true);
      expect(regIds.has(n.regionId)).toBe(true);
    }
  });

  it('рёбра ссылаются на новые узлы той же карты', () => {
    expect(out.edges).toHaveLength(1);
    const nodeIds = new Set(out.nodes.map((n) => n.id));
    for (const e of out.edges) {
      expect(nodeIds.has(e.fromNodeId)).toBe(true);
      expect(nodeIds.has(e.toNodeId)).toBe(true);
    }
  });

  it('задачи ссылаются на новые узлы', () => {
    expect(out.tasks).toHaveLength(1);
    const nodeIds = new Set(out.nodes.map((n) => n.id));
    for (const t of out.tasks) {
      expect(nodeIds.has(t.nodeId)).toBe(true);
    }
  });

  it('даты оживают из ISO-строк (пакет пришёл из JSON-файла)', () => {
    const fromJson = remapCoursePayload(
      JSON.parse(JSON.stringify(payload())) as CoursePayload
    );
    for (const m of fromJson.materials) expect(m.createdAt).toBeInstanceOf(Date);
    for (const n of fromJson.nodes) expect(n.createdAt).toBeInstanceOf(Date);
    for (const t of fromJson.tasks) expect(t.createdAt).toBeInstanceOf(Date);
  });
});

describe('remapCoursePayload — мусор и висячие ссылки', () => {
  it('узел с чужим materialId отбрасывается', () => {
    const p = payload();
    const ghost = node('материал-вне-комплекта', p.regions[0].id);
    const out = remapCoursePayload({ ...p, nodes: [...p.nodes, ghost] });
    expect(out.nodes).toHaveLength(2);
  });

  it('узел с потерянным regionId перепривязывается к первому региону карты', () => {
    const p = payload();
    const orphan = node(p.materials[0].id, 'регион-вне-комплекта', { title: 'Сирота' });
    const out = remapCoursePayload({ ...p, nodes: [...p.nodes, orphan] });
    expect(out.nodes).toHaveLength(3);
    const rootNew = out.materials.find((m) => m.title === 'Корень')!;
    const firstRegionOfRoot = out.regions.find((r) => r.materialId === rootNew.id)!;
    const moved = out.nodes.find((n) => n.title === orphan.title)!;
    expect(moved.regionId).toBe(firstRegionOfRoot.id);
  });

  it('регион чужой карты отбрасывается', () => {
    const p = payload();
    const ghostRegion = region('материал-вне-комплекта');
    const out = remapCoursePayload({ ...p, regions: [...p.regions, ghostRegion] });
    expect(out.regions).toHaveLength(2);
  });

  it('ребро с узлами вне комплекта отбрасывается', () => {
    const p = payload();
    const ghostEdge = edge(p.materials[0].id, 'узел-вне-комплекта-1', 'узел-вне-комплекта-2');
    const out = remapCoursePayload({ ...p, edges: [...p.edges, ghostEdge] });
    expect(out.edges).toHaveLength(1);
  });

  it('задача чужого узла отбрасывается', () => {
    const p = payload();
    const ghostTask = task(p.materials[0].id, 'узел-вне-комплекта');
    const out = remapCoursePayload({ ...p, tasks: [...p.tasks, ghostTask] });
    expect(out.tasks).toHaveLength(1);
  });

  it('родитель вне комплекта (экспорт подмножества) — карта становится корневой', () => {
    const p = payload();
    const child = p.materials[1];
    const out = remapCoursePayload({ ...p, materials: [child] });
    expect(out.materials).toHaveLength(1);
    expect(out.materials[0].parentId).toBeNull();
  });
});

// ============ parseCoursePayload ============

describe('parseCoursePayload', () => {
  it('валидный пакет проходит', () => {
    const p = payload();
    const parsed = parseCoursePayload(JSON.stringify(p));
    expect(parsed.title).toBe('Корень');
  });

  it('не-JSON — понятная ошибка', () => {
    expect(() => parseCoursePayload('{битый')).toThrow('не является корректным JSON');
  });

  it('чужой формат — понятная ошибка', () => {
    expect(() => parseCoursePayload('{"app": "другое"}')).toThrow('Неверный формат');
  });

  it('нет списка идей — ошибка о повреждении', () => {
    const p = payload() as unknown as Record<string, unknown>;
    delete p.nodes;
    expect(() => parseCoursePayload(JSON.stringify(p))).toThrow('повреждён');
  });

  it('пустой список карт — ошибка', () => {
    const p = payload();
    expect(() => parseCoursePayload(JSON.stringify({ ...p, materials: [] }))).toThrow(
      'нет ни одной карты'
    );
  });
});

// ============ courseFileName ============

describe('courseFileName', () => {
  it('транслитерация и дата', () => {
    const name = courseFileName('Квадратные уравнения');
    expect(name).toMatch(/^edu-game-course-kvadratnye-uravneniya-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('пустое название — заглушка course', () => {
    expect(courseFileName('?!')).toMatch(/^edu-game-course-course-\d{4}-\d{2}-\d{2}\.json$/);
  });
});
