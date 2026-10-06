'use client';

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  Trash2,
  Wand2,
  XCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import RichText from '@/components/RichText';
import CodeBlock from '@/components/CodeBlock';
import {
  clearTaskDraft,
  db,
  resetNodeProgress,
} from '@/lib/db';
import { useAppStore } from '@/store/useAppStore';
import {
  checkIdeaLLM,
  checkTaskLLM,
  fixIdeaLLM,
  fixTaskLLM,
  genTasksForAtom,
  generatedToTask,
  type CheckReport,
} from '@/lib/llm-ops';
import { evalExpr } from '@/lib/safeMath';
import { instantiateTask, taskProblems } from '@/lib/task-engine';
import type {
  AnswerSpec,
  Attempt,
  IdeaNode,
  LLMProvider,
  Task,
  TaskInstance,
  TaskParam,
  TaskType,
} from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Редактор узла — оверлей над экраном узла.
 * Ручная правка идеи и задач, LLM-проверка корректности,
 * LLM-исправление, генерация задач для «непроходимых» узлов.
 */
export default function NodeEditor() {
  const editNodeId = useAppStore((s) => s.editNodeId);
  if (!editNodeId) return null;
  return <NodeEditorInner key={editNodeId} nodeId={editNodeId} />;
}

function NodeEditorInner({ nodeId }: { nodeId: string }) {
  const closeNodeEditor = useAppStore((s) => s.closeNodeEditor);
  const providers = useAppStore((s) => s.providers);
  const activeProvider = providers.find((p) => p.isActive) ?? null;

  const bundle = useLiveQuery(async () => {
    const node = await db.nodes.get(nodeId);
    if (!node) return null;
    const [region, tasks, attempts] = await Promise.all([
      db.regions.get(node.regionId),
      db.tasks.where('nodeId').equals(nodeId).sortBy('orderIndex'),
      db.attempts.where('nodeId').equals(nodeId).toArray(),
    ]);
    return { node, region, tasks, attempts };
  }, [nodeId]);

  if (!bundle?.node) {
    return (
      <div className="fixed inset-0 z-[60] bg-background">
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    );
  }

  const { node, region, tasks } = bundle;

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background">
      {/* Шапка */}
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Button variant="ghost" size="icon" onClick={closeNodeEditor} aria-label="Назад к узлу">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
              Редактор · {region?.title ?? '—'}
            </p>
            <h1 className="truncate text-base font-semibold">{node.title}</h1>
          </div>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {activeProvider ? `LLM: ${activeProvider.model}` : 'LLM не подключён'}
          </Badge>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto thin-scroll">
        <div className="mx-auto flex max-w-lg flex-col gap-3 px-4 py-4 pb-24">
          <p className="text-xs leading-snug text-muted-foreground">
            Правь элементы узла вручную или доверь их LLM: «Проверить» найдёт ошибки (решая задачу),
            «Исправить» подставит исправленный вариант — после просмотра сохрани.
          </p>
          <IdeaEditor node={node} provider={activeProvider} />
          <TasksEditor node={node} tasks={tasks} attempts={bundle.attempts} provider={activeProvider} />
          <DangerZone node={node} />
        </div>
      </div>
    </div>
  );
}

// ============ Общий отчёт проверки ============

function CheckReportView({ report }: { report: CheckReport }) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3 text-sm',
        report.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5'
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {report.ok ? (
          <>
            <CheckCircle2 className="h-4 w-4 text-emerald-400" />
            <span className="text-emerald-400">Ошибок не найдено</span>
          </>
        ) : (
          <>
            <XCircle className="h-4 w-4 text-amber-400" />
            <span className="text-amber-400">Найдены проблемы</span>
          </>
        )}
      </div>
      {report.problems.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-amber-200/90">
          {report.problems.map((p, i) => (
            <li key={i}>
              <RichText>{p}</RichText>
            </li>
          ))}
        </ul>
      )}
      {report.feedback && (
        <p className="mt-2 text-xs leading-snug text-muted-foreground">
          <RichText>{report.feedback}</RichText>
        </p>
      )}
    </div>
  );
}

// ============ Редактор идеи ============

