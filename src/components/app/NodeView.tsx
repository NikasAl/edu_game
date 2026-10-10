'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ClipboardPaste, ArrowLeft, ArrowRight, AlertTriangle, BookOpen, CheckCircle2, Eye, History, Lightbulb, Map as MapIcon, MessageCircle, PencilLine, Play, RefreshCw, Send, Sparkles, Trophy, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import RichText from '@/components/RichText';
import CodeBlock from '@/components/CodeBlock';
import PhotoOcr from '@/components/app/PhotoOcr';
import { db, setMeta } from '@/lib/db';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { useNodeDraft, useTaskAnswerDraft } from '@/hooks/useNodeDraft';
import { checkAnswer, instantiateTask, isParametric, taskProblems } from '@/lib/task-engine';
import { countsForState, isOwnRequired, isTaskRequired } from '@/lib/progress';
import { checkEssayLLM, gradeEssayLocal, gradeFeynmanLLM, gradeFeynmanLocal, validateOwnTaskLLM, validateOwnTaskLocal } from '@/lib/llm-ops';
import { generateTasksForNodes } from '@/lib/task-gen';
import { essayDuplicatesFeynman } from '@/lib/text-sim';
import { computeSrsForNode, fmtDay, intervalFor, SRS_LADDER_DAYS, type SrsInfo } from '@/lib/srs';
import { AnswerHelpers, appendChunk } from '@/components/app/AnswerHelpers';
import IdeaChat from '@/components/app/IdeaChat';
import type { Attempt, EssayGrade, FeynmanGrade, IdeaNode, OwnTaskVerdict, Task, TaskInstance } from '@/lib/types';
import { cn } from '@/lib/utils';

