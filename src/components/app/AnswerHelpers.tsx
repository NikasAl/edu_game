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
 * В APK (Capacitor) — @capacitor-community/speech-recognition в фоновом режиме
 * (popup: false, partialResults: true, без системного диалога): плагин закрывает
 * внутреннюю сессию распознавания на паузе — мы сразу открываем новую. Конец
 * сессии ловится двумя путями: событие listeningState=stopped и watchdog-опрос
 * isListening() раз в 2 сек (некоторые ошибки, например таймаут тишины, не дают
 * JS-события вовсе). Плагин импортируется динамически и только в нативной среде:
 * на веб-сборке его код не выполняется.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Mic, Square } from 'lucide-react';
import { toast } from 'sonner';
import { isNativePlatform } from '@/lib/nativeHttp';
import { cn } from '@/lib/utils';

/** Платформенная среда неизменна за сессию — подписка не нужна */
const subscribeNoop = () => () => {};

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

// ---- Нативный плагин: минимальный тип используемого API ----

interface NativePluginHandle {
  remove: () => Promise<void>;
}
interface NativeSpeechPlugin {
  start(options?: {
    language?: string;
    maxResults?: number;
    partialResults?: boolean;
    popup?: boolean;
    prompt?: string;
  }): Promise<{ matches?: string[] } | void>;
  stop(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  removeAllListeners(): Promise<void>;
  addListener(
    eventName: 'partialResults',
    listenerFunc: (data: { matches?: string[] }) => void
  ): Promise<NativePluginHandle>;
  addListener(
    eventName: 'listeningState',
    listenerFunc: (data: { status: 'started' | 'stopped' }) => void
  ): Promise<NativePluginHandle>;
}

/** Состояние нативной сессии диктовки (живёт в ref — перерисовки не нужны) */
interface NativeSession {
  plugin: NativeSpeechPlugin | null;
  /** последний partial-текст текущей сессии плагина (дописывается на конце сессии) */
  pending: string | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  watchdog: ReturnType<typeof setInterval> | null;
  handles: Promise<NativePluginHandle>[];
  /** защита от параллельных перезапусков watchdog'а */
  ticking: boolean;
}

function newNativeSession(): NativeSession {
  return { plugin: null, pending: null, restartTimer: null, watchdog: null, handles: [], ticking: false };
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

  // ================= native =================

  function commitPending() {
    const p = nativeRef.current.pending;
    nativeRef.current.pending = null;
    if (p) onAppendRef.current(p);
  }

  function clearNativeTimers() {
    const n = nativeRef.current;
    if (n.restartTimer) {
      clearTimeout(n.restartTimer);
      n.restartTimer = null;
    }
    if (n.watchdog) {
      clearInterval(n.watchdog);
      n.watchdog = null;
    }
  }

  /** Один заход нативного распознавания: partialResults-события копят текст, конец сессии ловят слушатели */
  async function runNativeOnce() {
    const plugin = nativeRef.current.plugin;
    if (!plugin || !activeRef.current) return;
    nativeRef.current.pending = null;
    try {
      // popup: false — без системного диалога; start() резолвится сразу,
      // окончание сессии приходит событиями partialResults/listeningState
      await plugin.start({ language: 'ru-RU', maxResults: 1, partialResults: true, popup: false });
    } catch {
      // распознаватель занят/ошибка — попробуем снова, пока сессия активна
      scheduleNativeRestart(1200);
    }
  }

  function scheduleNativeRestart(delayMs: number) {
    if (!activeRef.current) return;
    const n = nativeRef.current;
    if (n.restartTimer) clearTimeout(n.restartTimer);
    n.restartTimer = setTimeout(() => {
      n.restartTimer = null;
      if (!activeRef.current) return;
      commitPending(); // дописать последнюю фразу закрывшейся сессии
      void runNativeOnce();
    }, delayMs);
  }

  async function watchdogTick() {
    const n = nativeRef.current;
    if (!activeRef.current || n.restartTimer || n.ticking) return;
    n.ticking = true;
    try {
      const { listening: isL } = await n.plugin?.isListening() ?? { listening: false };
      // сессия плагина заглохла без события (таймаут тишины и т.п.) — перезапуск
      if (!isL && !nativeRef.current.restartTimer) scheduleNativeRestart(0);
    } catch {
      /* плагин недоступен — сессию закроет stop/размонтирование */
    } finally {
      n.ticking = false;
    }
  }

  async function startNative() {
    activeRef.current = true;
    try {
      const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
      await SpeechRecognition.requestPermissions();
      const { available } = await SpeechRecognition.available();
      if (!available) {
        toast.error('Распознавание речи недоступно на этом устройстве');
        activeRef.current = false;
        return;
      }
      if (!activeRef.current) return; // пользователь уже нажал stop
      nativeRef.current.plugin = SpeechRecognition as unknown as NativeSpeechPlugin;
      await SpeechRecognition.removeAllListeners();
      nativeRef.current.handles = [
        SpeechRecognition.addListener('partialResults', (data: { matches?: string[] }) => {
          const t = data.matches?.[0]?.trim();
          if (t) nativeRef.current.pending = t;
        }),
        SpeechRecognition.addListener('listeningState', (data: { status: 'started' | 'stopped' }) => {
          // onEndOfSpeech: пользователь замолчал — финальный текст придёт следом,
          // поэтому перезапуск с задержкой; пауза до 30+ сек между фразами — норм
          if (data.status === 'stopped') scheduleNativeRestart(800);
        }),
      ];
      setListening(true);
      await runNativeOnce();
      // watchdog: часть ошибок плагина не даёт JS-событий — опрашиваем isListening
      nativeRef.current.watchdog = setInterval(() => void watchdogTick(), 2000);
    } catch {
      toast.error('Не удалось запустить распознавание речи');
      activeRef.current = false;
      setListening(false);
    }
  }

  async function stopNative() {
    const n = nativeRef.current;
    activeRef.current = false;
    clearNativeTimers();
    commitPending(); // то, что успело распознаться, — в поле
    const plugin = n.plugin;
    n.plugin = null;
    const handles = n.handles;
    n.handles = [];
    n.pending = null;
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
    <div className="flex items-center">
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
