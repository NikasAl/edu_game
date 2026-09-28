'use client';

/**
 * Менеджер карт: дерево карт с операциями —
 * войти, создать (корневую/подраздел), переименовать, переместить, удалить.
 * Карта — контейнер связанных идей; дерево задаётся Material.parentId.
 */
import { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Map as MapIcon,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
import type { Material } from '@/lib/types';

type DialogState =
  | { kind: 'createRoot' }
  | { kind: 'createSub'; parent: Material }
  | { kind: 'rename'; target: Material }
  | { kind: 'move'; target: Material }
  | { kind: 'delete'; target: Material }
  | null;

export default function MapsManager({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { ready, materials, stats } = useMapStats();
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const setActiveMaterialId = useAppStore((s) => s.setActiveMaterialId);
  const unsetActiveMaterial = useAppStore((s) => s.unsetActiveMaterial);
  const setActiveTab = useAppStore((s) => s.setActiveTab);

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState>(null);

  const roots = useMemo(() => childrenOf(materials, null), [materials]);

  const enter = async (id: string) => {
    await setActiveMaterialId(id);
    setActiveTab('map');
    onOpenChange(false);
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
          <div className="flex shrink-0 items-center gap-0.5 opacity-80">
            <button
              onClick={() => setDialog({ kind: 'createSub', parent: m })}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Добавить подраздел"
            >
              <CornerDownRight className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setDialog({ kind: 'rename', target: m })}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Переименовать"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setDialog({ kind: 'move', target: m })}
              className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Переместить"
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setDialog({ kind: 'delete', target: m })}
              className="flex h-6 w-6 items-center justify-center rounded text-rose-400/80 hover:bg-rose-500/10 hover:text-rose-400"
              title="Удалить"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {kids.length > 0 && isOpen && <div>{kids.map((c) => renderRow(c, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[80dvh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Мои карты</DialogTitle>
            <DialogDescription>
              Карта — контейнер связанных идей. Внутри карты могут лежать другие карты: входи в них прямо с графа.
            </DialogDescription>
          </DialogHeader>

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

          <DialogFooter className="flex-row gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => setDialog({ kind: 'createRoot' })}
            >
              <Plus className="mr-1 h-4 w-4" /> Новая карта
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dialog && (
        <MapDialogs
          dialog={dialog}
          materials={materials}
          stats={stats}
          onClose={() => setDialog(null)}
          onEnter={enter}
          afterDelete={afterDelete}
        />
      )}
    </>
  );
}

/** Диалоги операций над картой (открыты, когда dialog != null) */
function MapDialogs({
  dialog,
  materials,
  stats,
  onClose,
  onEnter,
  afterDelete,
}: {
  dialog: NonNullable<DialogState>;
  materials: Material[];
  stats: Map<string, { subtreeAtoms: number; subtreeMaps: number }>;
  onClose: () => void;
  onEnter: (id: string) => void;
  afterDelete: (deletedIds: string[]) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [moveTarget, setMoveTarget] = useState<string | null>(
    dialog.kind === 'move' ? (dialog.target.parentId ?? null) : null
  );
  const [busy, setBusy] = useState(false);

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