export default function NodeView({ nodeId }: { nodeId: string }) {
  const closeNode = useAppStore((s) => s.closeNode);
  const openNode = useAppStore((s) => s.openNode);
  const openNodeEditor = useAppStore((s) => s.openNodeEditor);
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const providers = useAppStore((s) => s.providers);
  const difficulty = useAppStore((s) => s.difficulty);
  const activeProvider = providers.find((p) => p.isActive) ?? null;
  const data = useMaterialData(activeMaterialId);
  // генерация задач прямо из карточки «узел без задач» (одна кнопка, без редактора)
  const [genBusy, setGenBusy] = useState(false);
  // обсуждение идеи с ИИ (полноэкранный чат поверх узла)
  const [chatOpen, setChatOpen] = useState(false);

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
    // официальное состояние испытаний: пробные (exploratory) попытки в зачёт не идут
    const map = new Map<string, Attempt>();
    const sorted = [...(bundle?.attempts ?? [])].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const a of sorted) {
      if (!countsForState(a)) continue;
      map.set(`${a.kind}|${a.taskId ?? ''}`, a);
    }
    return map;
  }, [bundle?.attempts]);

  // SRS: расписание повторения освоенного узла (null — узел не освоен/не освоиваем)
  const now = useMemo(() => new Date(), [nodeId]);
  const srsInfo = useMemo(
    () => (bundle?.node ? computeSrsForNode(bundle.node, bundle.tasks, bundle.attempts, now, difficulty) : null),
    [bundle, now, difficulty]
  );

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
  // гейт режима сложности: какие испытания обязательны для зачёта
  const ownRequired = isOwnRequired(difficulty);
  const requiredTasks = tasks.filter((t) => isTaskRequired(t, difficulty));
  const requiredPassed = requiredTasks.filter((t) => latest.get(`task|${t.id}`)?.verdict === 'pass').length;
  const allDone =
    feynmanA?.verdict === 'pass' &&
    (ownA?.verdict === 'pass' || !ownRequired) &&
    tasks.length > 0 &&
    requiredPassed === requiredTasks.length;

  const masteredNext = allDone && data.nextNode && data.nextNode.id !== nodeId ? data.nextNode : null;

  /** Сгенерировать задачи прямо здесь, не открывая редактор */
  const generateHere = async () => {
    if (!activeProvider) {
      toast.error('Для генерации задач нужен LLM-провайдер (Настройки)');
      return;
    }
    setGenBusy(true);
    try {
      const r = await generateTasksForNodes(activeProvider, [node], { pauseMs: 0 });
      if (r.generated > 0) {
        toast.success(
          r.brokenTasks > 0
            ? `Задач добавлено: ${r.tasksAdded} · с ошибками: ${r.brokenTasks} — исправь в редакторе`
            : `Задач добавлено: ${r.tasksAdded}`
        );
      } else if (r.skipped > 0) {
        toast.info('У узла уже появились задачи');
      } else {
        toast.error('Не удалось сгенерировать задачи — попробуй ещё раз или добавь вручную');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка генерации');
    } finally {
      setGenBusy(false);
    }
  };

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
          <Button variant="ghost" size="icon" onClick={() => setChatOpen(true)} aria-label="Обсудить идею с ИИ">
            <MessageCircle className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" onClick={() => openNodeEditor(node.id)} aria-label="Редактор узла">
            <PencilLine className="h-5 w-5" />
          </Button>
        </div>
        {/* Чипы испытаний: обязательные — как раньше, необязательные — пунктиром */}
        <div className="mx-auto flex max-w-lg gap-1.5 px-4 pb-2.5">
          <TrialChip label="Фейнман" done={feynmanA?.verdict === 'pass'} />
          <TrialChip
            label={`Задачи ${requiredPassed}/${requiredTasks.length}`}
            done={tasks.length > 0 && requiredPassed === requiredTasks.length}
          />
          <TrialChip label="Своя задача" done={ownA?.verdict === 'pass'} optional={!ownRequired} />
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
          <IdeaCard node={node} onDiscuss={() => setChatOpen(true)} />

          {/* Непроходимый узел: задач нет — генерация одной кнопкой или редактор */}
          {tasks.length === 0 && (
            <Card className="border-amber-500/40 bg-amber-500/5">
              <CardContent className="flex flex-col gap-2 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium text-amber-300">
                  <Sparkles className="h-4 w-4" /> У узла нет задач — он непроходим
                </p>
                <p className="text-xs leading-snug text-muted-foreground">
                  Похоже, генерация задач не удалась. Без задач узел нельзя завершить и перейти к следующим. Сгенерируй
                  задачи LLM или открой редактор и добавь вручную.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void generateHere()} disabled={genBusy}>
                    {genBusy ? (
                      'Генерация…'
                    ) : (
                      <>
                        <Sparkles className="mr-1 h-4 w-4" /> Сгенерировать задачи
                      </>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openNodeEditor(node.id)} disabled={genBusy}>
                    <PencilLine className="mr-1 h-4 w-4" /> Редактор
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Освоено: празднование */}
          {allDone && (
            <Card className="border-emerald-500/50 bg-emerald-500/10">
              <CardContent className="flex flex-col items-center gap-2 p-5 text-center">
                <Trophy className="h-9 w-9 text-emerald-400" />
                <p className="font-semibold">Узел освоен!</p>
                <p className="text-sm text-muted-foreground">
                  {ownRequired ? 'Все три испытания пройдены' : 'Все обязательные испытания пройдены'}. Прогресс
                  сохранён — карта обновилась.
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

          {/* Повторение (SRS): мини-задача, когда пора освежить память */}
          {srsInfo && <ReviewCard node={node} tasks={tasks} info={srsInfo} now={now} provider={activeProvider} />}

          {/* Испытание 1: Фейнман */}
          <FeynmanTrial key={`f:${nodeId}`} node={node} attempt={feynmanA} provider={activeProvider} />

          {/* Испытание 2: Задачи */}
          {tasks.map((task, i) => (
            <TaskTrial
              key={`${nodeId}:${task.id}`}
              task={task}
              index={i}
              node={node}
              attempt={latest.get(`task|${task.id}`)}
              provider={activeProvider}
              feynmanAnswer={feynmanA?.userAnswer}
              essayOptional={difficulty === 'easy' && task.type === 'essay'}
            />
          ))}

          {/* Испытание 3: Своя задача */}
          <OwnTaskTrial key={`o:${nodeId}`} node={node} attempt={ownA} provider={activeProvider} optional={!ownRequired} />
        </div>
      </div>

      {/* Обсуждение идеи с ИИ — поверх экрана узла */}
      {chatOpen && <IdeaChat node={node} provider={activeProvider} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

function titleList(data: ReturnType<typeof useMaterialData>, ids: string[]): string {
  const byId = new Map<string, string>(data.nodes.map((n) => [n.id, n.title] as const));
  return ids.map((id) => byId.get(id) ?? '—').join(', ');
}

function TrialChip({ label, done, optional }: { label: string; done: boolean; optional?: boolean }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]',
        done
          ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-400'
          : optional
            ? 'border-dashed border-border bg-transparent text-muted-foreground/70'
            : 'border-border bg-muted/40 text-muted-foreground'
      )}
    >
      {done && <CheckCircle2 className="h-3 w-3" />}
      {label}
      {optional && !done && <span className="opacity-70">· по желанию</span>}
    </span>
  );
}

// ============ Карточка идеи ============

function IdeaCard({ node, onDiscuss }: { node: IdeaNode; onDiscuss: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">Идея</p>
          <p className="mt-1 text-[15px] font-medium leading-snug">
            <RichText>{node.formulation}</RichText>
          </p>
        </div>
        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Пример</p>
          <p className="mt-1 text-sm leading-snug">
            <RichText>{node.example}</RichText>
          </p>
        </div>
        {node.code && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Код</p>
            <CodeBlock code={node.code} />
          </div>
        )}
        {node.misconception && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-amber-400">Частая ошибка</p>
            <p className="mt-1 text-sm leading-snug text-amber-200/90">
              <RichText>{node.misconception}</RichText>
            </p>
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
              <p className="text-sm leading-relaxed text-muted-foreground">
                <RichText>{node.sourceRef}</RichText>
              </p>
            </DialogContent>
          </Dialog>
        )}
        <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={onDiscuss}>
          <MessageCircle className="mr-1.5 h-4 w-4" /> Обсудить идею с ИИ
        </Button>
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
  // черновик объяснения: сохраняется даже без отправки на проверку
  const [text, setText] = useNodeDraft({
    nodeId: node.id,
    materialId: node.materialId,
    field: 'feynmanText',
    attemptAnswer: attempt?.userAnswer,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<FeynmanGrade | null>(null);
  const passed = attempt?.verdict === 'pass';
  // переответ после зачёта: пробная проверка другой формулировки (зачёт не меняется)
  const [retake, setRetake] = useState(false);
  const [explorGrade, setExplorGrade] = useState<FeynmanGrade | null>(null);

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
        // попытка после зачёта — пробная: зачёт не снимает и не даёт нового
        ...(passed ? { exploratory: true } : {}),
        createdAt: new Date(),
      });
      if (passed) {
        setExplorGrade(grade);
        toast.info('Новый разбор готов — зачёт сохранён');
      } else if (grade.verdict === 'pass') toast.success('Фейнман пройден!');
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
        <p className="text-sm leading-snug text-muted-foreground">
          <RichText>{node.feynmanQuestion}</RichText>
        </p>
        <Textarea
          placeholder="Представь, что объясняешь другу. Суть своими словами + пример…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
          className="resize-none"
          disabled={busy}
        />
        <AnswerHelpers
          variant="feynman"
          onAppend={(chunk) => setText((prev) => appendChunk(prev ?? '', chunk))}
          disabled={busy || (passed && !retake)}
        />
        <PhotoOcr
          mode="full"
          label="Фото с решением"
          onInsert={(t) => setText((prev) => (prev ? `${prev}\n${t}` : t))}
          disabled={busy}
        />
        {passed && !retake && (
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-xs text-muted-foreground"
              onClick={() => setRetake(true)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Ответить снова
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              Можно сформулировать иначе и увидеть новый разбор — зачёт по прежнему ответу сохранится.
            </p>
          </div>
        )}
        {(!passed || retake) && (
          <Button onClick={submit} disabled={busy} variant={passed ? 'outline' : 'default'}>
            {busy ? (
              'Проверяем…'
            ) : passed ? (
              <>
                <Send className="mr-1 h-4 w-4" /> Проверить (пробно)
              </>
            ) : (
              <>
                <Send className="mr-1 h-4 w-4" /> Проверить
              </>
            )}
          </Button>
        )}
        {retake && explorGrade ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Пробная проверка · зачёт сохранён
            </p>
            <GradeResult grade={explorGrade} />
          </div>
        ) : (
          shown && <GradeResult grade={shown} />
        )}
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
          {grade.misconceptions.map((m, i) => (
            <li key={i}>
              <RichText>{m}</RichText>
            </li>
          ))}
        </ul>
      )}
      {grade.feedback && (
        <p className="mt-2 text-sm leading-snug text-muted-foreground">
          <RichText>{grade.feedback}</RichText>
        </p>
      )}
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
  feynmanAnswer,
  essayOptional,
}: {
  task: Task;
  index: number;
  node: IdeaNode;
  attempt?: Attempt;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
  /** Текст последней попытки Фейнмана — источник переноса в эссе-дубликат */
  feynmanAnswer?: string;
  /** Режим «Лёгкий»: эссе не обязательны для зачёта узла */
  essayOptional?: boolean;
}) {
  // экземпляр пересобирается при изменении задачи (правка в редакторе) и по кнопке «другой вариант»
  const [roll, setRoll] = useState(0);
  const instance = useMemo(() => instantiateTask(task), [task, roll]);
  const openNodeEditor = useAppStore((s) => s.openNodeEditor);

  // битая задача (например формула с «%» от LLM): показываем предупреждение вместо падения экрана
  const problems = useMemo(() => taskProblems(task), [task]);
  const broken = problems.length > 0;

  // черновик ответа: набранный текст/вариант сохраняются и восстанавливаются
  const attemptChoiceIdx = useMemo(() => {
    if (task.answerSpec.kind !== 'choice' || !attempt) return undefined;
    const idx = task.answerSpec.options.findIndex((o) => o === attempt.userAnswer);
    return idx >= 0 ? idx : undefined;
  }, [task, attempt]);
  const isEssay = task.type === 'essay';
  // эссе спрашивает то же, что и феймановский вопрос → ответ можно не писать заново
  const dupOfFeynman = isEssay && !!feynmanAnswer && essayDuplicatesFeynman(task.prompt, node.feynmanQuestion);
  const { input, setInput, choiceIdx, setChoiceIdx } = useTaskAnswerDraft({
    nodeId: node.id,
    materialId: node.materialId,
    taskId: task.id,
    attemptAnswer: attempt?.userAnswer,
    attemptChoiceIdx,
    // авто-перенос ответа Фейнмана в эссе, дублирующее его вопрос:
    // поле пустое (нет черновика/попытки) → подставляем готовый текст
    autoFillText:
      isEssay && !broken && attempt?.verdict !== 'pass' && feynmanAnswer && feynmanAnswer.trim().length >= 10 && dupOfFeynman
        ? feynmanAnswer
        : undefined,
  });

  const [verdict, setVerdict] = useState<'pass' | 'fail' | null>(attempt?.verdict === 'pass' ? 'pass' : null);
  // переответ после зачёта: пробная проверка другой формулировки (зачёт не меняется)
  const [retake, setRetake] = useState(false);
  const [explor, setExplor] = useState<{
    verdict: 'pass' | 'fail';
    essay?: EssayGrade;
    correctAnswer?: string;
  } | null>(null);
  const [correctShown, setCorrectShown] = useState<string | null>(null);
  const [hintLevel, setHintLevel] = useState(0);
  const [llmHints, setLlmHints] = useState<Record<number, string>>({});
  const [essayBusy, setEssayBusy] = useState(false);
  // свежий результат проверки открытого ответа (LLM/локальная рубрика)
  const [essayResult, setEssayResult] = useState<EssayGrade | null>(null);
  // в поле — перенесённый ответ Фейнмана (показываем пояснение вместо кнопки переноса)
  const transferred = isEssay && !!feynmanAnswer && input === feynmanAnswer;
  // ручной перенос: с непустым полем — двухшагово (первый клик предупреждает о замене)
  const [armReplace, setArmReplace] = useState(false);
  const insertFeynman = () => {
    if (!feynmanAnswer) return;
    if (input.trim()) {
      if (!armReplace) {
        setArmReplace(true);
        window.setTimeout(() => setArmReplace(false), 3500);
        return;
      }
    }
    setInput(feynmanAnswer);
    setArmReplace(false);
  };
  // восстановление последней проверки из попытки (переприход в узел)
  const essayFromAttempt = useMemo<EssayGrade | null>(() => {
    if (!isEssay || !attempt?.feedback) return null;
    let missed: string[] = [];
    try {
      const d = JSON.parse(attempt.details ?? '{}');
      if (Array.isArray(d.missed)) missed = d.missed.map(String);
    } catch {
      // без details — просто без списка нераскрытых пунктов
    }
    return { verdict: attempt.verdict === 'pass' ? 'pass' : 'fail', score: attempt.score ?? 0, missed, feedback: attempt.feedback };
  }, [isEssay, attempt]);
  const hints = useMemo(() => {
    const arr = [task.hints[0] ?? '', task.hints[1] ?? '', task.explanation].filter(Boolean);
    // подсказки, догенерированные LLM, добавляются в конец (уровни после локальных)
    for (let lvl = arr.length + 1; lvl <= 3; lvl++) {
      if (llmHints[lvl]) arr.push(llmHints[lvl]);
    }
    return arr;
  }, [task, llmHints]);
  const passed = attempt?.verdict === 'pass' && verdict === 'pass';
  const choiceSpec = task.answerSpec.kind === 'choice' ? task.answerSpec : null;
  const isCode = task.type === 'code_output' || task.type === 'code_fill';

  const reRandomize = () => {
    if (!isParametric(task) || broken) return;
    setRoll((n) => n + 1);
    setInput('');
    setChoiceIdx(null);
    setCorrectShown(null);
    setHintLevel(0);
    // в пробном режиме новая формулировка продолжает пробную проверку,
    // в обычном — сбрасывает вердикт задачи
    if (passed) setExplor(null);
    else setVerdict(null);
  };

  const submit = async () => {
    if (broken) return;
    // Открытый ответ: проверка рубрикой (LLM, без провайдера — косвенная локальная)
    if (isEssay) {
      const answer = input.trim();
      if (answer.length < 10) {
        toast.error('Напиши развёрнутый ответ своими словами');
        return;
      }
      setEssayBusy(true);
      try {
        const grade = provider
          ? await checkEssayLLM(provider, task, node, answer)
          : gradeEssayLocal(task.answerSpec.kind === 'essay' ? task.answerSpec.expectation : [], answer);
        if (passed) {
          // пробная проверка после зачёта — вердикт задачи не трогаем
          setExplor({ verdict: grade.verdict, essay: grade });
        } else {
          setVerdict(grade.verdict);
          setEssayResult(grade);
        }
        await db.attempts.put({
          id: crypto.randomUUID(),
          materialId: node.materialId,
          nodeId: node.id,
          kind: 'task',
          taskId: task.id,
          userAnswer: answer,
          verdict: grade.verdict,
          score: grade.score,
          feedback: grade.feedback,
          details: JSON.stringify({ missed: grade.missed }),
          ...(passed ? { exploratory: true } : {}),
          createdAt: new Date(),
        });
        if (passed) {
          toast.info(grade.verdict === 'pass' ? 'Пробная проверка: зачтено' : 'Пробная проверка: не зачтено — зачёт сохранён');
        } else if (grade.verdict === 'pass') toast.success('Ответ зачтён!');
        else toast.error('Пока не зачтено — см. разбор');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
      } finally {
        setEssayBusy(false);
      }
      return;
    }
    const userInput = task.type === 'choice' ? String(choiceIdx ?? -1) : input;
    const res = checkAnswer(instance, task.answerSpec, userInput);
    if (passed) {
      // пробная проверка после зачёта — вердикт задачи не трогаем
      setExplor({ verdict: res.verdict, correctAnswer: res.correctAnswer ?? undefined });
    } else {
      setVerdict(res.verdict);
      setCorrectShown(res.verdict === 'fail' ? res.correctAnswer ?? null : null);
    }
    await db.attempts.put({
      id: crypto.randomUUID(),
      materialId: node.materialId,
      nodeId: node.id,
      kind: 'task',
      taskId: task.id,
      userAnswer: task.type === 'choice' ? task.answerSpec.kind === 'choice' ? task.answerSpec.options[choiceIdx ?? -1] ?? '—' : userInput : userInput,
      verdict: res.verdict,
      ...(passed ? { exploratory: true } : {}),
      createdAt: new Date(),
    });
    if (passed) {
      toast.info(res.verdict === 'pass' ? 'Пробная проверка: зачтено' : 'Пробная проверка: не зачтено — зачёт сохранён');
    } else if (res.verdict === 'pass') toast.success('Верно!');
    else toast.error('Неверно. Попробуй ещё — или открой подсказку');
  };

  const showHint = () => {
    const next = Math.min(hintLevel + 1, 3);
    if (next > hintLevel && next > hints.length) {
      // локальные подсказки кончились, LLM может сгенерировать ещё
      if (provider) {
        void (async () => {
          try {
            const { genHint } = await import('@/lib/llm-ops');
            const h = await genHint(provider, node, task, next);
            setLlmHints((prev) => ({ ...prev, [next]: h }));
            setHintLevel(next);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Подсказка недоступна');
          }
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
          right={isParametric(task) && (!passed || retake) ? (
            <Button variant="ghost" size="sm" onClick={reRandomize} className="h-7 px-2 text-xs text-muted-foreground">
              <RefreshCw className="mr-1 h-3 w-3" /> другой вариант
            </Button>
          ) : undefined}
        />
        <p className="text-sm leading-snug">
          <RichText>{instance.renderedPrompt}</RichText>
        </p>

        {/* Листинг code-задачи (code_output — целая программа, code_fill — с пропуском ___) */}
        {isCode && task.code && <CodeBlock code={task.code} />}

        {/* Сломанная задача: валидные части показываем, но пройти нельзя — чини в редакторе */}
        {broken && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <p className="flex items-center gap-1.5 font-medium text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" /> Задача сломана — её нельзя пройти
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-amber-200/90">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            <p className="mt-1 text-amber-200/70">
              Обычно это ошибка в формуле ответа после генерации. Исправь формулу или удали задачу в редакторе узла.
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => openNodeEditor(node.id)}>
              <PencilLine className="mr-1 h-3.5 w-3.5" /> Открыть редактор
            </Button>
          </div>
        )}

        {choiceSpec ? (
          <div className="flex flex-col gap-1.5">
            {choiceSpec.options.map((opt, i) => (
              <button
                key={i}
                disabled={broken || (passed && !retake)}
                onClick={() => setChoiceIdx(i)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                  choiceIdx === i ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40',
                  passed && i === choiceSpec.correctIndex && 'border-emerald-500/60 bg-emerald-500/10'
                )}
              >
                <RichText>{opt}</RichText>
              </button>
            ))}
          </div>
        ) : isEssay ? (
          <div className="flex flex-col gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={broken || essayBusy || (passed && !retake)}
              placeholder="Развёрнутый ответ своими словами…"
              rows={5}
              className="resize-none"
            />
            {(!passed || retake) && !broken && (
              <AnswerHelpers
                variant="essay"
                onAppend={(chunk) => setInput((prev) => appendChunk(prev ?? '', chunk))}
                disabled={essayBusy}
              />
            )}
            {essayOptional && !passed && !broken && (
              <p className="rounded-lg bg-muted/40 px-2.5 py-1.5 text-[11px] leading-snug text-muted-foreground">
                Режим «Лёгкий»: это эссе не обязательно для зачёта узла — можно ответить, а можно перейти к следующей
                идее.
              </p>
            )}
            {transferred && !passed && (
              <p className="text-[11px] leading-snug text-emerald-400/90">
                Перенесено из объяснения Фейнмана: задача повторяет его вопрос почти дословно. Сократи, дополни — или
                отправляй как есть.
              </p>
            )}
            {(!passed || retake) && !broken && feynmanAnswer && !transferred && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 self-start px-2 text-xs text-muted-foreground"
                disabled={essayBusy}
                onClick={insertFeynman}
              >
                <ClipboardPaste className="mr-1 h-3.5 w-3.5" />
                {armReplace ? 'Ещё раз — заменит набранный ответ' : 'Вставить ответ Фейнмана'}
              </Button>
            )}
            {(!passed || retake) && !broken && (
              <PhotoOcr
                mode="full"
                label="Фото с решением"
                onInsert={(t) => setInput((prev) => (prev ? `${prev}\n${t}` : t))}
                disabled={essayBusy}
              />
            )}
            <p className="text-[11px] text-muted-foreground">
              {provider ? 'Проверит ИИ: сравнит с ключевыми пунктами полного ответа' : 'ИИ не подключён — косвенная проверка по ключевым словам'}
            </p>
          </div>
        ) : (
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (!passed || retake) && !broken && submit()}
              disabled={broken || (passed && !retake)}
              placeholder={
                task.type === 'code_output' ? 'Вывод программы' : task.type === 'code_fill' ? 'Недостающий фрагмент кода' : 'Ответ'
              }
              inputMode="text"
              className={cn(
                'h-10 flex-1 rounded-lg border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary',
                isCode && 'font-mono'
              )}
            />
            {!passed && !broken && (
              <PhotoOcr
                mode="short"
                label=""
                onInsert={(t) => setInput(t)}
              />
            )}
          </div>
        )}

        {passed && !retake && (
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-xs text-muted-foreground"
              onClick={() => setRetake(true)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Ответить снова
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              Можно ответить иначе (для параметрической — «другой вариант») и увидеть новый разбор — зачёт сохранится.
            </p>
          </div>
        )}

        {(!passed || retake) && (
          <div className="flex gap-2">
            <Button onClick={submit} className="flex-1" variant={passed ? 'outline' : 'default'} disabled={broken || essayBusy}>
              {essayBusy ? 'Проверяем…' : passed ? 'Проверить (пробно)' : 'Ответить'}
            </Button>
            <Button variant="outline" onClick={showHint} disabled={hintLevel >= 3 && !provider}>
              <Lightbulb className="mr-1 h-4 w-4" /> Подсказка {Math.min(hintLevel + 1, 3)}/3
            </Button>
          </div>
        )}

        {hintLevel > 0 && (
          <div className="rounded-lg bg-muted/50 p-3 text-sm leading-snug">
            {hints.slice(0, hintLevel).map((h, i) => (
              <div key={i} className={i > 0 ? 'mt-2 border-t border-border/60 pt-2' : ''}>
                <RichText>{h}</RichText>
              </div>
            ))}
          </div>
        )}

        {verdict && !isEssay && (
          <div className={cn('rounded-lg border p-2.5 text-sm', verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/40 bg-rose-500/10 text-rose-300')}>
            {verdict === 'pass' ? 'Верно! Задача засчитана.' : 'Неверно.'}{' '}
            {verdict === 'fail' && correctShown && (
              <>
                Правильный ответ:{' '}
                <b className={isCode ? 'font-mono' : undefined}>{correctShown}</b>. Открой подсказки и разбери решение.
              </>
            )}
          </div>
        )}

        {verdict && isEssay && (() => {
          const shown = essayResult ?? essayFromAttempt;
          if (!shown) return null;
          return (
            <div className={cn('rounded-xl border p-3', shown.verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className="gap-1">Раскрыто {Math.round(shown.score * 100)}%</Badge>
                {shown.verdict === 'pass' ? (
                  <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> зачтено</span>
                ) : (
                  <span className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-400"><XCircle className="h-4 w-4" /> доработай ответ</span>
                )}
              </div>
              {shown.missed.length > 0 && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-muted-foreground">Не раскрыто:</p>
                  <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-xs text-amber-300">
                    {shown.missed.map((m, i) => (
                      <li key={i}><RichText>{m}</RichText></li>
                    ))}
                  </ul>
                </div>
              )}
              {shown.feedback && (
                <p className="mt-2 text-sm leading-snug text-muted-foreground"><RichText>{shown.feedback}</RichText></p>
              )}
            </div>
          );
        })()}

        {/* Результат пробной проверки (переответ после зачёта) */}
        {explor && passed && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Пробная проверка · зачёт сохранён
            </p>
            <div className={cn('rounded-xl border p-3', explor.verdict === 'pass' ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-amber-500/40 bg-amber-500/5')}>
              {explor.essay ? (
                <>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary" className="gap-1">Раскрыто {Math.round(explor.essay.score * 100)}%</Badge>
                    {explor.verdict === 'pass' ? (
                      <span className="ml-auto flex items-center gap-1 text-xs font-medium text-emerald-400"><CheckCircle2 className="h-4 w-4" /> зачтено</span>
                    ) : (
                      <span className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-400"><XCircle className="h-4 w-4" /> доработай ответ</span>
                    )}
                  </div>
                  {explor.essay.missed.length > 0 && (
                    <div className="mt-2">
                      <p className="text-xs font-medium text-muted-foreground">Не раскрыто:</p>
                      <ul className="mt-0.5 list-disc space-y-0.5 pl-5 text-xs text-amber-300">
                        {explor.essay.missed.map((m, i) => (
                          <li key={i}><RichText>{m}</RichText></li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {explor.essay.feedback && (
                    <p className="mt-2 text-sm leading-snug text-muted-foreground"><RichText>{explor.essay.feedback}</RichText></p>
                  )}
                </>
              ) : (
                <p className="text-sm">
                  {explor.verdict === 'pass' ? (
                    <span className="text-emerald-300">Верно!</span>
                  ) : (
                    <span className="text-amber-300">
                      Неверно.
                      {explor.correctAnswer && (
                        <> Правильный ответ: <b className={isCode ? 'font-mono' : undefined}>{explor.correctAnswer}</b>.</>
                      )}
                    </span>
                  )}
                </p>
              )}
            </div>
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
  optional,
}: {
  node: IdeaNode;
  attempt?: Attempt;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
  /** Режимы «Лёгкий»/«Обычный»: своя задача не обязательна для зачёта */
  optional?: boolean;
}) {
  // черновик своей задачи: сохраняется даже без отправки на проверку
  const [text, setText] = useNodeDraft({
    nodeId: node.id,
    materialId: node.materialId,
    field: 'ownTaskText',
    attemptAnswer: attempt?.userAnswer,
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnTaskVerdict | null>(null);
  const passed = attempt?.verdict === 'pass';
  // переответ после зачёта: пробная проверка другой задачи (зачёт не меняется)
  const [retake, setRetake] = useState(false);
  const [explorResult, setExplorResult] = useState<OwnTaskVerdict | null>(null);

  const submit = async () => {
    if (text.trim().length < 10) {
      toast.error('Сформулируй условие задачи');
      return;
    }
    setBusy(true);
    try {
      const v = provider ? await validateOwnTaskLLM(provider, node, text.trim()) : validateOwnTaskLocal(text.trim());
      setResult(v);
      if (passed) setExplorResult(v);
      await db.attempts.put({
        id: crypto.randomUUID(),
        materialId: node.materialId,
        nodeId: node.id,
        kind: 'own',
        userAnswer: text.trim(),
        verdict: v.verdict,
        feedback: v.feedback,
        // попытка после зачёта — пробная: зачёт не снимает и не даёт нового
        ...(passed ? { exploratory: true } : {}),
        createdAt: new Date(),
      });
      if (passed) {
        toast.info(v.verdict === 'pass' ? 'Пробная проверка: зачтено' : 'Пробная проверка: не зачтено — зачёт сохранён');
      } else if (v.verdict === 'pass') toast.success('Задача зачтена!');
      else toast.error('Задачу нужно доработать');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
    } finally {
      setBusy(false);
    }
  };

  const shown =
    retake && explorResult
      ? explorResult
      : result ?? (attempt
          ? { onTopic: true, solvable: true, answer: '', feedback: attempt.feedback ?? '', verdict: attempt.verdict as 'pass' | 'fail' }
          : null);

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
          {optional && ' В текущем режиме это испытание по желанию.'}
        </p>
        <Textarea
          placeholder="Например: «Велосипедист едет по закону s(t)=4t². Найти его скорость через 5 секунд…»"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          className="resize-none"
          disabled={busy}
        />
        <AnswerHelpers
          variant="own"
          onAppend={(chunk) => setText((prev) => appendChunk(prev ?? '', chunk))}
          disabled={busy || (passed && !retake)}
        />
        <PhotoOcr
          mode="full"
          label="Фото с решением"
          onInsert={(t) => setText((prev) => (prev ? `${prev}\n${t}` : t))}
          disabled={busy}
        />
        {passed && !retake && (
          <div className="flex flex-col gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 self-start px-2 text-xs text-muted-foreground"
              onClick={() => setRetake(true)}
            >
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Придумать другую задачу
            </Button>
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              Можно сформулировать другую задачу и увидеть новый разбор — зачёт сохранится.
            </p>
          </div>
        )}
        {(!passed || retake) && (
          <Button onClick={submit} disabled={busy} variant={passed ? 'outline' : 'default'}>
            {busy ? (
              'Проверяем…'
            ) : passed ? (
              <>
                <Send className="mr-1 h-4 w-4" /> Проверить (пробно)
              </>
            ) : (
              <>
                <Send className="mr-1 h-4 w-4" /> Отправить
              </>
            )}
          </Button>
        )}
        {shown && (
          <div className="flex flex-col gap-1.5">
            {retake && explorResult && (
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Пробная проверка · зачёт сохранён
              </p>
            )}
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
              {shown.answer && (
                <p className="mt-2 text-muted-foreground">
                  Ответ проверяющего:{' '}
                  <b className="text-foreground">
                    <RichText>{shown.answer}</RichText>
                  </b>
                </p>
              )}
              {shown.feedback && (
                <p className="mt-1.5 leading-snug text-muted-foreground">
                  <RichText>{shown.feedback}</RichText>
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============ Повторение (SRS) ============

function daysUntil(dueAt: Date, now: Date): number {
  return Math.ceil((dueAt.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Карточка интервального повторения освоенного узла.
 * Зачёт → попытка kind='review' (продвигает лестницу интервалов),
 * провал → попытка kind='task' с провалом (снимает освоенность узла).
 */
function ReviewCard({
  node,
  tasks,
  info,
  now,
  provider,
}: {
  node: IdeaNode;
  tasks: Task[];
  info: SrsInfo;
  now: Date;
  provider: ReturnType<typeof useAppStore.getState>['providers'][number] | null;
}) {
  const [reviewTaskId, setReviewTaskId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [choiceIdx, setChoiceIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [verdict, setVerdict] = useState<'pass' | 'fail' | null>(null);
  const [essayGrade, setEssayGrade] = useState<EssayGrade | null>(null);
  // интервал, зафиксированный в момент зачёта (info после записи попытки
  // уже учтёт зачёт — считать от него было бы двойным увеличением)
  const [passNextDays, setPassNextDays] = useState<number | null>(null);

  // Пул задач для проверки памяти: не битые; предпочтение — коротким
  // объективным форматам (exact/numeric/code), затем choice (правильный
  // вариант виден выше в зачтённой задаче), эссе — только если в узле нет
  // ничего другого: переписывать текст на повторении слишком дорого
  const pool = useMemo(() => {
    const ok = tasks.filter((t) => taskProblems(t).length === 0);
    const objective = ok.filter((t) => t.type !== 'essay');
    const shortAnswer = objective.filter((t) => t.type !== 'choice');
    const preferred = shortAnswer.length > 0 ? shortAnswer : objective.length > 0 ? objective : ok;
    return preferred.map((t) => t.id);
  }, [tasks]);

  const reviewTask = tasks.find((t) => t.id === reviewTaskId) ?? null;
  const instance = useMemo(() => (reviewTask ? instantiateTask(reviewTask) : null), [reviewTask]);
  const isEssay = reviewTask?.type === 'essay';
  const isCode = reviewTask?.type === 'code_output' || reviewTask?.type === 'code_fill';
  const choiceSpec = reviewTask?.answerSpec.kind === 'choice' ? reviewTask.answerSpec : null;

  const start = () => {
    if (pool.length === 0) return;
    setReviewTaskId(pool[Math.floor(Math.random() * pool.length)]);
    setInput('');
    setChoiceIdx(null);
    setVerdict(null);
    setEssayGrade(null);
  };

  const submit = async () => {
    if (!reviewTask || !instance) return;
    // интервал, который получит узел этим зачётом (info ещё «до зачёта»)
    const nextDays = intervalFor(info.reviewsDone + 1);
    if (isEssay) {
      const answer = input.trim();
      if (answer.length < 10) {
        toast.error('Напиши развёрнутый ответ своими словами');
        return;
      }
      setBusy(true);
      try {
        const grade = provider
          ? await checkEssayLLM(provider, reviewTask, node, answer)
          : gradeEssayLocal(reviewTask.answerSpec.kind === 'essay' ? reviewTask.answerSpec.expectation : [], answer);
        setEssayGrade(grade);
        setVerdict(grade.verdict);
        if (grade.verdict === 'pass') setPassNextDays(nextDays);
        await db.attempts.put({
          id: crypto.randomUUID(),
          materialId: node.materialId,
          nodeId: node.id,
          // зачёт повторения — отдельный вид попытки; провал падает в задачу
          // и существующими правилами снимает освоенность узла
          kind: grade.verdict === 'pass' ? 'review' : 'task',
          taskId: reviewTask.id,
          userAnswer: answer,
          verdict: grade.verdict,
          score: grade.score,
          feedback: grade.feedback,
          details: JSON.stringify({ missed: grade.missed, srs: true }),
          createdAt: new Date(),
        });
        if (grade.verdict === 'pass') toast.success('Память свежая — интервал продлён!');
        else toast.error('Идея забылась — узел снова в работе');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Ошибка проверки');
      } finally {
        setBusy(false);
      }
      return;
    }
    const userInput = reviewTask.type === 'choice' ? String(choiceIdx ?? -1) : input;
    const res = checkAnswer(instance, reviewTask.answerSpec, userInput);
    await db.attempts.put({
      id: crypto.randomUUID(),
      materialId: node.materialId,
      nodeId: node.id,
      kind: res.verdict === 'pass' ? 'review' : 'task',
      taskId: reviewTask.id,
      userAnswer:
        reviewTask.type === 'choice'
          ? choiceSpec
            ? choiceSpec.options[choiceIdx ?? -1] ?? '—'
            : userInput
          : userInput,
      verdict: res.verdict,
      details: JSON.stringify({ srs: true }),
      createdAt: new Date(),
    });
    setVerdict(res.verdict);
    if (res.verdict === 'pass') setPassNextDays(nextDays);
    if (res.verdict === 'pass') toast.success('Память свежая — интервал продлён!');
    else toast.error('Идея забылась — узел снова в работе');
  };

  return (
    <Card className={info.due ? 'border-sky-500/40 bg-sky-500/5' : undefined}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-500/15 text-sky-400">
            <History className="h-4 w-4" />
          </span>
          <p className="text-sm font-semibold">Повторение</p>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {info.reviewsDone > 0 ? `повторений: ${info.reviewsDone} · ` : ''}интервал {info.intervalDays} дн.
          </span>
        </div>

        {!reviewTask && (
          info.due ? (
            <>
              <p className="text-sm leading-snug text-muted-foreground">
                Идея освоена {fmtDay(info.masteredAt)} — пора освежить память. Ответь на одну задачу из узла: зачёт
                продлит интервал, провал вернёт идею в работу.
              </p>
              <Button size="sm" className="self-start" onClick={start} disabled={pool.length === 0}>
                <Play className="mr-1 h-4 w-4" /> Проверить память
              </Button>
            </>
          ) : (
            <p className="text-sm leading-snug text-muted-foreground">
              Следующее повторение: <b className="text-foreground">{fmtDay(info.dueAt)}</b>
              {` `}(через {daysUntil(info.dueAt, now)} дн.).
            </p>
          )
        )}

        {reviewTask && instance && (
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-snug">
              <RichText>{instance.renderedPrompt}</RichText>
            </p>
            {isCode && reviewTask.code && <CodeBlock code={reviewTask.code} />}

            {choiceSpec ? (
              <div className="flex flex-col gap-1.5">
                {choiceSpec.options.map((opt, i) => (
                  <button
                    key={i}
                    disabled={busy || verdict !== null}
                    onClick={() => setChoiceIdx(i)}
                    className={cn(
                      'rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                      choiceIdx === i ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/40'
                    )}
                  >
                    <RichText>{opt}</RichText>
                  </button>
                ))}
              </div>
            ) : isEssay ? (
              <div className="flex flex-col gap-2">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={busy || verdict !== null}
                  placeholder="Краткий ответ своими словами…"
                  rows={4}
                  className="resize-none"
                />
                {verdict === null && (
                  <AnswerHelpers
                    variant="review"
                    onAppend={(chunk) => setInput((prev) => appendChunk(prev ?? '', chunk))}
                    disabled={busy}
                  />
                )}
              </div>
            ) : (
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && verdict === null && !busy && submit()}
                disabled={busy || verdict !== null}
                placeholder={isCode ? 'Вывод программы' : 'Ответ'}
                inputMode="text"
                className={cn(
                  'h-10 rounded-lg border border-input bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground focus:border-primary',
                  isCode && 'font-mono'
                )}
              />
            )}

            {verdict === null && (
              <Button size="sm" className="self-start" onClick={submit} disabled={busy}>
                {busy ? 'Проверяем…' : 'Ответить'}
              </Button>
            )}

            {verdict === 'pass' && (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-sm text-emerald-300">
                Память свежая! Следующее повторение — через {passNextDays ?? info.intervalDays} дн.
              </div>
            )}
            {verdict === 'fail' && isEssay && essayGrade && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="secondary" className="gap-1">Раскрыто {Math.round(essayGrade.score * 100)}%</Badge>
                  <span className="ml-auto flex items-center gap-1 text-xs font-medium text-amber-400">
                    <XCircle className="h-4 w-4" /> идея забылась
                  </span>
                </div>
                {essayGrade.feedback && (
                  <p className="mt-1.5 leading-snug text-muted-foreground">
                    <RichText>{essayGrade.feedback}</RichText>
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        <p className="text-[11px] leading-snug text-muted-foreground/80">
          Зачёты повторений продлевают интервал: {SRS_LADDER_DAYS.join(' → ')} дней. Провал возвращает идею в работу.
        </p>
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
