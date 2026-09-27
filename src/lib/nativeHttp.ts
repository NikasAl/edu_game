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

interface NativeHttpPlugin {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
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
 */
export async function nativeRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<NativeHttpResponse> {
  if (isNativePlatform()) {
    return NativeHttp.request({
      url,
      method: options.method ?? 'POST',
      headers: options.headers ?? {},
      body: options.body,
    });
  }

  const res = await fetch(url, {
    method: options.method ?? 'POST',
    headers: options.headers ?? {},
    body: options.body,
    signal: AbortSignal.timeout(300_000),
  });

  const responseBody = await res.text();
  return { status: res.status, body: responseBody };
}

void ({} as PluginListenerHandle | null);
