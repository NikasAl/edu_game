/**
 * Интеллектуальные операции над учебными материалами.
 * Все операции имеют два режима:
 *  - LLM (OpenAI-совместимый провайдер из настроек);
 *  - локальный демо-оценщик (без LLM; помечается в UI как «демо»).
 */
import { callLLM, type LLMMessage } from './llm-client';
import { extractJson } from './llm-json';
import type {
  AtomKind,
  EdgeKind,
  EssayGrade,
  FeynmanGrade,
  IngestResult,
  LLMProvider,
  OwnTaskVerdict,
  ParsedAtom,
  Task,
  TaskInstance,
  TaskType,
} from './types';
import { normalizeAtomKind } from './types';
import { normalizeText } from './safeMath';

const SYSTEM = `Ты — методист-редактор образовательных материалов. Ты аккуратен, соблюдаешь запрошенный формат JSON и пишешь по-русски. Не выдумывай факты, которых нет в материале; если чего-то не хватает — опирайся на общепринятые школьные/вузовские формулировки.

ФОРМУЛЫ: пиши математические выражения в LaTeX — строчные формулы оборачивай в $...$ (например: $v(t) = 2at$), выключные/отдельной строкой — в $$...$$. Степени и индексы — только LaTeX-синтаксисом ($x^2$, $t_0$), без юникод-надстрочных знаков (², ₀) ВНУТРИ формул. Обратные слэши в командах LaTeX (\\frac, \\cdot, \\int) сохраняй как есть. Вне формул — обычный текст. В поля, которые обрабатывает решатель (expr, value, alts), LaTeX НЕ писать — там чистый синтаксис решателя.`;

// ============ 0. JSON-запрос с авто-повтором при ответе «невпопад» ============

/**
 * Бесплатные прокси иногда отвечают на JSON-промпт «невпопад» и без ошибки
 * сервера: в ответе проза, markdown-картинка (реальный случай из журнала:
 * «Here is your generated image: …» от top-tools-ai) или вообще не тот
 * JSON. extractJson падает, и раньше это роняло всю операцию — например,
 * многофрагментный импорт после десятков минут работы. Повторный запрос
 * почти всегда даёт нормальный ответ, поэтому все JSON-операции идут через
 * эту обёртку: до JSON_ATTEMPTS попыток с паузой и подсказкой модели
 * «верни только JSON». Сетевые и HTTP-ошибки не трогаем — у callLLM
 * собственные повторы, наверх они пробрасываются сразу.
 */
const JSON_ATTEMPTS = 3;

/** Повторяем только «ответ не разобрать / ответ пуст» — остальное сразу наверх */
function isRetryableAnswerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.startsWith('LLM вернул некорректный JSON') ||
    msg.startsWith('LLM вернул пустой ответ') ||
    msg.startsWith('Модель вернула пустой ответ')
  );
}

