/**
 * Минимальный OpenAI-совместимый LLM-клиент (паттерн NutriAdvisor).
 * Работает и в браузере (fetch), и в Capacitor APK (native HTTP без CORS).
 *
 * Отладка (важно для ошибок вида «LLM вернул некорректный JSON»):
 *  - каждый вызов пишется в ЖУРНАЛ LLM (кольцевой буфер, последние 40 записей),
 *    просмотр: Настройки → Журнал LLM (промпт, сырой ответ, статус, длительность);
 *  - каждый вызов дублируется в console.debug (виден в DevTools браузера);
 *  - на серверных сборках журнал дополнительно релеится на POST /api/llm-log
 *    и попадает в консоль `npm run dev` и файл llm-debug.log (в статической
 *    сборке/APK релей тихо игнорируется — журнал доступен в настройках).
 */
import type { LLMProvider } from './types';
import { nativeRequest } from './nativeHttp';
import { extractJson } from './llm-json';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /** Строка — обычный текст; массив — мультимодальное сообщение (OCR/визион) */
  content: string | LLMContentPart[];
}

/** Часть мультимодального сообщения (OpenAI-совместимый формат) */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// ============ Журнал LLM (для отладки промптов и ответов) ============

export interface LLMLogEntry {
  id: number;
  ts: number;
  op: string;
  url: string;
  model: string;
  ok: boolean;
  status?: number;
  durationMs: number;
  attempts: number;
  finishReason?: string;
  usage?: LLMResponse['usage'];
  requestMessages: LLMMessage[];
  content: string;
  rawResponse: string;
  error?: string;
}

const MAX_LOG_ENTRIES = 40;
let logEntries: LLMLogEntry[] = [];
let logSeq = 0;
const logListeners = new Set<() => void>();

function notifyLogListeners() {
  for (const fn of logListeners) fn();
}

/** Подписка на изменения журнала (для UI). Возвращает функцию отписки. */
export function llmDebugSubscribe(fn: () => void): () => void {
  logListeners.add(fn);
  return () => logListeners.delete(fn);
}

/** Снимок журнала: стабильная ссылка (для useSyncExternalStore); последние записи в конце */
export function llmDebugSnapshot(): LLMLogEntry[] {
  return logEntries;
}

export function llmDebugClear(): void {
  logEntries = [];
  notifyLogListeners();
}

function pushLogEntry(entry: LLMLogEntry) {
  logEntries = [...logEntries, entry].slice(-MAX_LOG_ENTRIES);
  notifyLogListeners();
  logToConsole(entry);
  relayToServer(entry);
}

/**
 * Заменить base64-изображения в сообщениях на короткую пометку —
 * иначе журнал/UI/релей раздуваются мегабайтами данных.
 */
function sanitizeMessagesForLog(messages: LLMMessage[]): LLMMessage[] {
  return messages.map((m) => {
    if (typeof m.content === 'string') return m;
    const text = m.content
      .map((p) => {
        if (p.type === 'text') return p.text;
        const url = p.image_url?.url ?? '';
        const kb = Math.round((url.length * 0.75) / 1024);
        return `[изображение ~${kb} КБ]`;
      })
      .join('\n');
    return { ...m, content: text };
  });
}

function logToConsole(entry: LLMLogEntry) {
  const tag = `LLM ${entry.op}`;
  const head = `${entry.ok ? '✓' : '✗'} ${entry.model} HTTP ${entry.status ?? '—'} ${entry.durationMs} мс (попыток: ${entry.attempts})`;
  try {
    console.groupCollapsed(`[${tag}] ${head}`);
    console.debug('ЗАПРОС (messages):', entry.requestMessages);
    console.debug('ОТВЕТ (raw):', entry.rawResponse);
    console.debug('ОТВЕТ (content):', entry.content || '(пусто)');
    if (entry.error) console.debug('ОШИБКА:', entry.error);
    if (entry.usage) console.debug('usage:', entry.finishReason, entry.usage);
    console.groupEnd();
  } catch {
    // консоль может отсутствовать (редкие WebView) — не критично
  }
}

