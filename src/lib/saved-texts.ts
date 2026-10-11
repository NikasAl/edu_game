/**
 * Библиотека сохранённых текстов импорта.
 *
 * Зачем: удачный результат OCR/извлечения терялся, если разбор на атомы
 * падал или карта не сохранялась — источник приходилось распознавать заново.
 * Теперь текст, отправленный на разбор, автоматически попадает в библиотеку:
 * к нему можно вернуться, перезапустить разбор или прочитать место, откуда
 * взята идея (связь идея → место в тексте).
 *
 * Группировка: тексты одного источника (файл книги, страница сайта) собираются
 * в папку-источник SourceGroup. Совпадение источников — по имени (регистр и
 * пробелы не важны): повторное распознавание той же книги попадает в её папку.
 */

import { v4 as uuid } from 'uuid';
import { db } from './db';
import type { ImportSourceMode, SavedText, SourceGroup } from './types';

// ============ Чистые функции (покрываются тестами) ============

/**
 * Нормализация текста для неточного поиска цитат: регистр и ё/е не важны,
 * любая последовательность пробельных символов эквивалентна одному пробелу.
 * OCR и LLM часто переформатируют переносы строк — дословное сравнение их не переживает.
 */
export function normalizeForSearch(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/** Метасимволы регулярных выражений внутри цитаты экранируются */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Найти смещение цитаты в тексте (0 — начало). Порядок попыток:
 *  1) точное вхождение (indexOf) — самый частый и дешёвый случай;
 *  2) вхождение с «гибкими» пробелами: любая последовательность пробельных
 *     символов в цитате совпадает с любой в тексте (переносы строк, двойные пробелы);
 *  3) нормализованное сравнение скользящим окном — на случай разницы в
 *     пунктуации-мусоре вокруг слов не сработает, но опечаток регистра/пробелов уже
 *     покрывает п.2; окно нужно, когда цитата склеена из абзацев с другими разделителями.
 * Не найдено → null (связь просто не получит смещение, идея останется без ссылки).
 */
export function findQuoteOffset(text: string, quote: string): number | null {
  const q = quote.trim();
  if (!q || !text) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return exact;

  // Гибкие пробелы: каждый пробельный фрагмент цитаты → \s+
  const parts = q.split(/\s+/).filter((p) => p.length > 0).map(escapeRegExp);
  if (parts.length > 0) {
    const re = new RegExp(parts.join('\\s+'));
    const m = re.exec(text);
    if (m) return m.index;
  }

  // Нормализованное окно: ищем нормализованную цитату в нормализованном тексте.
  // Чтобы вернуть смещение в ИСХОДНОМ тексте, предвычисляем карту начал слов.
  const norm = normalizeForSearch(text);
  const normQ = normalizeForSearch(q);
  const at = norm.indexOf(normQ);
  if (at >= 0 && at === 0) return 0;
  if (at > 0) {
    // Пробелов после нормализации меньше — считаем, сколько «настоящих»
    // символов текста стоит до нужного нормализованного места.
    let normPos = 0;
    let i = 0;
    const n = text.length;
    while (i < n && normPos < at) {
      if (/\s/.test(text[i])) {
        // пропуск последовательности пробелов целиком (в норме это 1 символ)
        while (i < n && /\s/.test(text[i])) i++;
        normPos++;
      } else {
        i++;
        normPos++;
      }
    }
    return i < n ? i : null;
  }
  return null;
}

/**
 * Совпадают ли два имени источников как одна папка: без учёта регистра,
 * пробелов по краям и ё/е. Пустые имена не совпадают ни с чем.
 */
export function sameSourceName(a: string, b: string): boolean {
  const na = normalizeForSearch(a);
  const nb = normalizeForSearch(b);
  return na.length > 0 && na === nb;
}

/** Ключ дедупликации: одинаковые название+текст не сохраняем второй раз */
export function savedTextDedupeKey(title: string, text: string): string {
  return `${normalizeForSearch(title)}#${text.length}#${normalizeForSearch(text.slice(0, 400))}`;
}

// ============ Операции с базой ============

export interface SaveSourceTextInput {
  title: string;
  text: string;
  /** Подпись источника: имя файла, URL, «Вставленный текст» */
  sourceLabel: string;
  mode: ImportSourceMode;
  /** Имя папки-источника (для вставки — обычно равно title) */
  groupName: string;
}

export interface SaveSourceTextResult {
  id: string;
  /** true — текст добавлен, false — такой уже был в библиотеке (дедуп) */
  created: boolean;
}

/**
 * Сохранить текст в библиотеку: найти или создать папку-источник по имени,
 * отсеять дубликат (тот же title + тот же текст уже сохранён).
 */
