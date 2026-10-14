'use client';

/**
 * Помощник ввода для текстовых испытаний: голосовая диктовка.
 *
 * Кнопка-микрофон запускает сессию диктовки, которая держится, пока пользователь
 * сам её не выключит: пауза на раздумье любой длины (те самые «30 секунд тишины»)
 * не прерывает запись — распознавание просто перезапускается и ждёт дальше.
 * Каждая произнесённая фраза дописывается в конец поля ввода.
 *
 * В браузере — Web Speech API (Chrome/Edge, кнопка скрыта, если API нет):
 * continuous-режим + автоперезапуск, когда браузер всё же закрыл сессию на тишине.
 * В APK (Capacitor) — собственный нативный плагин ContinuousSpeech (см.
 * src/lib/nativeSpeech.ts): ОДНА сессия распознавания терпит паузу до 12/30 сек
 * (extras тишины в Intent), рестарты происходят ВНУТРИ Java без круга через
 * JS-мост — окно выключенного микрофона минимально, фразы не режутся. Текст
 * доезжает событиями partial (живая подсказка под кнопкой) и final (дописывается
 * в поле). Плагин импортируется динамически и только в нативной среде: на
 * веб-сборке его код не выполняется.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { PluginListenerHandle } from '@capacitor/core';
import type { ContinuousSpeechPlugin } from '@/lib/nativeSpeech';
import { isNativePlatform } from '@/lib/nativeHttp';
import { previewTail } from '@/lib/dictation';
import { cn } from '@/lib/utils';

/** Дописать кусок к набранному тексту (нужен NodeView'у по старому пути) */
export { appendChunk } from '@/lib/dictation';

/** Платформенная среда неизменна за сессию — подписка не нужна */
const subscribeNoop = () => () => {};

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

// ---- Нативный плагин ContinuousSpeech (типы — см. src/lib/nativeSpeech.ts) ----

/** Состояние нативной сессии диктовки (живёт в ref — перерисовки не нужны) */
interface NativeSession {
  plugin: ContinuousSpeechPlugin | null;
  /** черновик текущей сессии плагина — дописывается, если сессия кончилась без финала */
  pending: string | null;
  handles: Promise<PluginListenerHandle>[];
}

function newNativeSession(): NativeSession {
  return { plugin: null, pending: null, handles: [] };
}

/** Единственная активная сессия диктовки на всё приложение (Android-распознаватель — синглтон) */
let activeSessionStopper: (() => void) | null = null;

