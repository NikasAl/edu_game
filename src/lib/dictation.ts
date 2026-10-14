/**
 * Чистая логика диктовки — без React и браузерных API, покрыта тестами.
 */

/** Дописать кусок к набранному тексту с аккуратным разделителем */
export function appendChunk(prev: string, chunk: string): string {
  if (!prev.trim()) return chunk;
  return /[\s\n]$/.test(prev) ? prev + chunk : prev + ' ' + chunk;
}

/**
 * Хвост для живой подсказки диктовки: показываем последние max символов,
 * более длинный текст — с ведущим многоточием.
 */
export function previewTail(text: string, max = 120): string {
  if (text.length <= max) return text;
  return '…' + text.slice(-(max - 1));
}