export async function saveSourceText(input: SaveSourceTextInput): Promise<SaveSourceTextResult> {
  const title = input.title.trim();
  const text = input.text;
  if (title.length === 0 || text.trim().length === 0) {
    throw new Error('Пустой текст не сохраняется');
  }

  // Дедуп: тот же текст под тем же названием уже в библиотеке
  const existing = await db.savedTexts.toArray();
  const key = savedTextDedupeKey(title, text);
  for (const t of existing) {
    if (savedTextDedupeKey(t.title, t.text) === key) {
      return { id: t.id, created: false };
    }
  }

  // Папка-источник: совпадение по нормализованному имени
  let groupId: string | null = null;
  const groupName = input.groupName.trim();
  if (groupName.length > 0) {
    const groups = await db.textSources.toArray();
    const found = groups.find((g) => sameSourceName(g.name, groupName));
    if (found) {
      groupId = found.id;
    } else {
      groupId = uuid();
      await db.textSources.put({ id: groupId, name: groupName, createdAt: new Date() });
    }
  }

  const rec: SavedText = {
    id: uuid(),
    groupId,
    title,
    sourceLabel: input.sourceLabel.trim() || 'Вставленный текст',
    mode: input.mode,
    text,
    createdAt: new Date(),
  };
  await db.savedTexts.put(rec);
  return { id: rec.id, created: true };
}

/**
 * Удалить один сохранённый текст. Связи атомов с этим текстом снимаются —
 * после удаления у идей не должно остаться ссылок в пустоту.
 */
export async function deleteSavedText(id: string): Promise<void> {
  await db.savedTexts.delete(id);
  await detachSavedTextLinks(id);
}

/**
 * Удалить папку-источник вместе со всеми её текстами.
 * Возвращает количество удалённых текстов.
 */
export async function deleteSourceGroup(groupId: string): Promise<number> {
  const texts = await db.savedTexts.filter((t) => t.groupId === groupId).toArray();
  await db.transaction('rw', db.savedTexts, db.textSources, async () => {
    await db.savedTexts.bulkDelete(texts.map((t) => t.id));
    await db.textSources.delete(groupId);
  });
  for (const t of texts) await detachSavedTextLinks(t.id);
  return texts.length;
}

/** Переименовать папку-источник */
export async function renameSourceGroup(groupId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (clean.length === 0) throw new Error('Название не может быть пустым');
  await db.textSources.update(groupId, { name: clean });
}

/**
 * Связать атомы карты с сохранённым текстом: узел получает savedTextId,
 * а для узлов с цитатой sourceRef, найденной в тексте, — и sourceChar
 * (смещение, чтобы сразу открыть нужное место).
 * Возвращает количество связанных узлов.
 */
export async function linkNodesToSavedText(
  materialId: string,
  savedTextId: string,
  text: string
): Promise<number> {
  const nodes = await db.nodes.where('materialId').equals(materialId).toArray();
  let linked = 0;
  for (const n of nodes) {
    if (n.savedTextId) continue; // уже связан с каким-то текстом — не трогаем
    const offset = n.sourceRef ? findQuoteOffset(text, n.sourceRef) : null;
    await db.nodes.update(n.id, {
      savedTextId,
      ...(offset !== null ? { sourceChar: offset } : {}),
    });
    linked++;
  }
  return linked;
}

export interface QuoteMatch {
  text: SavedText;
  offset: number;
}

/**
 * Поиск цитаты по всей библиотеке (для старых атомов без связи):
 * побеждает самый свежий текст с точным вхождением, затем — с гибким.
 */
export async function searchSavedTextsForQuote(quote: string): Promise<QuoteMatch | null> {
  const q = quote.trim();
  if (q.length < 8) return null; // слишком короткая цитата — совпадения случайны
  const texts = await db.savedTexts.orderBy('createdAt').reverse().toArray();
  // Сначала точные вхождения (самый надёжный сигнал), потом гибкие
  for (const t of texts) {
    if (t.text.includes(q)) return { text: t, offset: t.text.indexOf(q) };
  }
  for (const t of texts) {
    const at = findQuoteOffset(t.text, q);
    if (at !== null) return { text: t, offset: at };
  }
  return null;
}

/** Удалённый текст мог быть связан с атомами — снимаем связи (библиотека → узлы) */
export async function detachSavedTextLinks(savedTextId: string): Promise<void> {
  const linked = await db.nodes.filter((n) => n.savedTextId === savedTextId).toArray();
  for (const n of linked) {
    await db.nodes.update(n.id, { savedTextId: undefined, sourceChar: undefined });
  }
}
