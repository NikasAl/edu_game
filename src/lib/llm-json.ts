/**
 * Устойчивое извлечение JSON из ответа LLM (без зависимостей — проверяется node-тестом).
 *
 * Почему это отдельный модуль: ответ reasoning-моделей бывает обёрнут в <think>…</think>,
 * содержит текст вокруг JSON, «сырые» переводы строк внутри строковых значений или
 * обрезается посреди строки. Стандартный JSON.parse здесь бессилен.
 */

/** Краткий фрагмент сырого ответа для сообщений об ошибках и журнала */
export function rawSnippet(raw: string, max = 180): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '…';
}

/** Убрать ЗАКРЫТЫЕ блоки «внутренних размышлений», если модель втиснула их в content */
function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '');
}

/** Есть ли в тексте признаки незакрытого блока размышлений */
function hasThinkMarkers(text: string): boolean {
  return /<think|<reasoning/i.test(text);
}

/**
 * Найти сбалансированный JSON-объект/массив, начиная с позиции start.
 * Учитывает строки и экранирование: скобки внутри "…" не считаются.
 * Возвращает срез до закрывающей скобки или null.
 */
function balancedSlice(text: string, start: number): string | null {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open || ch === '{' || ch === '[') {
      // считаем только скобки того же «семейства»: для { считаем и вложенные { и [
      depth++;
    } else if (ch === close || ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Починка «сырых» переводов строк/табуляций внутри строковых значений
 * (частая ошибка слабых моделей: JSON.parse требует \n, а не реальный перенос).
 */
function repairControlChars(json: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

function tryParse<T>(candidate: string): { ok: true; value: T } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(candidate) as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Извлечь JSON из ответа LLM: терпимо к ```json-обёрткам, тексту вокруг,
 * <think>-блокам, сырым переводам строк внутри строк. Бросает ошибку с фрагментом ответа.
 */
export function extractJson<T>(raw: string): T {
  if (raw === null || raw === undefined) {
    throw new Error('LLM вернул пустой ответ (content отсутствует)');
  }
  let text = String(raw).trim();
  if (text === '') {
    throw new Error('LLM вернул пустой ответ (content отсутствует)');
  }
  text = stripThinkBlocks(text).trim();

  // 1) как есть
  const direct = tryParse<T>(text);
  if (direct.ok) return direct.value;

  // 2) снять ```-обёртку
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const inner = tryParse<T>(fence[1].trim());
    if (inner.ok) return inner.value;
  }

  // 3) собрать кандидатов: сбалансированные срезы от каждой { (или [, если объектов нет)
  //    ищем именно объекты: проза вокруг может содержать квадратные скобки
  const candidates: string[] = [];
  const starts: number[] = [];
  let pos = text.indexOf('{');
  while (pos >= 0 && starts.length < 50) {
    starts.push(pos);
    pos = text.indexOf('{', pos + 1);
  }
  if (starts.length === 0) {
    const arr = text.indexOf('[');
    if (arr >= 0) starts.push(arr);
  }
  for (const s of starts) {
    const slice = balancedSlice(text, s);
    if (slice) candidates.push(slice);
  }
  if (candidates.length === 0 && starts.length > 0) {
    // всё обрезано — берём «хвост» с починкой control-символов
    candidates.push(repairControlChars(text.slice(starts[0])));
  }

  //    порядок: обычно первый валидный; если были <think>-блоки — рассуждения идут
  //    ДО финального JSON, поэтому берём последний валидный
  const order = hasThinkMarkers(text) ? [...candidates].reverse() : candidates;
  for (const c of order) {
    const p1 = tryParse<T>(c);
    if (p1.ok) return p1.value;
    const p2 = tryParse<T>(repairControlChars(c));
    if (p2.ok) return p2.value;
  }

  throw new Error(
    `LLM вернул некорректный JSON. Начало ответа: «${rawSnippet(text)}». ` +
      `Полные промпт и ответ смотри в Настройки → Журнал LLM.`
  );
}
