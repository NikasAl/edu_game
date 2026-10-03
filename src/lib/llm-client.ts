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
import { nativeRequest, DEFAULT_REQUEST_TIMEOUT_MS, NetworkHttpError } from './nativeHttp';
import { extractJson } from './llm-json';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  /** Строка — обычный текст; массив — мультимодальное сообщение (OCR/визион) */
  content: string | LLMContentPart[];
}

/** Часть мультимодального сообщения (OpenAI-совместимый формат) */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | {
      type: 'image_url';
      image_url: {
        url: string;
        /** OpenAI-стиль: просим полное разрешение, а не экономную downscale-версию */
        detail?: 'auto' | 'low' | 'high';
      };
    };

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
  /** Тип сбоя: connect (не подключились), dropped (соединение оборвано), timeout, http (код не 2xx), empty (пустой ответ), parse (не разобрали) */
  errorKind?: 'connect' | 'dropped' | 'timeout' | 'http' | 'empty' | 'parse';
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
  options: { temperature?: number; maxTokens?: number; withResponseFormat: boolean; stream: boolean; timeoutMs?: number }
): Promise<PostResult> {
  const payload: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: options.temperature ?? 0.3,
    /**
     * Потоковая передача (включена по умолчанию): reasoning-модель может молча
     * думать несколько минут, и промежуточные шлюзы провайдеров (Cloudflare,
     * nginx) рвут такое «простаивающее» соединение — в журнале это выглядело
     * как «Failed to fetch» через ~2 мин без всякого HTTP-статуса. При
     * stream:true сервер шлёт чаты (включая reasoning_content), соединение не
     * простаивает; ответ собирается целиком в parseSseResponse.
     */
    stream: options.stream,
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
    timeoutMs: options.timeoutMs,
  });
}

/** Похоже ли тело ответа на SSE-поток («data: …»). В валидном JSON сырое
 * переносить внутри строковых значений запрещены (экранируются как \n),
 * поэтому ложных срабатываний на JSON-ответах нет. */
export function looksLikeSse(raw: string): boolean {
  return /^\s*data:/m.test(raw);
}

interface SseParseResult {
  /** Ответ, собранный в OpenAI-формат (choices[0].message.content и пр.) */
  data: Record<string, unknown>;
  /** Пришёл финал: finish_reason или data: [DONE] */
  complete: boolean;
  /** Ошибка, переданная сервером чанком {"error": …} */
  error?: string;
}

/**
 * Собрать SSE-поток chat.completion.chunk в объект ответа OpenAI-формата.
 * Склеивает delta.content / delta.reasoning_content, берёт финальный
 * finish_reason, модель и usage. Битые строки пропускает, не роняя поток.
 */
export function parseSseResponse(raw: string): SseParseResult | null {
  let content = '';
  let reasoning = '';
  let finish = '';
  let model = '';
  let usage: unknown;
  let streamError = '';
  let sawChunk = false;
  let sawDone = false;

  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue; // комментарии («: ping») и event: пропускаем
    const payload = t.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      sawDone = true;
      continue;
    }
    let j: Record<string, unknown>;
    try {
      j = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // битая строка — не роняем весь поток
    }
    if (j.error) {
      const e = j.error as { message?: string } | string;
      streamError = typeof e === 'string' ? e : String(e.message ?? JSON.stringify(e));
      continue;
    }
    sawChunk = true;
    if (!model && typeof j.model === 'string') model = j.model;
    if (j.usage && typeof j.usage === 'object') usage = j.usage;
    const choice = (j.choices as unknown[] | undefined)?.[0] as Record<string, unknown> | undefined;
    if (choice) {
      const delta = (choice.delta as Record<string, unknown> | undefined) ?? (choice.message as Record<string, unknown> | undefined) ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason) finish = choice.finish_reason;
    }
  }

  if (!sawChunk) return null;
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (!content.trim() && reasoning.trim()) message.reasoning_content = reasoning; // поймёт extractContentAndRaw
  return {
    data: {
      model,
      choices: [{ index: 0, message, finish_reason: finish || null }],
      ...(usage !== undefined ? { usage } : {}),
    },
    complete: sawDone || Boolean(finish),
    ...(streamError ? { error: streamError } : {}),
  };
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
      // проверка соединения должна падать быстро, а не через 10 минут
      timeoutMs: 45_000,
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

/**
 * Вызов LLM с журналированием и повторами. Запрос идёт потоково (stream:true):
 * reasoning-модель может молча думать минуты, и шлюзы провайдеров рвут такие
 * «простаивающие» соединения (в журнале это выглядело как «Failed to fetch»
 * через ~2 мин без HTTP-статуса). При потоке соединение не простаивает, ответ
 * собирается целиком из чатов (parseSseResponse); провайдеры без поддержки
 * stream автоматически повторяются без него.
 */
