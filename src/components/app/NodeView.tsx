'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, ArrowRight, BookOpen, CheckCircle2, Eye, Lightbulb, Map as MapIcon, RefreshCw, Send, Sparkles, Trophy, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { db, setMeta } from '@/lib/db';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { checkAnswer, instantiateTask, isParametric } from '@/lib/task-engine';
import { gradeFeynmanLLM, gradeFeynmanLocal, validateOwnTaskLLM, validateOwnTaskLocal } from '@/lib/llm-ops';
import type { Attempt, FeynmanGrade, IdeaNode, OwnTaskVerdict, Task, TaskInstance } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function NodeView({ nodeId }: { nodeId: string }) {
  const closeNode = useAppStore((s) => s.closeNode);
  const openNode = useAppStore((s) => s.openNode);
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const providers = useAppStore((s) => s.providers);
  const activeProvider = providers.find((p) => p.isActive) ?? null;
  const data = useMaterialData(activeMaterialId);

  // живые данные узла
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

  useEffect(() => {
    void setMeta('lastNodeId', nodeId);
  }, [nodeId]);

  const latest = useMemo(() => {
    const map = new Map<string, Attempt>();
    const sorted = [...(bundle?.attempts ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const a of sorted) map.set(`${a.kind}|${a.taskId ?? ''}`, a);
    return map;
  }, [bundle?.attempts]);

  if (!bundle?.node || !data.ready) {
    return (
      <div className="fixed inset-0 z-50 bg-background">
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
        </div>
      </div>
    );
  }

  const { node, region, tasks } = bundle;
  const st = data.states.get(nodeId);
  const feynmanA = latest.get('feynman|');
  const ownA = latest.get('own|');
  const tasksPassed = tasks.filter((t) => latest.get(`task|${t.id}`)?.verdict === 'pass').length;
  const allDone =
    feynmanA?.verdict === 'pass' && ownA?.verdict === 'pass' && tasks.length > 0 && tasksPassed === tasks.length;

  const masteredNext = allDone && data.nextNode && data.nextNode.id !== nodeId ? data.nextNode : null;

  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col">
      {/* Шапка */}
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Button variant="ghost" size="icon" onClick={closeNode} aria-label="Назад к карте">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{region?.title}</p>
            <h1 className="truncate text-base font-semibold">{node.title}</h1>
          </div>
        </div>
        {/* Чипы испытаний */}
        <div className="mx-auto flex max-w-lg gap-1.5 px-4 pb-2.5">
          <TrialChip label="Фейнман" done={feynmanA?.verdict === 'pass'} />
          <TrialChip label={`Задачи ${tasksPassed}/${tasks.length}`} done={tasks.length > 0 && tasksPassed === tasks.length} />
          <TrialChip label="Своя задача" done={ownA?.verdict === 'pass'} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto thin-scroll">
        <div className="mx-auto flex max-w-lg flex-col gap-3 px-4 py-4 pb-24">
          {/* Предупреждение о риске */}
          {st?.risky && (
            <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
              <p className="flex items-center gap-1.5 font-medium">
                <Sparkles className="h-3.5 w-3.5" /> Рискованный вход
              </p>
              <p className="mt-1 text-amber-200/90">
                Смежные идеи ещё не освоены: {st.missingSoft.length > 0 && titleList(data, st.missingSoft)}. Иди в своём
                темпе — при затруднениях лучше вернуться к ним.
              </p>
            </div>
          )}

          {/* Карточка идеи */}
          <IdeaCard node={node} />

          {/* Освоено: празднование */}
          {allDone && (
            <Card className="border-emerald-500/50 bg-emerald-500/10">
              <CardContent className="flex flex-col items-center gap-2 p-5 text-center">
                <Trophy className="h-9 w-9 text-emerald-400" />
                <p className="font-semibold">Узел освоен!</p>
                <p className="text-sm text-muted-foreground">
                  Все три испытания пройдены. Прогресс сохранён — карта обновилась.
                </p>
                <div className="mt-1 flex gap-2">
                  <Button variant="outline" size="sm" onClick={closeNode}>
                    <MapIcon className="mr-1 h-4 w-4" /> На карту
                  </Button>
                  {masteredNext && (
                    <Button size="sm" onClick={() => openNode(masteredNext.id)}>
                      Следующая идея <ArrowRight className="ml-1 h-4 w-4" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Испытание 1: Фейнман */}
          <FeynmanTrial node={node} attempt={feynmanA} provider={activeProvider} />

          {/* Испытание 2: Задачи */}
          {tasks.map((task, i) => (
            <TaskTrial
              key={task.id}
              task={task}
              index={i}
              node={node}
              attempt={latest.get(`task|${task.id}`)}
              provider={activeProvider}
            />
          ))}

          {/* Испытание 3: Своя задача */}
          <OwnTaskTrial node={node} attempt={ownA} provider={activeProvider} />
        </div>
      </div>
    </div>
  );
}

function titleList(data: ReturnType<typeof useMaterialData>, ids: string[]): string {
  const byId = new Map(data.nodes.map((n) => [n.id, n.title]));
  return ids.map((id) => byId.get(id) ?? '—').join(', ');
}

function TrialChip({ label, done }: { label: string; done: boolean }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]',
        done ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400' : 'border-border bg-muted/40 text-muted-foreground'
      )}
    >
      {done && <CheckCircle2 className="h-3 w-3" />}
      {label}
    </span>
  );
}