/** Релей на сервер: только в браузерной сборке с API-роутом; ошибки глушим */
function relayToServer(entry: LLMLogEntry) {
  if (typeof window === 'undefined') return;
  const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…[обрезано]' : s);
  const payload = {
    ...entry,
    requestMessages: entry.requestMessages.map((m) => ({
      ...m,
      content: clip(typeof m.content === 'string' ? m.content : '[мультимодальное сообщение]', 6000),
    })),
    rawResponse: clip(entry.rawResponse, 8000),
    content: clip(entry.content, 4000),
  };
  fetch('/api/llm-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
    keepalive: true,
  }).catch(() => {
    /* нет роута (статическая сборка/APK) — журнал доступен в настройках */
  });
}

// ============ HTTP ============

function buildHeaders(provider: LLMProvider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

/** Нормализовать message.content: строка | массив частей | reasoning_content */
function extractContentAndRaw(data: Record<string, unknown>): { content: string; rawText: string; finishReason: string } {
  const choice = (data.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
  const message = (choice?.message as Record<string, unknown> | undefined) ?? {};
  const finishReason = String(choice?.finish_reason ?? '');
  let content = '';
  let rawText = '';
  const c = message.content;
  if (typeof c === 'string') {
    content = c;
    rawText = c;
  } else if (Array.isArray(c)) {
    // некоторые провайдеры возвращают массив частей {type:'text', text:'…'}
    content = c
      .map((p) => (typeof p === 'string' ? p : String((p as Record<string, unknown>)?.text ?? '')))
      .join('');
    rawText = content;
  }
  if (!content.trim() && typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    // reasoning-модели: иногда весь текст уходит в reasoning_content — пробуем оттуда
    content = message.reasoning_content;
    rawText = message.reasoning_content;
  }
  return { content, rawText, finishReason };
}

interface PostResult {
  status: number;
  body: string;
}

async function doPost(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; withResponseFormat: boolean }
): Promise<PostResult> {
  const payload: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: options.temperature ?? 0.3,
  };
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
  if (options.withResponseFormat && provider.type !== 'ollama' && provider.type !== 'llamacpp') {
    // просим строгий JSON там, где это поддерживается; локальные серверы могут не уметь
    payload.response_format = { type: 'json_object' };
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return nativeRequest(url, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(payload),
  });
}

/** Быстрая проверка провайдера: короткий запрос */
export async function testProvider(provider: LLMProvider): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await nativeRequest(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(provider),
      body: JSON.stringify({
        model: provider.model,
        messages: [{ role: 'user', content: 'Ответь одним словом: работает' }],
        max_tokens: 300,
        temperature: 0,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, message: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
    }
    const data = JSON.parse(res.body);
    const { content } = extractContentAndRaw(data);
    return {
      ok: true,
      message: `Провайдер работает. Модель: ${data.model ?? provider.model}. Ответ: «${content.slice(0, 50)}»`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `Ошибка соединения: ${err instanceof Error ? err.message : 'неизвестная'}`,
    };
  }
}

