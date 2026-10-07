/**
 * Native HTTP plugin — проксирует запросы через Java HttpURLConnection,
 * обходя CORS и mixed-content ограничения Android WebView.
 * Доступен только в Capacitor (APK); в браузере — fallback на fetch().
 * Паттерн перенесён из NutriAdvisor.
 */

import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

export interface NativeHttpResponse {
  status: number;
  body: string;
}

/**
 * Тайм-аут HTTP-запроса по умолчанию: 10 минут.
 * Reasoning-модели на большом фрагменте могут думать дольше 5 минут
 * (замер по журналу LLM: успешные инжесты шли 247–263 с, упиравшиеся
 * в прежний лимит 300 с так и не успели).
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

// ============ Классификация сетевых ошибок ============
// «Failed to fetch» (сырой TypeError браузера) не говорит ничего о причине:
// под ним скрываются и DNS, и отказ соединения, и обрыв долгого запроса
// шлюзом провайдера, и CORS-блок. Здесь каждая ситуация получает ясное
// русское сообщение + тип (kind) для журнала.

export type NetworkErrorKind = 'timeout' | 'connect' | 'dropped';

/** Классифицированная сетевая ошибка: message — уже готов для пользователя */
export class NetworkHttpError extends Error {
  readonly kind: NetworkErrorKind;
  /** Сколько времени прошло до сбоя (для сообщений «оборвалось через N с») */
  readonly durationMs: number;

  constructor(kind: NetworkErrorKind, message: string, durationMs: number) {
    super(message);
    this.name = 'NetworkHttpError';
    this.kind = kind;
    this.durationMs = durationMs;
  }
}

