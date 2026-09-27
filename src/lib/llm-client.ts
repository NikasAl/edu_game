/**
 * Минимальный OpenAI-совместимый LLM-клиент (паттерн NutriAdvisor).
 * Работает и в браузере (fetch), и в Capacitor APK (native HTTP без CORS).
 */
import type { LLMProvider } from './types';
import { nativeRequest } from './nativeHttp';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  provider: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

function buildHeaders(provider: LLMProvider): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
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
        max_tokens: 10,
        temperature: 0,
      }),
    });
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, message: `HTTP ${res.status}: ${res.body.slice(0, 200)}` };
    }
    const data = JSON.parse(res.body);
    const content = data.choices?.[0]?.message?.content ?? '';
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

/** Обычный (нестримовый) вызов LLM */
export async function callLLM(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<LLMResponse> {
  const payload: Record<string, unknown> = {
    model: provider.model,
    messages,
    temperature: options.temperature ?? 0.3,
  };
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens;
  if (provider.type !== 'ollama' && provider.type !== 'llamacpp') {
    // просим строгий JSON там, где это поддерживается; локальные серверы могут не уметь
    payload.response_format = { type: 'json_object' };
  }

  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await nativeRequest(url, {
    method: 'POST',
    headers: buildHeaders(provider),
    body: JSON.stringify(payload),
  });

  if (res.status < 200 || res.status >= 300) {
    throw new Error(`LLM API error (${res.status}): ${res.body.slice(0, 300)}`);
  }

  const data = JSON.parse(res.body);
  const content = data.choices?.[0]?.message?.content ?? '';
  return {
    content,
    model: data.model ?? provider.model,
    provider: provider.name,
    usage: data.usage ?? undefined,
  };
}

/**
 * Извлечь JSON из ответа LLM: терпимо к ```json-обёрткам и тексту вокруг.
 */
export function extractJson<T>(raw: string): T {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  // найти первую { или [
  const start = text.search(/[{[]/);
  if (start > 0) text = text.slice(start);
  // попытка 1: как есть
  try {
    return JSON.parse(text) as T;
  } catch {
    // попытка 2: обрезать до последней закрывающей скобки
    const lastBrace = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (lastBrace > 0) {
      return JSON.parse(text.slice(0, lastBrace + 1)) as T;
    }
    throw new Error('LLM вернул некорректный JSON');
  }
}