export async function callLLM(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number; op?: string; jsonMode?: boolean; timeoutMs?: number } = {}
): Promise<LLMResponse> {
  const op = options.op ?? 'call';
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const t0 = Date.now();
  let attempts = 0;
  let journalWritten = false;
  let lastStatus: number | undefined;
  let lastRaw = '';
  let lastFinish = '';
  let lastUsage: LLMResponse['usage'];
  let maxTokens = options.maxTokens;
  let partialForLog = '';

  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const post = (opts?: { withResponseFormat?: boolean; stream?: boolean }): Promise<PostResult> =>
    doPost(provider, messages, {
      ...options,
      maxTokens,
      withResponseFormat: opts?.withResponseFormat ?? options.jsonMode !== false,
      stream: opts?.stream ?? true,
      timeoutMs,
    });

  /** Разобрать тело 2xx-ответа: SSE-поток или обычный JSON. Бросает понятные ошибки. */
  const parseBody = (res: PostResult): Record<string, unknown> => {
    lastStatus = res.status;
    lastRaw = res.body.slice(0, 8000);
    if (looksLikeSse(res.body)) {
      const parsed = parseSseResponse(res.body);
      if (!parsed) {
        throw new NetworkHttpError('dropped', 'Сервер вернул поток без данных: ни одного чанка не пришло', Date.now() - t0);
      }
      if (parsed.error) {
        throw new Error(`LLM API error: ${parsed.error.slice(0, 300)}`);
      }
      if (!parsed.complete) {
        // поток оборван посреди генерации — что успело прийти, покажем в журнале
        const c = parsed.data.choices as Array<Record<string, unknown>> | undefined;
        const msg = (c?.[0]?.message ?? {}) as Record<string, unknown>;
        const partial = typeof msg.content === 'string' ? msg.content : '';
        partialForLog = partial;
        throw new NetworkHttpError(
          'dropped',
          `Поток ответа оборван: сервер закрыл соединение до конца генерации (получено ${partial.length} симв., финала нет). Попробуй ещё раз — повтор обычно помогает.`,
          Date.now() - t0
        );
      }
      return parsed.data;
    }
    try {
      return JSON.parse(res.body) as Record<string, unknown>;
    } catch {
      throw new Error(`Сервер вернул не-JSON ответ (HTTP ${res.status}): ${res.body.slice(0, 150)}`);
    }
  };

  try {
    // --- попытка 1; сетевые сбои (DNS-микросбой, отказ порта, обрыв соединения)
    // повторяем один раз — шлюзы бесплатных провайдеров бывают капризными ---
    attempts++;
    let res: PostResult;
    const t1 = Date.now();
    try {
      res = await post();
    } catch (err) {
      if (err instanceof NetworkHttpError && err.kind !== 'timeout' && attempts < 3) {
        await pause(2000);
        attempts++;
        res = await post();
      } else {
        throw err;
      }
    }

    // бесплатные/публичные провайдеры часто отдают 429/5xx «модель временно недоступна» —
    // один автоматический повтор через паузу экономит пользователю ручной тык
    if ((res.status === 429 || (res.status >= 500 && res.status < 600)) && attempts < 3) {
      await pause(2500);
      attempts++;
      res = await post();
    }

    // некоторые провайдеры отклоняют response_format — повторяем без него
    if (res.status === 400 && /response_format/i.test(res.body)) {
      attempts++;
      res = await post({ withResponseFormat: false });
    }

    // редкие провайдеры не умеют stream — повторяем без него
    if (res.status === 400 && /stream/i.test(res.body)) {
      attempts++;
      res = await post({ stream: false });
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`LLM API error (${res.status}): ${res.body.slice(0, 300)}`);
    }

    const data = parseBody(res);
    let { content, rawText, finishReason } = extractContentAndRaw(data);
    lastFinish = finishReason;
    lastUsage = data.usage as LLMResponse['usage'] | undefined;

    // --- reasoning-модели съедают лимит токенов размышлениями: повторяем с удвоенным ---
    // (finish_reason=length + пустой content = на ответ не хватило токенов)
    if (!content.trim() && lastFinish === 'length' && maxTokens !== undefined && maxTokens * 2 <= 100000) {
      attempts++;
      maxTokens = maxTokens * 2;
      const res2 = await post();
      if (res2.status >= 200 && res2.status < 300) {
        const data2 = parseBody(res2);
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
      model: String(data.model || provider.model),
      ok: Boolean(content.trim()),
      status: lastStatus,
      durationMs: Date.now() - t0,
      attempts,
      finishReason: lastFinish || undefined,
      usage: lastUsage,
      requestMessages: sanitizeMessagesForLog(messages),
      content,
      rawResponse: rawText || lastRaw,
      error: content.trim()
        ? undefined
        : lastFinish === 'length'
          ? 'Пустой content: модель потратила весь лимит токенов на внутренние размышления (finish_reason=length)'
          : 'Пустой content в ответе модели',
      errorKind: content.trim() ? undefined : 'empty',
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
      model: String(data.model || provider.model),
      provider: provider.name,
      usage: lastUsage,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const kind: LLMLogEntry['errorKind'] = err instanceof NetworkHttpError ? err.kind : /^LLM API error \(/.test(message) ? 'http' : 'parse';
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
        content: partialForLog,
        rawResponse: lastRaw,
        error: message,
        errorKind: kind,
      });
    }
    throw err;
  }
}

export { extractJson };