async function callLLMJson<T>(
  provider: LLMProvider,
  messages: LLMMessage[],
  options: {
    op: string;
    temperature?: number;
    maxTokens?: number;
    /** Проверка структуры ответа: вернуть текст проблемы или null, если всё в порядке */
    validate: (parsed: T) => string | null;
  }
): Promise<T> {
  let lastProblem = '';
  for (let attempt = 1; attempt <= JSON_ATTEMPTS; attempt++) {
    const attemptMessages: LLMMessage[] =
      attempt === 1
        ? messages
        : [
            ...messages,
            {
              role: 'user',
              content: `Предыдущий ответ не подошёл: ${lastProblem} Верни ТОЛЬКО валидный JSON в запрошенном формате — без пояснений, без markdown-заборов и без текста вокруг.`,
            },
          ];
    let parsed: T;
    try {
      const res = await callLLM(provider, attemptMessages, {
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        op: options.op,
      });
      parsed = extractJson<T>(res.content);
    } catch (err) {
      if (!isRetryableAnswerError(err)) throw err; // сетевые/HTTP — сразу наверх
      lastProblem = err instanceof Error ? err.message : String(err);
      if (attempt >= JSON_ATTEMPTS) break; // попытки исчерпаны — финальная ошибка ниже
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    const problem = options.validate(parsed);
    if (problem === null) return parsed;
    lastProblem = `JSON не той структуры (${problem}).`;
    if (attempt < JSON_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(
    `Модель ${JSON_ATTEMPTS} раза подряд ответила не по формату: ${lastProblem} Попробуй ещё раз позже или выбери другую модель; полный ответ модели — в Настройки → Журнал LLM.`
  );
}

// ============ 1. Ингест: текст → атомы идей ============

const INGEST_PROMPT = `Разбери учебный материал и выдели атомарные идеи (атомы).

Правила атомарности:
- атом = ОДНА идея: формулируется одним предложением, иллюстрируется одним примером, проверяется одним вопросом;
- на главу обычно 4–12 атомов; не дроби сильнее, не склеивай разные идеи;
- для каждого атома укажи, от каких других атомов он зависит (needs): hard = без этого понять нельзя, soft = помогает;
- зависимости должны образовывать ациклический граф;
- atomKind — тип идеи, ровно одно значение: "fact" (изолированный факт), "date" (событие/дата/период), "person" (персоналия), "concept" (понятие/закономерность без вычислений), "procedure" (метод/алгоритм/последовательность действий), "formula" (количественная закономерность/формула/вычисление), "opinion" (оценка/аргументация «почему так»);
- если атом поясняется листингом кода из материала — перенеси его в поле "code" атома КАК ЕСТЬ (с переносами строк и отступами, без нумерации строк, без markdown-обёрток из трёх обратных кавычек; не более ~20 строк; если листинга нет — пустая строка);
- 1–3 региона (главы/раздела), атомы распределены по регионам;
- feynmanQuestion — вопрос, требующий объяснения идеи СВОИМИ словами с примером;
- sourceQuote — короткая цитата из материала, к которой привязан атом (если она есть).

Верни СТРОГО JSON без пояснений:
{
  "regions": [{"title": "строка"}],
  "atoms": [{
    "regionIndex": 0,
    "title": "короткое название идеи",
    "formulation": "суть идеи одним предложением",
    "example": "один наглядный пример",
    "misconception": "типичное заблуждение (или пусто)",
    "sourceQuote": "цитата из материала (или пусто)",
    "feynmanQuestion": "вопрос для объяснения своими словами",
    "keyTerms": ["3-6 ключевых терминов идеи"],
    "atomKind": "concept",
    "code": "листинг кода (или пусто)",
    "needs": [{"title": "название другого атома", "kind": "hard|soft"}]
  }]
}`;

export async function ingestSplitIntoIdeas(
  provider: LLMProvider,
  materialTitle: string,
  sourceText: string,
  part?: { part: number; total: number }
): Promise<IngestResult> {
  const partNote = part
    ? `Это часть ${part.part} из ${part.total} большого материала. Анализируй ТОЛЬКО этот фрагмент — не пытайся покрыть весь материал. Идеи соседних частей будут добавлены из других запросов; дубли допустимы, их отфильтруют позже.`
    : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${INGEST_PROMPT}${partNote ? `\n\n${partNote}` : ''}\n\nНазвание материала: «${materialTitle}»\n\nМАТЕРИАЛ:\n${sourceText.slice(0, 24000)}`,
    },
  ];
  return callLLMJson<IngestResult>(provider, messages, {
    op: 'ingest',
    temperature: 0.2,
    maxTokens: 50000,
    validate: (p) => {
      if (!Array.isArray(p.atoms) || p.atoms.length === 0) return 'массив atoms пуст или отсутствует';
      if (!Array.isArray(p.regions)) return 'массив regions отсутствует';
      return null;
    },
  });
}

// ============ 1б. Ингест с детализацией: длинный текст → фрагменты ============

/**
 * На длинных текстах модель за один запрос находит лишь ~десяток самых заметных
 * идей — сколько бы их ни было в материале. Поэтому текст делится на фрагменты
 * (размер зависит от уровня детализации), идеи выделяются по каждому фрагменту
 * отдельно и объединяются с дедупликацией по названию.
 */
export type IngestDetail = 'compact' | 'normal' | 'detailed';

export const INGEST_DETAIL_META: Record<
  IngestDetail,
  { label: string; chunkChars: number; hint: string }
> = {
  compact: {
    label: 'Крупно',
    chunkChars: 24000,
    hint: 'Фрагменты по ~24 000 знаков: только основные идеи, минимум запросов',
  },
  normal: {
    label: 'Обычный',
    chunkChars: 10000,
    hint: 'Фрагменты по ~10 000 знаков: сбалансированный охват',
  },
  detailed: {
    label: 'Подробно',
    chunkChars: 5000,
    hint: 'Фрагменты по ~5 000 знаков: заметно больше идей, но больше запросов к модели',
  },
};

/** Предохранитель: больше фрагментов за один раз не берём (40 × 24k = ~1 МБ текста) */
export const MAX_INGEST_CHUNKS = 40;

/** Разбить текст на фрагменты по границам абзацев/строк с небольшим перекрытием */
export function splitIntoChunks(text: string, limit: number, overlap = 350): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length && chunks.length < MAX_INGEST_CHUNKS + 50) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length) {
      // режем по ближайшей границе во второй половине фрагмента
      const windowStart = start + Math.floor(limit * 0.5);
      const para = text.lastIndexOf('\n\n', end);
      if (para > windowStart) {
        end = para;
      } else {
        const nl = text.lastIndexOf('\n', end);
        if (nl > windowStart) {
          end = nl;
        } else {
          const dot = text.lastIndexOf('. ', end);
          if (dot > windowStart) end = dot + 1;
        }
      }
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + Math.floor(limit * 0.4)); // гарантия прогресса
  }
  return chunks;
}

/**
 * Ингест с учётом детализации: короткий текст — один запрос, длинный —
 * по фрагментам с объединением результатов (регионы сливаются по названию,
 * атомы дедуплицируются по нормализованному названию).
 */
export async function ingestSplitIntoIdeasChunked(
  provider: LLMProvider,
  materialTitle: string,
  sourceText: string,
  detail: IngestDetail,
  onProgress?: (done: number, total: number) => void
): Promise<IngestResult> {
  const chunkChars = INGEST_DETAIL_META[detail].chunkChars;
  const chunks = splitIntoChunks(sourceText.trim(), chunkChars);
  if (chunks.length > MAX_INGEST_CHUNKS) {
    throw new Error(
      `Текст слишком большой: ${chunks.length} фрагментов (максимум ${MAX_INGEST_CHUNKS}). Уменьши детализацию или импортируй материал частями`
    );
  }
  if (chunks.length === 1) {
    onProgress?.(0, 1);
    const result = await ingestSplitIntoIdeas(provider, materialTitle, chunks[0]);
    onProgress?.(1, 1);
    return result;
  }

  const merged: IngestResult = { regions: [], atoms: [] };
  const regionByKey = new Map<string, number>();
  const MAX_REGIONS = 8;
  const seenAtoms = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i, chunks.length);
    const part = await ingestSplitIntoIdeas(provider, materialTitle, chunks[i], {
      part: i + 1,
      total: chunks.length,
    });
    // регионы: слияние по нормализованному названию, сверху ограничение
    const partRegionIdx: number[] = [];
    for (const r of part.regions) {
      const key = normalizeText(r.title);
      let idx = regionByKey.get(key);
      if (idx === undefined) {
        if (merged.regions.length >= MAX_REGIONS) {
          idx = merged.regions.length - 1; // переполнение — складываем в последний регион
        } else {
          idx = merged.regions.length;
          merged.regions.push(r);
          regionByKey.set(key, idx);
        }
      }
      partRegionIdx.push(idx);
    }
    // атомы: дедупликация по названию (стыки фрагментов дают повторы)
    for (const a of part.atoms) {
      const key = normalizeText(a.title);
      if (seenAtoms.has(key)) continue;
      seenAtoms.add(key);
      const regionIdx = partRegionIdx[a.regionIndex] ?? 0;
      merged.atoms.push({ ...a, regionIndex: regionIdx });
    }
  }
  onProgress?.(chunks.length, chunks.length);
  return merged;
}

// ============ 2. Генерация задач для атома (роутер типов) ============

/**
 * Роутер заданий: для каждого типа атома — своя пара форматов.
 * Раньше промпт требовал «задача 1 — всегда числовая параметрическая»,
 * из-за чего атомам истории/литературы навязывалась арифметика.
 */
const TASK_PLANS: Record<AtomKind, { first: TaskType; second: TaskType; note: string }> = {
  formula: {
    first: 'numeric',
    second: 'choice',
    note: 'числовая задача на применение формулы/закона + выбор варианта, где дистракторы — типичные ошибки в вычислении или интерпретации',
  },
  procedure: {
    first: 'numeric',
    second: 'exact',
    note: 'если к методу естественно применимы числа — задача на применение метода; если чисел нет (например, порядок действий в истории или биологии) — вместо numeric сделай exact о ключевом шаге; вторая задача — точный короткий ответ о важном шаге, условии применения или результате метода',
  },
  concept: {
    first: 'choice',
    second: 'essay',
    note: 'выбор варианта с дистракторами — правдоподобными заблуждениями (если известна типичная ошибка — используй её) + открытый вопрос «объясни своими словами, почему/как/чем отличается...», ответ должен раскрывать суть идеи',
  },
  fact: {
    first: 'exact',
    second: 'choice',
    note: 'точный короткий ответ — сам факт + выбор варианта с правдоподобными неверными вариантами этого факта',
  },
  date: {
    first: 'exact',
    second: 'choice',
    note: 'точный ответ — дата/событие/период + выбор варианта (например, «какое событие произошло раньше» или соотнесение события и периода)',
  },
  person: {
    first: 'exact',
    second: 'choice',
    note: 'точный ответ — кто это или что сделал + выбор варианта о заслугах/фактах, связанных с этим человеком',
  },
  opinion: {
    first: 'essay',
    second: 'choice',
    note: 'открытый вопрос «аргументируй/объясни почему» с ожиданием ключевых пунктов аргументации + выбор варианта о том, какой аргумент поддерживает или опровергает утверждение',
  },
};

const TASK_FORMATS_DOC = `Форматы заданий (поля JSON):
- numeric — числовая параметрическая: {"type":"numeric","prompt":"...","params":[{"name":"a","choices":[1,2,3]}],"expr":"формула ответа от параметров","hints":["...","..."],"explanation":"..."}; ВАЖНО: expr — чистый синтаксис решателя: только числа, латинские имена параметров, + - * / ^, скобки и функции sqrt/abs/min/max/round/ln/log/floor/ceil; НЕ LaTeX; НЕ используй символы %, ×, ÷, √, π и запятые (проценты — «x/100», корень — sqrt(x), число пи — pi);
- exact — точный короткий ответ: {"type":"exact","prompt":"...","value":"эталон","alts":["варианты написания"],"hints":[...],"explanation":"..."}; ответ однозначен и краток (слово, имя, дата, число);
- choice — выбор варианта: {"type":"choice","prompt":"...","options":["А","Б","В"],"correctIndex":0,"hints":[...],"explanation":"..."}; ровно одна верная опция, дистракторы — правдоподобные ошибки;
- essay — открытый развёрнутый ответ: {"type":"essay","prompt":"...","expectation":["ключевой пункт 1","ключевой пункт 2","ключевой пункт 3"],"hints":[...],"explanation":"..."}; expectation — 3–5 ключевых пунктов ПОЛНОГО ответа, каждый — одна короткая содержательная фраза; вопрос должен требовать рассуждения/объяснения, а не одного слова.
- code_output — «что выведет код»: {"type":"code_output","prompt":"Что выведет этот код?","code":"полный листинг, переносы строк — \\n","value":"точный вывод программы","alts":["варианты записи вывода"],"hints":[...],"explanation":"пошаговая трасса выполнения"}; листинг — минимальная ЦЕЛИКОМ исполняемая программа (не фрагмент); value — ровно то, что напечатает программа, без кавычек-обёрток;
- code_fill — «заполни пропуск»: {"type":"code_fill","prompt":"Заполни пропуск, чтобы код ...","code":"листинг, в котором пропуск обозначен ___","value":"недостающий фрагмент кода","alts":["эквивалентные варианты фрагмента"],"hints":[...],"explanation":"..."}; пропуск ___ заменяет РОВНО одно выражение/строку, ответ однозначен; value — код (выражение/строка), а не объяснение.`;

const TASKS_COMMON_RULES = `Общие требования:
- текст задания (prompt) может содержать формулы в LaTeX вида $...$ и подстановки вида {{имя_параметра}} (подстановки — только для numeric);
- в полях code/value/alts код-задач (code_output/code_fill) — ЧИСТЫЙ код или вывод: без LaTeX, без markdown и кавычек-обёрток; переносы строк внутри кода сохраняй;
- числовые ответы — целые или с <=2 знаками после запятой; answers должны быть вычислимы/однозначны;
- hints: 2 подсказки (1-я — направление, 2-я — шаг решения), explanation — полный разбор (можно с LaTeX);
- всё по-русски, в рамках идеи атома; задания проверяют именно эту идею, а не смежные темы.`;

/**
 * План заданий при наличии листинга кода у атома: пара code_output + code_fill.
 * Если листинг не годится для одного из форматов, модель меняет его на базовый план.
 */
const CODE_PLAN_NOTE = (baseFirst: TaskType, baseSecond: TaskType) =>
  `У атома ЕСТЬ листинг кода (дан ниже) — план такой:
- задание 1 — формат code_output: «Что выведет этот код?» по листингу атома; если листинг — нецелая программа, допиши его в поле code до минимальной работающей; если идея в принципе не проверяется выводом программы — замени формат на ${baseFirst};
- задание 2 — формат code_fill: листинг с пропуском ___ (ровно одно выражение/строка, ответ однозначен); если пропуск неуместен — замени формат на ${baseSecond}.
В code-заданиях проверяй именно идею атома, а не смежные конструкции языка.`;

function buildTasksPrompt(kind: AtomKind, hasCode = false): string {
  const plan = TASK_PLANS[kind];
  const planBlock = hasCode
    ? CODE_PLAN_NOTE(plan.first, plan.second)
    : `- задание 1 — формат ${plan.first}: ${plan.note};
- задание 2 — формат ${plan.second}.`;
  return `Создай для атома знания 2 проверяемых задания.

Форматы заданий:
${TASK_FORMATS_DOC}

${TASKS_COMMON_RULES}

ПЛАН для этого атома (тип идеи: ${kind}):
${planBlock}
Оба задания в указанных форматах; не заменяй формат другим без веской причины.

Верни СТРОГО JSON:
{
  "feynmanQuestion": "вопрос для объяснения своими словами (если удалось уточнить — иначе повтори исходный)",
  "tasks": [<задание формата ${hasCode ? 'code_output' : plan.first}>, <задание формата ${hasCode ? 'code_fill' : plan.second}>]
}`;
}

/** Определить тип атома одним быстрым LLM-запросом (для атомов без atomKind) */
const CLASSIFY_PROMPT = `Определи тип идеи атома знаний — от этого зависит, какими заданиями её проверять:
- "fact" — изолированный факт/утверждение («первой печатной книгой был “Апостол”»);
- "date" — событие, дата, период (Дворцовые перевороты 1725–1762);
- "person" — персоналия: кто это, что сделал (Менделеев, Пушкин);
- "concept" — понятие, определение, закономерность без вычислений (инфляция, метафора, адаптация);
- "procedure" — метод, алгоритм, последовательность действий (решение квадратного уравнения, разбор слова по составу);
- "formula" — количественная закономерность, формула, вычисление (второй закон Ньютона, процент от числа);
- "opinion" — оценка, аргументация, вопрос «почему так произошло/чем это хорошо или плохо».
Верни СТРОГО JSON: {"atomKind":"concept"}`;

export async function classifyAtomLLM(
  provider: LLMProvider,
  atom: { title: string; formulation: string }
): Promise<AtomKind> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${CLASSIFY_PROMPT}\n\nАтом: «${atom.title}»\nФормулировка: ${atom.formulation}`,
    },
  ];
  const parsed = await callLLMJson<{ atomKind: string }>(provider, messages, {
    op: 'classify_atom',
    temperature: 0.1,
    maxTokens: 2000,
    validate: (p) =>
      normalizeAtomKind(p.atomKind)
        ? null
        : `atomKind неизвестен (${String(p.atomKind ?? 'нет')}) — ожидается fact/date/person/concept/procedure/formula/opinion`,
  });
  return normalizeAtomKind(parsed.atomKind)!;
}

export interface GeneratedTasks {
  feynmanQuestion?: string;
  tasks: {
    type: 'numeric' | 'exact' | 'choice' | 'essay' | 'code_output' | 'code_fill';
    prompt: string;
    params?: { name: string; choices: number[] }[];
    expr?: string;
    options?: string[];
    correctIndex?: number;
    value?: string;
    alts?: string[];
    expectation?: string[]; // для essay: ключевые пункты полного ответа
    code?: string; // для code_output/code_fill: листинг задачи
    hints: string[];
    explanation: string;
  }[];
}

export async function genTasksForAtom(
  provider: LLMProvider,
  atom: {
    title: string;
    formulation: string;
    example: string;
    atomKind?: AtomKind; // если известен — роутер срабатывает без доп. запроса
    misconception?: string; // подсказка для дистракторов choice
    code?: string; // листинг кода атома → план code_output + code_fill
  },
  sourceText?: string
): Promise<GeneratedTasks> {
  // Роутер: тип атома известен из ингеста → план сразу; иначе быстрый классификатор.
  // При сбое классификации — безопасный дефолт «понятие» (choice + essay).
  let kind = normalizeAtomKind(atom.atomKind);
  if (!kind) {
    try {
      kind = await classifyAtomLLM(provider, atom);
    } catch {
      kind = 'concept';
    }
  }
  const listing = typeof atom.code === 'string' ? atom.code.trim() : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${buildTasksPrompt(kind, listing.length > 0)}\n\nАтом: «${atom.title}»\nФормулировка: ${atom.formulation}\nПример: ${atom.example}\n${
        atom.misconception ? `Типичное заблуждение (используй как дистрактор): ${atom.misconception}\n` : ''
      }${
        listing
          ? `Листинг кода атома (используй для code_output/code_fill):\n\`\`\`\n${listing.slice(0, 3000)}\n\`\`\`\n`
          : ''
      }${
        sourceText ? `Фрагмент источника:\n${sourceText.slice(0, 3000)}\n` : ''
      }`,
    },
  ];
  return callLLMJson<GeneratedTasks>(provider, messages, {
    op: 'gen_tasks',
    temperature: 0.4,
    maxTokens: 50000,
    validate: (p) => {
      if (!Array.isArray(p.tasks) || p.tasks.length === 0) {
        return 'массив tasks пуст или отсутствует';
      }
      for (const t of p.tasks) {
        if (
          t.type !== 'numeric' &&
          t.type !== 'exact' &&
          t.type !== 'choice' &&
          t.type !== 'essay' &&
          t.type !== 'code_output' &&
          t.type !== 'code_fill'
        ) {
          return `неизвестный тип задания: ${String(t.type ?? '—')}`;
        }
        if (t.type === 'essay' && (!Array.isArray(t.expectation) || t.expectation.length < 2)) {
          return 'у essay-задачи нет поля expectation (3–5 ключевых пунктов полного ответа)';
        }
        if ((t.type === 'code_output' || t.type === 'code_fill') && (!String(t.value ?? '').trim() || !String(t.code ?? '').trim())) {
          return 'у code-задачи должны быть заполнены поля code (листинг) и value (эталонный ответ)';
        }
      }
      return null;
    },
  });
}

// ============ 2б. Проверка открытого ответа (essay-задача) ============

const ESSAY_CHECK_PROMPT = `Ты проверяешь ответ студента на открытый вопрос по идее атома. Ключевые пункты полного ответа перечислены ниже.

Как проверять:
- пункт раскрыт, если студент передал его суть (своими словами — это нормально, дословность не требуется);
- зачёт (pass), если раскрыто большинство пунктов (>= 70%) и в ответе НЕТ фактических ошибок по теме;
- краткий, но верный ответ — это нормально; фактические ошибки и уход от темы — не зачёт;
- score — доля раскрытых пунктов (0..1); missed — нераскрытые/искажённые пункты (цитатами из списка);
- feedback: 1–3 предложения, конструктивно: чего не хватает или что неверно.

Верни СТРОГО JSON:
{"verdict":"pass","score":0.75,"missed":["нераскрытый пункт"],"feedback":"..."}`;

export async function checkEssayLLM(
  provider: LLMProvider,
  task: Task,
  node: { title: string; formulation: string },
  userAnswer: string
): Promise<EssayGrade> {
  const expectation = task.answerSpec.kind === 'essay' ? task.answerSpec.expectation : [];
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ESSAY_CHECK_PROMPT}\n\nИдея: «${node.title}» — ${node.formulation}\nВопрос: ${task.prompt}\nКлючевые пункты полного ответа:\n${
        expectation.map((e, i) => `${i + 1}. ${e}`).join('\n') || '(не заданы — оцени по сути идеи)'
      }\n\nОтвет студента:\n${userAnswer.slice(0, 6000)}`,
    },
  ];
  const parsed = await callLLMJson<EssayGrade>(provider, messages, {
    op: 'check_essay',
    temperature: 0.2,
    maxTokens: 8000,
    validate: (p) =>
      (p.verdict === 'pass' || p.verdict === 'fail') && typeof p.feedback === 'string' && p.feedback.trim()
        ? null
        : 'нет verdict (pass/fail) или feedback',
  });
  return {
    verdict: parsed.verdict,
    score: Math.min(1, Math.max(0, Number(parsed.score) || 0)),
    missed: Array.isArray(parsed.missed) ? parsed.missed.slice(0, 6).map(String).filter(Boolean) : [],
    feedback: parsed.feedback,
  };
}