// ============ Карточка идеи ============

function IdeaCard({ node }: { node: IdeaNode }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">Идея</p>
          <p className="mt-1 text-[15px] font-medium leading-snug">{node.formulation}</p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Пример</p>
          <p className="mt-1 text-sm leading-snug">{node.example}</p>
        </div>
        {node.misconception && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-400">Частая ошибка</p>
            <p className="mt-1 text-sm leading-snug text-amber-200/90">{node.misconception}</p>
          </div>
        )}
        {node.sourceRef && (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" className="self-start text-muted-foreground">
                <BookOpen className="mr-1.5 h-4 w-4" /> Показать источник
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Источник</DialogTitle>
              </DialogHeader>
              <p className="text-sm leading-relaxed text-muted-foreground">{node.sourceRef}</p>
            </DialogContent>
          </Dialog>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Испытание 1: Фейнман ============

function FeynmanTrial({
  node,
  attempt,
  provider,
}: {
  node: IdeaNode;
  attempt?: Attempt;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FeynmanGrade | null>(null);
  const passed = attempt?.verdict === 'pass';

  const submit = async () => {
    if (text.trim().length < 10) {
      toast.error('Сначала напиши объяснение своими словами');
      return;
    }
    setBusy(true);
    try {
      const grade = provider
        ? await gradeFeynmanLLM(provider, node, text.trim())
        : gradeFeynmanLocal(node, text.trim());
      setResult(grade);
      await db.attempts.put({
        id: crypto.randomUUID(),
        materialId: node.materialId,
        nodeId: node.id,
        kind: 'feynman',
        userAnswer: text.trim(),
        verdict: grade.verdict,
        score: (grade.accuracy / 2) * 0.5 + (grade.completeness / 2) * 0.3 + grade.ownWords * 0.2,
        feedback: grade.feedback,
        details: JSON.stringify({ accuracy: grade.accuracy, completeness: grade.completeness, ownWords: grade.ownWords, misconceptions: grade.misconceptions }),
        createdAt: new Date(),
      });
      if (grade.verdict === 'pass') toast.success('Фейнман пройден!');
      else toast.error('Пока не зачтено — см. разбор');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setBusy(false);
    }
  };

  const shown = result ?? (attempt?.details ? parseGrade(attempt) : null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <SectionHeader
          step={1}
          title="Объясни своими словами"
          done={passed}
          mode={provider ? `LLM: ${provider.model}` : 'локальный оценщик (демо)'}
        />
        <p className="text-sm leading-snug text-muted-foreground">{node.feynmanQuestion}</p>
        <Textarea
          placeholder="Представь, что объясняешь другу. Суть своими словами + пример…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="resize-none"
          disabled={busy}
        />
        {!passed && (
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Проверяем…' : <><Send className="mr-1 h-4 w-4" /> Проверить</>}
          </Button>
        )}
        {shown && <GradeResult grade={shown} />}
      </CardContent>
    </Card>
  );
}

function parseGrade(attempt: Attempt): FeynmanGrade | null {
  try {
    const d = JSON.parse(attempt.details ?? '{}');
    return { accuracy: d.accuracy ?? 0, completeness: d.completeness ?? 0, ownWords: d.ownWords ?? 0, misconceptions: d.misconceptions ?? [], feedback: attempt.feedback ?? '', verdict: attempt.verdict as 'pass' | 'fail' };
  } catch {
    return null;
  }
}

function GradeResult({ grade }: { grade: FeynmanGrade }) {
  return (
    <div className={cn('rounded-xl border p-3', grade.verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary" className="gap-1">Точность {grade.accuracy}/2</Badge>
        <Badge variant="secondary" className="gap-1">Полнота {grade.completeness}/2</Badge>
        <Badge variant="secondary" className="gap-1">Свои слова {grade.ownWords}/1</Badge>
        {grade.verdict === 'pass' ? (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> зачтено</span>
        ) : (
          <span className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-400"><XCircle className="h-4 w-4" /> доработай</span>
        )}
      </div>
      {grade.misconceptions.length > 0 && (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-rose-300">
          {grade.misconceptions.map((m, i) => <li key={i}>{m}</li>)}
        </ul>
      )}
      {grade.feedback && <p className="mt-2 text-sm leading-snug text-muted-foreground">{grade.feedback}</p>}
    </div>
  );
}

// ============ Испытание 2: Задачи ============

function TaskTrial({
  task,
  index,
  node,
  attempt,
  provider,
}: {
  task: Task;
  index: number;
  node: IdeaNode;
  attempt?: Attempt;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
}) {
  const [instance, setInstance] = useState<TaskInstance>(() => instantiateTask(task));
  const [input, setInput] = useState('');
  const [choiceIdx, setChoiceIdx] = useState<number | null>(null);
  const [verdict, setVerdict] = useState<'pass' | 'fail' | null>(attempt?.verdict === 'pass' ? 'pass' : null);
  const [correctShown, setCorrectShown] = useState<string | null>(null);
  const [hintLevel, setHintLevel] = useState(0);
  const hints = useMemo(() => [task.hints[0] ?? '', task.hints[1] ?? '', task.explanation].filter(Boolean), [task]);
  const passed = attempt?.verdict === 'pass' && verdict === 'pass';

  const reRandomize = () => {
    if (!isParametric(task)) return;
    setInstance(instantiateTask(task));
    setInput('');
    setChoiceIdx(null);
    setVerdict(null);
    setCorrectShown(null);
    setHintLevel(0);
  };

  const submit = async () => {
    const userInput = task.type === 'choice' ? String(choiceIdx ?? -1) : input;
    const res = checkAnswer(instance, task.answerSpec, userInput);
    setVerdict(res.verdict);
    setCorrectShown(res.verdict === 'fail' ? res.correctAnswer ?? null : null);
    await db.attempts.put({
      id: crypto.randomUUID(),
      materialId: node.materialId,
      nodeId: node.id,
      kind: 'task',
      taskId: task.id,
      userAnswer: task.type === 'choice' ? task.answerSpec.kind === 'choice' ? task.answerSpec.options[choiceIdx ?? -1] ?? '—' : userInput : userInput,
      verdict: res.verdict,
      createdAt: new Date(),
    });
    if (res.verdict === 'pass') toast.success('Верно!');
    else toast.error('Неверно. Попробуй ещё — или открой подсказку');
  };

  const showHint = () => {
    const next = Math.min(hintLevel + 1, 3);
    if (next > hintLevel && next > hints.length) {
      // локальные подсказки кончились, LLM может сгенерировать ещё
      if (provider) {
        void (async () => {
          const { genHint } = await import('@/lib/llm-ops');
          const h = await genHint(provider, node, task, next);
          hints[next - 1] = h;
          setHintLevel(next);
        })();
        return;
      }
    }
    setHintLevel(next);
  };

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <SectionHeader
          step={2}
          title={`Задача ${index + 1}`}
          done={passed}
          right={isParametric(task) && !passed ? (
            <Button variant="ghost" size="sm" onClick={reRandomize} className="h-7 px-2 text-xs text-muted-foreground">
              <RefreshCw className="mr-1 h-3 w-3" /> другой вариант
            </Button>
          ) : undefined}
        />
        <p className="text-sm leading-snug">{instance.renderedPrompt}</p>

        {task.type === 'choice' && task.answerSpec.kind === 'choice' ? (
          <div className="flex flex-col gap-1.5">
            {task.answerSpec.options.map((opt, i) => (
              <button
                key={i}
                disabled={passed}
                onClick={() => setChoiceIdx(i)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                  choiceIdx === i ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40',
                  passed && i === task.answerSpec.correctIndex && 'border-emerald-500/60 bg-emerald-500/10'
                )}
              >
                {opt}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !passed && submit()}
              disabled={passed}
              placeholder="Ответ"
              inputMode="text"
              className="h-10 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary"
            />
          </div>
        )}

        {!passed && (
          <div className="flex gap-2">
            <Button onClick={submit} className="flex-1">Ответить</Button>
            <Button variant="outline" onClick={showHint} disabled={hintLevel >= 3 && !provider}>
              <Lightbulb className="mr-1 h-4 w-4" /> Подсказка {Math.min(hintLevel + 1, 3)}/3
            </Button>
          </div>
        )}

        {hintLevel > 0 && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm leading-snug">
            {hints.slice(0, hintLevel).map((h, i) => (
              <p key={i} className={i > 0 ? 'mt-2 border-t border-border/60 pt-2' : ''}>{h}</p>
            ))}
          </div>
        )}

        {verdict && (
          <div className={cn('rounded-lg border p-2.5 text-sm', verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300')}>
            {verdict === 'pass' ? 'Верно! Задача засчитана.' : 'Неверно.'} {verdict === 'fail' && correctShown && <>Правильный ответ: <b>{correctShown}</b>. Открой подсказки и разбери решение.</>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Испытание 3: Своя задача ============

function OwnTaskTrial({
  node,
  attempt,
  provider,
}: {
  node: IdeaNode;
  attempt?: Attempt;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnTaskVerdict | null>(null);
  const passed = attempt?.verdict === 'pass';

  const submit = async () => {
    if (text.trim().length < 10) {
      toast.error('Сформулируй условие задачи');
      return;
    }
    setBusy(true);
    try {
      const v = provider ? await validateOwnTaskLLM(provider, node, text.trim()) : validateOwnTaskLocal(text.trim());
      setResult(v);
      await db.attempts.put({
        id: crypto.randomUUID(),
        materialId: node.materialId,
        nodeId: node.id,
        kind: 'own',
        userAnswer: text.trim(),
        verdict: v.verdict,
        feedback: v.feedback,
        createdAt: new Date(),
      });
      if (v.verdict === 'pass') toast.success('Задача зачтена!');
      else toast.error('Задачу нужно доработать');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setBusy(false);
    }
  };

  const shown = result ?? (attempt ? { onTopic: true, solvable: true, answer: '', feedback: attempt.feedback ?? '', verdict: attempt.verdict as 'pass' | 'fail' } : null);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <SectionHeader
          step={3}
          title="Придумай свою задачу"
          done={passed}
          mode={provider ? `LLM: ${provider.model}` : 'самопроверка (демо)'}
        />
        <p className="text-sm leading-snug text-muted-foreground">
          Придумай задачу на идею «{node.title}»: что дано и что найти. Чужая формулировка своими словами — лучший тест понимания.
        </p>
        <Textarea
          placeholder="Например: «Велосипедист едет по закону s(t)=4t². Найти его скорость через 5 секунд…»"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="resize-none"
          disabled={busy}
        />
        {!passed && (
          <Button onClick={submit} disabled={busy}>
            {busy ? 'Проверяем…' : <><Send className="mr-1 h-4 w-4" /> Отправить</>}
          </Button>
        )}
        {shown && (
          <div className={cn('rounded-xl border p-3 text-sm', shown.verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="secondary">на тему: {shown.onTopic ? 'да' : 'нет'}</Badge>
              <Badge variant="secondary">решаема: {shown.solvable ? 'да' : 'нет'}</Badge>
              {shown.verdict === 'pass' ? (
                <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> зачтено</span>
              ) : (
                <span className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-400"><XCircle className="h-4 w-4" /> доработай</span>
              )}
            </div>
            {shown.answer && <p className="mt-2 text-muted-foreground">Ответ проверяющего: <b className="text-foreground">{shown.answer}</b></p>}
            {shown.feedback && <p className="mt-1.5 leading-snug text-muted-foreground">{shown.feedback}</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionHeader({
  step,
  title,
  done,
  mode,
  right,
}: {
  step: number;
  title: string;
  done: boolean;
  mode?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold', done ? 'bg-emerald-500/20 text-emerald-400' : 'bg-primary/15 text-primary')}>
        {done ? <CheckCircle2 className="h-4 w-4" /> : step}
      </span>
      <p className="text-sm font-semibold">{title}</p>
      {mode && <span className="flex items-center gap-1 text-[10px] text-muted-foreground"><Eye className="h-3 w-3" />{mode}</span>}
      {right && <span className="ml-auto">{right}</span>}
    </div>
  );
}
