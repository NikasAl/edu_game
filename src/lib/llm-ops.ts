/**
 * Интеллектуальные операции над учебными материалами.
 * Все операции имеют два режима:
 *  - LLM (OpenAI-совместимый провайдер из настроек);
 *  - локальный демо-оценщик (без LLM; помечается в UI как «демо»).
 */
import { callLLM, type LLMMessage } from './llm-client';
import { extractJson } from './llm-json';
import type {
  FeynmanGrade,
  IngestResult,
  LLMProvider,
  OwnTaskVerdict,
  ParsedAtom,
  Task,
  TaskInstance,
} from './types';
import { normalizeText } from './safeMath';

const SYSTEM = `Ты — методист-редактор образовательных материалов. Ты аккуратен, соблюдаешь запрошенный формат JSON и пишешь по-русски. Не выдумывай факты, которых нет в материале; если чего-то не хватает — опирайся на общепринятые школьные/вузовские формулировки.

ФОРМУЛЫ: пиши математические выражения в LaTeX — строчные формулы оборачивай в $...$ (например: $v(t) = 2at$), выключные/отдельной строкой — в $$...$$. Степени и индексы — только LaTeX-синтаксисом ($x^2$, $t_0$), без юникод-надстрочных знаков (², ₀) ВНУТРИ формул. Обратные слэши в командах LaTeX (\\frac, \\cdot, \\int) сохраняй как есть. Вне формул — обычный текст. В поля, которые обрабатывает решатель (expr, value, alts), LaTeX НЕ писать — там чистый синтаксис решателя.`;

// ============ 1. Ингест: текст → атомы идей ============

const INGEST_PROMPT = `Разбери учебный материал и выдели атомарные идеи (атомы).

Правила атомарности:
- атом = ОДНА идея: формулируется одним предложением, иллюстрируется одним примером, проверяется одним вопросом;
- на главу обычно 4–12 атомов; не дроби сильнее, не склеивай разные идеи;
- для каждого атома укажи, от каких других атомов он зависит (needs): hard = без этого понять нельзя, soft = помогает;
- зависимости должны образовывать ациклический граф;
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
  const res = await callLLM(provider, messages, { temperature: 0.2, maxTokens: 50000, op: 'ingest' });
  const parsed = extractJson<IngestResult>(res.content);
  if (!Array.isArray(parsed.atoms) || parsed.atoms.length === 0) {
    throw new Error('LLM не вернул ни одного атома');
  }
  return parsed;
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

// ============ 2. Генерация задач для атома ============

const TASKS_PROMPT = `Создай для атома знания 2 проверяемых задания.

Требования:
- задача 1: числовая, ПАРАМЕТРИЧЕСКАЯ — придумай 2–4 параметра с 3–4 допустимыми значениями каждый; ответ должен выражаться формулой от параметров; ВАЖНО: поле expr — чистый синтаксис решателя: только числа, латинские имена параметров, + - * / ^, скобки и функции sqrt/abs/min/max/round/ln/log/floor/ceil; НЕ LaTeX; НЕ используй символы %, ×, ÷, √, π и запятые (проценты пиши как «x/100», корень — sqrt(x), число пи — pi);
- текст задачи (prompt) может содержать формулы в LaTeX вида $...$ и подстановки вида {{имя_параметра}};
- задача 2: с выбором варианта (3 опции) ИЛИ точным коротким текстовым ответом;
- answers должны быть вычислимы/однозначны; числовой ответ — целое или с <=2 знаками после запятой;
- hints: 2 подсказки (1-я — направление, 2-я — шаг решения), explanation — полный разбор (можно с LaTeX);
- всё по-русски, в рамках идеи атома.