/** Локальная проверка essay без LLM (демо-режим): покрытие пунктов по словам.
 *  Косвенная эвристика: пункт считается раскрытым, если ≥50% его значимых слов
 *  встречаются в ответе. Порог зачёта — 70% пунктов, как у LLM-рубрики. */
export function gradeEssayLocal(expectation: string[], userAnswer: string): EssayGrade {
  const words = new Set(
    normalizeText(userAnswer).split(/[^a-zа-яё0-9]+/i).filter((w) => w.length > 2)
  );
  let covered = 0;
  const missed: string[] = [];
  for (const e of expectation) {
    const eWords = normalizeText(e).split(/[^a-zа-яё0-9]+/i).filter((w) => w.length > 2);
    if (eWords.length === 0) {
      covered++;
      continue;
    }
    const hit = eWords.filter((w) => words.has(w)).length / eWords.length;
    if (hit >= 0.5) covered++;
    else missed.push(e);
  }
  const score = expectation.length > 0 ? covered / expectation.length : 0;
  return {
    verdict: score >= 0.7 ? 'pass' : 'fail',
    score,
    missed,
    feedback:
      expectation.length > 0
        ? `Косвенная проверка без ИИ: раскрыто ${covered} из ${expectation.length} ключевых пунктов. Подключи LLM-провайдера в настройках для содержательной проверки.`
        : 'У задачи не заданы ключевые пункты ожидаемого ответа (см. редактор узла).',
  };
}

