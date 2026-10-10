import { describe, expect, it } from 'vitest';
import { buildTasksFromGenerated, nodesWithoutTasks } from '@/lib/task-gen';
import type { GeneratedTasks } from '@/lib/llm-ops';
import type { IdeaNode, Task } from '@/lib/types';

function node(id: string): IdeaNode {
  return {
    id,
    materialId: 'm1',
    regionId: 'r1',
    title: `Идея ${id}`,
    formulation: 'суть',
    example: 'пример',
    feynmanQuestion: 'вопрос?',
    keyTerms: [],
    orderIndex: 0,
    createdAt: new Date(),
  };
}

function task(id: string, nodeId: string): Task {
  return {
    id,
    nodeId,
    materialId: 'm1',
    type: 'exact',
    prompt: 'условие',
    answerSpec: { kind: 'exact', value: 'ответ', alts: [] },
    explanation: '',
    hints: [],
    orderIndex: 0,
    createdAt: new Date(),
  };
}

describe('nodesWithoutTasks', () => {
  it('оставляет только узлы без задач', () => {
    const nodes = [node('a'), node('b'), node('c')];
    const tasks = [task('t1', 'a'), task('t2', 'c')];
    expect(nodesWithoutTasks(nodes, tasks).map((n) => n.id)).toEqual(['b']);
  });

  it('без задач — все узлы; без узлов — пусто', () => {
    expect(nodesWithoutTasks([node('a'), node('b')], [])).toHaveLength(2);
    expect(nodesWithoutTasks([], [task('t1', 'a')])).toEqual([]);
  });
});

describe('buildTasksFromGenerated', () => {
  it('маппинг полей: nodeId/materialId, сквозной orderIndex, уникальные id', () => {
    const gen: GeneratedTasks = {
      tasks: [
        {
          type: 'choice',
          prompt: 'Сколько будет 2+2?',
          options: ['4', '5'],
          correctIndex: 0,
          hints: ['считай'],
          explanation: 'арифметика',
        },
        {
          type: 'exact',
          prompt: 'Назови число',
          value: '4',
          hints: [],
          explanation: '',
        },
      ],
    };
    const { rows, broken } = buildTasksFromGenerated(gen, node('n1'), 5);
    expect(rows).toHaveLength(2);
    expect(broken).toBe(0);
    expect(rows[0].nodeId).toBe('n1');
    expect(rows[0].materialId).toBe('m1');
    expect(rows[0].orderIndex).toBe(5);
    expect(rows[1].orderIndex).toBe(6);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows[0].answerSpec).toEqual({ kind: 'choice', options: ['4', '5'], correctIndex: 0 });
  });

  it('эссе без ключевых пунктов считается битым (taskProblems), но не роняет преобразование', () => {
    const gen: GeneratedTasks = {
      tasks: [
        { type: 'essay', prompt: 'Объясни', hints: [], explanation: '' },
        { type: 'exact', prompt: 'Число', value: '7', hints: [], explanation: '' },
      ],
    };
    const { rows, broken } = buildTasksFromGenerated(gen, node('n1'), 0);
    expect(rows).toHaveLength(2);
    expect(broken).toBe(1);
  });

  it('мусорные типы LLM деградируют в exact (не падаем)', () => {
    const gen = {
      tasks: [{ type: 'weird' as unknown as 'exact', prompt: 'x', value: '1', hints: [], explanation: '' }],
    };
    const { rows } = buildTasksFromGenerated(gen, node('n1'), 0);
    expect(rows[0].type).toBe('exact');
  });
});
