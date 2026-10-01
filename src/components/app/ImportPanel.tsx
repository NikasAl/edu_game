'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  ImageOff,
  Link2,
  Loader2,
  Map as MapIcon,
  Minus,
  Save,
  ScanText,
  Sparkles,
  TriangleAlert,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { db, getMeta } from '@/lib/db';
import { useAppStore } from '@/store/useAppStore';
import {
  INGEST_DETAIL_META,
  genTasksForAtom,
  generatedToTask,
  ingestSplitIntoIdeasChunked,
  ocrTextbookPage,
  validateIngest,
  type IngestDetail,
} from '@/lib/llm-ops';
import { hasCycle } from '@/lib/progress';
import { normalizeText } from '@/lib/safeMath';
import { getPathToRoot, nextOrderIndex } from '@/lib/maps';
import {
  extractFromPdf,
  extractFromUrl,
  openPdf,
  pdfPageSpans,
  renderPdfPageToDataUrl,
  type ExtractedSection,
  type OpenedPdf,
  type PdfDoc,
} from '@/lib/extract';
import type { EdgeKind, IdeaEdge, IdeaNode, LLMProvider, Material, Region, Task } from '@/lib/types';
import { v4 as uuid } from 'uuid';

type Phase = 'input' | 'extract' | 'pdfOcr' | 'parsing' | 'review' | 'tasks';
type SourceMode = 'paste' | 'url' | 'pdf';

/** Диапазон страниц PDF для OCR-режима */
type OcrSpan = { id: string; title: string; from: number; to: number };

/**
 * Разрешение картинки, отправляемой в vision-модель на распознавание.
 * Модели сами ужимают вход до ~1–2 тыс. px — если отдать страницу мелкой,
 * текст на ней становится нечитаемым, поэтому рендерим крупно.
 */
const OCR_RENDER_WIDTH = 2200;
const OCR_RENDER_QUALITY = 0.9;

