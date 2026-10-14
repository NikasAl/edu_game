'use client';

/**
 * Страница «Карты» (вкладка в нижней навигации): дерево карт с операциями —
 * войти, создать (корневую/подраздел), переименовать, удалить.
 * Карта — контейнер связанных идей; дерево задаётся Material.parentId.
 * Перенос по иерархии — drag-n-drop (dnd-kit: мышь — короткий сдвиг, тач —
 * долгое нажатие ~200 мс, чтобы не мешать прокрутке и тапам). Бросок на строку
 * карты кладёт перетаскиваемую карту в неё; зона под списком возвращает в корень.
 * Операции по карте собраны в меню «⋯» у строки (на узком экране телефона
 * ряд отдельных кнопок съедает место у названия), открываются диалогами поверх страницы.
 */
import { useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Check,
  CornerDownRight,
  FileDown,
  FileUp,
  GripVertical,
  Map as MapIcon,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/useAppStore';
import { useMapStats, type MapStats } from '@/hooks/useMapStats';
import { createMap, renameMap, childrenOf, moveMap } from '@/lib/maps';
import { collectSubtreeIds, deleteMapCascade } from '@/lib/db';
import {
  buildCourseBundle,
  courseFileName,
  importCoursePayload,
  parseCoursePayload,
} from '@/lib/course-bundle';
import { saveJsonFile } from '@/lib/save-file';
import type { Material } from '@/lib/types';

/** id псевдо-карты «брось сюда, чтобы карта стала корневой» */
const ROOT_ZONE_ID = 'maps-drop-root';

type DialogState =
  | { kind: 'createRoot' }
  | { kind: 'createSub'; parent: Material }
  | { kind: 'rename'; target: Material }
  | { kind: 'delete'; target: Material }
  | { kind: 'export'; target: Material }
  | null;

export default function MapsPanel() {
  const { ready, materials, stats } = useMapStats();
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const setActiveMaterialId = useAppStore((s) => s.setActiveMaterialId);
  const unsetActiveMaterial = useAppStore((s) => s.unsetActiveMaterial);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);

  // drag-n-drop: id перетаскиваемой карты; заглушка клика после броска,
  // чтобы drop не превращался в случайный «войти в карту»
  const [dragId, setDragId] = useState<string | null>(null);
  const suppressClickUntil = useRef(0);

  const roots = useMemo(() => childrenOf(materials, null), [materials]);

  // на себя и своё поддерево перетаскиваемую карту бросить нельзя (цикл)
  const blockedIds = useMemo(
    () => (dragId ? new Set(collectSubtreeIds(materials, dragId)) : null),
    [materials, dragId]
  );
  const dragTitle = useMemo(
    () => materials.find((m) => m.id === dragId)?.title ?? '',
    [materials, dragId]
  );

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } })
  );

  const enter = async (id: string) => {
    if (Date.now() < suppressClickUntil.current) return;
    await setActiveMaterialId(id);
    setActiveTab('map');
  };

  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const afterDelete = async (deletedIds: string[]) => {
    if (activeMaterialId && deletedIds.includes(activeMaterialId)) {
      const alive = materials
        .filter((m) => !deletedIds.includes(m.id))
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      if (alive.length > 0) await setActiveMaterialId(alive[0].id);
      else await unsetActiveMaterial();
    }
  };

  /** Импорт файла курса (экспорт с вкладки «Карты»): копия с новыми id */
  const handleCourseFile = async (f: File) => {
    if (importBusy) return;
    setImportBusy(true);
    try {
      const payload = parseCoursePayload(await f.text());
      const r = await importCoursePayload(payload);
      toast.success(`Курс «${r.title}» добавлен`, {
        description: `Карт: ${r.materials}, идей: ${r.nodes}, задач: ${r.tasks}. Прогресс начнётся с нуля.`,
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось импортировать курс');
    } finally {
      setImportBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDragStart = (e: DragStartEvent) => {
    setDragId(String(e.active.id));
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    setDragId(null);
    suppressClickUntil.current = Date.now() + 300;
    if (!over) return;
    const draggedId = String(active.id);
    const overId = String(over.id);
    if (overId === draggedId) return;
    const dragged = materials.find((m) => m.id === draggedId);
    if (!dragged) return;
    const toRoot = overId === ROOT_ZONE_ID;
    const newParent = toRoot ? null : overId;
    try {
      await moveMap(draggedId, newParent);
      if (newParent) {
        // развернуть нового родителя, чтобы результат броска был виден
        setCollapsed((prev) => {
          if (!prev.has(newParent)) return prev;
          const next = new Set(prev);
          next.delete(newParent);
          return next;
        });
      }
      toast.success(
        toRoot
          ? `«${dragged.title}» — теперь корневая карта`
          : `«${dragged.title}» перенесена в «${materials.find((m) => m.id === newParent)?.title ?? ''}»`
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Не удалось переместить карту');
    }
  };

  const rowProps = {
    materials,
    stats,
    collapsed,
    toggle,
    activeMaterialId,
    enter,
    blockedIds,
    onMenuAction: (kind: 'createSub' | 'rename' | 'export' | 'delete', target: Material) => {
      if (kind === 'createSub') setDialog({ kind: 'createSub', parent: target });
      else setDialog({ kind, target });
    },
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Компактная шапка: заголовок и иконки на одной строке, пояснение —
          во всю ширину, а не в узкой колонке между кнопками (проблема телефонов) */}
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Мои карты</h1>
          <div className="flex shrink-0 gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => fileRef.current?.click()}
              disabled={importBusy}
              title="Импорт курса из файла"
              aria-label="Импорт курса из файла"
            >
              <FileUp className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setDialog({ kind: 'createRoot' })}
              title="Новая карта"
              aria-label="Новая карта"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <p className="text-[13px] leading-snug text-muted-foreground">
          Карта — контейнер связанных идей. Удерживай карту и брось её на другую, чтобы вложить; в самой карте живут
          идеи, а внутрь дочерних карт входя́т прямо с графа.
        </p>
      </header>

      {/* файл курса импортируется копией с новыми id — конфликты с существующими картами невозможны */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleCourseFile(f);
        }}
      />

      {/* MeasuringStrategy.Always: зона «корень» маунтится уже во время перетаскивания */}
      <DndContext
        sensors={sensors}
        collisionDetection={pointerWithin}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={handleDragStart}
        onDragEnd={(e) => void handleDragEnd(e)}
      >
        <div className="flex flex-col gap-1">
          {!ready ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Загрузка…</p>
          ) : roots.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Пока нет карт. Создай первую или импортируй материал.
            </p>
          ) : (
            roots.map((m) => <MapRow key={m.id} m={m} depth={0} {...rowProps} />)
          )}
        </div>

        {dragId && <RootDropZone />}
        <DragOverlay dropAnimation={null}>
          {dragId && (
            <div className="flex max-w-64 items-center gap-2 rounded-lg border border-primary/50 bg-background px-3 py-1.5 text-sm shadow-lg">
              <MapIcon className="h-4 w-4 shrink-0 text-primary" />
              <span className="truncate">{dragTitle}</span>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {roots.length > 0 && (
        <Button
          variant="outline"
          onClick={() => setDialog({ kind: 'createRoot' })}
          className="mx-auto w-1/2 min-w-40"
        >
          <Plus className="mr-1 h-4 w-4" /> Новая карта
        </Button>
      )}

      {dialog && (
        <MapDialogs
          dialog={dialog}
          materials={materials}
          stats={stats}
          onClose={() => setDialog(null)}
          afterDelete={afterDelete}
        />
      )}
    </div>
  );
}

type MapRowProps = {
  m: Material;
  depth: number;
  materials: Material[];
  stats: Map<string, MapStats>;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  activeMaterialId: string | null;
  enter: (id: string) => Promise<void>;
  /** поддерево текущей перетаскиваемой карты (null — перетаскивания нет) */
  blockedIds: Set<string> | null;
  onMenuAction: (kind: 'createSub' | 'rename' | 'export' | 'delete', target: Material) => void;
};

/** Строка карты в дереве: сама перетаскивает себя и принимает чужой бросок */
function MapRow({
  m,
  depth,
  materials,
  stats,
  collapsed,
  toggle,
  activeMaterialId,
  enter,
  blockedIds,
  onMenuAction,
}: MapRowProps) {
  const kids = childrenOf(materials, m.id);
  const st = stats.get(m.id);
  const isOpen = !collapsed.has(m.id);
  const isActive = m.id === activeMaterialId;

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({ id: m.id });
  const { isOver, setNodeRef: setDropRef } = useDroppable({
    id: m.id,
    // бросок на себя и своё поддерево запрещён — dnd-kit исключит цель из коллизий
    disabled: blockedIds === null || blockedIds.has(m.id),
  });
  const combinedRef = (el: HTMLDivElement | null) => {
    setDragRef(el);
    setDropRef(el);
  };

  return (
    <div>
      <div
        ref={combinedRef}
        {...listeners}
        {...attributes}
        className={cn(
          'group flex items-center gap-1 rounded-lg px-1.5 py-1.5',
          isActive && !isDragging ? 'bg-primary/10' : 'hover:bg-muted/60',
          isDragging && 'opacity-40',
          isOver && !isDragging && 'ring-2 ring-primary bg-primary/15',
          blockedIds?.has(m.id) && 'opacity-50'
        )}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
        {kids.length > 0 ? (
          <button
            onClick={() => toggle(m.id)}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
            aria-label={isOpen ? 'Свернуть' : 'Развернуть'}
          >
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : (
          <span className="w-5 shrink-0" />
        )}
        <button
          onClick={() => void enter(m.id)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left"
          title="Войти в карту"
        >
          <MapIcon className={`h-4 w-4 shrink-0 ${isActive ? 'text-primary' : 'text-violet-300/80'}`} />
          <span className={`truncate text-sm ${isActive ? 'font-medium text-primary' : ''}`}>{m.title}</span>
        </button>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {st ? `${st.subtreeMastered}/${st.subtreeAtoms}` : '—'}
        </span>
        {isActive && (
          <Badge variant="default" className="shrink-0 px-1.5 py-0 text-[10px]">
            открыта
          </Badge>
        )}
        <MapRowMenu onAction={(kind) => onMenuAction(kind, m)} />
      </div>
      {kids.length > 0 &&
        isOpen &&
        kids.map((c) => (
          <MapRow
            key={c.id}
            m={c}
            depth={depth + 1}
            materials={materials}
            stats={stats}
            collapsed={collapsed}
            toggle={toggle}
            activeMaterialId={activeMaterialId}
            enter={enter}
            blockedIds={blockedIds}
            onMenuAction={onMenuAction}
          />
        ))}
    </div>
  );
}

/** Зона под списком: вернуть перетаскиваемую карту в корень иерархии */
function RootDropZone() {
  const { isOver, setNodeRef } = useDroppable({ id: ROOT_ZONE_ID });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'mt-1 flex items-center justify-center gap-2 rounded-xl border border-dashed px-3 py-3 text-xs text-muted-foreground transition-colors',
        isOver ? 'border-primary bg-primary/15 text-foreground' : 'border-border bg-muted/30'
      )}
    >
      <MapIcon className="h-4 w-4" />
      Отпусти здесь — сделать корневой картой
    </div>
  );
}