// ============ 2б-2. Переформулировка эссе, дублирующего вопрос Фейнмана ============

const ESSAY_DIFFERENTIATE_PROMPT = `В курсе эссе-задача почти дословно повторяет фейнмановский вопрос узла: студент будет писать один и тот же развёрнутый ответ дважды. Перепиши эссе-задачу так, чтобы она проверяла ТУ ЖЕ идею с ДРУГОЙ стороны и не дублировала феймановское объяснение.

Возможные ракурсы (выбери подходящий):
- применение идеи к новой ситуации или конкретным данным;
- сравнение с близким понятием: отличия, контрпример, граничный случай;
- следствие идеи: что из неё вытекает, где её нельзя применить;
- типичное заблуждение: почему наивное рассуждение неверно.

Требования:
- вопрос остаётся открытым (развёрнутый ответ своими словами), уровень сложности — как у исходного эссе;
- в формулировке не повторяй слова и обороты феймановского вопроса;
- expectation — 3–5 ключевых пунктов полного ответа на НОВОЙ формулировке;
- пиши по-русски, формулы — LaTeX ($...$).

Верни СТРОГО JSON:
{"prompt":"новая формулировка вопроса","expectation":["пункт 1","пункт 2","пункт 3"]}`;

export async function differentiateEssayLLM(
  provider: LLMProvider,
  node: { title: string; formulation: string; example: string; feynmanQuestion: string },
  task: Task
): Promise<{ prompt: string; expectation: string[] }> {
  const spec = task.answerSpec.kind === 'essay' ? task.answerSpec : null;
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${ESSAY_DIFFERENTIATE_PROMPT}\n\nИдея: «${node.title}» — ${node.formulation}\nПример из материала: ${node.example}\nФеймановский вопрос (повторять его нельзя): ${node.feynmanQuestion}\n\nТекущая эссе-задача: ${task.prompt}\nЕё ключевые пункты: ${spec ? spec.expectation.join('; ') || '—' : '—'}`,
    },
  ];
  const parsed = await callLLMJson<{ prompt: string; expectation: string[] }>(provider, messages, {
    op: 'differentiate_essay',
    temperature: 0.4,
    maxTokens: 8000,
    validate: (p) => {
      if (!String(p.prompt ?? '').trim()) return 'пустой prompt';
      if (!Array.isArray(p.expectation) || p.expectation.filter((e) => String(e).trim()).length < 2) {
        return 'expectation должен содержать минимум 2 непустых пункта';
      }
      return null;
    },
  });
  return {
    prompt: String(parsed.prompt).trim().slice(0, 4000),
    expectation: parsed.expectation
      .slice(0, 6)
      .map((s) => String(s).trim().slice(0, 300))
      .filter(Boolean),
  };
}

// ============ 2в. Проход построения графа зависимостей ============

/**
 * Рёбра из needs при ингесте «замылены»: модель видит только свой фрагмент,
 * поэтому межфрагментные связи (глава N → глава M) физически не попадают в граф.
 * Этот проход смотрит на ВСЕ атомы материала и добирает недостающие рёбра.
 * Атомы идут батчами по ~30 (полные описания), плюс в каждый промпт входит
 * глобальный каталог названий — модель может связать атомы из разных батчей.
 */
export interface GraphEdgeSuggestion {
  fromId: string;
  toId: string;
  kind: EdgeKind;
}

/** Атомов в одном батче (30 × ~180 знаков описания + каталог ≈ 15k знаков) */
const GRAPH_BATCH = 30;
/** Параноидальный предел на ответ: больше — значит модель «полила связями всё» */
const GRAPH_RAW_CAP = 500;

const GRAPH_PROMPT = `Ты строишь граф зависимостей учебного материала. Даны атомы идей. Найди связи: для освоения идеи to сначала нужно освоить идею from.

Правила:
- связывай только идеи, которые РЕАЛЬНО зависят друг от друга: to прямо опирается на from — использует его понятие, факт, формулу, метод, опирается на него в рассуждении;
- kind: "hard" — без from идею to понять или применить нельзя; "soft" — from помогает, но to понятна и без него;
- рассматривай связи атомов пакета с ЛЮБЫМИ атомами материала, включая атомы вне пакета из общего списка;
- не более 3–4 связей на атом: значимые связи, а не «всё со всем». Похожие слова сами по себе — не связь;
- направление: from — базовая идея, to — надстройка. Циклов не создавай.

Верни СТРОГО JSON без пояснений:
{"edges":[{"from":номер,"to":номер,"kind":"hard|soft"}]}
Если связей нет — верни {"edges":[]}`;

/**
 * Построить предложения рёбер для всего материала.
 * Чистая функция над llm-client: без Dexie — вызывается из graph-db.enrichGraph.
 * Возвращает уникальные направленные рёбра (встречные пары и дубли отброшены).
 */
export async function buildGraphEdgesLLM(
  provider: LLMProvider,
  atoms: { id: string; title: string; formulation: string }[],
  opts: {
    batchSize?: number;
    onProgress?: (done: number, total: number) => void;
  } = {}
): Promise<GraphEdgeSuggestion[]> {
  const N = atoms.length;
  if (N < 2) return [];
  const batchSize = Math.max(2, opts.batchSize ?? GRAPH_BATCH);
  const totalBatches = Math.ceil(N / batchSize);
  const globalIdx = new Map(atoms.map((a, i) => [a.id, i + 1]));
  const catalog = atoms.map((a, i) => `${i + 1}. ${a.title.slice(0, 80)}`).join('\n');

  const seen = new Set<string>();
  const out: GraphEdgeSuggestion[] = [];
  const addEdge = (fromIdx: number, toIdx: number, kind: EdgeKind): void => {
    if (!Number.isInteger(fromIdx) || !Number.isInteger(toIdx)) return;
    if (fromIdx < 1 || fromIdx > N || toIdx < 1 || toIdx > N || fromIdx === toIdx) return;
    const fromId = atoms[fromIdx - 1].id;
    const toId = atoms[toIdx - 1].id;
    const key = `${fromId}->${toId}`;
    if (seen.has(key) || seen.has(`${toId}->${fromId}`)) return; // дубль или встречная пара
    seen.add(key);
    out.push({ fromId, toId, kind });
  };

  for (let start = 0, done = 0; start < N; start += batchSize) {
    done++;
    const batchList = atoms
      .slice(start, start + batchSize)
      .map((a) => `#${globalIdx.get(a.id)} ${a.title} — ${a.formulation.slice(0, 240)}`)
      .join('\n');
    const messages: LLMMessage[] = [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: `${GRAPH_PROMPT}\n\nАТОМЫ ПАКЕТА (полные описания):\n${batchList}\n\nВСЕ АТОМЫ МАТЕРИАЛА (номер. название — связи могут вести и на них):\n${catalog}`,
      },
    ];
    const parsed = await callLLMJson<{ edges?: unknown }>(provider, messages, {
      op: 'build_graph',
      temperature: 0.1,
      maxTokens: 8000,
      validate: (p) => {
        const list = Array.isArray(p) ? p : p.edges;
        if (!Array.isArray(list)) return 'нет массива edges';
        if (list.length > GRAPH_RAW_CAP) return 'подозрительно много связей — оставь только значимые';
        for (const e of list) {
          if (!e || typeof e !== 'object' || Array.isArray(e)) return 'элемент edges не объект';
          const from = (e as Record<string, unknown>).from;
          const to = (e as Record<string, unknown>).to;
          if (!Number.isInteger(from) || !Number.isInteger(to)) return 'from/to должны быть целыми номерами';
        }
        return null;
      },
    });
    const list = (Array.isArray(parsed) ? parsed : (parsed.edges ?? [])) as Record<string, unknown>[];
    for (const e of list) {
      // мусорный kind трактуем как hard — так же, как needs при ингесте;
      // выход за диапазон/самосвязи/дубли отсеет addEdge
      addEdge(e.from as number, e.to as number, e.kind === 'soft' ? 'soft' : 'hard');
    }
    opts.onProgress?.(done, totalBatches);
  }
  return out;
}