/** Столько атомов показывается в ревью и сохраняется (остальные отбрасываются) */
const MAX_ATOMS = 60;

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

  // детализация выделения идей (размер фрагментов при анализе)
  const [detail, setDetail] = useState<IngestDetail>('normal');

  // источники текста
  const [sourceMode, setSourceMode] = useState<SourceMode>('paste');
  const [urlValue, setUrlValue] = useState('');
  const [urlBusy, setUrlBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const pdfInputRef = useRef<HTMLInputElement>(null);

  // LLM OCR для PDF (сканы / сломанный текстовый слой)
  const [pdfOcrMode, setPdfOcrMode] = useState(false);
  const [ocrSpans, setOcrSpans] = useState<OcrSpan[]>([]);
  // выбор ПОСТРАНИЧНЫЙ: пользователь может взять отдельные страницы из группы
  const [ocrSelectedPages, setOcrSelectedPages] = useState<Set<number>>(new Set());
  // увеличенный предпросмотр одной страницы (диалог)
  const [previewPage, setPreviewPage] = useState<number | null>(null);
  const [ocrNumPages, setOcrNumPages] = useState(0);
  const [ocrSource, setOcrSource] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const pdfDocRef = useRef<OpenedPdf | null>(null);
  /** PDF-документ для рендера (реактивная копия ref — доступна в JSX) */
  const [ocrDoc, setOcrDoc] = useState<PdfDoc | null>(null);
  const ocrCancelRef = useRef(false);

  // OCR-провайдер — тот же, что и для «OCR с фото» (Настройки → OCR с фото)
  const [ocrProviderId, setOcrProviderId] = useState('');
  const [ocrModel, setOcrModel] = useState('');
  useEffect(() => {
    void getMeta('ocrProviderId').then((v) => v && setOcrProviderId(v));
    void getMeta('ocrModel').then((v) => v && setOcrModel(v));
  }, []);
  const ocrProvider: LLMProvider | null = useMemo(() => {
    const base = (ocrProviderId && providers.find((p) => p.id === ocrProviderId)) || activeProvider;
    if (!base) return null;
    return ocrModel.trim() ? { ...base, model: ocrModel.trim() } : base;
  }, [ocrProviderId, ocrModel, providers, activeProvider]);

  // закрыть PDF при уходе со вкладки — иначе воркер pdf.js остаётся в памяти
  useEffect(
    () => () => {
      void pdfDocRef.current?.destroy();
      pdfDocRef.current = null;
    },
    []
  );

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
      const result = await ingestSplitIntoIdeasChunked(
        activeProvider,
        ingestTitle.trim(),
        ingestSourceText.trim(),
        detail,
        (done, total) => {
          setProgressMsg(
            total > 1
              ? `Разбираю на атомы: фрагмент ${Math.min(done + 1, total)} из ${total}…`
              : 'Разбираю текст на атомы идей…'
          );
          setProgressVal(10 + Math.round((Math.min(done, total) / total) * 30));
        }
      );
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
    try {
      const buf = await file.arrayBuffer();
      if (pdfOcrMode) {
        // LLM OCR: открыть документ, показать диапазоны страниц для выбора
        setProgressMsg('Открываю PDF…');
        const opened = await openPdf(buf);
        pdfDocRef.current = opened;
        setOcrDoc(opened.doc);
        const info = await pdfPageSpans(opened.doc, file.name);
        setOcrSource(file.name);
        setOcrNumPages(info.numPages);
        setOcrSpans(info.spans.map((s, i) => ({ ...s, id: `sp${i}` })));
        setExtractTitle(info.title);
        // маленькие документы отмечаем целиком, большие — выбор за пользователем
        setOcrSelectedPages(
          info.numPages <= 6 ? new Set(Array.from({ length: info.numPages }, (_, i) => i + 1)) : new Set()
        );
        setPhase('pdfOcr');
      } else {
        setProgressMsg('Читаю PDF…');
        const res = await extractFromPdf(buf, file.name, setProgressMsg);
        openExtract(res, file.name);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось разобрать PDF');
    } finally {
      setPdfBusy(false);
    }
  };

  const closePdfDoc = () => {
    void pdfDocRef.current?.destroy();
    pdfDocRef.current = null;
    setOcrDoc(null);
  };

  const toggleOcrPage = (page: number) => {
    setOcrSelectedPages((prev) => {
      const next = new Set(prev);
      if (next.has(page)) next.delete(page);
      else next.add(page);
      return next;
    });
  };

  /** Чекбокс группы: всё выбрано → снять; иначе отметить всю группу */
  const toggleOcrGroup = (from: number, to: number) => {
    setOcrSelectedPages((prev) => {
      const next = new Set(prev);
      const pages = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      const allSelected = pages.every((p) => next.has(p));
      for (const p of pages) {
        if (allSelected) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  };

  const ocrSelectedCount = ocrSelectedPages.size;

  /** Группы страниц для отображения: секции оглавления; одиночные авто-страницы
   *  («Страница N» без оглавления) сливаются в один сплошной список миниатюр */
  const ocrGroups = useMemo(() => {
    const groups: { key: string; title: string | null; pages: number[] }[] = [];
    const maxPage = ocrNumPages || Number.MAX_SAFE_INTEGER;
    for (const sp of ocrSpans) {
      const to = Math.min(sp.to, maxPage);
      const pages = Array.from({ length: Math.max(0, to - sp.from + 1) }, (_, i) => sp.from + i);
      if (pages.length === 0) continue;
      const isAutoSingle = pages.length === 1 && /^Страница \d+$/.test(sp.title);
      const prev = groups[groups.length - 1];
      if (isAutoSingle && prev && prev.title === null) {
        prev.pages.push(...pages);
      } else {
        groups.push({ key: sp.id, title: isAutoSingle ? null : sp.title || null, pages });
      }
    }
    return groups;
  }, [ocrSpans, ocrNumPages]);

  const runPdfOcr = async () => {
    const opened = pdfDocRef.current;
    if (!opened) return;
    const doc = opened.doc;
    if (!ocrProvider) {
      toast.error('Нужен LLM-провайдер с vision-моделью — настрой его в «Настройки → OCR с фото»');
      return;
    }
    const selected = [...ocrSelectedPages].sort((a, b) => a - b);
    if (selected.length === 0) {
      toast.error('Отметь хотя бы одну страницу');
      return;
    }
    if (selected.length > 40) {
      toast.warning(`${selected.length} страниц — распознавание займёт много времени и токенов`);
    }
    setOcrBusy(true);
    setProgressVal(0);
    ocrCancelRef.current = false;
    const sections: ExtractedSection[] = [];
    try {
      let done = 0;
      let cancelled = false;
      for (const sp of ocrSpans) {
        if (cancelled) break;
        const lastPage = Math.min(sp.to, doc.numPages);
        const pagesInSpan = selected.filter((p) => p >= sp.from && p <= lastPage);
        if (pagesInSpan.length === 0) continue;
        const texts: string[] = [];
        for (const p of pagesInSpan) {
          if (ocrCancelRef.current) {
            cancelled = true;
            break;
          }
          setProgressMsg(`OCR: страница ${p} (${done + 1}/${selected.length})…`);
          try {
            const dataUrl = await renderPdfPageToDataUrl(doc, p, OCR_RENDER_WIDTH, OCR_RENDER_QUALITY);
            const text = await ocrTextbookPage(ocrProvider, dataUrl);
            texts.push(text.trim().length > 0 ? text : `[страница ${p}: модель вернула пустой ответ]`);
          } catch (e) {
            texts.push(`[страница ${p} не распознана: ${e instanceof Error ? e.message : 'ошибка'}]`);
          }
          done++;
          setProgressVal(Math.round((done / selected.length) * 100));
        }
        const text = texts.join('\n\n').trim();
        if (text.length > 0) {
          sections.push({
            id: `sec${sections.length}`,
            title: sp.title || `Раздел ${sections.length + 1}`,
            text,
          });
        }
      }
      if (sections.length === 0) {
        toast.error('Ни одна страница не распознана');
        setPhase('input');
      } else {
        openExtract(
          {
            title: extractTitle,
            sections,
            warning: cancelled
              ? 'Распознавание прервано — применены уже распознанные разделы'
              : undefined,
          },
          `${ocrSource} · LLM OCR`
        );
        setPhase('extract');
      }
    } finally {
      setOcrBusy(false);
      closePdfDoc();
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
      const nodes: IdeaNode[] = ingestResult.atoms.slice(0, MAX_ATOMS).map((a, i) => ({
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

      {/* ============ Фаза выбора страниц для LLM OCR ============ */}
      {phase === 'pdfOcr' && (
        <>
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <div>
              <p className="text-xs text-muted-foreground">
                Файл: {ocrSource} · {ocrNumPages} стр.
              </p>
              <p className="mt-2 text-sm font-medium">Какие страницы распознать через LLM OCR?</p>
            </div>

            {!ocrProvider && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-300">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Для OCR нужна vision-модель. Подключи провайдера и выбери модель в «Настройки →
                  OCR с фото».
                </p>
              </div>
            )}
            {ocrProvider && (
              <p className="text-[11px] text-muted-foreground">
                Распознавать будет:{' '}
                <span className="font-medium text-foreground">
                  {ocrProvider.name} · {ocrProvider.model}
                </span>{' '}
                (меняется в «Настройки → OCR с фото»)
              </p>
            )}

            <div className="flex items-center justify-between text-xs">
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2"
                  onClick={() =>
                    setOcrSelectedPages(new Set(Array.from({ length: ocrNumPages }, (_, i) => i + 1)))
                  }
                >
                  Выбрать все
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => setOcrSelectedPages(new Set())}
                >
                  Снять все
                </Button>
              </div>
              <Badge variant={ocrSelectedCount > 40 ? 'destructive' : 'secondary'}>
                {ocrSelectedCount} стр.
              </Badge>
            </div>

            {/* Группы страниц: заголовок секции + миниатюры с постраничным выбором */}
            <div className="flex flex-col gap-3">
              {ocrGroups.map((g) => {
                const groupFrom = g.pages[0];
                const groupTo = g.pages[g.pages.length - 1];
                const allSel = g.pages.every((p) => ocrSelectedPages.has(p));
                const someSel = g.pages.some((p) => ocrSelectedPages.has(p));
                return (
                  <div key={g.key}>
                    {g.title && (
                      <div className="mb-1.5 flex items-center gap-2">
                        <button
                          onClick={() => toggleOcrGroup(groupFrom, groupTo)}
                          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                            allSel
                              ? 'border-primary bg-primary text-primary-foreground'
                              : someSel
                                ? 'border-primary/60 bg-primary/20 text-primary'
                                : 'border-muted-foreground/40'
                          }`}
                          aria-label={allSel ? 'Снять всю группу' : 'Отметить всю группу'}
                          aria-pressed={allSel}
                        >
                          {allSel ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : someSel ? (
                            <Minus className="h-3.5 w-3.5" />
                          ) : null}
                        </button>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium">{g.title}</span>
                        <span className="shrink-0 text-[11px] text-muted-foreground">
                          {g.pages.length === 1
                            ? `стр. ${groupFrom}`
                            : `стр. ${groupFrom}–${groupTo}`}
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-2">
                      {g.pages.map((p) => (
                        <PageThumb
                          key={p}
                          doc={ocrDoc}
                          page={p}
                          selected={ocrSelectedPages.has(p)}
                          onToggle={() => toggleOcrPage(p)}
                          onPreview={() => setPreviewPage(p)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Каждая страница — отдельный vision-запрос в высоком разрешении (~2200 px по ширине):
              формулы переводятся в LaTeX, колонтитулы отбрасываются. Нажми на глаз — увидишь
              страницу крупно: если текст не читается даже в предпросмотре, модель его тоже не
              разберёт. Отмечать можно отдельные страницы, не всю группу.
            </p>

            {ocrBusy ? (
              <div className="flex flex-col gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3">
                <p className="flex items-center gap-2 text-sm text-primary">
                  <Loader2 className="h-4 w-4 animate-spin" /> {progressMsg}
                </p>
                <Progress value={progressVal} className="h-1.5" />
                <Button variant="outline" size="sm" onClick={() => (ocrCancelRef.current = true)}>
                  Прервать и сохранить распознанное
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setPhase('input');
                    setOcrSpans([]);
                    setOcrSelectedPages(new Set());
                    closePdfDoc();
                  }}
                >
                  Отмена
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => void runPdfOcr()}
                  disabled={ocrSelectedCount === 0 || !ocrProvider}
                >
                  <ScanText className="mr-1 h-4 w-4" /> Распознать ({ocrSelectedCount} стр.)
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Увеличенный предпросмотр страницы — так её увидит модель */}
        <Dialog open={previewPage !== null} onOpenChange={(o) => !o && setPreviewPage(null)}>
          <DialogContent className="max-h-[90dvh] overflow-y-auto thin-scroll">
            <DialogHeader>
              <DialogTitle>Страница {previewPage} — предпросмотр</DialogTitle>
            </DialogHeader>
            {previewPage !== null && ocrDoc && (
              <OcrPagePreview key={previewPage} doc={ocrDoc} page={previewPage} />
            )}
            {previewPage !== null && (
              <Button
                variant={ocrSelectedPages.has(previewPage) ? 'outline' : 'default'}
                onClick={() => {
                  if (previewPage !== null) toggleOcrPage(previewPage);
                }}
              >
                {ocrSelectedPages.has(previewPage)
                  ? 'Не распознавать эту страницу'
                  : 'Распознавать эту страницу'}
              </Button>
            )}
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Рендер в том же разрешении, что и для OCR. Если текст здесь читается, но модель
              распознаёт плохо — попробуй другую vision-модель в «Настройки → OCR с фото».
            </p>
          </DialogContent>
        </Dialog>
        </>
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
              <Badge variant="secondary">
                {selectedSections.length}/{sections.length} · {selectedChars.toLocaleString('ru-RU')} знаков
              </Badge>
            </div>

            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Отметь разделы, из которых собрать материал — по каждому доступен предпросмотр.
              Длинный текст при анализе делится на фрагменты по выбранной детализации
              (~{INGEST_DETAIL_META[detail].chunkChars.toLocaleString('ru-RU')} знаков сейчас), так что
              большие разделы применять можно — модель пройдёт их по частям.
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
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted/60 p-1">
                  <button
                    onClick={() => setPdfOcrMode(false)}
                    disabled={pdfBusy}
                    className={`flex min-h-[34px] items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
                      !pdfOcrMode
                        ? 'bg-card font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    aria-pressed={!pdfOcrMode}
                  >
                    Текстовый слой
                  </button>
                  <button
                    onClick={() => setPdfOcrMode(true)}
                    disabled={pdfBusy}
                    className={`flex min-h-[34px] items-center justify-center gap-1.5 rounded-md px-2 text-xs transition-colors ${
                      pdfOcrMode
                        ? 'bg-card font-medium text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    aria-pressed={pdfOcrMode}
                  >
                    <ScanText className="h-4 w-4 shrink-0" />
                    LLM OCR
                  </button>
                </div>
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
                  {pdfOcrMode
                    ? 'Страницы распознаёт vision-модель (как «OCR с фото»): формулы переводятся в LaTeX. Для сканов и учебников со сломанным текстовым слоем. После выбора файла отметь нужные страницы.'
                    : 'Подходят PDF с текстовым слоем. Оглавление даст разделы по его пунктам, иначе — по страницам. Если вместо формул в тексте мусор — переключись на «LLM OCR».'}
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
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Детализация выделения идей
              </label>
              <Select
                value={detail}
                onValueChange={(v) => setDetail(v as IngestDetail)}
                disabled={phase !== 'input'}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">Крупно — только основные идеи</SelectItem>
                  <SelectItem value="normal">Обычный — сбалансированный охват</SelectItem>
                  <SelectItem value="detailed">Подробно — максимум идей</SelectItem>
                </SelectContent>
              </Select>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {INGEST_DETAIL_META[detail].hint}. Длинный текст делится на фрагменты, идеи
                выделяются по каждому и объединяются — так модель не пропускает важное на
                больших материалах.
              </p>
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
      {ingestResult.atoms.length > MAX_ATOMS && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-300">
          Показаны первые {MAX_ATOMS} из {ingestResult.atoms.length} атомов — при сохранении
          остальные будут отброшены. Лучше импортируй материал частями или снизь детализацию.
        </p>
      )}
      {ingestResult.atoms.slice(0, MAX_ATOMS).map((a, i) => (
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

/** Миниатюра страницы PDF с ленивой отрисовкой по мере прокрутки */
function PageThumb({
  doc,
  page,
  selected,
  onToggle,
  onPreview,
}: {
  doc: PdfDoc | null;
  page: number;
  selected: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!doc) return;
    const el = ref.current;
    if (!el) return;
    let cancelled = false;
    const render = () => {
      void renderPdfPageToDataUrl(doc, page, 340, 0.72)
        .then((url) => {
          if (!cancelled) setThumb(url);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    // рисуем только когда миниатюма приблизилась к видимой области —
    // иначе сотни страниц рендерились бы все разом
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'undefined') {
      render();
    } else {
      io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) {
            io?.disconnect();
            render();
          }
        },
        { rootMargin: '400px' }
      );
      io.observe(el);
    }
    return () => {
      cancelled = true;
      io?.disconnect();
    };
  }, [doc, page]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={onToggle}
        aria-label={`Страница ${page}: ${selected ? 'снять отметку' : 'распознавать'}`}
        aria-pressed={selected}
        className={`flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-lg border-2 bg-muted/40 transition-colors ${
          selected ? 'border-primary' : 'border-transparent hover:border-border'
        }`}
      >
        {thumb ? (
          <img src={thumb} alt={`Страница ${page}`} className="h-full w-full object-cover object-top" />
        ) : failed ? (
          <ImageOff className="h-5 w-5 text-muted-foreground" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        )}
        <span className="absolute bottom-1 left-1 rounded bg-background/85 px-1 text-[10px] font-medium text-foreground">
          {page}
        </span>
        {selected && (
          <span className="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <Check className="h-3 w-3" />
          </span>
        )}
      </button>
      <button
        onClick={onPreview}
        aria-label={`Предпросмотр страницы ${page}`}
        className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-background/85 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
      >
        <Eye className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** Полный предпросмотр страницы: рендер с тем же качеством, что и для OCR.
 *  Монтируется с key={page} — состояние сбрасывается при смене страницы. */
function OcrPagePreview({ doc, page }: { doc: PdfDoc; page: number }) {
  const [img, setImg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void renderPdfPageToDataUrl(doc, page, OCR_RENDER_WIDTH, OCR_RENDER_QUALITY)
      .then((url) => {
        if (!cancelled) setImg(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, page]);

  if (failed) {
    return <p className="text-sm text-destructive">Не удалось отрисовать страницу</p>;
  }
  if (!img) {
    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-muted/30">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <img src={img} alt={`Страница ${page}`} className="w-full rounded-lg border" />;
}