/** Меню «⋯» с операциями над картой — заменяет ряд кнопок, съедавший название на телефоне */
function MapRowMenu({ onAction }: { onAction: (kind: 'createSub' | 'rename' | 'export' | 'delete') => void }) {
  return (
    // modal=false: меню не ставит body pointer-events:none. Модальное меню в связке
    // «пункт → диалог» оставляло body заблокированным навсегда (диалог маунтился,
    // пока меню закрывалось, захватывал none как «исходное» и возвращал его при
    // закрытии) — приложение переставало отвечать на любые клики, включая навигацию.
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title="Действия с картой"
          aria-label="Действия с картой"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={() => onAction('createSub')}>
          <CornerDownRight /> Добавить подраздел
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('rename')}>
          <Pencil /> Переименовать
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction('export')}>
          <FileDown /> Экспорт курса
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => onAction('delete')}
          className="text-rose-400 focus:bg-rose-500/10 focus:text-rose-400"
        >
          <Trash2 className="!text-rose-400" /> Удалить
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Диалоги операций над картой (открыты, когда dialog != null) */
function MapDialogs({
  dialog,
  materials,
  stats,
  onClose,
  afterDelete,
}: {
  dialog: NonNullable<DialogState>;
  materials: Material[];
  stats: Map<string, MapStats>;
  onClose: () => void;
  afterDelete: (deletedIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [includeChildren, setIncludeChildren] = useState(true); // для диалога экспорта

  const titleOf = (m: Material) => m.title;

  const handleCreate = async (parentId: string | null) => {
    setBusy(true);
    try {
      const created = await createMap({ title: name, parentId });
      toast.success(`Карта «${created.title}» создана`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось создать карту');
    } finally {
      setBusy(false);
    }
  };

  const handleRename = async (target: Material) => {
    setBusy(true);
    try {
      await renameMap(target.id, name);
      toast.success('Название обновлено');
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось переименовать');
    } finally {
      setBusy(false);
    }
  };

  const handleExport = async (target: Material, withChildren: boolean) => {
    setBusy(true);
    try {
      const payload = await buildCourseBundle(target.id, withChildren);
      const json = JSON.stringify(payload, null, 2);
      const fname = courseFileName(target.title);
      const res = await saveJsonFile(json, fname, 'Отправить курс…');
      if (res === 'shared') {
        toast.success('Файл курса сохранён — отправь его в мессенджере или на другое устройство');
      } else if (res === 'downloaded') {
        toast.success(`Файл курса скачан: ${fname}`);
      }
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось экспортировать курс');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (target: Material) => {
    setBusy(true);
    try {
      const { collectSubtreeIds: collect } = await import('@/lib/db');
      const ids = collect(materials, target.id);
      const st = stats.get(target.id);
      await deleteMapCascade(target.id);
      await afterDelete(ids);
      toast.success(
        `Удалено карт: ${ids.length}${st ? `, идей: ${st.subtreeAtoms}` : ''}`
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setBusy(false);
    }
  };

  if (dialog.kind === 'createRoot' || dialog.kind === 'createSub') {
    const isSub = dialog.kind === 'createSub';
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{isSub ? 'Новый подраздел' : 'Новая карта'}</DialogTitle>
            <DialogDescription>
              {isSub
                ? `Подраздел появится внутри карты «${titleOf(dialog.parent)}» и будет виден на её графе.`
                : 'Корневая карта верхнего уровня.'}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Название карты"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void handleCreate(isSub ? dialog.parent.id : null);
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Отмена</Button>
            <Button disabled={!name.trim() || busy} onClick={() => void handleCreate(isSub ? dialog.parent.id : null)}>
              Создать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (dialog.kind === 'rename') {
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Переименовать карту</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            placeholder="Новое название"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) void handleRename(dialog.target);
            }}
          />
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Отмена</Button>
            <Button disabled={!name.trim() || busy} onClick={() => void handleRename(dialog.target)}>
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (dialog.kind === 'export') {
    const target = dialog.target;
    const st = stats.get(target.id);
    const subtreeMaps = st?.subtreeMaps ?? 0;
    const hasKids = subtreeMaps > 0;
    const atoms = hasKids && includeChildren ? (st?.subtreeAtoms ?? 0) : (st?.directAtoms ?? 0);
    // «1 вложенную карту» / «2 вложенные карты» / «5 вложенных карт»
    const m10 = subtreeMaps % 10;
    const m100 = subtreeMaps % 100;
    const mapsWord =
      m10 === 1 && m100 !== 11
        ? 'вложенную карту'
        : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)
          ? 'вложенные карты'
          : 'вложенных карт';
    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Экспорт курса «{target.title}»</DialogTitle>
            <DialogDescription>
              В файл войдут {hasKids && includeChildren ? `карта и ${subtreeMaps} ${mapsWord}, всего идей: ${atoms}` : `идеи карты: ${atoms}`} с задачами и связями.
              Прогресс не переносится: на новом устройстве курс начнётся с нуля.
            </DialogDescription>
          </DialogHeader>
          {hasKids && (
            <button
              onClick={() => setIncludeChildren((v) => !v)}
              className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5 text-left text-sm"
              aria-pressed={includeChildren}
            >
              <span
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                  includeChildren ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40'
                }`}
              >
                {includeChildren && <Check className="h-4 w-4" />}
              </span>
              <span>
                Включить {subtreeMaps === 1 ? 'вложенную карту' : 'вложенные карты'} ({subtreeMaps})
                <span className="block text-xs text-muted-foreground">
                  Без галочки экспортируется только сама карта ({st?.directAtoms ?? 0} идей)
                </span>
              </span>
            </button>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Отмена</Button>
            <Button disabled={busy} onClick={() => void handleExport(target, includeChildren)}>
              <FileDown className="mr-1 h-4 w-4" /> Экспортировать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // delete
  const target = dialog.target;
  const st = stats.get(target.id);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Удалить карту «{target.title}»?</DialogTitle>
          <DialogDescription>
            Будет удалена карта{st && st.subtreeMaps > 0 ? `, все ${st.subtreeMaps} вложенных карт` : ''} и все идеи с
            задачами{st ? ` (всего идей: ${st.subtreeAtoms})` : ''}. Прогресс будет потерян — сначала можно сделать
            бэкап в «Настройках».
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Отмена</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void handleDelete(target)}>
            <Trash2 className="mr-1 h-4 w-4" /> Удалить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