function IdeaEditor({ node, provider }: { node: IdeaNode; provider: LLMProvider | null }) {
  const [title, setTitle] = useState(node.title);
  const [formulation, setFormulation] = useState(node.formulation);
  const [example, setExample] = useState(node.example);
  const [misconception, setMisconception] = useState(node.misconception ?? '');
  const [feynmanQuestion, setFeynmanQuestion] = useState(node.feynmanQuestion);
  const [keyTermsText, setKeyTermsText] = useState(node.keyTerms.join(', '));
  const [code, setCode] = useState(node.code ?? '');
  const [busy, setBusy] = useState<'save' | 'check' | 'fix' | null>(null);
  const [report, setReport] = useState<CheckReport | null>(null);

  const keyTerms = keyTermsText
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const dirty =
    title !== node.title ||
    formulation !== node.formulation ||
    example !== node.example ||
    misconception !== (node.misconception ?? '') ||
    feynmanQuestion !== node.feynmanQuestion ||
    keyTermsText !== node.keyTerms.join(', ') ||
    code !== (node.code ?? '');

  const currentNode = () => ({
    title: title.trim() || node.title,
    formulation: formulation.trim(),
    example: example.trim(),
    misconception: misconception.trim() || undefined,
    feynmanQuestion: feynmanQuestion.trim(),
    keyTerms,
    code: code.trim() || undefined,
  });

  const save = async () => {
    if (!title.trim() || !formulation.trim()) {
      toast.error('Название и формулировка не могут быть пустыми');
      return;
    }
    setBusy('save');
    try {
      await db.nodes.update(node.id, {
        title: title.trim(),
        formulation: formulation.trim(),
        example: example.trim(),
        misconception: misconception.trim() || undefined,
        feynmanQuestion: feynmanQuestion.trim(),
        keyTerms,
        code: code.trim() || undefined,
      });
      toast.success('Идея сохранена');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!provider) {
      toast.error('Для проверки нужен LLM-провайдер (Настройки)');
      return;
    }
    setBusy('check');
    setReport(null);
    try {
      setReport(await checkIdeaLLM(provider, currentNode()));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setBusy(null);
    }
  };

  const fix = async () => {
    if (!provider) {
      toast.error('Для исправления нужен LLM-провайдер (Настройки)');
      return;
    }
    if (!formulation.trim() || !example.trim()) {
      toast.error('Заполни формулировку и пример — исправлять нечего');
      return;
    }
    setBusy('fix');
    try {
      const f = await fixIdeaLLM(
        provider,
        currentNode(),
        report && !report.ok ? report.problems : undefined
      );
      setTitle(f.title);
      setFormulation(f.formulation);
      setExample(f.example);
      setMisconception(f.misconception);
      setFeynmanQuestion(f.feynmanQuestion);
      setKeyTermsText(f.keyTerms.join(', '));
      toast.success('Исправление подставлено — проверь и сохрани');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка исправления');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <PencilLine className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Идея</h2>
          {dirty && <Badge variant="secondary" className="text-[10px]">изменено</Badge>}
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Название</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Формулировка (суть одним предложением)</Label>
          <Textarea value={formulation} onChange={(e) => setFormulation(e.target.value)} rows={3} className="resize-none" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Пример</Label>
          <Textarea value={example} onChange={(e) => setExample(e.target.value)} rows={3} className="resize-none" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Частая ошибка (необязательно)</Label>
          <Textarea value={misconception} onChange={(e) => setMisconception(e.target.value)} rows={2} className="resize-none" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Вопрос Фейнмана</Label>
          <Textarea value={feynmanQuestion} onChange={(e) => setFeynmanQuestion(e.target.value)} rows={2} className="resize-none" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Ключевые термины (через запятую)</Label>
          <Input value={keyTermsText} onChange={(e) => setKeyTermsText(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Листинг кода (необязательно; без markdown-обёрток — только сам код)</Label>
          <Textarea value={code} onChange={(e) => setCode(e.target.value)} rows={6} className="resize-none font-mono text-xs" />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={!dirty || busy !== null} className="min-w-32">
            {busy === 'save' ? 'Сохраняем…' : <><Save className="mr-1 h-4 w-4" /> Сохранить</>}
          </Button>
          <Button variant="outline" onClick={check} disabled={busy !== null}>
            {busy === 'check' ? 'Проверяем…' : <><Send className="mr-1 h-4 w-4" /> Проверить</>}
          </Button>
          <Button variant="outline" onClick={fix} disabled={busy !== null}>
            {busy === 'fix' ? 'Исправляем…' : <><Wand2 className="mr-1 h-4 w-4" /> Исправить</>}
          </Button>
        </div>
        {!provider && (
          <p className="text-[11px] text-muted-foreground">
            «Проверить» и «Исправить» требуют LLM-провайдера — подключи его во вкладке «Настройки».
          </p>
        )}

        {report && <CheckReportView report={report} />}
      </CardContent>
    </Card>
  );
}

// ============ Секция задач ============

const TYPE_LABEL: Record<TaskType, string> = {
  numeric: 'числовая',
  exact: 'точный ответ',
  choice: 'выбор варианта',
  essay: 'открытый ответ',
  code_output: 'код: что выведет',
  code_fill: 'код: заполни пропуск',
};

function TasksEditor({
  node,
  tasks,
  attempts,
  provider,
}: {
  node: IdeaNode;
  tasks: Task[];
  attempts: Attempt[];
  provider: LLMProvider | null;
}) {
  const [busyGen, setBusyGen] = useState(false);

  const passedByTask = useMemo(() => {
    const latest = new Map<string, Attempt>();
    for (const a of [...attempts].sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())) {
      if (a.kind === 'task' && a.taskId) latest.set(a.taskId, a);
    }
    return new Map([...latest.entries()].filter(([, a]) => a.verdict === 'pass').map(([id]) => [id, true] as const));
  }, [attempts]);

  const genTasks = async () => {
    if (!provider) {
      toast.error('Для генерации задач нужен LLM-провайдер (Настройки)');
      return;
    }
    setBusyGen(true);
    try {
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
      let i = tasks.length;
      const rows = gen.tasks.map((g) =>
        generatedToTask(g, {
          id: crypto.randomUUID(),
          nodeId: node.id,
          materialId: node.materialId,
          orderIndex: i++,
        })
      );
      await db.tasks.bulkPut(rows);
      if (!node.feynmanQuestion.trim() && gen.feynmanQuestion) {
        await db.nodes.update(node.id, { feynmanQuestion: gen.feynmanQuestion });
      }
      const broken = rows.filter((t) => taskProblems(t).length > 0).length;
      toast.success(
        broken > 0
          ? `Добавлено задач: ${rows.length} · с ошибками: ${broken} — исправь их в карточках ниже`
          : `Добавлено задач: ${rows.length}`
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сгенерировать задачи');
    } finally {
      setBusyGen(false);
    }
  };

  const addManual = async () => {
    const t: Task = {
      id: crypto.randomUUID(),
      nodeId: node.id,
      materialId: node.materialId,
      type: 'exact',
      prompt: '',
      answerSpec: { kind: 'exact', value: '', alts: [] },
      explanation: '',
      hints: [],
      orderIndex: tasks.length,
      createdAt: new Date(),
    };
    await db.tasks.put(t);
    toast('Пустая задача добавлена — заполни её');
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <PencilLine className="h-4 w-4 text-primary" /> Задачи ({tasks.length})
        </h2>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={addManual} disabled={busyGen}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Вручную
          </Button>
          <Button size="sm" onClick={genTasks} disabled={busyGen}>
            {busyGen ? (
              'Генерация…'
            ) : (
              <>
                <Sparkles className="mr-1 h-3.5 w-3.5" /> Сгенерировать
              </>
            )}
          </Button>
        </div>
      </div>

      {tasks.length === 0 && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-amber-300">
            <AlertTriangle className="h-3.5 w-3.5" /> Узел непроходим: нет ни одной задачи
          </p>
          <p className="mt-1 text-amber-200/90">
            Без задач узел нельзя завершить и двигаться дальше. Сгенерируй задачи LLM или добавь вручную,
            заполни условие и ответ.
          </p>
        </div>
      )}

      {tasks.map((t, i) => (
        <TaskEditorCard
          key={t.id}
          task={t}
          index={i}
          node={node}
          provider={provider}
          passed={passedByTask.get(t.id) ?? false}
        />
      ))}
    </section>
  );
}

// ============ Карточка задачи в редакторе ============

function parseParamsJson(json: string): { params?: TaskParam[]; error?: string } {
  const trimmed = json.trim();
  if (!trimmed) return { params: [] };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { error: 'Параметры: невалидный JSON' };
  }
  if (!Array.isArray(data)) return { error: 'Параметры: ожидается массив [ {...}, ... ]' };
  const params: TaskParam[] = [];
  for (const raw of data) {
    const p = raw as { name?: unknown; choices?: unknown };
    if (typeof p?.name !== 'string' || !p.name.trim()) return { error: 'Параметры: у каждого должно быть поле name' };
    if (!Array.isArray(p.choices) || p.choices.length === 0 || !p.choices.every((c) => typeof c === 'number' && Number.isFinite(c))) {
      return { error: `Параметры: «${p.name}» — choices должен быть непустым списком чисел` };
    }
    params.push({ name: p.name.trim(), choices: p.choices });
  }
  return { params };
}

/** Проверить, что expr вычисляется на наборе значений параметров (до 32 комбинаций) */
function validateExprSamples(params: TaskParam[], expr: string): string | null {
  const combos: Record<string, number>[] = [];
  const total = params.reduce((acc, p) => acc * p.choices.length, 1);
  if (params.length === 0) {
    combos.push({});
  } else if (total <= 32) {
    const rec = (i: number, acc: Record<string, number>) => {
      if (i === params.length) {
        combos.push({ ...acc });
        return;
      }
      for (const c of params[i].choices) rec(i + 1, { ...acc, [params[i].name]: c });
    };
    rec(0, {});
  } else {
    for (let k = 0; k < 32; k++) {
      const acc: Record<string, number> = {};
      for (const p of params) acc[p.name] = p.choices[Math.floor(Math.random() * p.choices.length)];
      combos.push(acc);
    }
  }
  for (const vars of combos) {
    try {
      evalExpr(expr, vars);
    } catch (e) {
      return e instanceof Error ? e.message : 'Выражение не вычисляется';
    }
  }
  return null;
}

/** Детерминированный экземпляр (первые значения choices) — для LLM-проверки */
function makeSampleInstance(t: Task): TaskInstance {
  const values: Record<string, number> = {};
  for (const p of t.params ?? []) values[p.name] = p.choices[0];
  const renderedPrompt = t.prompt.replace(/\{\{\s*([a-zA-Z_][a-zA-Z_0-9]*)\s*\}\}/g, (_, name: string) =>
    name in values ? String(values[name]) : `{{${name}}}`
  );
  const spec = t.answerSpec;
  let answer: number | string = '';
  if (spec.kind === 'numeric') answer = evalExpr(spec.expr, values);
  else if (spec.kind === 'exact') answer = spec.value;
  else if (spec.kind === 'choice') answer = String(spec.correctIndex);
  else if (spec.kind === 'code') answer = spec.value;
  else answer = spec.expectation.join('; ');
  return { taskId: t.id, values, renderedPrompt, answer };
}

const NO_REPORT: CheckReport | null = null;

function TaskEditorCard({
  task,
  index,
  node,
  provider,
  passed,
}: {
  task: Task;
  index: number;
  node: IdeaNode;
  provider: LLMProvider | null;
  passed: boolean;
}) {
  const [open, setOpen] = useState(() => !task.prompt);
  const [prompt, setPrompt] = useState(task.prompt);
  const [type, setType] = useState<TaskType>(task.type);
  const [expr, setExpr] = useState(task.answerSpec.kind === 'numeric' ? task.answerSpec.expr : '');
  const [tolerance, setTolerance] = useState(
    String(task.answerSpec.kind === 'numeric' ? task.answerSpec.tolerance ?? 0.02 : 0.02)
  );
  const [paramsJson, setParamsJson] = useState(task.params ? JSON.stringify(task.params) : '[]');
  const [value, setValue] = useState(task.answerSpec.kind === 'exact' ? task.answerSpec.value : '');
  const [alts, setAlts] = useState(
    task.answerSpec.kind === 'exact' ? (task.answerSpec.alts ?? []).join('; ') : ''
  );
  const [optionsText, setOptionsText] = useState(
    task.answerSpec.kind === 'choice' ? task.answerSpec.options.join('\n') : ''
  );
  const [correctIndex, setCorrectIndex] = useState(
    task.answerSpec.kind === 'choice' ? task.answerSpec.correctIndex : 0
  );
  const [expectationText, setExpectationText] = useState(
    task.answerSpec.kind === 'essay' ? task.answerSpec.expectation.join('\n') : ''
  );
  const [codeText, setCodeText] = useState(task.code ?? '');
  const [hint1, setHint1] = useState(task.hints[0] ?? '');
  const [hint2, setHint2] = useState(task.hints[1] ?? '');
  const [explanation, setExplanation] = useState(task.explanation);
  const [busy, setBusy] = useState<'save' | 'check' | 'fix' | null>(null);
  const [report, setReport] = useState<CheckReport | null>(NO_REPORT);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reroll, setReroll] = useState(0);

  const spec = useMemo<{ spec: AnswerSpec; params: { params?: TaskParam[]; error?: string } }>(() => {
    if (type === 'numeric') {
      const tol = Number.parseFloat(tolerance.replace(',', '.'));
      return {
        spec: { kind: 'numeric', expr: expr.trim(), tolerance: Number.isFinite(tol) ? Math.abs(tol) : 0.02 } as AnswerSpec,
        params: parseParamsJson(paramsJson),
      };
    }
    if (type === 'exact') {
      return {
        spec: { kind: 'exact', value: value.trim(), alts: alts.split(';').map((s) => s.trim()).filter(Boolean) } as AnswerSpec,
        params: {},
      };
    }
    if (type === 'code_output' || type === 'code_fill') {
      return {
        spec: { kind: 'code', value: value.trim(), alts: alts.split(';').map((s) => s.trim()).filter(Boolean) } as AnswerSpec,
        params: {},
      };
    }
    if (type === 'essay') {
      const expectation = expectationText.split('\n').map((s) => s.trim()).filter(Boolean);
      return {
        spec: { kind: 'essay', expectation } as AnswerSpec,
        params: {},
      };
    }
    const options = optionsText.split('\n').map((s) => s.trim()).filter(Boolean);
    return {
      spec: {
        kind: 'choice',
        options,
        correctIndex: Math.min(Math.max(0, correctIndex), Math.max(0, options.length - 1)),
      } as AnswerSpec,
      params: {},
    };
  }, [type, expr, tolerance, paramsJson, value, alts, optionsText, correctIndex, expectationText]);

  /** Черновик задачи + строка ошибки валидации (null — ок) */
  const draft = useMemo(() => {
    const problem: string[] = [];
    if (!prompt.trim()) problem.push('Заполни условие задачи');
    let params: TaskParam[] | undefined;
    if (type === 'numeric') {
      if (spec.params.error) problem.push(spec.params.error);
      else {
        params = spec.params.params;
        if (!expr.trim()) problem.push('Заполни формулу ответа (expr)');
        else if (params) {
          const err = validateExprSamples(params, expr.trim());
          if (err) problem.push(`Формула: ${err}`);
        }
      }
    } else if (type === 'exact') {
      if (!value.trim()) problem.push('Заполни эталонный ответ');
    } else if (type === 'code_output' || type === 'code_fill') {
      if (!codeText.trim()) problem.push('Добавь листинг кода задачи');
      if (!value.trim()) problem.push('Заполни эталонный ответ (вывод программы или фрагмент кода)');
    } else if (type === 'essay') {
      const exp = spec.spec.kind === 'essay' ? spec.spec.expectation : [];
      if (exp.length < 2) problem.push('Укажи минимум 2 ключевых пункта полного ответа (по одному в строке)');
    } else {
      const opts = spec.spec.kind === 'choice' ? spec.spec.options : [];
      if (opts.length < 2) problem.push('Минимум 2 варианта ответа');
      else if (correctIndex < 0 || correctIndex >= opts.length) problem.push('Верный вариант вне диапазона');
    }
    const t: Task = {
      id: task.id,
      nodeId: task.nodeId,
      materialId: task.materialId,
      type,
      prompt: prompt.trim(),
      params,
      code: type === 'code_output' || type === 'code_fill' ? codeText.trim() || undefined : undefined,
      answerSpec: spec.spec,
      hints: [hint1.trim(), hint2.trim()].filter(Boolean),
      explanation: explanation.trim(),
      orderIndex: task.orderIndex,
      createdAt: task.createdAt,
    };
    return { task: t, error: problem.length > 0 ? problem.join('. ') : null };
  }, [task, type, prompt, spec, expr, paramsJson, value, codeText, correctIndex, hint1, hint2, explanation]);

  const preview = useMemo(() => {
    void reroll; // смена счётчика пересоздаёт случайный вариант параметров
    if (draft.error) return null;
    try {
      return instantiateTask(draft.task);
    } catch {
      return null;
    }
  }, [draft, reroll]);

  const previewAnswer = (() => {
    if (!preview) return '';
    if (draft.task.answerSpec.kind === 'numeric') {
      const v = preview.answer as number;
      return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100).replace('.', ',');
    }
    if (draft.task.answerSpec.kind === 'exact') return String(preview.answer);
    if (draft.task.answerSpec.kind === 'code') return String(preview.answer);
    if (draft.task.answerSpec.kind === 'essay') {
      const exp = draft.task.answerSpec.expectation;
      return exp.length > 0 ? `${exp.length} ключевых пунктов — проверяет ИИ` : '—';
    }
    const opt = draft.task.answerSpec.options[Number(preview.answer)];
    return opt ? `«${opt}»` : '—';
  })();

  const changeType = (t: TaskType) => {
    setType(t);
    if (t === 'numeric') {
      if (!expr.trim()) setExpr('0');
    } else if (t === 'choice') {
      if (!optionsText.trim()) setOptionsText('Вариант 1\nВариант 2\nВариант 3');
      setCorrectIndex(0);
    } else if (t === 'essay') {
      if (!expectationText.trim()) setExpectationText('Ключевой пункт ответа 1\nКлючевой пункт ответа 2\nКлючевой пункт ответа 3');
    } else if (t === 'code_output' || t === 'code_fill') {
      if (!codeText.trim()) setCodeText(t === 'code_output' ? 'print(2 + 3)' : 'def f(x):\n    return x * ___\n\nprint(f(4))');
    }
  };

  const save = async () => {
    if (draft.error) {
      toast.error(draft.error);
      return;
    }
    setBusy('save');
    try {
      const answerChanged = JSON.stringify(task.answerSpec) !== JSON.stringify(draft.task.answerSpec) || type !== task.type;
      await db.tasks.put(draft.task);
      if (answerChanged) {
        // старые попытки и набранный ответ относятся к прежней постановке — сбрасываем
        await db.attempts.where('nodeId').equals(node.id)
          .and((a) => a.kind === 'task' && a.taskId === task.id)
          .delete();
        await clearTaskDraft(node.id, task.id);
        toast.success('Задача сохранена. Ответ изменился — попытки по задаче сброшены');
      } else {
        toast.success('Задача сохранена');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения');
    } finally {
      setBusy(null);
    }
  };

  const check = async () => {
    if (!provider) {
      toast.error('Для проверки нужен LLM-провайдер (Настройки)');
      return;
    }
    if (draft.error) {
      toast.error(draft.error);
      return;
    }
    setBusy('check');
    setReport(null);
    try {
      setReport(await checkTaskLLM(provider, node, draft.task, makeSampleInstance(draft.task)));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setBusy(null);
    }
  };

  const fix = async () => {
    if (!provider) {
      toast.error('Для исправления нужен LLM-провайдер (Настройки)');
      return;
    }
    if (draft.error) {
      toast.error(`Сначала исправь сохраняемое: ${draft.error}`);
      return;
    }
    setBusy('fix');
    try {
      const gen = await fixTaskLLM(
        provider,
        node,
        draft.task,
        report && !report.ok ? report.problems : undefined
      );
      setPrompt(gen.prompt);
      setType(gen.type);
      if (gen.type === 'numeric') {
        setExpr(gen.expr ?? '0');
        setTolerance('0.02');
        setParamsJson(JSON.stringify((gen.params ?? []).map((p) => ({ name: p.name, choices: p.choices }))));
      } else if (gen.type === 'exact') {
        setValue(gen.value ?? '');
        setAlts((gen.alts ?? []).join('; '));
      } else if (gen.type === 'essay') {
        setExpectationText((gen.expectation ?? []).join('\n'));
      } else if (gen.type === 'code_output' || gen.type === 'code_fill') {
        setValue(gen.value ?? '');
        setAlts((gen.alts ?? []).join('; '));
        setCodeText(gen.code ?? '');
      } else {
        setOptionsText((gen.options ?? []).join('\n'));
        setCorrectIndex(Math.max(0, gen.correctIndex ?? 0));
      }
      setHint1(gen.hints[0] ?? '');
      setHint2(gen.hints[1] ?? '');
      setExplanation(gen.explanation ?? '');
      setReport(null);
      toast.success('Исправление подставлено — проверь и сохрани');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка исправления');
    } finally {
      setBusy(null);
    }
  };

  const del = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3500);
      return;
    }
    try {
      await db.transaction('rw', db.tasks, db.attempts, async () => {
        await db.tasks.delete(task.id);
        await db.attempts.where('nodeId').equals(node.id)
          .and((a) => a.kind === 'task' && a.taskId === task.id)
          .delete();
      });
      await clearTaskDraft(node.id, task.id);
      toast('Задача удалена');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка удаления');
    }
  };

  const options = type === 'choice' && spec.spec.kind === 'choice' ? spec.spec.options : [];

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        {/* Заголовок-сворачивалка */}
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />}
          <span className="shrink-0 text-sm font-semibold">Задача {index + 1}</span>
          <Badge variant="secondary" className="shrink-0 text-[10px]">{TYPE_LABEL[task.type]}</Badge>
          {passed && <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />}
          <span className="ml-auto max-w-[45%] truncate text-xs text-muted-foreground">
            {task.prompt || '(пусто — заполни)'}
          </span>
        </button>

        {open && (
          <>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Условие (формулы LaTeX в $…$, подстановки {'{{param}}'})</Label>
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="resize-none" />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Тип задачи</Label>
              <Select value={type} onValueChange={(v) => changeType(v as TaskType)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="numeric">Числовая (параметрическая)</SelectItem>
                  <SelectItem value="exact">Точный ответ</SelectItem>
                  <SelectItem value="choice">Выбор варианта</SelectItem>
                  <SelectItem value="essay">Открытый ответ (проверяет ИИ)</SelectItem>
                  <SelectItem value="code_output">Код: что выведет</SelectItem>
                  <SelectItem value="code_fill">Код: заполни пропуск</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {type === 'numeric' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Параметры — JSON: [{'{'}&quot;name&quot;: &quot;a&quot;, &quot;choices&quot;: [1,2,3]{'}'}]</Label>
                  <Textarea value={paramsJson} onChange={(e) => setParamsJson(e.target.value)} rows={2} className="resize-none font-mono text-xs" />
                </div>
                <div className="flex gap-2">
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Формула ответа (expr)</Label>
                    <Input value={expr} onChange={(e) => setExpr(e.target.value)} className="font-mono text-xs" />
                  </div>
                  <div className="flex w-28 flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Допуск</Label>
                    <Input value={tolerance} onChange={(e) => setTolerance(e.target.value)} inputMode="decimal" />
                  </div>
                </div>
              </>
            )}

            {type === 'exact' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Эталонный ответ</Label>
                  <Input value={value} onChange={(e) => setValue(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Допустимые варианты (через «;»)</Label>
                  <Input value={alts} onChange={(e) => setAlts(e.target.value)} />
                </div>
              </>
            )}

            {type === 'essay' && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Ключевые пункты полного ответа (по одному в строке) — по ним ИИ зачитывает ответ</Label>
                <Textarea value={expectationText} onChange={(e) => setExpectationText(e.target.value)} rows={4} className="resize-none" />
              </div>
            )}

            {(type === 'code_output' || type === 'code_fill') && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Листинг кода{type === 'code_fill' ? ' — пропуск обозначь «___» (ровно одно выражение/строка)' : ' — целиком исполняемая программа'}
                  </Label>
                  <Textarea value={codeText} onChange={(e) => setCodeText(e.target.value)} rows={6} className="resize-none font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    {type === 'code_output' ? 'Точный вывод программы' : 'Недостающий фрагмент кода'}
                  </Label>
                  <Textarea value={value} onChange={(e) => setValue(e.target.value)} rows={2} className="resize-none font-mono text-xs" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Засчитывается также (через «;»)</Label>
                  <Input value={alts} onChange={(e) => setAlts(e.target.value)} />
                </div>
              </>
            )}

            {type === 'choice' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">Варианты (по одному в строке)</Label>
                  <Textarea value={optionsText} onChange={(e) => setOptionsText(e.target.value)} rows={3} className="resize-none" />
                </div>
                {options.length >= 2 && (
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-xs text-muted-foreground">Верный вариант</Label>
                    <Select
                      value={String(Math.min(correctIndex, options.length - 1))}
                      onValueChange={(v) => setCorrectIndex(Number(v))}
                    >
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {options.map((o, i) => (
                          <SelectItem key={i} value={String(i)}>
                            {i + 1}. {o.length > 40 ? `${o.slice(0, 40)}…` : o}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </>
            )}

            <div className="grid grid-cols-1 gap-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Подсказка 1 (направление)</Label>
                <Textarea value={hint1} onChange={(e) => setHint1(e.target.value)} rows={2} className="resize-none" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Подсказка 2 (шаг решения)</Label>
                <Textarea value={hint2} onChange={(e) => setHint2(e.target.value)} rows={2} className="resize-none" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs text-muted-foreground">Полный разбор</Label>
                <Textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} rows={4} className="resize-none" />
              </div>
            </div>

            {/* Предпросмотр экземпляра */}
            {preview && (
              <div className="rounded-lg bg-muted/50 p-3">
                <div className="mb-1 flex items-center gap-2">
                  <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Предпросмотр</p>
                  {(draft.task.params?.length ?? 0) > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-muted-foreground"
                      onClick={() => setReroll((n) => n + 1)}
                    >
                      <RefreshCw className="mr-1 h-3 w-3" /> другой вариант
                    </Button>
                  )}
                </div>
                <p className="text-sm leading-snug">
                  <RichText>{preview.renderedPrompt}</RichText>
                </p>
                {(draft.task.type === 'code_output' || draft.task.type === 'code_fill') && draft.task.code && (
                  <CodeBlock code={draft.task.code} className="my-1.5" />
                )}
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Ответ решателя: <b className="text-foreground">{previewAnswer}</b>
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={save} disabled={busy !== null || draft.error !== null} className="min-w-32">
                {busy === 'save' ? 'Сохраняем…' : <><Save className="mr-1 h-4 w-4" /> Сохранить</>}
              </Button>
              <Button variant="outline" onClick={check} disabled={busy !== null}>
                {busy === 'check' ? 'Проверяем…' : <><Send className="mr-1 h-4 w-4" /> Проверить</>}
              </Button>
              <Button variant="outline" onClick={fix} disabled={busy !== null}>
                {busy === 'fix' ? 'Исправляем…' : <><Wand2 className="mr-1 h-4 w-4" /> Исправить</>}
              </Button>
              <Button
                variant="ghost"
                onClick={del}
                disabled={busy !== null}
                className={cn('ml-auto', confirmDelete ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground')}
              >
                <Trash2 className="mr-1 h-4 w-4" /> {confirmDelete ? 'Точно удалить?' : 'Удалить'}
              </Button>
            </div>
            {draft.error && <p className="text-[11px] text-amber-400">{draft.error}</p>}

            {report && <CheckReportView report={report} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Сброс прогресса узла ============

function DangerZone({ node }: { node: IdeaNode }) {
  const [confirm, setConfirm] = useState(false);

  const reset = async () => {
    if (!confirm) {
      setConfirm(true);
      setTimeout(() => setConfirm(false), 3500);
      return;
    }
    try {
      await resetNodeProgress(node.id);
      toast.success('Попытки узла сброшены — все испытания нужно пройти заново');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сброса');
    }
  };

  return (
    <Card className="border-border/60">
      <CardContent className="flex items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Сбросить попытки узла</p>
          <p className="text-xs text-muted-foreground">
            Удалит все попытки (Фейнман, задачи, своя задача) и черновики ответов. После правки идеи/задач старые
            зачёты могут не отражать знания.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={reset}
          className={cn('shrink-0', confirm && 'bg-destructive/15 text-destructive')}
        >
          <Trash2 className="mr-1 h-4 w-4" /> {confirm ? 'Точно сбросить?' : 'Сбросить'}
        </Button>
      </CardContent>
    </Card>
  );
}

