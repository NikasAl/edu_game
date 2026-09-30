'use client';

import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  Link2,
  Loader2,
  Map as MapIcon,
  Save,
  Sparkles,
  TriangleAlert,
  Type,
} from 'lucide-react';
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
import { extractFromPdf, extractFromUrl, type ExtractedSection } from '@/lib/extract';
import type { EdgeKind, IdeaEdge, IdeaNode, Material, Region, Task } from '@/lib/types';
import { v4 as uuid } from 'uuid';

type Phase = 'input' | 'extract' | 'parsing' | 'review' | 'tasks';
type SourceMode = 'paste' | 'url' | 'pdf';

/** За один раз в анализ попадает не больше этого числа знаков (см. llm-ops) */
const ANALYZE_LIMIT = 24000;

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

  // источники текста
  const [sourceMode, setSourceMode] = useState<SourceMode>('paste');
  const [urlValue, setUrlValue] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // фаза выбора секций (URL/PDF)
  const [extractTitle, setExtractTitle] = useState('');
  const [extractSource, setExtractSource] = useState('');
  const [sections, setSections] = useState<ExtractedSection[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [openSectionId, setOpenSectionId] = useState<string | null>(null);

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

  // ============ Извлечение из URL / PDF ============

  const openExtract = (res: { title: string; sections: ExtractedSection[]; warning?: string; viaReader?: boolean }, sourceLabel: string) => {
    if (res.sections.length === 0) {
      toast.error('Не удалось извлечь текст: нет подходящих разделов');
      return;
    }
    setExtractTitle(res.title || '');
    setExtractSource(sourceLabel);
    setSections(res.sections);
    setSelectedIds(new Set(res.sections.map((s) => s.id)));
    setOpenSectionId(res.sections.length === 1 ? res.sections[0].id : null);
    setPhase('extract');
    if (res.warning) toast.warning(res.warning);
    if (res.viaReader) toast.info('Прямая загрузка заблокирована (CORS) — текст получен через reader-прокси');
  };

  const runUrl = async () => {
    if (!/^https?:\/\//i.test(urlValue.trim())) {
      toast.error('Введи ссылку, начинающуюся с http:// или https://');
      return;
    }
    setUrlBusy(true);
    try {
      const res = await extractFromUrl(urlValue.trim());
      openExtract(res, urlValue.trim());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось загрузить страницу');
    } finally {
      setUrlBusy(false);
    }
  };

  const runPdf = async (file: File) => {
    setPdfBusy(true);
    setProgressMsg('Читаю PDF…');
    try {
      const buf = await file.arrayBuffer();
      const res = await extractFromPdf(buf, file.name, setProgressMsg);
      openExtract(res, file.name);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось разобрать PDF');
    } finally {
      setPdfBusy(false);
    }
  };

  const toggleSection = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedSections = sections.filter((s) => selectedIds.has(s.id));
  const selectedChars = selectedSections.reduce((n, s) => n + s.text.length, 0);

  const applyExtract = () => {
    if (selectedSections.length === 0) {
      toast.error('Отметь хотя бы один раздел');
      return;
    }
    const text = selectedSections.map((s) => s.text.trim()).join('\n\n');
    if (text.trim().length < 500) {
      toast.error('Выбрано слишком мало текста: нужно хотя бы ~500 знаков');
      return;
    }
    setIngestDraft(extractTitle.trim() || ingestTitle, text);
    setSourceMode('paste');
    setPhase('input');
    toast.success(
      `Добавлено разделов: ${selectedSections.length} (${text.length} знаков). Проверь текст и нажми «Разобрать на атомы»`
    );
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

  const SOURCE_TABS: { id: SourceMode; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'paste', label: 'Текст', icon: Type },
    { id: 'url', label: 'Ссылка', icon: Link2 },
    { id: 'pdf', label: 'PDF', icon: FileText },
  ];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">Импорт материала</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Вставь текст, укажи ссылку на статью или загрузи PDF — LLM выделит атомы идей, построит граф зависимостей
          и сгенерирует задания.
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

      {/* ============ Фаза выбора секций извлечения ============ */}
      {phase === 'extract' && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">Источник: {extractSource}</p>
              <label className="mb-1.5 mt-2 block text-xs font-medium text-muted-foreground">
                Название материала
              </label>
              <Input
                value={extractTitle}
                onChange={(e) => setExtractTitle(e.target.value)}
                placeholder="Название — заполнено из источника, можно поправить"
              />
            </div>

            <div className="flex items-center justify-between text-xs">
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  onClick={() => setSelectedIds(new Set(sections.map((s) => s.id)))}
                >
                  Выбрать все
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setSelectedIds(new Set())}
                >
                  Снять все
                </Button>
              </div>
              <Badge variant={selectedChars > ANALYZE_LIMIT ? 'destructive' : 'secondary'}>
                {selectedSections.length}/{sections.length} · {selectedChars.toLocaleString('ru-RU')} знаков
              </Badge>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Отметь разделы, из которых собрать материал — по каждому доступен предпросмотр. В анализ за один раз
              попадает до ~{ANALYZE_LIMIT.toLocaleString('ru-RU')} знаков: большой документ лучше импортировать
              несколькими картами.
            </p>

            <div className="flex flex-col gap-1">
              {sections.map((s) => {
                const selected = selectedIds.has(s.id);
                const open = openSectionId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`rounded-lg border transition-colors ${
                      selected ? 'border-primary/40 bg-primary/5' : 'border-border bg-card'
                    }`}
                  >
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button
                        onClick={() => toggleSection(s.id)}
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                          selected ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                        }`}
                        aria-label={selected ? 'Снять отметку' : 'Отметить раздел'}
                        aria-pressed={selected}
                      >
                        {selected && <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        onClick={() => setOpenSectionId(open ? null : s.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        title="Предпросмотр текста"
                      >
                        {open ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        )}
                        <span className={`truncate text-sm ${selected ? '' : 'text-muted-foreground'}`}>
                          {s.title}
                        </span>
                      </button>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {s.text.length.toLocaleString('ru-RU')}
                      </span>
                    </div>
                    {open && (
                      <pre className="mx-2 mb-2 max-h-40 overflow-y-auto thin-scroll whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
                        {s.text}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  setPhase('input');
                  setSections([]);
                  setSelectedIds(new Set());
                }}
              >
                Отмена
              </Button>
              <Button className="flex-1" onClick={applyExtract} disabled={selectedSections.length === 0}>
                <ArrowRight className="mr-1 h-4 w-4" /> Применить выбранные
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ============ Фаза ввода ============ */}
      {(phase === 'input' || phase === 'parsing') && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Источник текста</label>
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1">
                {SOURCE_TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    onClick={() => setSourceMode(id)}
                    disabled={phase !== 'input'}
                    className={`flex min-h-[36px] items-center justify-center gap-1.5 rounded-lg px-2 text-xs transition-colors ${
                      sourceMode === id
                        ? 'bg-card font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    } ${phase !== 'input' ? 'opacity-60' : ''}`}
                    aria-pressed={sourceMode === id}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                ))}
              </div>
            </div>

            {sourceMode === 'url' && (
              <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/30 p-3">
                <Input
                  value={urlValue}
                  onChange={(e) => setUrlValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !urlBusy) void runUrl();
                  }}
                  placeholder="https://example.com/article"
                  inputMode="url"
                  disabled={urlBusy}
                />
                <div className="flex items-center gap-2">
                  <Button className="flex-1" onClick={() => void runUrl()} disabled={urlBusy}>
                    {urlBusy ? (
                      <>
                        <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Загружаю…
                      </>
                    ) : (
                      <>
                        <Link2 className="mr-1 h-4 w-4" /> Загрузить статью
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Статья будет разбита по заголовкам на разделы — выбери нужные. На Android загрузка идёт через
                  нативный HTTP без CORS; в браузере при блокировке — через reader-прокси.
                </p>
              </div>
            )}

            {sourceMode === 'pdf' && (
              <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-muted/30 p-3">
                <input
                  ref={pdfInputRef}
                  type="file"
                  accept=".pdf,application/pdf"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void runPdf(f);
                    e.target.value = '';
                  }}
                />
                <Button className="w-full" onClick={() => pdfInputRef.current?.click()} disabled={pdfBusy}>
                  {pdfBusy ? (
                    <>
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" /> {progressMsg || 'Читаю PDF…'}
                    </>
                  ) : (
                    <>
                      <FileText className="mr-1 h-4 w-4" /> Выбрать PDF-файл
                    </>
                  )}
                </Button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Подходят PDF с текстовым слоем. Если в файле есть оглавление — разделы создадутся по его пунктам,
                  иначе по страницам. Сканы страниц без текста не поддерживаются.
                </p>
              </div>
            )}

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
                Текст материала ({ingestSourceText.length.toLocaleString('ru-RU')} знаков)
              </label>
              <Textarea
                value={ingestSourceText}
                onChange={(e) => setIngestDraft(ingestTitle, e.target.value)}
                placeholder={
                  sourceMode === 'paste'
                    ? 'Вставь сюда главу учебника, статью или конспект…'
                    : 'Поле заполнится после выбора разделов из источника — потом можно подредактировать'
                }
                rows={sourceMode === 'paste' ? 10 : 6}
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
          (можно вложить в существующую) — все карты собраны во вкладке «Карты».
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
