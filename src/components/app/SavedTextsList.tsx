'use client';

/**
 * Библиотека сохранённых текстов импорта.
 *
 * Тексты, дошедшие до разбора на атомы, остаются доступны независимо от судьбы
 * карт: если разбор не удался или материал нужен снова — открываешь текст
 * отсюда, а не распознаёшь источник заново. Тексты одного источника (файл
 * книги, страница сайта) собраны в папки: главы одной книги лежат вместе,
 * хотя карт из них получилось несколько.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  BookOpen,
  BookMarked,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { db } from '@/lib/db';
import { deleteSavedText, deleteSourceGroup, renameSourceGroup } from '@/lib/saved-texts';
import type { ImportSourceMode, SavedText } from '@/lib/types';

const MODE_ICON: Record<ImportSourceMode, typeof Type> = {
  paste: Type,
  url: Globe,
  pdf: FileText,
  djvu: BookOpen,
};

const MODE_LABEL: Record<ImportSourceMode, string> = {
  paste: 'текст',
  url: 'ссылка',
  pdf: 'PDF',
  djvu: 'DjVu',
};

function fmtDate(d: Date): string {
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

interface SavedTextsListProps {
  /** Загрузить текст обратно в редактор импорта */
  onUse: (t: SavedText) => void;
}