/** Обычный (нестримовый) вызов LLM с журналированием и повторами */
export async function callLLM(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; op?: string; jsonMode?: boolean } = {}
): Promise<LLMResponse> {
  const op = options.op ?? 'call';
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const t0 = Date.now();
  let attempts = 0;
  let journalWritten = false;
  let lastStatus: number | undefined;
  let lastRaw = '';
  let lastFinish = '';
  let lastUsage: LLMResponse['usage'];
  let maxTokens = options.maxTokens;

  try {
    // --- попытка 1 ---
    attempts++;
    let res = await doPost(provider, messages, { ...options, maxTokens, withResponseFormat: options.jsonMode !== false });
    lastStatus = res.status;
    lastRaw = res.body;

    // бесплатные/публичные провайдеры часто отдают 429/5xx «модель временно недоступна» —
    // один автоматический повтор через паузу экономит пользователю ручной тык
    if (
      (res.status === 429 || (res.status >= 500 && res.status < 600)) &&
      attempts < 3
    ) {
      await new Promise((r) => setTimeout(r, 2500));
      attempts++;
      res = await doPost(provider, messages, { ...options, maxTokens, withResponseFormat: options.jsonMode !== false });
      lastStatus = res.status;
      lastRaw = res.body;
    }

    // некоторые провайдеры отклоняют response_format — повторяем без него
    if (res.status === 400 && /response_format/i.test(res.body)) {
      attempts++;
      res = await doPost(provider, messages, { ...options, maxTokens, withResponseFormat: false });
      lastStatus = res.status;
      lastRaw = res.body;
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`LLM API error (${res.status}): ${res.body.slice(0, 300)}`);
    }

    const data = JSON.parse(res.body) as Record<string, unknown>;
    let { content, rawText, finishReason } = extractContentAndRaw(data);
    lastFinish = finishReason;
    lastUsage = data.usage as LLMResponse['usage'] | undefined;

    // --- reasoning-модели съедают лимит токенов размышлениями: повторяем с удвоенным ---
    // (finish_reason=length + пустой content = на ответ не хватило токенов)
    if (!content.trim() && finishReason === 'length' && maxTokens !== undefined && maxTokens * 2 <= 100000) {
      attempts++;
      maxTokens = maxTokens * 2;
      const res2 = await doPost(provider, messages, { ...options, maxTokens, withResponseFormat: options.jsonMode !== false });
      lastStatus = res2.status;
      lastRaw = res2.body;
      if (res2.status >= 200 && res2.status < 300) {
        const data2 = JSON.parse(res2.body) as Record<string, unknown>;
        ({ content, rawText, finishReason } = extractContentAndRaw(data2));
        lastFinish = finishReason;
        lastUsage = data2.usage as LLMResponse['usage'] | undefined;
      }
    }

    pushLogEntry({
      id: ++logSeq,
      ts: Date.now(),
      op,
      url,
      model: String(data.model ?? provider.model),
      ok: Boolean(content.trim()),
      status: lastStatus,
      durationMs: Date.now() - t0,
      attempts,
      finishReason: lastFinish || undefined,
      usage: lastUsage,
      requestMessages: sanitizeMessagesForLog(messages),
      content,
      rawResponse: rawText || lastRaw.slice(0, 8000),
      error: content.trim()
        ? undefined
        : lastFinish === 'length'
          ? 'Пустой content: модель потратила весь лимит токенов на внутренние размышления (finish_reason=length)'
          : 'Пустой content в ответе модели',
    });
    journalWritten = true;

    if (!content.trim()) {
      throw new Error(
        lastFinish === 'length'
          ? 'Модель потратила весь лимит токенов на внутренние размышления и не успела дать ответ (finish_reason=length). Повтори попытку или выбери другую модель.'
          : 'Модель вернула пустой ответ (content отсутствует). Смотри Настройки → Журнал LLM.'
      );
    }

    return {
      content,
      model: String(data.model ?? provider.model),
      provider: provider.name,
      usage: lastUsage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // не дублируем запись журнала, если её уже добавили до броска
    if (!journalWritten) {
      pushLogEntry({
        id: ++logSeq,
        ts: Date.now(),
        op,
        url,
        model: provider.model,
        ok: false,
        status: lastStatus,
        durationMs: Date.now() - t0,
        attempts,
        finishReason: lastFinish || undefined,
        usage: lastUsage,
        requestMessages: sanitizeMessagesForLog(messages),
        content: '',
        rawResponse: lastRaw.slice(0, 8000),
        error: message,
      });
    }
    throw err;
  }
}

export { extractJson };