// ============ 3. Проверка фейнмановского объяснения ============

const FEYNMAN_PROMPT = `Ты проверяешь объяснение студента по методу Фейнмана: он объясняет идею своими словами.

Оцени строго, но доброжелательно:
- accuracy 0–2: нет фактических ошибок (2 — верно; 1 — мелкая неточность; 0 — существенная ошибка);
- completeness 0–2: названы ключевые компоненты идеи (2 — полно; 1 — частично; 0 — не названы);
- ownWords 0–1: объяснение своими словами, а не копия формулировки (проверь на совпадение с эталоном);
- misconception: перечисли фактические заблуждения (если есть);
- feedback: 2–4 предложения, доброжелательно, с конкретикой; укажи, что упущено и что хорошо. По-русски.
Зачёт: accuracy == 2 && completeness >= 1 && ownWords == 1.

Верни СТРОГО JSON:
{"accuracy":0,"completeness":0,"ownWords":0,"misconceptions":["..."],"feedback":"...","verdict":"pass|fail"}`;

export async function gradeFeynmanLLM(
  provider: LLMProvider,
  node: { title: string; formulation: string; example: string; keyTerms: string[] },
  userAnswer: string
): Promise<FeynmanGrade> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${FEYNMAN_PROMPT}\n\nИдея: «${node.title}»\nЭталонная формулировка: ${node.formulation}\nКлючевые термины: ${node.keyTerms.join(', ')}\nПример: ${node.example}\n\nОБЪЯСНЕНИЕ СТУДЕНТА:\n${userAnswer}`,
    },
  ];
  const parsed = await callLLMJson<FeynmanGrade>(provider, messages, {
    op: 'grade_feynman',
    temperature: 0.2,
    maxTokens: 4000,
    validate: (p) =>
      p.accuracy !== undefined || p.verdict !== undefined || p.feedback !== undefined
        ? null
        : 'нет полей оценки (accuracy/verdict/feedback)',
  });
  const accuracy = clampInt(parsed.accuracy, 0, 2);
  const completeness = clampInt(parsed.completeness, 0, 2);
  const ownWords = clampInt(parsed.ownWords, 0, 1);
  const verdict = accuracy === 2 && completeness >= 1 && ownWords === 1 ? 'pass' : 'fail';
  return {
    accuracy,
    completeness,
    ownWords,
    misconceptions: Array.isArray(parsed.misconceptions) ? parsed.misconceptions.slice(0, 5) : [],
    feedback: parsed.feedback ?? '',
    verdict,
  };
}

/**
 * Локальный демо-оценщик фейнмана (без LLM): эвристики.
 * Помечается в UI как демо-режим.
 */
export function gradeFeynmanLocal(
  node: { title: string; formulation: string; sourceQuote?: string; keyTerms: string[] },
  userAnswer: string
): FeynmanGrade {
  const text = userAnswer.trim();
  const norm = normalizeText(text);
  const srcNorm = normalizeText(`${node.formulation} ${node.sourceQuote ?? ''}`);

  // 1) Длина: осмысленное объяснение не бывает короче фразы
  if (text.length < 40) {
    return {
      verdict: 'fail',
      accuracy: 0,
      completeness: 0,
      ownWords: 0,
      misconceptions: [],
      feedback:
        'Слишком коротко. По Фейнману объяснение — это несколько предложений: суть своими словами + пример. Попробуй развернуть ответ.',
    };
  }

  // 2) Покрытие ключевых терминов
  const hits = node.keyTerms.filter((t) => norm.includes(normalizeText(t).split(' ')[0] ?? t));
  const coverage = node.keyTerms.length > 0 ? hits.length / node.keyTerms.length : 1;
  const completeness = coverage >= 0.5 ? 2 : coverage >= 0.25 ? 1 : 0;

  // 3) Пересказ источника? (триграммное сходство)
  const ownWords = trigramSimilarity(norm, srcNorm) < 0.6 ? 1 : 0;

  // 4) Фактическая точность: локально не проверяется — начисляем при непустом осмысленном тексте
  const accuracy = norm.length >= 80 ? 2 : 1;

  const verdict = accuracy === 2 && completeness >= 1 && ownWords === 1 ? 'pass' : 'fail';
  const missed = node.keyTerms.filter((t) => !hits.includes(t));
  const parts: string[] = [];
  parts.push(
    completeness < 2
      ? `Кажется, ты не упомянул: ${missed.slice(0, 3).join(', ') || 'часть ключевых понятий'}.`
      : 'Ключевые понятия упомянуты.'
  );
  if (ownWords === 0)
    parts.push('Ответ очень близко повторяет формулировку — попробуй пересказать полностью своими словами.');
  parts.push(
    'Это локальный демо-оценщик без LLM: фактическую точность он проверить не может. Подключи провайдера в настройках для полноценной проверки.'
  );
  return {
    verdict,
    accuracy,
    completeness,
    ownWords,
    misconceptions: [],
    feedback: parts.join(' '),
  };
}

// ============ 4. Проверка «своей задачи» ============

const OWN_TASK_PROMPT = `Студент придумал свою задачу по теме, чтобы закрепить идею. Проверь:
- onTopic: задача действительно на ЭТУ идею (а не просто про числа);
- solvable: условие корректно и задача решаема (достаточно данных, нет противоречий);
- answer: реши задачу и дай краткий ответ;
- feedback: 2–3 предложения по-русски: что хорошо, что поправить.
Верни СТРОГО JSON: {"onTopic":true,"solvable":true,"answer":"...","feedback":"...","verdict":"pass|fail"}
verdict = pass, только если onTopic && solvable.`;

export async function validateOwnTaskLLM(
  provider: LLMProvider,
  node: { title: string; formulation: string },
  userTask: string
): Promise<OwnTaskVerdict> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${OWN_TASK_PROMPT}\n\nИдея: «${node.title}»\nФормулировка идеи: ${node.formulation}\n\nЗАДАЧА СТУДЕНТА:\n${userTask}`,
    },
  ];
  const parsed = await callLLMJson<OwnTaskVerdict>(provider, messages, {
    op: 'own_task',
    temperature: 0.2,
    maxTokens: 4000,
    validate: (p) =>
      p.onTopic !== undefined || p.solvable !== undefined || p.feedback !== undefined || p.answer !== undefined
        ? null
        : 'нет полей вердикта (onTopic/solvable/feedback)',
  });
  const onTopic = Boolean(parsed.onTopic);
  const solvable = Boolean(parsed.solvable);
  return {
    onTopic,
    solvable,
    answer: parsed.answer ?? '',
    feedback: parsed.feedback ?? '',
    verdict: onTopic && solvable ? 'pass' : 'fail',
  };
}

