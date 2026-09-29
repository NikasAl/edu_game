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
} from './types';
import { normalizeText } from './safeMath';

const SYSTEM = `Ты — методист-редактор образовательных материалов. Ты аккуратен, соблюдаешь запрошенный формат JSON и пишешь по-русски. Не выдумывай факты, которых нет в материале; если чего-то не хватает — опирайся на общепринятые школьные/вузовские формулировки.

ФОРМУЛЫ: пиши математические выражения в LaTeX — строчные формулы оборачивай в \( ... \) (например: \( v(t) = 2at \)), выключные/отдельной строкой — в \[ ... \]. Степени и индексы — только LaTeX-синтаксисом (\( x^2 \), \( t_0 \)), без юникод-надстрочных знаков (², ₀) ВНУТРИ формул. Вне формул — обычный текст. В поля, которые обрабатывает решатель (expr, value, alts), LaTeX НЕ писать — там чистый синтаксис решателя.`;

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
  sourceText: string
): Promise<IngestResult> {
  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `${INGEST_PROMPT}\n\nНазвание материала: «${materialTitle}»\n\nМАТЕРИАЛ:\n${sourceText.slice(0, 24000)}`,
    },
  ];
  const res = await callLLM(provider, messages, { temperature: 0.2, maxTokens: 50000, op: 'ingest' });
  const parsed = extractJson<IngestResult>(res.content);
  if (!Array.isArray(parsed.atoms) || parsed.atoms.length === 0) {
    throw new Error('LLM не вернул ни одного атома');
  }
  return parsed;
}

// ============ 2. Генерация задач для атома ============

const TASKS_PROMPT = `Создай для атома знания 2 проверяемых задания.

Требования:
- задача 1: числовая, ПАРАМЕТРИЧЕСКАЯ — придумай 2–4 параметра с 3–4 допустимыми значениями каждый; ответ должен выражаться формулой от параметров; ВАЖНО: поле expr — чистый синтаксис решателя (только числа, параметры, + - * / ^, скобки, sqrt/abs/min/max/round), НЕ LaTeX;
- текст задачи (prompt) может содержать LaTeX \( \) для формул и подстановки вида {{имя_параметра}};
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
- математические выражения перепиши в LaTeX: строчные формулы — в \\( ... \\), отдельные строки — в \\[ ... \\];
- не решай задачу и не добавляй ничего от себя;
- неразборчивый фрагмент помечай как [неразборчиво].
Верни ТОЛЬКО распознанный текст, без комментариев и без markdown-заборов.`;

const OCR_PROMPT_SHORT = `На изображении — рукописное решение задачи. Верни ТОЛЬКО итоговый ответ (число, выражение или слово) — как он записан в конце решения. Без пояснений. Если итогового ответа нет — верни самую релевантную строку с результатом.`;

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
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
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

/** Преобразование сгенерированной LLM задачи в Task для БД */
export function generatedToTask(
  gen: GeneratedTasks['tasks'][number],
  ids: { id: string; nodeId: string; materialId: string; orderIndex: number }
): Task {
  const base: Omit<Task, 'answerSpec'> = {
    id: ids.id,
    nodeId: ids.nodeId,
    materialId: ids.materialId,
    type: gen.type,
    prompt: gen.prompt,
    hints: (gen.hints ?? []).slice(0, 2),
    explanation: gen.explanation ?? '',
    orderIndex: ids.orderIndex,
    createdAt: new Date(),
  };
  if (gen.type === 'numeric') {
    return {
      ...base,
      params: (gen.params ?? []).filter((p) => p.name && Array.isArray(p.choices) && p.choices.length > 0),
      answerSpec: { kind: 'numeric', expr: gen.expr ?? '0', tolerance: 0.02 },
    };
  }
  if (gen.type === 'choice') {
    return {
      ...base,
      answerSpec: {
        kind: 'choice',
        options: gen.options ?? [],
        correctIndex: Math.max(0, gen.correctIndex ?? 0),
      },
    };
  }
  return {
    ...base,
    answerSpec: { kind: 'exact', value: gen.value ?? '', alts: gen.alts },
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