Верни СТРОГО JSON:
{
  "feynmanQuestion": "вопрос для объяснения своими словами (если удалось уточнить — иначе повтори исходный)",
  "tasks": [
    {
      "type": "numeric",
      "prompt": "текст задачи с подстановками вида {{имя_параметра}}",
      "params": [{"name": "a", "choices": [1,2,3]}],
      "expr": "формула ответа от параметров",
      "hints": ["направление", "шаг"],
      "explanation": "полный разбор"
    },
    {
      "type": "choice",
      "prompt": "вопрос",
      "options": ["А","Б","В"],
      "correctIndex": 0,
      "hints": ["направление", "шаг"],
      "explanation": "разбор"
    }
  ]
}
(вместо choice может быть {"type":"exact","prompt":"...","value":"эталон","alts":["варианты написания"], ...})`;

export interface GeneratedTasks {
  feynmanQuestion?: string;
  tasks: {
    type: 'numeric' | 'exact' | 'choice';
    prompt: string;
    params?: { name: string; choices: number[] }[];
    expr?: string;
    options?: string[];
    correctIndex?: number;
    value?: string;
    alts?: string[];
    hints: string[];
    explanation: string;
  }[];
}

export async function genTasksForAtom(
  provider: LLMProvider,
  atom: { title: string; formulation: string; example: string },
  sourceText?: string
): Promise<GeneratedTasks> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${TASKS_PROMPT}\n\nАтом: «${atom.title}»\nФормулировка: ${atom.formulation}\nПример: ${atom.example}\n\n${
        sourceText ? `Фрагмент источника:\n${sourceText.slice(0, 3000)}\n` : ''
      }`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.4, maxTokens: 50000, op: 'gen_tasks' });
  const parsed = extractJson<GeneratedTasks>(res.content);
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error('LLM не вернул задачи');
  }
  return parsed;
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
  const res = await callLLM(provider, messages, { temperature: 0.2, maxTokens: 4000, op: 'grade_feynman' });
  const parsed = extractJson<FeynmanGrade>(res.content);
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
  const res = await callLLM(provider, messages, { temperature: 0.2, maxTokens: 4000, op: 'own_task' });
  const parsed = extractJson<OwnTaskVerdict>(res.content);
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
  } else {
    expected = `«${spec.options[spec.correctIndex]}» (индекс ${spec.correctIndex})`;
  }
  const valuesNote =
    task.params && task.params.length > 0
      ? `\nЗначения параметров для проверки: ${task.params.map((p) => `${p.name}=${sample.values[p.name] ?? p.choices[0]}`).join(', ')}`
      : '';
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${CHECK_TASK_PROMPT}\n\nИдея: «${node.title}» — ${node.formulation}\n\nТип задачи: ${task.type}\nШаблон условия: ${task.prompt}${valuesNote}\nЭкземпляр для проверки: ${sample.renderedPrompt}\nЭталонный ответ: ${expected}\n\nПодсказки:\n${task.hints.map((h, i) => `${i + 1}. ${h}`).join('\n') || '(нет)'}\n\nРазбор:\n${task.explanation || '(нет)'}`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.1, maxTokens: 4000, op: 'check_task' });
  const parsed = extractJson<CheckReport>(res.content);
  return {
    ok: Boolean(parsed.ok),
    problems: Array.isArray(parsed.problems) ? parsed.problems.filter((p) => typeof p === 'string' && p.trim()).slice(0, 8) : [],
    feedback: parsed.feedback ?? '',
  };
}

const CHECK_IDEA_PROMPT = `Проверь карточку идеи (атом знаний) как методист:
- formulation: фактически верна и атомарна (ровно одна идея, одно предложение);
- example: наглядный пример, соответствующий идее, без ошибок;
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
  }
): Promise<CheckReport> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${CHECK_IDEA_PROMPT}\n\nНазвание: «${node.title}»\nФормулировка: ${node.formulation}\nПример: ${node.example}\nЧастая ошибка: ${node.misconception || '(не указана)'}\nВопрос Фейнмана: ${node.feynmanQuestion}\nКлючевые термины: ${node.keyTerms.join(', ') || '(нет)'}`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.1, maxTokens: 3000, op: 'check_idea' });
  const parsed = extractJson<CheckReport>(res.content);
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
- hints: 2 подсказки (направление, шаг — без готового ответа);
- explanation: полный разбор, приводящий к ответу;
- всё по-русски.

Верни СТРОГО JSON одной задачи:
{"type":"numeric","prompt":"...","params":[{"name":"a","choices":[1,2,3]}],"expr":"...","hints":["...","..."],"explanation":"..."}
(для exact — {"type":"exact","prompt":"...","value":"...","alts":["..."],...}; для choice — {"type":"choice","prompt":"...","options":["А","Б","В"],"correctIndex":0,...})`;

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
  else answerLine = `options: [${spec.options.map((o, i) => `${i === spec.correctIndex ? '✓' : ''}${o}`).join(' | ')}], correctIndex: ${spec.correctIndex}`;
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${FIX_TASK_PROMPT}\n\nИдея: «${node.title}»\nФормулировка: ${node.formulation}\nПример: ${node.example}\n\nЗАДАЧА (тип ${task.type}):\nУсловие: ${task.prompt}\n${spec.kind === 'numeric' && task.params?.length ? `Параметры: ${JSON.stringify(task.params)}\n` : ''}${answerLine}\nПодсказки: ${task.hints.join(' | ') || '(нет)'}\nРазбор: ${task.explanation || '(нет)'}\n${problems?.length ? `\nНАЙДЕННЫЕ ПРОБЛЕМЫ (устрани их):\n${problems.map((p) => `- ${p}`).join('\n')}` : ''}`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.3, maxTokens: 50000, op: 'fix_task' });
  const parsed = extractJson<GeneratedTasks['tasks'][number]>(res.content);
  if (!parsed.prompt || (!parsed.explanation && !parsed.expr && !parsed.value && !parsed.options)) {
    throw new Error('LLM вернул неполное исправление задачи');
  }
  return parsed;
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
  const res = await callLLM(provider, messages, { temperature: 0.3, maxTokens: 8000, op: 'fix_idea' });
  const parsed = extractJson<FixedIdea>(res.content);
  if (!parsed.formulation || !parsed.example) throw new Error('LLM вернул неполное исправление идеи');
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
  const type: Task['type'] = gen.type === 'numeric' || gen.type === 'choice' ? gen.type : 'exact';
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
