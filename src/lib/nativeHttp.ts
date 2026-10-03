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

  if (isNativePlatform()) {
    return NativeHttp.request({
      url,
      method: options.method ?? 'POST',
      headers: options.headers ?? {},
      body: options.body,
      timeoutMs,
    });
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
    // AbortSignal.timeout даёт DOMException name='TimeoutError' с невнятным
    // текстом «signal timed out» — заменяем на понятное пользователю сообщение
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      const min = Math.max(1, Math.round(timeoutMs / 60_000));
      throw new Error(
        `Тайм-аут: ответ не получен за ${min} мин. Модель слишком медленная для этого запроса — попробуй ещё раз, уменьши фрагмент или выбери более быструю модель.`
      );
    }
    throw err;
  }
}

void ({} as PluginListenerHandle | null);
