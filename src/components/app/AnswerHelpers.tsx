'use client';

/**
 * Помощники ввода для текстовых испытаний: шаблоны фраз (одна кнопка — одна
 * заготовка начала ответа) и голосовой ввод.
 *
 * Голос: в браузере — Web Speech API (Chrome/Edge, кнопка скрыта, если API нет);
 * в APK (Capacitor) — @capacitor-community/speech-recognition с системным
 * диалогом распознавания. Плагин импортируется динамически и только в
 * нативной среде: на веб-сборке его код не выполняется.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import { isNativePlatform } from '@/lib/nativeHttp';
import { cn } from '@/lib/utils';

export type AnswerHelperVariant = 'feynman' | 'essay' | 'own' | 'review';

/** Платформенная среда неизменна за сессию — подписка не нужна */
const subscribeNoop = () => () => {};

/** Заготовки-«стартеры»: снимают страх пустой страницы и экономят набор */
const PHRASES: Record<AnswerHelperVariant, string[]> = {
  feynman: ['Это значит, что…', 'Например, …', 'Проще говоря, …', 'Главное здесь — '],
  essay: ['Суть в том, что…', 'Например, …', 'Из этого следует, что…', 'В отличие от…'],
  own: ['Дано: ', 'Найти: ', 'Решение: '],
  review: ['Коротко: ', 'Например, …'],
};

/** Дописать кусок к набранному тексту с аккуратным разделителем */
export function appendChunk(prev: string, chunk: string): string {
  if (!prev.trim()) return chunk;
  return /[\s\n]$/.test(prev) ? prev + chunk : prev + ' ' + chunk;
}

// ---- Web Speech API (браузер): минимальные типы без any ----

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}
interface SpeechRecognitionResultLike {
  isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function webSpeechCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function AnswerHelpers({
  variant,
  onAppend,
  disabled,
}: {
  variant: AnswerHelperVariant;
  /** Дописать кусок текста (фраза или финальный фрагмент диктовки) */
  onAppend: (chunk: string) => void;
  disabled?: boolean;
}) {
  const [listening, setListening] = useState(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);

  // поддержка речи неизменна за сессию: useSyncExternalStore без setState
  // в эффекте, false на сервере/в статике — без расхождения гидратации
  const voiceAvailable = useSyncExternalStore(
    subscribeNoop,
    () => isNativePlatform() || !!webSpeechCtor(),
    () => false
  );

  // остановить диктовку при размонтировании карточки
  useEffect(
    () => () => {
      recRef.current?.stop();
      recRef.current = null;
    },
    []
  );

  const startWeb = () => {
    const Ctor = webSpeechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    recRef.current = rec;
    rec.lang = 'ru-RU';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r.isFinal) continue;
        const t = r[0]?.transcript.trim();
        if (t) onAppend(t);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast.error('Нет доступа к микрофону — разреши его в браузере');
      } else if (e.error !== 'aborted') {
        toast.info('Речь не распознана — попробуй ещё раз');
      }
    };
    rec.onend = () => {
      setListening(false);
      recRef.current = null;
    };
    rec.start();
    setListening(true);
  };

  const startNative = async () => {
    setListening(true);
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      await SpeechRecognition.requestPermissions();
      const { available } = await SpeechRecognition.available();
      if (!available) {
        toast.error('Распознавание речи недоступно на этом устройстве');
        return;
      }
      // popup: системный диалог Android; start() вернёт matches, когда закончится
      const res = await SpeechRecognition.start({
        language: 'ru-RU',
        maxResults: 1,
        partialResults: false,
        popup: true,
      });
      const text = res.matches?.[0]?.trim();
      if (text) onAppend(text);
      else toast.info('Речь не распознана — попробуй ещё раз');
    } catch {
      toast.error('Не удалось запустить распознавание речи');
    } finally {
      setListening(false);
    }
  };

  const toggleVoice = () => {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    if (isNativePlatform()) void startNative();
    else startWeb();
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {PHRASES[variant].map((p) => (
        <button
          key={p}
          type="button"
          disabled={disabled}
          onClick={() => onAppend(p)}
          className="rounded-full border border-border px-2.5 py-1 text-[11px] leading-none text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          {p.trim()}
        </button>
      ))}
      {voiceAvailable && (
        <button
          type="button"
          disabled={disabled}
          onClick={toggleVoice}
          aria-label={listening ? 'Остановить диктовку' : 'Продиктовать'}
          title={listening ? 'Остановить диктовку' : 'Продиктовать — допишет в конец текста'}
          className={cn(
            'ml-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
            listening
              ? 'animate-pulse border-rose-500/60 bg-rose-500/15 text-rose-400'
              : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
          )}
        >
          {listening ? <Square className="h-3 w-3" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}
