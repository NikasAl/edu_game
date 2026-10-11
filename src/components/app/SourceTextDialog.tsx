'use client';

/**
 * Диалог «Показать источник» на экране идеи.
 *
 * У атома есть цитата sourceRef; если исходный текст сохранён в библиотеке
 * импорта и цитата в нём нашлась — показываем МЕСТО В ТЕКСТЕ: окно вокруг
 * цитаты с подсветкой. Так идея видна в своём контексте, а не одной строкой.
 * Для старых атомов без связи с текстом работает поиск цитаты по всей
 * библиотеке сохранённых текстов.
 */

import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BookOpen, Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { db } from '@/lib/db';
import { findQuoteOffset, searchSavedTextsForQuote, type QuoteMatch } from '@/lib/saved-texts';
import type { IdeaNode } from '@/lib/types';
import RichText from '@/components/RichText';

/** Сколько символов текста показывать вокруг цитаты */
const CONTEXT = 700;

export default function SourceTextDialog({ node }: { node: IdeaNode }) {
  const [open, setOpen] = useState(false);
  const [searched, setSearched] = useState<QuoteMatch | null | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [showFull, setShowFull] = useState(false);

  // Связанный текст из библиотеки (undefined — нет связи или ещё грузится)
  const saved = useLiveQuery(
    () => (node.savedTextId ? db.savedTexts.get(node.savedTextId) : undefined),
    [node.savedTextId]
  );

  const match: QuoteMatch | null | undefined = useMemo(() => {
    if (!open) return undefined;
    if (saved) {
      const at = node.sourceRef ? findQuoteOffset(saved.text, node.sourceRef) : null;
      return at !== null ? { text: saved, offset: at } : null;
    }
    return searched;
  }, [open, saved, searched, node.sourceRef]);

  /** Ищем связанный текст, но он ещё грузится */
  const loadingSaved = open && !!node.savedTextId && !saved && searched === undefined;

  const runSearch = async () => {
    if (!node.sourceRef || searching) return;
    setSearching(true);
    try {
      setSearched(await searchSavedTextsForQuote(node.sourceRef));
    } finally {
      setSearching(false);
    }
  };

  const quote = node.sourceRef ?? '';

  // Окно текста вокруг цитаты
  const windowView = useMemo(() => {
    if (!match) return null;
    const full = match.text.text;
    const qLen = Math.max(1, quote.trim().length);
    const from = showFull ? 0 : Math.max(0, match.offset - CONTEXT);
    const to = showFull ? full.length : Math.min(full.length, match.offset + qLen + CONTEXT);
    return {
      before: full.slice(from, match.offset),
      quote: full.slice(match.offset, match.offset + qLen),
      after: full.slice(match.offset + qLen, to),
      hasBefore: from > 0,
      hasAfter: to < full.length,
    };
  }, [match, quote, showFull]);

  if (!node.sourceRef) return null;

  return (
    <Dialog open={open} onOpenChange={(o) => setOpen(o)}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="self-start text-muted-foreground">
          <BookOpen className="mr-1.5 h-4 w-4" /> Показать источник
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>Источник</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            <RichText>{quote}</RichText>
          </p>

          {loadingSaved && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Ищу место в сохранённом тексте…
            </p>
          )}

          {/* Место идеи в тексте: окно вокруг цитаты с подсветкой */}
          {match && windowView && (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] font-medium text-primary">
                Место в тексте «{match.text.title}»
              </p>
              <div className="thin-scroll max-h-[45vh] overflow-y-auto rounded-lg bg-muted/40 p-3">
                <pre className="whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-muted-foreground">
                  {windowView.hasBefore && '…'}
                  {windowView.before}
                  <mark className="rounded bg-primary/25 px-0.5 text-foreground">
                    {windowView.quote}
                  </mark>
                  {windowView.after}
                  {windowView.hasAfter && '…'}
                </pre>
              </div>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                <span className="min-w-0 truncate">{match.text.sourceLabel}</span>
                <button
                  onClick={() => setShowFull((v) => !v)}
                  className="shrink-0 underline-offset-2 hover:underline"
                >
                  {showFull ? 'Только место идеи' : 'Показать весь текст'}
                </button>
              </div>
            </div>
          )}

          {/* Цитата не привязана к тексту — предлагаем поиск по библиотеке */}
          {!node.savedTextId && searched === undefined && !loadingSaved && (
            <Button variant="outline" size="sm" className="self-start" onClick={() => void runSearch()}>
              {searching ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> Ищу…
                </>
              ) : (
                <>
                  <Search className="mr-1.5 h-4 w-4" /> Найти в сохранённых текстах
                </>
              )}
            </Button>
          )}

          {searched === null && !saved && (
            <p className="text-xs text-muted-foreground">
              Цитата не нашлась в сохранённых текстах — возможно, текст этого материала ещё не
              сохранялся в библиотеке импорта.
            </p>
          )}

          {saved && match === null && !loadingSaved && (
            <p className="text-xs text-muted-foreground">
              Цитата не нашлась в связанном тексте «{saved.title}» — возможно, модель пересказала
              источник другими словами.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
