'use client';

/**
 * Страница «Карты» (вкладка в нижней навигации): дерево карт с операциями —
 * войти, создать (корневую/подраздел), переименовать, переместить, удалить.
 * Карта — контейнер связанных идей; дерево задаётся Material.parentId.
 * Операции по карте собраны в меню «⋯» у строки (на узком экране телефона
 * ряд отдельных кнопок съедает место у названия), открываются диалогами поверх страницы.
 */
import { useMemo, useRef, useState } from 'react';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  Check,
  CornerDownRight,
  FileDown,
  FileUp,
  Map as MapIcon,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
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
import { useAppStore } from '@/store/useAppStore';
import { useMapStats } from '@/hooks/useMapStats';
import { createMap, moveMap, renameMap, childrenOf, getPathToRoot } from '@/lib/maps';
import { deleteMapCascade } from '@/lib/db';
import {
  buildCourseBundle,
  courseFileName,
  importCoursePayload,
  parseCoursePayload,
} from '@/lib/course-bundle';
import { saveJsonFile } from '@/lib/save-file';
import type { Material } from '@/lib/types';

type DialogState =
  | { kind: 'createRoot' }
  | { kind: 'createSub'; parent: Material }
  | { kind: 'rename'; target: Material }
  | { kind: 'move'; target: Material }
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

  const roots = useMemo(() => childrenOf(materials, null), [materials]);

  const enter = async (id: string) => {
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

  const renderRow = (m: Material, depth: number) => {
    const kids = childrenOf(materials, m.id);
    const st = stats.get(m.id);
    const isOpen = !collapsed.has(m.id);
    const isActive = m.id === activeMaterialId;
    return (
      <div key={m.id}>
        <div
          className={`group flex items-center gap-1 rounded-lg px-1.5 py-1.5 ${
            isActive ? 'bg-primary/10' : 'hover:bg-muted/60'
          }`}
          style={{ paddingLeft: 6 + depth * 16 }}
        >
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
          <MapRowMenu
            onAction={(kind) => {
              if (kind === 'createSub') setDialog({ kind: 'createSub', parent: m });
              else setDialog({ kind, target: m });
            }}
          />
        </div>
        {kids.length > 0 && isOpen && <div>{kids.map((c) => renderRow(c, depth + 1))}</div>}
      </div>
    );
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
          Карта — контейнер связанных идей. Внутри могут лежать другие карты — входи в них прямо с графа.
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

      <div className="flex flex-col gap-1">
        {!ready ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Загрузка…</p>
        ) : roots.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Пока нет карт. Создай первую или импортируй материал.
          </p>
        ) : (
          roots.map((m) => renderRow(m, 0))
        )}
      </div>

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

/** Меню «⋯» с операциями над картой — заменяет ряд кнопок, съедавший название на телефоне */
function MapRowMenu({ onAction }: { onAction: (kind: 'createSub' | 'rename' | 'move' | 'export' | 'delete') => void }) {
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
        <DropdownMenuItem onClick={() => onAction('move')}>
          <ArrowRightLeft /> Переместить
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
  stats: Map<string, { directAtoms: number; subtreeAtoms: number; subtreeMaps: number }>;
  onClose: () => void;
  afterDelete: (deletedIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [moveTarget, setMoveTarget] = useState<string | null>(
    dialog.kind === 'move' ? (dialog.target.parentId ?? null) : null
  );
  const [busy, setBusy] = useState(false);
  const [includeChildren, setIncludeChildren] = useState(true); // для диалога экспорта

  const titleOf = (m: Material) => m.title;
  const depthById = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of materials) map.set(m.id, getPathToRoot(materials, m.id).length - 1);
    return map;
  }, [materials]);

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

  const handleMove = async (target: Material) => {
    setBusy(true);
    try {
      await moveMap(target.id, moveTarget);
      toast.success(`«${target.title}» перемещена`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось переместить');
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
      const { collectSubtreeIds } = await import('@/lib/db');
      const ids = collectSubtreeIds(materials, target.id);
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

  if (dialog.kind === 'move') {
    // кандидаты: всё, кроме самой карты и её поддерева
    const excluded = new Set<string>();
    {
      const stack = [dialog.target.id];
      while (stack.length > 0) {
        const id = stack.pop()!;
        if (excluded.has(id)) continue;
        excluded.add(id);
        for (const c of childrenOf(materials, id)) stack.push(c.id);
      }
    }
    const candidates = materials.filter((m) => !excluded.has(m.id));

    return (
      <Dialog open onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="max-h-[70dvh] overflow-y-auto sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Переместить «{dialog.target.title}»</DialogTitle>
            <DialogDescription>Выбери новую родительскую карту.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setMoveTarget(null)}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                moveTarget === null ? 'border-primary bg-primary/10 text-primary' : 'border-border'
              }`}
            >
              <MapIcon className="h-4 w-4" /> Корень (карта верхнего уровня)
            </button>
            {candidates.map((m) => {
              const depth = depthById.get(m.id) ?? 0;
              return (
                <button
                  key={m.id}
                  onClick={() => setMoveTarget(m.id)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${
                    moveTarget === m.id ? 'border-primary bg-primary/10 text-primary' : 'border-border'
                  }`}
                  style={{ paddingLeft: 12 + depth * 14 }}
                >
                  <MapIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{m.title}</span>
                  {m.id === dialog.target.parentId && (
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">текущий</span>
                  )}
                </button>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>Отмена</Button>
            <Button disabled={busy} onClick={() => void handleMove(dialog.target)}>Переместить</Button>
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

