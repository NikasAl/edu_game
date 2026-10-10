/**
 * Сходство коротких учебных текстов: эссе-задача vs фейнмановский вопрос.
 *
 * Зачем: в импортированных курсах эссе-задача часто спрашивает то же, что и
 * испытание Фейнмана («объясни своими словами…») — студент пишет один и тот же
 * развёрнутый ответ дважды с телефона. Детектор дубликата позволяет:
 *  - автоматически перенести готовый ответ Фейнмана в эссе (экран узла);
 *  - подсветить дубликат в редакторе и предложить удалить/переформулировать.
 *
 * Метрика — «вхождение» (containment): доля словаря МЕНЬШЕГО текста, покрытая
 * словарём другого. В отличие от Жаккара не штрафует длинный фейнмановский
 * вопрос (формулировка + уточняющие подвопросы) при кратком эссе-версии.
 * Морфология не учитывается осознанно: дубликаты генерируются по одному
 * шаблону («Объясни своими словами…»), корневых совпадений достаточно.
 */

const MIN_WORD_LEN = 3;

/** Словарь значимых слов: lowercase, ё→е, слова длиной ≥ 3 букв/цифр */
export function contentWords(s: string): Set<string> {
  const out = new Set<string>();
  const clean = s.toLowerCase().replace(/ё/g, 'е');
  for (const w of clean.split(/[^a-zа-я0-9]+/)) {
    if (w.length >= MIN_WORD_LEN) out.add(w);
  }
  return out;
}

/** Доля словаря меньшего текста, покрытая другим текстом (0..1); пустые тексты → 0 */
export function containment(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  return hit / small.size;
}

/**
 * Порог «эссе повторяет вопрос Фейнмана». Откалиброван на реальном
 * экспортированном курсе матанализа (31 эссе): дословные/перефразированные
 * дубликаты дали 0.75–0.84, близкие по теме, но разные вопросы — 0.64 и ниже
 * (фон независимых вопросов — ≤ 0.53). 0.55 отделяет одни от других без
 * ложных срабатываний.
 */
export const ESSAY_DUPLICATE_THRESHOLD = 0.55;

/** Эссе-задача спрашивает то же, что и феймановский вопрос узла */
export function essayDuplicatesFeynman(essayPrompt: string, feynmanQuestion: string): boolean {
  const a = essayPrompt.trim();
  const b = feynmanQuestion.trim();
  if (!a || !b) return false;
  return containment(a, b) >= ESSAY_DUPLICATE_THRESHOLD;
}