/** Демо-режим «своей задачи»: самопроверка с честной пометкой */
export function validateOwnTaskLocal(userTask: string): OwnTaskVerdict {
  const ok = userTask.trim().length >= 25;
  return {
    onTopic: ok,
    solvable: ok,
    answer: '',
    feedback: ok
      ? 'Задача сохранена (демо-режим: без LLM корректность не проверяется — оцени сам себя честно). Подключи провайдера в настройках для автоматической проверки.'
      : 'Слишком коротко: сформулируй полноценное условие задачи (что дано, что найти).',
    verdict: ok ? 'pass' : 'fail',
  };
}

// ============ 5. Подсказки ============

/** Подсказка уровня 1..3. Уровни 1–2 из task.hints, 3 — полный разбор (explanation). */
export async function genHint(
  provider: LLMProvider,
  node: { title: string; formulation: string },
  task: { prompt: string; explanation: string },
  level: number
): Promise<string> {
  if (level >= 3) return task.explanation;
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `Дай подсказку уровня ${level} (1 = лёгкий намёк-направление, 2 = конкретный шаг без готового ответа) к задаче. Одно-два предложения, по-русски.\n\nИдея: «${node.title}» — ${node.formulation}\nЗадача: ${task.prompt}`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.4, maxTokens: 2000, op: 'hint' });
  return res.content.trim();
}

// ============ 6. OCR рукописного решения (vision) ============

const OCR_PROMPT_FULL = `Ты — точная OCR-система. На изображении — фрагмент рукописного или печатного решения. Распознай ВЕСЬ текст выделенной области:
- сохрани порядок и структуру строк;
- математические выражения перепиши в LaTeX: строчные формулы — в $...$, отдельные строки — в $$...$$;
- не решай задачу и не добавляй ничего от себя;
- неразборчивый фрагмент помечай как [неразборчиво].
Верни ТОЛЬКО распознанный текст, без комментариев и без markdown-заборов.`;

const OCR_PROMPT_SHORT = `На изображении — рукописное решение задачи. Верни ТОЛЬКО итоговый ответ (число, выражение или слово) — как он записан в конце решения. Без пояснений. Если итогового ответа нет — верни самую релевантную строку с результатом.`;

const OCR_PAGE_PROMPT = `Ты — точная OCR-система для учебников. На изображении — страница учебного материала. Перепиши ВЕСЬ содержательный текст страницы:
- сохрани структуру: заголовки разделов помечай в начале строки «## », подзаголовки — «### », остальное — обычными абзацами;
- определения, теоремы, правила и выводы переписывай дословно;
- ВСЕ математические формулы переведи в LaTeX: строчные — в $...$, выключные (отдельной строкой) — в $$...$$. Примеры: $x^2 + 2x$, $$\\int_0^1 x\\,dx = \\frac{1}{2}$$;
- таблицы записывай построчно, значения через « | »;
- верхние/нижние колонтитулы, номера страниц и повторяющуюся навигацию НЕ переноси;
- рисунки помечай одной строкой: [Рисунок: краткое описание];
- неразборчивое место помечай как [неразборчиво];
- не решай задачи и условия из страницы, не добавляй ничего от себя.
Верни ТОЛЬКО распознанный текст, без комментариев и без markdown-заборов.`;

/**
 * Распознать текст с фотографии решения (OpenAI-совместимый vision-запрос).
 * Требуется модель, принимающая изображения (gpt-4o-mini, gemini-flash, qwen-vl и т.п.).
 */
export async function ocrHandwritten(
  provider: LLMProvider,
  imageDataUrl: string,
  mode: 'full' | 'short'
): Promise<string> {
  const base64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: mode === 'short' ? OCR_PROMPT_SHORT : OCR_PROMPT_FULL },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
      ],
    },
  ];
  const res = await callLLM(provider, messages, {
    temperature: 0,
    maxTokens: 4000,
    op: 'ocr',
    jsonMode: false,
  });
  return res.content.trim();
}

/**
 * Распознать страницу учебника (OpenAI-совместимый vision-запрос).
 * В отличие от рукописного OCR здесь важна структура: заголовки, абзацы,
 * таблицы; все формулы — в LaTeX. Текстовый слой PDF часто мусорный,
 * поэтому страница отдаётся моделью картинкой (см. extract.renderPdfPageToDataUrl).
 */
export async function ocrTextbookPage(
  provider: LLMProvider,
  imageDataUrl: string
): Promise<string> {
  const base64 = imageDataUrl.includes(',') ? imageDataUrl.split(',')[1] : imageDataUrl;
  const messages: LLMMessage[] = [
    {
      role: 'user',
      content: [
        { type: 'text', text: OCR_PAGE_PROMPT },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
      ],
    },
  ];
  const res = await callLLM(provider, messages, {
    temperature: 0,
    maxTokens: 8000,
    op: 'ocr_page',
    jsonMode: false,
  });
  return res.content.trim();
}

// ============ 7. Редактор узла: проверка и исправление ============

/** Отчёт LLM-проверки элемента узла (задача или идея) */
export interface CheckReport {
  ok: boolean;
  problems: string[]; // конкретные проблемы (пусто, если ok)
  feedback: string; // общий вердикт 1–3 предложения
}

const CHECK_TASK_PROMPT = `Ты — методист, проверяющий учебную задачу. Реши задачу самостоятельно и проверь по пунктам:
1. Условие: понятное, однозначное, данных достаточно;
2. Ответ: твой ответ совпадает с эталонным (эталон вычислен решателем — доверяй арифметике решателя, но проверь, соответствует ли формула условию);
3. Разбор (explanation): верен, ведёт именно к эталонному ответу;
4. Подсказки: первая — только направление, вторая — шаг, готовый ответ не раскрывают.
Если указаны значения параметров — подставь ИМЕННО их. Ответ задач с выбором — один из опций, ровно один верный.
Верни СТРОГО JSON: {"ok":true|false,"problems":["конкретная проблема"],"feedback":"вердикт 1–3 предложения"}`;

/**
 * Проверить задачу LLM. sample — детерминированный экземпляр
 * (значения параметров = первые из choices), чтобы проверяющий
 * сверял ответ для конкретных чисел.
 */