export function AnswerHelpers({
  onAppend,
  disabled,
}: {
  /** Дописать финальный фрагмент диктовки (или былой фразы) в конец текста */
  onAppend: (chunk: string) => void;
  disabled?: boolean;
}) {
  const [listening, setListening] = useState(false);
  // живой черновик распознавания для подсказки под кнопкой (нативная сессия)
  const [livePartial, setLivePartial] = useState('');
  // сессия диктовки активна (включена кнопкой, выключается той же кнопкой)
  const activeRef = useRef(false);
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const nativeRef = useRef<NativeSession>(newNativeSession());
  const onAppendRef = useRef(onAppend);
  onAppendRef.current = onAppend;

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
      stopSession();
    },
    []
  );

  // ================= web =================

  function stopWeb() {
    const rec = recRef.current;
    recRef.current = null;
    if (rec) {
      rec.onend = null;
      rec.onresult = null;
      rec.onerror = null;
      try {
        rec.stop();
      } catch {
        /* уже остановлен */
      }
    }
  }

  /** Запустить один заход web-распознавания; перезапуск — в onend, пока сессия активна */
  function spawnWeb() {
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
        if (t) onAppendRef.current(t);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        activeRef.current = false;
        setListening(false);
        toast.error('Нет доступа к микрофону — разреши его в браузере');
        return;
      }
      // no-speech (пауза) и aborted (наш stop) — норма: перезапустит onend
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        toast.info('Речь не распознана — пробую слушать дальше');
      }
    };
    rec.onend = () => {
      recRef.current = null;
      if (!activeRef.current) {
        setListening(false);
        return;
      }
      // браузер закрыл сессию (тишина/лимит длины) — тихо открываем новую
      setTimeout(() => {
        if (activeRef.current) spawnWeb();
      }, 250);
    };
    try {
      rec.start();
    } catch {
      /* busy от прошлого захода — перезапустится через onend */
    }
  }

  // ================= native (ContinuousSpeech) =================

  function commitPending() {
    const p = nativeRef.current.pending;
    nativeRef.current.pending = null;
    if (p) onAppendRef.current(p);
  }

  async function startNative() {
    activeRef.current = true;
    try {
      const { ContinuousSpeech } = await import('@/lib/nativeSpeech');
      nativeRef.current.plugin = ContinuousSpeech;
      nativeRef.current.handles = [
        // живой черновик текущей сессии — виден в подсказке,
        // в поле дописывается на границе сессии (final) или по stop
        ContinuousSpeech.addListener('partial', ({ text }) => {
          const t = text.trim();
          nativeRef.current.pending = t || null;
          setLivePartial(t);
        }),
        ContinuousSpeech.addListener('final', ({ text }) => {
          const t = text.trim();
          nativeRef.current.pending = null;
          setLivePartial('');
          if (t) onAppendRef.current(t);
        }),
        ContinuousSpeech.addListener('fatal', (data) => {
          if (!activeRef.current) return;
          if (data.message) toast.error(data.message);
          stopSession();
        }),
      ];
      // одна длинная сессия внутри плагина: пауза на раздумье до 12/30 сек её
      // не рвёт, на завершении плагин сам открывает новую — JS ничего не
      // перезапускает и не опрашивает таймерами, потеря фраз исключена
      await ContinuousSpeech.start({ lang: 'ru-RU' });
      if (!activeRef.current) {
        void stopNative(); // пользователь уже нажал stop, пока плагин стартовал
        return;
      }
      setListening(true);
    } catch {
      toast.error('Не удалось запустить распознавание речи');
      activeRef.current = false;
      setListening(false);
      nativeRef.current.plugin = null;
    }
  }

  async function stopNative() {
    const n = nativeRef.current;
    activeRef.current = false;
    commitPending(); // то, что успело распознаться, — в поле
    const plugin = n.plugin;
    n.plugin = null;
    const handles = n.handles;
    n.handles = [];
    n.pending = null;
    setLivePartial('');
    if (handles.length > 0) {
      void Promise.all(
        handles.map((h) =>
          h
            .then((real) => real.remove())
            .catch(() => undefined)
        )
      );
    }
    if (plugin) {
      try {
        await plugin.stop();
      } catch {
        /* уже остановлен */
      }
    }
    setListening(false);
  }

  // ================= переключатель =================

  /** Остановить сессию этого экземпляра (или чужую — при монтировании новой) */
  function stopSession() {
    activeRef.current = false;
    stopWeb();
    void stopNative();
    if (activeSessionStopper === stopSession) activeSessionStopper = null;
  }

  const toggleVoice = () => {
    if (listening || activeRef.current) {
      stopSession();
      return;
    }
    // другой микрофон на этой странице уже диктует — глушим его
    if (activeSessionStopper && activeSessionStopper !== stopSession) activeSessionStopper();
    activeSessionStopper = stopSession;
    activeRef.current = true;
    if (isNativePlatform()) void startNative();
    else {
      setListening(true);
      spawnWeb();
    }
  };

  return (
    <div className="relative flex items-center">
      {listening && livePartial ? (
        <div
          aria-hidden
          className="pointer-events-none absolute right-0 top-full z-20 mt-2 flex max-w-[85vw] items-start gap-1.5 rounded-lg border border-rose-500/30 bg-popover/95 px-2.5 py-1.5 text-xs leading-snug text-muted-foreground shadow-lg"
        >
          <span className="mt-1 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-rose-500" />
          <span className="line-clamp-2">{previewTail(livePartial)}</span>
        </div>
      ) : null}
      <button
        type="button"
        disabled={disabled}
        onClick={toggleVoice}
        aria-label={listening ? 'Остановить диктовку' : 'Продиктовать'}
        title={
          listening
            ? 'Остановить диктовку (паузы на раздумье не прерывают запись)'
            : 'Продиктовать — допишет в конец текста; паузы до 30 сек и больше не выключают запись'
        }
        className={cn(
          'ml-auto flex h-7 w-7 items-center justify-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50',
          listening
            ? 'animate-pulse border-rose-500/60 bg-rose-500/15 text-rose-400'
            : 'border-border text-muted-foreground hover:border-primary/40 hover:text-foreground'
        )}
      >
        {listening ? <Square className="h-3 w-3" /> : <Mic className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