/** «126000 мс» → «2 мин 6 с» (для сообщений и журнала) */
export function fmtDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} мин ${rest} с` : `${m} мин`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Понятная ошибка для «сервер закрыл соединение» (по любой длительности) */
function droppedMsg(host: string, durationMs: number, codeHint: string): NetworkHttpError {
  return new NetworkHttpError(
    'dropped',
    `Соединение с ${host} оборвалось через ${fmtDuration(durationMs)} без ответа: сервер закрыл запрос — шлюзы провайдеров так поступают с долгими «молчащими» соединениями (пока модель думает) или при перегрузке. Попробуй ещё раз или выбери другого провайдера/модель.${codeHint}`,
    durationMs
  );
}

/** Сформировать понятную ошибку из сырого TypeError браузерного/node fetch */
function describeFetchTypeError(url: string, durationMs: number, cause: unknown): NetworkHttpError {
  const host = hostOf(url);
  const causeText = cause ? String((cause as { message?: string }).message ?? cause).trim() : '';
  const cl = causeText.toLowerCase();
  const codeHint = causeText && !/failed to fetch|fetch failed/i.test(causeText) ? ` Код ошибки: ${causeText.slice(0, 120)}.` : '';

  // 1) причина от сетевого стека точнее любых эвристик по времени
  if (/econnrefused|connection refused/.test(cl)) {
    return new NetworkHttpError('connect', `Сервер ${host} отклонил подключение — проверь адрес и порт провайдера.${codeHint}`, durationMs);
  }
  if (/enotfound|getaddrinfo|eai_again/.test(cl)) {
    return new NetworkHttpError('connect', `Не удалось определить адрес сервера ${host} (DNS). Проверь Base URL и интернет-соединение.${codeHint}`, durationMs);
  }
  if (/econnreset|other side closed|socket hung up|epipe|socket error/.test(cl)) {
    return droppedMsg(host, durationMs, codeHint);
  }

  // 2) браузер часто скрывает причину — судим по времени до сбоя
  if (durationMs < 5_000) {
    // подключиться не удалось вовсе: адрес, сеть, CORS preflight
    return new NetworkHttpError(
      'connect',
      `Не удалось подключиться к ${host} (ответа нет за ${fmtDuration(durationMs)}). Причины: неверный Base URL, сервер недоступен или нет интернета; из браузера запрос может блокировать CORS (в приложении/APK — нет).${codeHint}`,
      durationMs
    );
  }
  // соединение жили долго и умерло без ответа — почти наверняка шлюз провайдера
  return droppedMsg(host, durationMs, codeHint);
}

/** Понятное сообщение для типовых отказов Java HttpURLConnection (нативный путь) */
function describeNativeRejection(raw: string, durationMs: number): NetworkHttpError {
  const m = raw.toLowerCase();
  const dur = fmtDuration(durationMs);
  if (m.includes('тайм-аут') || m.includes('timeout')) {
    // Java уже возвращает готовое русское сообщение про тайм-аут
    return new NetworkHttpError('timeout', raw, durationMs);
  }
  if (m.includes('unable to resolve host') || m.includes('unknownhost')) {
    return new NetworkHttpError('connect', `Не удалось определить адрес сервера (DNS). Проверь Base URL и интернет-соединение. (${raw})`, durationMs);
  }
  if (m.includes('connection refused')) {
    return new NetworkHttpError('connect', `Сервер отклонил подключение — проверь адрес и порт (${raw})`, durationMs);
  }
  if (m.includes('connection reset') || m.includes('broken pipe') || m.includes('unexpected end of stream') || m.includes('econnreset')) {
    return new NetworkHttpError('dropped', `Соединение оборвалось через ${dur}: сервер сбросил соединение во время запроса. Попробуй ещё раз или выбери другого провайдера. (${raw})`, durationMs);
  }
  if (m.includes('network is unreachable') || m.includes('no address associated')) {
    return new NetworkHttpError('connect', `Нет сети до сервера (${raw})`, durationMs);
  }
  return new NetworkHttpError('dropped', `Сетевая ошибка после ${dur}: ${raw}`, durationMs);
}

interface NativeHttpPlugin {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<NativeHttpResponse>;
  addListener(eventName: string, listenerFunc: (data: unknown) => void): Promise<PluginListenerHandle>;
  removeAllListeners(): Promise<void>;
}

/** Запущено ли внутри нативной оболочки Capacitor */
export function isNativePlatform(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

const NativeHttp = registerPlugin<NativeHttpPlugin>('NativeHttp');

/**
 * HTTP-запрос: в нативной среде — через Java (без CORS), иначе fetch().
 * timeoutMs переопределяет тайм-аут (иначе DEFAULT_REQUEST_TIMEOUT_MS).
 * Любой сбой бросается как NetworkHttpError с понятной причиной.
 */
export async function nativeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {}
): Promise<NativeHttpResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const startedAt = Date.now();

  if (isNativePlatform()) {
    try {
      return await NativeHttp.request({
        url,
        method: options.method ?? 'POST',
        headers: options.headers ?? {},
        body: options.body,
        timeoutMs,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      throw describeNativeRejection(raw, Date.now() - startedAt);
    }
  }

  try {
    const res = await fetch(url, {
      method: options.method ?? 'POST',
      headers: options.headers ?? {},
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseBody = await res.text();
    return { status: res.status, body: responseBody };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    // AbortSignal.timeout даёт DOMException name='TimeoutError' (в некоторых
    // средах — 'AbortError') с невнятным текстом «signal timed out» —
    // заменяем на понятное пользователю сообщение
    const errName = err instanceof DOMException ? err.name : (err as { name?: string } | null)?.name;
    if (errName === 'TimeoutError' || errName === 'AbortError') {
      throw new NetworkHttpError(
        'timeout',
        `Тайм-аут: ответ не получен за ${fmtDuration(timeoutMs)}. Модель слишком медленная для этого запроса — попробуй ещё раз, уменьши фрагмент или выбери более быструю модель.`,
        durationMs
      );
    }
    // TypeError: Failed to fetch — обрыв сети/соединения/CORS без HTTP-статуса
    if (err instanceof TypeError) {
      const cause = (err as { cause?: unknown }).cause;
      throw describeFetchTypeError(url, durationMs, cause);
    }
    throw err;
  }
}