export async function checkTaskLLM(
  provider: LLMProvider,
  node: { title: string; formulation: string },
  task: Task,
  sample: TaskInstance
): Promise<CheckReport> {
  const spec = task.answerSpec;
  let expected = '';
  if (spec.kind === 'numeric') {
    const v = sample.answer as number;
    expected = `${Number.isInteger(v) ? v : Math.round(v * 100) / 100} (допуск ±${spec.tolerance ?? 0.01})`;
  } else if (spec.kind === 'exact') {
    expected = `«${spec.value}»${spec.alts?.length ? ` (также засчитывается: ${spec.alts.join('; ')})` : ''}`;
  } else if (spec.kind === 'choice') {
    expected = `«${spec.options[spec.correctIndex]}» (индекс ${spec.correctIndex})`;
  } else if (spec.kind === 'code') {
    expected = `«${spec.value}»${spec.alts?.length ? ` (также засчитывается: ${spec.alts.join('; ')})` : ''}`;
  } else {
    expected = `открытый ответ; ключевые пункты полного ответа: ${spec.expectation.join('; ')}`;
  }
  const valuesNote =
    task.params && task.params.length > 0
      ? `\nЗначения параметров для проверки: ${task.params.map((p) => `${p.name}=${sample.values[p.name] ?? p.choices[0]}`).join(', ')}`
      : '';
  const codeNote = task.code ? `\n\nЛистинг кода задачи:\n\`\`\`\n${task.code}\n\`\`\`` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${CHECK_TASK_PROMPT}\n\nИдея: «${node.title}» — ${node.formulation}\n\nТип задачи: ${task.type}\nШаблон условия: ${task.prompt}${valuesNote}\nЭкземпляр для проверки: ${sample.renderedPrompt}${codeNote}\nЭталонный ответ: ${expected}\n\nПодсказки:\n${task.hints.map((h, i) => `${i + 1}. ${h}`).join('\n') || '(нет)'}\n\nРазбор:\n${task.explanation || '(нет)'}`,
    },
  ];
  const parsed = await callLLMJson<CheckReport>(provider, messages, {
    op: 'check_task',
    temperature: 0.1,
    maxTokens: 4000,
    validate: (p) =>
      p.ok !== undefined || Array.isArray(p.problems) || p.feedback !== undefined
        ? null
        : 'нет полей отчёта (ok/problems/feedback)',
  });
  return {
    ok: Boolean(parsed.ok),
    problems: Array.isArray(parsed.problems) ? parsed.problems.filter((p) => typeof p === 'string' && p.trim()).slice(0, 8) : [],
    feedback: parsed.feedback ?? '',
  };
}

const CHECK_IDEA_PROMPT = `Проверь карточку идеи (атом знаний) как методист:
- formulation: фактически верна и атомарна (ровно одна идея, одно предложение);
- example: наглядный пример, соответствующий идее, без ошибок;
- code (если задан): листинг синтаксически и логически корректен, исполняется без ошибок и иллюстрирует именно эту идею;
- feynmanQuestion: вопрос требует объяснения своими словами (а не «перескажи определение»);
- keyTerms: ключевые термины соответствуют идее.
Не выдумывай ошибок: если всё верно — так и скажи.
Верни СТРОГО JSON: {"ok":true|false,"problems":["конкретная проблема"],"feedback":"вердикт 1–3 предложения"}`;

export async function checkIdeaLLM(
  provider: LLMProvider,
  node: {
    title: string;
    formulation: string;
    example: string;
    misconception?: string;
    feynmanQuestion: string;
    keyTerms: string[];
    code?: string;
  }
): Promise<CheckReport> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${CHECK_IDEA_PROMPT}\n\nНазвание: «${node.title}»\nФормулировка: ${node.formulation}\nПример: ${node.example}\nЧастая ошибка: ${node.misconception || '(не указана)'}\nВопрос Фейнмана: ${node.feynmanQuestion}\nКлючевые термины: ${node.keyTerms.join(', ') || '(нет)'}${node.code ? `\nЛистинг кода:\n\`\`\`\n${node.code}\n\`\`\`` : ''}`,
    },
  ];
  const parsed = await callLLMJson<CheckReport>(provider, messages, {
    op: 'check_idea',
    temperature: 0.1,
    maxTokens: 3000,
    validate: (p) =>
      p.ok !== undefined || Array.isArray(p.problems) || p.feedback !== undefined
        ? null
        : 'нет полей отчёта (ok/problems/feedback)',
  });
  return {
    ok: Boolean(parsed.ok),
    problems: Array.isArray(parsed.problems) ? parsed.problems.filter((p) => typeof p === 'string' && p.trim()).slice(0, 8) : [],
    feedback: parsed.feedback ?? '',
  };
}

const FIX_TASK_PROMPT = `Исправь учебную задачу: устрани проблемы (или сделай её лучше по указанию пользователя), сохранив тему идеи и уровень сложности. Если ответ неверен — реши задачу заново и дай верный ответ.

Правила (как при создании задач):
- задача типа numeric: ПАРАМЕТРИЧЕСКАЯ — 2–4 параметра с 3–4 допустимыми значениями каждый; поле expr — чистый синтаксис решателя (числа, параметры, + - * / ^, скобки, sqrt/abs/min/max/round), НЕ LaTeX; ответ вычислим по expr при любых комбинациях значений;
- текст prompt может содержать формулы в LaTeX вида $...$ и подстановки вида {{имя_параметра}};
- задача типа exact: короткий однозначный текстовый ответ (value) и варианты написания (alts);
- задача типа choice: 3 опции, ровно одна верная (correctIndex);
- задача типа essay: открытый вопрос с развёрнутым ответом; expectation — 3–5 ключевых пунктов полного ответа, каждый — одна короткая содержательная фраза;
- задача типа code_output: поле code — минимальная ЦЕЛИКОМ исполняемая программа; value — точный вывод программы;
- задача типа code_fill: поле code — листинг с пропуском ___ (ровно одно выражение/строка); value — недостающий фрагмент кода (не объяснение);
- в code/value/alts код-задач — чистый код или вывод, без LaTeX и markdown;
- hints: 2 подсказки (направление, шаг — без готового ответа);
- explanation: полный разбор, приводящий к ответу;
- всё по-русски.

Верни СТРОГО JSON одной задачи:
{"type":"numeric","prompt":"...","params":[{"name":"a","choices":[1,2,3]}],"expr":"...","hints":["...","..."],"explanation":"..."}
(для exact — {"type":"exact","prompt":"...","value":"...","alts":["..."],...}; для choice — {"type":"choice","prompt":"...","options":["А","Б","В"],"correctIndex":0,...}; для essay — {"type":"essay","prompt":"...","expectation":["...","...","..."],...}; для code_output — {"type":"code_output","prompt":"...","code":"...","value":"...","alts":["..."],...}; для code_fill — {"type":"code_fill","prompt":"...","code":"... с ___ ...","value":"...","alts":["..."],...})`;

/**
 * Исправить задачу LLM. Возвращает черновик задачи в том же формате,
 * что и генерация (применение — через generatedToTask с сохранением id).
 */
export async function fixTaskLLM(
  provider: LLMProvider,
  node: { title: string; formulation: string; example: string },
  task: Task,
  problems?: string[]
): Promise<GeneratedTasks['tasks'][number]> {
  const spec = task.answerSpec;
  let answerLine = '';
  if (spec.kind === 'numeric') answerLine = `expr: ${spec.expr}`;
  else if (spec.kind === 'exact') answerLine = `value: ${spec.value}${spec.alts?.length ? ` (alts: ${spec.alts.join('; ')})` : ''}`;
  else if (spec.kind === 'choice') answerLine = `options: [${spec.options.map((o, i) => `${i === spec.correctIndex ? '✓' : ''}${o}`).join(' | ')}], correctIndex: ${spec.correctIndex}`;
  else if (spec.kind === 'code') answerLine = `value: ${spec.value}${spec.alts?.length ? ` (alts: ${spec.alts.join('; ')})` : ''}`;
  else answerLine = `expectation (ключевые пункты полного ответа): ${spec.expectation.join(' | ')}`;
  const codeLine = task.code ? `Код задачи:\n\`\`\`\n${task.code}\n\`\`\`\n` : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${FIX_TASK_PROMPT}\n\nИдея: «${node.title}»\nФормулировка: ${node.formulation}\nПример: ${node.example}\n\nЗАДАЧА (тип ${task.type}):\nУсловие: ${task.prompt}\n${spec.kind === 'numeric' && task.params?.length ? `Параметры: ${JSON.stringify(task.params)}\n` : ''}${codeLine}${answerLine}\nПодсказки: ${task.hints.join(' | ') || '(нет)'}\nРазбор: ${task.explanation || '(нет)'}\n${problems?.length ? `\nНАЙДЕННЫЕ ПРОБЛЕМЫ (устрани их):\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`,
    },
  ];
  return callLLMJson<GeneratedTasks['tasks'][number]>(provider, messages, {
    op: 'fix_task',
    temperature: 0.3,
    maxTokens: 50000,
    validate: (p) =>
      p.prompt && (p.explanation || p.expr || p.value || p.options || p.expectation)
        ? null
        : 'нет условия задачи (prompt) или ответа (explanation/expr/value/options/expectation)',
  });
}

