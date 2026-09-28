'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowRight, FileText, Loader2, Map as MapIcon, Save, Sparkles, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { db } from '@/lib/db';
import { useAppStore } from '@/store/useAppStore';
import { ingestSplitIntoIdeas, genTasksForAtom, generatedToTask, validateIngest } from '@/lib/llm-ops';
import { hasCycle } from '@/lib/progress';
import { normalizeText } from '@/lib/safeMath';
import { getPathToRoot, nextOrderIndex } from '@/lib/maps';
import type { EdgeKind, IdeaEdge, IdeaNode, Material, Region, Task } from '@/lib/types';
import { v4 as uuid } from 'uuid';

type Phase = 'input' | 'parsing' | 'review' | 'tasks';

export default function ImportPanel() {
  const providers = useAppStore((s) => s.providers);
  const activeProvider = providers.find((p) => p.isActive) ?? null;
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const ingestResult = useAppStore((s) => s.ingestResult);
  const ingestTitle = useAppStore((s) => s.ingestTitle);
  const ingestSourceText = useAppStore((s) => s.ingestSourceText);
  const setIngestDraft = useAppStore((s) => s.setIngestDraft);
  const setIngestResult = useAppStore((s) => s.setIngestResult);
  const setActiveMaterialId = useAppStore((s) => s.setActiveMaterialId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [phase, setPhase] = useState<Phase>('input');
  const [progressMsg, setProgressMsg] = useState('');
  const [progressVal, setProgressVal] = useState(0);

  const materials = useLiveQuery(() => db.materials.toArray(), []);
  // куда поместить новую карту: 'root' или id существующей карты
  const [parentChoice, setParentChoice] = useState<string | null>(null);
  const effectiveParent = parentChoice ?? (activeMaterialId && materials?.some((m) => m.id === activeMaterialId) ? activeMaterialId : 'root');

  const startParse = async () => {
    if (!activeProvider) {
      toast.error('Сначала подключи LLM-провайдера во вкладке «Настройки»');
      return;
    }
    if (ingestTitle.trim().length < 3) {
      toast.error('Укажи название материала');
      return;
    }
    if (ingestSourceText.trim().length < 500) {
      toast.error('Текст слишком короткий: нужно хотя бы ~500 знаков содержательной части');
      return;
    }
    setPhase('parsing');
    setProgressMsg('Разбираю текст на атомы идей…');
    setProgressVal(10);
    try {
      const result = await ingestSplitIntoIdeas(activeProvider, ingestTitle.trim(), ingestSourceText.trim());
      setProgressVal(45);
      const check = validateIngest(result);
      if (!check.ok) throw new Error(check.message);
      setIngestResult(result);
      setPhase('review');
      toast.success(`Готово: ${check.message}. Проверь и сохрани.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось разобрать материал');
      setPhase('input');
    }
  };

  const saveMaterial = async () => {
    if (!ingestResult) return;
    setPhase('tasks');
    const materialId = uuid();
    const now = new Date();
    try {
      // Регионы
      const regions: Region[] = ingestResult.regions.map((r, i) => ({
        id: uuid(),
        materialId,
        title: r.title || `Раздел ${i + 1}`,
        orderIndex: i,
      }));

      // Узлы
      const nodes: IdeaNode[] = ingestResult.atoms.slice(0, 15).map((a, i) => ({
        id: uuid(),
        materialId,
        regionId: regions[Math.min(a.regionIndex, regions.length - 1)].id,
        title: a.title,
        formulation: a.formulation,
        example: a.example,
        misconception: a.misconception || undefined,
        sourceRef: a.sourceQuote || undefined,
        feynmanQuestion: a.feynmanQuestion || `Объясни своими словами: ${a.formulation}`,
        keyTerms: Array.isArray(a.keyTerms) ? a.keyTerms.slice(0, 6) : [],
        orderIndex: i,
        createdAt: now,
      }));

      // Рёбра по needs (сопоставление по нормализованному названию)
      const byTitle = new Map<string, string>(nodes.map((n) => [normalizeText(n.title), n.id]));
      const edges: IdeaEdge[] = [];
      nodes.forEach((n, i) => {
        const atom = ingestResult.atoms[i];
        for (const need of atom.needs ?? []) {
          const fromId = byTitle.get(normalizeText(need.title));
          if (!fromId || fromId === n.id) continue;
          let kind: EdgeKind = need.kind === 'soft' ? 'soft' : 'hard';
          // защита от циклов в hard-рёбрах
          if (kind === 'hard') {
            const test = [...edges, { id: 'test', materialId, fromNodeId: fromId, toNodeId: n.id, kind }];
            if (hasCycle(nodes, test as IdeaEdge[])) kind = 'soft';
          }
          edges.push({ id: uuid(), materialId, fromNodeId: fromId, toNodeId: n.id, kind });
        }
      });

      await db.materials.put({
        id: materialId,
        title: ingestTitle.trim(),
        sourceText: ingestSourceText.trim(),
        createdAt: now,
        parentId: effectiveParent === 'root' ? null : effectiveParent,
        orderIndex: nextOrderIndex(materials ?? [], effectiveParent === 'root' ? null : effectiveParent),
      });
      await db.regions.bulkPut(regions);
      await db.nodes.bulkPut(nodes);
      await db.edges.bulkPut(edges);

      // Задачи: последовательно по атомам
      for (let i = 0; i < nodes.length; i++) {
        setProgressMsg(`Генерирую задачи для идеи ${i + 1}/${nodes.length}: «${nodes[i].title}»`);
        setProgressVal(60 + Math.round((i / nodes.length) * 40));
        try {
          const gen = await genTasksForAtom(
            activeProvider!,
            { title: nodes[i].title, formulation: nodes[i].formulation, example: nodes[i].example },
            ingestResult.atoms[i].sourceQuote
          );
          if (gen.feynmanQuestion) {
            await db.nodes.update(nodes[i].id, { feynmanQuestion: gen.feynmanQuestion });
          }
          const tasks: Task[] = gen.tasks.slice(0, 3).map((gt, ti) =>
            generatedToTask(gt, { id: uuid(), nodeId: nodes[i].id, materialId, orderIndex: ti })
          );
          await db.tasks.bulkPut(tasks);
        } catch {
          // генерация задач для одного атома не должна валить весь импорт
          toast.warning(`Задачи для «${nodes[i].title}» не сгенерировались — можно добавить позже`);
        }
      }

      await setActiveMaterialId(materialId);
      setIngestResult(null);
      setIngestDraft('', '');
      setPhase('input');
      toast.success(
        effectiveParent === 'root'
          ? 'Карта сохранена в корне дерева карт!'
          : 'Карта сохранена как подраздел!'
      );
      setActiveTab('map');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка сохранения');
      setPhase('review');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">Импорт материала</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Вставь текст учебника/статьи — LLM выделит атомы идей, построит граф зависимостей и сгенерирует задания.
        </p>
      </header>

      {!activeProvider && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            LLM-провайдер не подключён. Импорт требует модель: открой «Настройки» и добавь OpenAI-совместимого
            провайдера (OpenRouter, OpenAI, локальный vLLM/Ollama).
          </p>
        </div>
      )}

      {(phase === 'input' || phase === 'parsing') && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Название материала</label>
              <Input
                value={ingestTitle}
                onChange={(e) => setIngestDraft(e.target.value, ingestSourceText)}
                placeholder="Например: Лекции по кинематике"
                disabled={phase !== 'input'}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Куда поместить новую карту
              </label>
              <Select value={effectiveParent} onValueChange={setParentChoice} disabled={phase !== 'input'}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Выбери место" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">
                    <span className="flex items-center gap-2">
                      <MapIcon className="h-3.5 w-3.5" /> Новая карта в корне
                    </span>
                  </SelectItem>
                  {(materials ?? []).map((m: Material) => {
                    const depth = getPathToRoot(materials ?? [], m.id).length - 1;
                    return (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="flex items-center gap-2 truncate">
                          {'— '.repeat(depth)}
                          <MapIcon className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                          {m.title}
                          {m.id === activeMaterialId ? ' (текущая)' : ''}
                        </span>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Текст материала ({ingestSourceText.length} знаков)
              </label>
              <Textarea
                value={ingestSourceText}
                onChange={(e) => setIngestDraft(ingestTitle, e.target.value)}
                placeholder="Вставь сюда главу учебника, статью или конспект…"
                rows={10}
                className="resize-none"
                disabled={phase !== 'input'}
              />
            </div>
            {phase === 'input' ? (
              <Button onClick={startParse} disabled={!activeProvider}>
                <Sparkles className="mr-1 h-4 w-4" /> Разобрать на атомы
              </Button>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <p className="flex items-center gap-2 text-sm text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" /> {progressMsg}
                </p>
                <Progress value={progressVal} className="h-1.5" />
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {phase === 'review' && ingestResult && (
        <ReviewList onBack={() => setPhase('input')} onSave={saveMaterial} />
      )}

      {phase === 'tasks' && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <p className="flex items-center gap-2 text-sm text-primary">
              <Loader2 className="h-4 w-4 animate-spin" /> {progressMsg}
            </p>
            <Progress value={progressVal} className="h-1.5" />
            <p className="text-xs text-muted-foreground">Не закрывай приложение — создаётся база заданий.</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
            <FileText className="h-3.5 w-3.5" /> Демо-курс уже загружен
          </p>
          При первом запуске в систему добавлен демо-курс «Алгебра и начала анализа: Производная» — 12 атомов идей,
          гибридный граф зависимостей и 24 параметрические задачи с автопроверкой. Его можно пройти целиком без LLM:
          локальный демо-оценщик проверит фейнмановские объяснения. Импортированный материал станет отдельной картой
          (можно вложить в существующую) — все карты доступны через кнопку «Карты».
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewList({ onBack, onSave }: { onBack: () => void; onSave: () => void }) {
  const ingestResult = useAppStore((s) => s.ingestResult)!;
  const setIngestResult = useAppStore((s) => s.setIngestResult);

  const updateAtom = (idx: number, patch: Partial<(typeof ingestResult.atoms)[number]>) => {
    const atoms = [...ingestResult.atoms];
    atoms[idx] = { ...atoms[idx], ...patch };
    setIngestResult({ ...ingestResult, atoms });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">
          Ревью: {ingestResult.atoms.length} атомов, {ingestResult.regions.length} регионов
        </h2>
      </div>
      {ingestResult.atoms.slice(0, 15).map((a, i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-2 p-4">
            <Input value={a.title} onChange={(e) => updateAtom(i, { title: e.target.value })} className="font-medium" />
            <Textarea
              value={a.formulation}
              onChange={(e) => updateAtom(i, { formulation: e.target.value })}
              rows={2}
              className="resize-none text-sm"
            />
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <Badge variant="secondary">{ingestResult.regions[a.regionIndex]?.title ?? '—'}</Badge>
              {(a.needs ?? []).map((n, j) => (
                <Badge key={j} variant="outline" className="gap-1">
                  <ArrowRight className="h-3 w-3" /> {n.title} ({n.kind})
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
      <div className="flex gap-2 pb-2">
        <Button variant="outline" onClick={onBack} className="flex-1">Назад</Button>
        <Button onClick={onSave} className="flex-1">
          <Save className="mr-1 h-4 w-4" /> Сохранить и сгенерировать задачи
        </Button>
      </div>
    </div>
  );
}
