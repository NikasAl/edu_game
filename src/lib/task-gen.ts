/**
 * Догенерация задач LLM для узлов, оставшихся без задач («непроходимых»).
 *
 * Проблема: после импорта часть узлов не получает задач (сбой генерации или
 * LLM вернула пустой план) — такой узел нельзя завершить (гейт освоения
 * требует хотя бы одну пройденную задачу), и вместе с hard-рёбрами он запирает
 * весь низ карты. Раньше каждый такой узел чинлся вручную: открыть узел →
 * редактор → «Сгенерировать». Здесь — один обход списка узлов одной кнопкой.
 *
 * Безопасность: пишутся только задачи (попытки/прогресс не трогаются), узлы,
 * у которых задачи появились во время обхода, пропускаются — повторный запуск
 * не создаёт дубликатов.
 */
import { db } from './db';
import { genTasksForAtom, generatedToTask, type GeneratedTasks } from './llm-ops';
import { taskProblems } from './task-engine';
import type { IdeaNode, LLMProvider, Task } from './types';

/** Узлы материала, у которых нет ни одной задачи из переданного списка */
export function nodesWithoutTasks(nodes: IdeaNode[], tasks: Task[]): IdeaNode[] {
  const has = new Set(tasks.map((t) => t.nodeId));
  return nodes.filter((n) => !has.has(n.id));
}

/** Ответ генератора → строки БД (новые id, нумерация с startOrder) + счётчик битых */
export function buildTasksFromGenerated(
  gen: GeneratedTasks,
  node: IdeaNode,
  startOrder: number
): { rows: Task[]; broken: number } {
  const rows = gen.tasks.map((g, i) =>
    generatedToTask(g, {
      id: crypto.randomUUID(),
      nodeId: node.id,
      materialId: node.materialId,
      orderIndex: startOrder + i,
    })
  );
  return { rows, broken: rows.filter((t) => taskProblems(t).length > 0).length };
}

export interface BatchGenResult {
  generated: number; // узлам добавлены задачи
  skipped: number; // задачи появились во время обхода — не тронуты
  failed: number; // генерация не удалась (LLM/сеть)
  tasksAdded: number; // всего записано задач
  brokenTasks: number; // из них с невалидным answerSpec (правятся в редакторе)
  failedTitles: string[]; // названия не удавшихся узлов
}

/**
 * Сгенерировать комплект задач каждому узлу списка (по одному LLM-вызову).
 * isCancelled проверяется между узлами: остановка не откатывает сделанное.
 * Небольшая пауза между узлами смягчает rate-limit провайдера.
 */
export async function generateTasksForNodes(
  provider: LLMProvider,
  nodes: IdeaNode[],
  opts: {
    onProgress?: (msg: string) => void;
    isCancelled?: () => boolean;
    pauseMs?: number;
  } = {}
): Promise<BatchGenResult> {
  const res: BatchGenResult = { generated: 0, skipped: 0, failed: 0, tasksAdded: 0, brokenTasks: 0, failedTitles: [] };
  const pauseMs = opts.pauseMs ?? 700;
  for (let i = 0; i < nodes.length; i++) {
    if (opts.isCancelled?.()) break;
    const node = nodes[i];
    opts.onProgress?.(`Генерация задач ${i + 1}/${nodes.length}: «${node.title}»…`);
    try {
      const existing = await db.tasks.where('nodeId').equals(node.id).count();
      if (existing > 0) {
        res.skipped++;
        continue;
      }
      const gen = await genTasksForAtom(
        provider,
        {
          title: node.title,
          formulation: node.formulation,
          example: node.example,
          atomKind: node.atomKind,
          misconception: node.misconception,
          code: node.code,
        },
        node.sourceRef
      );
      const { rows, broken } = buildTasksFromGenerated(gen, node, 0);
      await db.tasks.bulkPut(rows);
      res.generated++;
      res.tasksAdded += rows.length;
      res.brokenTasks += broken;
      if (!node.feynmanQuestion.trim() && gen.feynmanQuestion) {
        await db.nodes.update(node.id, { feynmanQuestion: gen.feynmanQuestion });
      }
    } catch {
      res.failed++;
      res.failedTitles.push(node.title);
    }
    if (i < nodes.length - 1) await new Promise((r) => setTimeout(r, pauseMs));
  }
  return res;
}