export interface FixedIdea {
  title: string;
  formulation: string;
  example: string;
  misconception: string; // пустая строка = нет
  feynmanQuestion: string;
  keyTerms: string[];
}

const FIX_IDEA_PROMPT = `Исправь карточку идеи (атом знаний): устрани фактические ошибки, сделай формулировку точной и атомарной (ровно одна идея, одно предложение), пример — наглядным и строго соответствующим идее, вопрос Фейнмана — требующим объяснения своими словами. Частая ошибка — типичное заблуждение учеников по этой идее (если неуместно — пустая строка). Название оставь коротким (2–5 слов).
Верни СТРОГО JSON:
{"title":"...","formulation":"...","example":"...","misconception":"...","feynmanQuestion":"...","keyTerms":["3-6 терминов"]}`;

/** Исправить карточку идеи LLM. Применение — в черновик редактора, сохранение вручную. */
export async function fixIdeaLLM(
  provider: LLMProvider,
  node: {
    title: string;
    formulation: string;
    example: string;
    misconception?: string;
    feynmanQuestion: string;
    keyTerms: string[];
  },
  problems?: string[]
): Promise<FixedIdea> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${FIX_IDEA_PROMPT}\n\nНазвание: «${node.title}»\nФормулировка: ${node.formulation}\nПример: ${node.example}\nЧастая ошибка: ${node.misconception || '(не указана)'}\nВопрос Фейнмана: ${node.feynmanQuestion}\nКлючевые термины: ${node.keyTerms.join(', ') || '(нет)'}\n${problems?.length ? `\nНАЙДЕННЫЕ ПРОБЛЕМЫ (устрани их):\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`,
    },
  ];
  const parsed = await callLLMJson<FixedIdea>(provider, messages, {
    op: 'fix_idea',
    temperature: 0.3,
    maxTokens: 8000,
    validate: (p) => (p.formulation && p.example ? null : 'нет полей formulation/example'),
  });
  return {
    title: parsed.title || node.title,
    formulation: parsed.formulation,
    example: parsed.example,
    misconception: parsed.misconception ?? '',
    feynmanQuestion: parsed.feynmanQuestion || node.feynmanQuestion,
    keyTerms: Array.isArray(parsed.keyTerms) ? parsed.keyTerms.slice(0, 8).map(String) : node.keyTerms,
  };
}

// ============ utils ============

function clampInt(v: unknown, min: number, max: number): number {
  const n = typeof v === 'number' ? Math.round(v) : parseInt(String(v), 10);
  if (Number.isNaN(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Триграммное сходство двух нормализованных строк (0..1) */
function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    const padded = ` ${s} `;
    for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
    return set;
  };
  const ga = grams(a);
  const gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size);
}

/** Строка из ответа LLM → безопасная строка с обрезкой */
function toStr(v: unknown, cap: number): string {
  const s = typeof v === 'string' ? v : v == null ? '' : String(v);
  return s.trim().slice(0, cap);
}

/** Массив строк из ответа LLM → безопасный список непустых строк */
function toStrList(v: unknown, capItem: number, capCount: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => toStr(x, capItem))
    .filter((s) => s.length > 0)
    .slice(0, capCount);
}

/** Преобразование сгенерированной LLM задачи в Task для БД.
 *  Санитизация обязательна: LLM может вернуть битовую формулу (например с «%»),
 *  пустые списки или неверные индексы — валидные куски сохраняем, проблемы
 *  подсвечивает taskProblems() (экран узла больше не падает). */
export function generatedToTask(
  gen: GeneratedTasks['tasks'][number],
  ids: { id: string; nodeId: string; materialId: string; orderIndex: number }
): Task {
  const type: Task['type'] =
    gen.type === 'numeric' || gen.type === 'choice' || gen.type === 'essay' || gen.type === 'code_output' || gen.type === 'code_fill'
      ? gen.type
      : 'exact';
  const base: Omit<Task, 'answerSpec'> = {
    id: ids.id,
    nodeId: ids.nodeId,
    materialId: ids.materialId,
    type,
    prompt: toStr(gen.prompt, 4000),
    hints: toStrList(gen.hints, 500, 2),
    explanation: toStr(gen.explanation, 4000),
    orderIndex: ids.orderIndex,
    createdAt: new Date(),
  };
  if (type === 'numeric') {
    // параметры: латинское имя-идентификатор + непустой список конечных чисел
    const params = (Array.isArray(gen.params) ? gen.params : [])
      .slice(0, 6)
      .map((p) => ({
        name: toStr(p?.name, 40)
          .replace(/[^a-zA-Z_0-9]/g, '')
          .replace(/^\d/, '_$&'),
        choices: (Array.isArray(p?.choices) ? p.choices : [])
          .filter((c) => typeof c === 'number' && Number.isFinite(c))
          .slice(0, 8),
      }))
      .filter((p) => p.name && p.choices.length > 0);
    return {
      ...base,
      params: params.length > 0 ? params : undefined,
      answerSpec: { kind: 'numeric', expr: toStr(gen.expr, 500) || '0', tolerance: 0.02 },
    };
  }
  if (type === 'choice') {
    const options = toStrList(gen.options, 300, 6);
    const correctIndex = Math.min(Math.max(0, Math.round(Number(gen.correctIndex ?? 0)) || 0), Math.max(0, options.length - 1));
    return {
      ...base,
      answerSpec: { kind: 'choice', options, correctIndex },
    };
  }
  if (type === 'essay') {
    return {
      ...base,
      // без пунктов задача не проверяема — taskProblems подсветит проблему
      answerSpec: { kind: 'essay', expectation: toStrList(gen.expectation, 300, 6) },
    };
  }
  if (type === 'code_output' || type === 'code_fill') {
    return {
      ...base,
      // без листинга задача непроверяема — taskProblems подсветит проблему
      code: toStr(gen.code, 4000) || undefined,
      answerSpec: { kind: 'code', value: toStr(gen.value, 500), alts: toStrList(gen.alts, 300, 6) },
    };
  }
  return {
    ...base,
    answerSpec: { kind: 'exact', value: toStr(gen.value, 300), alts: toStrList(gen.alts, 300, 6) },
  };
}

/** Валидация результата ингеста перед сохранением */
export function validateIngest(result: IngestResult): { ok: boolean; message: string } {
  if (!Array.isArray(result.regions) || result.regions.length === 0) {
    return { ok: false, message: 'LLM не выделил регионы' };
  }
  if (!Array.isArray(result.atoms) || result.atoms.length === 0) {
    return { ok: false, message: 'LLM не выделил атомы' };
  }
  const titles = new Set(result.atoms.map((a) => normalizeText(a.title)));
  for (const a of result.atoms) {
    if (!a.title || !a.formulation) return { ok: false, message: 'У атома нет названия или формулировки' };
    if (a.regionIndex === undefined || a.regionIndex < 0 || a.regionIndex >= result.regions.length) {
      return { ok: false, message: `Атом «${a.title}» ссылается на несуществующий регион` };
    }
    for (const need of a.needs ?? []) {
      if (!titles.has(normalizeText(need.title))) {
        // зависимость на несуществующий атом — отбрасываем (не фатально)
        void need;
      }
    }
  }
  return { ok: true, message: `${result.atoms.length} атомов, ${result.regions.length} регионов` };
}

export type { ParsedAtom };