export default function SavedTextsList({ onUse }: SavedTextsListProps) {
  const data = useLiveQuery(async () => {
    const [texts, groups] = await Promise.all([
      db.savedTexts.orderBy('createdAt').toArray(),
      db.textSources.toArray(),
    ]);
    return { texts, groups };
  }, []);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [viewText, setViewText] = useState<SavedText | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null); // id текста/группы на удалении
  const [renameGroup, setRenameGroup] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Автосброс «подтверждения удаления» — чтобы красная кнопка не ждала вечно
  useEffect(() => {
    if (!confirmId) return;
    const t = setTimeout(() => setConfirmId(null), 4000);
    return () => clearTimeout(t);
  }, [confirmId]);

  const groupsWithTexts = useMemo(() => {
    if (!data) return [];
    const byGroup = new Map<string, SavedText[]>();
    for (const t of data.texts) {
      if (!t.groupId) continue;
      const list = byGroup.get(t.groupId) ?? [];
      list.push(t);
      byGroup.set(t.groupId, list);
    }
    const groups = data.groups
      .filter((g) => byGroup.has(g.id))
      .map((g) => ({ group: g, texts: [...(byGroup.get(g.id) ?? [])].reverse() })) // свежие сверху
      .sort((a, b) => {
        const da = a.texts[a.texts.length - 1]?.createdAt.getTime() ?? 0;
        const dbb = b.texts[b.texts.length - 1]?.createdAt.getTime() ?? 0;
        return dbb - da;
      });
    return groups;
  }, [data]);

  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const askDelete = (id: string) => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    setConfirmId(id);
  };

  const doDeleteText = async (t: SavedText) => {
    setBusy(true);
    try {
      await deleteSavedText(t.id);
      setConfirmId(null);
      toast.success(`Текст «${t.title}» удалён из библиотеки`);
    } catch {
      toast.error('Не удалось удалить текст');
    } finally {
      setBusy(false);
    }
  };

  const doDeleteGroup = async (groupId: string, name: string) => {
    setBusy(true);
    try {
      const n = await deleteSourceGroup(groupId);
      setConfirmId(null);
      toast.success(`Папка «${name}» удалена (текстов: ${n})`);
    } catch {
      toast.error('Не удалось удалить папку');
    } finally {
      setBusy(false);
    }
  };

  const doRename = async () => {
    if (!renameGroup) return;
    setBusy(true);
    try {
      await renameSourceGroup(renameGroup.id, renameGroup.name);
      setRenameGroup(null);
      toast.success('Папка переименована');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось переименовать папку');
    } finally {
      setBusy(false);
    }
  };

  if (!data || data.texts.length === 0) return null;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            <BookMarked className="h-4 w-4 text-primary" />
            Сохранённые тексты
          </p>
          <Badge variant="secondary">{data.texts.length}</Badge>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Тексты из источников остаются здесь даже если разбор на идеи не удался — вернись к
          любому из них позже. Тексты одного источника собраны в общие папки.
        </p>

        <div className="flex flex-col gap-1.5">
          {groupsWithTexts.map(({ group, texts }) => {
            const open = expanded.has(group.id);
            const deleting = confirmId === group.id;
            return (
              <div key={group.id} className="rounded-lg border border-border/70">
                {/* Папка-источник */}
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={open ? 'Свернуть папку' : 'Развернуть папку'}
                    aria-expanded={open}
                  >
                    {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </button>
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-violet-300" />
                    <span className="min-w-0 truncate text-xs font-medium" title={group.name}>
                      {group.name}
                    </span>
                  </button>
                  <Badge variant="secondary" className="shrink-0 px-1.5 text-[10px]">
                    {texts.length}
                  </Badge>
                  <button
                    onClick={() => setRenameGroup({ id: group.id, name: group.name })}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label="Переименовать папку"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => (deleting ? void doDeleteGroup(group.id, group.name) : askDelete(group.id))}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors ${
                      deleting
                        ? 'bg-destructive text-destructive-foreground'
                        : 'text-muted-foreground hover:bg-muted hover:text-destructive'
                    }`}
                    aria-label={deleting ? 'Подтвердить удаление папки' : 'Удалить папку с текстами'}
                  >
                    {deleting ? <Check className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>

                {/* Тексты папки */}
                {open && (
                  <div className="flex flex-col gap-px border-t border-border/60 pb-1.5">
                    {texts.map((t) => {
                      const ModeIcon = MODE_ICON[t.mode] ?? Type;
                      const delNow = confirmId === t.id;
                      return (
                        <div
                          key={t.id}
                          className="flex items-center gap-1.5 px-2 py-1.5 pl-9 transition-colors hover:bg-muted/40"
                        >
                          <ModeIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <button
                            onClick={() => setViewText(t)}
                            className="flex min-w-0 flex-1 flex-col text-left"
                            title="Просмотреть текст"
                          >
                            <span className="truncate text-xs font-medium">{t.title}</span>
                            <span className="truncate text-[10px] text-muted-foreground">
                              {fmtDate(t.createdAt)} · {t.text.length.toLocaleString('ru-RU')} знаков ·{' '}
                              {MODE_LABEL[t.mode] ?? t.mode}
                            </span>
                          </button>
                          <button
                            onClick={() => setViewText(t)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            aria-label="Просмотреть текст"
                          >
                            <Eye className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => onUse(t)}
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary"
                            aria-label="Загрузить в редактор импорта"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => (delNow ? void doDeleteText(t) : askDelete(t.id))}
                            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors ${
                              delNow
                                ? 'bg-destructive text-destructive-foreground'
                                : 'text-muted-foreground hover:bg-muted hover:text-destructive'
                            }`}
                            aria-label={delNow ? 'Подтвердить удаление текста' : 'Удалить текст'}
                          >
                            {busy && delNow ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : delNow ? (
                              <Check className="h-3.5 w-3.5" />
                            ) : (
                              <Trash2 className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>

      {/* Просмотр сохранённого текста */}
      <Dialog open={viewText !== null} onOpenChange={(o) => !o && setViewText(null)}>
        <DialogContent className="max-h-[85vh]">
          <DialogHeader>
            <DialogTitle className="pr-6 text-base">{viewText?.title}</DialogTitle>
          </DialogHeader>
          {viewText && (
            <div className="flex min-h-0 flex-col gap-2">
              <p className="text-[11px] text-muted-foreground">
                Источник: {viewText.sourceLabel} · {viewText.text.length.toLocaleString('ru-RU')} знаков ·{' '}
                {viewText.createdAt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })}
              </p>
              <div className="thin-scroll max-h-[60vh] overflow-y-auto rounded-lg bg-muted/40 p-3">
                <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
                  {viewText.text}
                </pre>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    onUse(viewText);
                    setViewText(null);
                  }}
                >
                  <RotateCcw className="mr-1 h-4 w-4" /> В редактор импорта
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Переименование папки-источника */}
      <Dialog open={renameGroup !== null} onOpenChange={(o) => !o && setRenameGroup(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать папку</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input
              value={renameGroup?.name ?? ''}
              onChange={(e) => setRenameGroup((g) => (g ? { ...g, name: e.target.value } : g))}
              placeholder="Название источника"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) void doRename();
              }}
            />
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setRenameGroup(null)} disabled={busy}>
                Отмена
              </Button>
              <Button className="flex-1" onClick={() => void doRename()} disabled={busy}>
                Сохранить
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
