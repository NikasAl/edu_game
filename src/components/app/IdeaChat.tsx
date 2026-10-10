'use client';

/**
 * Обсуждение идеи с ИИ-наставником: полноэкранный чат поверх экрана узла.
 * История переписки хранится в IndexedDB по узлу (chatMessages, схема v4),
 * контекстом модели служит сама идея (суть/пример/ошибка/термины).
 * Это обсуждение, а не проверка: без оценок и зачётов.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, MessageCircle, Send, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import RichText from '@/components/RichText';
import { clearNodeChat, db } from '@/lib/db';
import { chatWithTutorLLM } from '@/lib/llm-ops';
import type { ChatMessage, IdeaNode, LLMProvider } from '@/lib/types';
import { cn } from '@/lib/utils';

/** Подсказки-вопросы для пустого чата: с чего начать обсуждение */
const SUGGESTIONS = [
  'Как это применяется на практике?',
  'Объясни пример ещё проще',
  'А что, если взять другой случай?',
];

export default function IdeaChat({
  node,
  provider,
  onClose,
}: {
  node: IdeaNode;
  provider: LLMProvider | null;
  onClose: () => void;
}) {
  const history = useLiveQuery(
    () => db.chatMessages.where('nodeId').equals(node.id).sortBy('createdAt'),
    [node.id]
  );
  const messages = useMemo(() => history ?? [], [history]);

  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  // двухшаговое подтверждение очистки (как замена ответа в испытаниях)
  const [armClear, setArmClear] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  // автоскролл вниз: на новое сообщение и во время набора
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, busy]);

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || busy) return;
    if (!provider) {
      toast.error('Для обсуждения нужен ИИ-провайдер — Настройки → LLM-провайдер');
      return;
    }
    setInput('');
    setBusy(true);
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      nodeId: node.id,
      materialId: node.materialId,
      role: 'user',
      content: text,
      createdAt: new Date(),
    };
    try {
      await db.chatMessages.put(userMsg);
      // история для модели — всё, что есть к этому моменту (включая только что добавленное)
      const soFar = await db.chatMessages.where('nodeId').equals(node.id).sortBy('createdAt');
      const reply = await chatWithTutorLLM(provider, node, soFar);
      await db.chatMessages.put({
        id: crypto.randomUUID(),
        nodeId: node.id,
        materialId: node.materialId,
        role: 'assistant',
        content: reply,
        createdAt: new Date(),
      });
    } catch (e) {
      // сообщение пользователя осталось в истории — можно переспросить или исправить
      toast.error(e instanceof Error ? e.message : 'Не удалось получить ответ');
    } finally {
      setBusy(false);
    }
  };

  const clearChat = async () => {
    if (messages.length > 0 && !armClear) {
      setArmClear(true);
      window.setTimeout(() => setArmClear(false), 3500);
      return;
    }
    setArmClear(false);
    await clearNodeChat(node.id);
    toast.success('Обсуждение очищено');
  };

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-background" role="dialog" aria-label="Обсуждение идеи">
      {/* Шапка */}
      <header className="border-b border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-center gap-2 px-4 py-3">
          <Button variant="ghost" size="icon" onClick={onClose} aria-label="Назад к идее">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              <MessageCircle className="h-3 w-3" /> Обсуждение с наставником
            </p>
            <h1 className="truncate text-base font-semibold">{node.title}</h1>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void clearChat()}
            disabled={messages.length === 0}
            aria-label="Очистить обсуждение"
            className={cn(armClear && 'text-destructive')}
          >
            <Trash2 className="h-5 w-5" />
          </Button>
        </div>
      </header>

      {/* Сообщения */}
      <div ref={listRef} className="thin-scroll flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-lg flex-col gap-3 px-4 py-4">
          {/* Приветствие — всегда первое, статичное (без траты токенов) */}
          <Bubble
            role="assistant"
            text={`Привет! Это обсуждение идеи «${node.title}». Спроси, что непонятно, расскажи свою мысль — разберём вместе.`}
            muted
          />

          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} text={m.content} ts={m.createdAt} />
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <span className="flex gap-1">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/70 [animation-delay:300ms]" />
              </span>
              Наставник печатает…
            </div>
          )}

          {/* Пустой чат: подсказки-вопросы */}
          {messages.length === 0 && !busy && (
            <div className="flex flex-col gap-1.5 pt-1">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  disabled={!provider}
                  className="rounded-xl border border-dashed border-border px-3 py-2 text-left text-sm text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Ввод */}
      <div className="border-t border-border bg-card/60 backdrop-blur">
        <div className="mx-auto flex max-w-lg items-end gap-2 px-4 py-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={provider ? 'Спроси или поделись мыслью…' : 'ИИ не подключён — добавь провайдера в Настройках'}
            disabled={busy || !provider}
            className="max-h-32 min-h-10 flex-1 resize-none"
            aria-label="Сообщение наставнику"
          />
          <Button size="icon" onClick={() => void send()} disabled={busy || !input.trim() || !provider} aria-label="Отправить">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function Bubble({
  role,
  text,
  ts,
  muted,
}: {
  role: 'user' | 'assistant';
  text: string;
  ts?: Date;
  muted?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-snug',
          isUser
            ? 'rounded-br-md bg-primary text-primary-foreground'
            : 'rounded-bl-md border border-border bg-muted/50 text-foreground'
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{text}</p>
        ) : (
          <div className={cn(muted && 'italic text-muted-foreground')}>
            <RichText>{text}</RichText>
          </div>
        )}
        {ts && !muted && (
          <p className={cn('mt-1 text-[10px]', isUser ? 'text-primary-foreground/60' : 'text-muted-foreground/70')}>
            {new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(ts)}
          </p>
        )}
      </div>
    </div>
  );
}
