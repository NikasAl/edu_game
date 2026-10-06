/**
 * Извлечение текста для импорта из внешних источников.
 *
 *  — Веб-статья по URL: на Android (Capacitor) — через нативный HTTP без CORS
 *    (src/lib/nativeHttp.ts); в браузере — fetch, а при блокировке CORS —
 *    автоматический фолбэк через reader-прокси r.jina.ai (возвращает markdown).
 *  — PDF с текстовым слоем: pdf.js (pdfjs-dist), разбивка по пунктам оглавления
 *    (outline), а без оглавления — по страницам (по 1 или 5).
 *  — PDF через LLM OCR (для сканов и книг с формулами): текстовый слой часто
 *    бесполезен (формулы превращаются в мусор, кодировка ломается), поэтому
 *    страницы можно распознать vision-моделью: renderPdfPageToDataUrl отдаёт
 *    страницу картинкой, а ocrTextbookPage (llm-ops) переводит её в текст с LaTeX.
 *  — DjVu (старые сканы книг): парсер djvu.js (djvujs-dist, чистый JS без wasm —
 *    работает офлайн) даёт то же, что pdf.js для PDF: оглавление (NAVM),
 *    скрытый текстовый слой (TXTa/TXTz) и картинку страницы. Оба пути —
 *    «текст» и «LLM OCR» — работают в точности как у PDF.
 *
 * Результат — плоский список секций: пользователь отмечает нужные, смотрит
 * предпросмотр и применяет выбранный текст к анализу на идеи.
 */

import { isNativePlatform, nativeRequest } from './nativeHttp';

export interface ExtractedSection {
  id: string;
  title: string;
  text: string;
}

export interface ExtractResult {
  title: string;
  sections: ExtractedSection[];
  /** Предупреждение для пользователя (например, про скан без текстового слоя) */
  warning?: string;
  /** Текст получен через reader-прокси (в браузере, при блокировке CORS) */
  viaReader?: boolean;
}

/** Защита от аномально больших секций */
const MAX_SECTION_CHARS = 120_000;
/** Порог «пустого» извлечения */
const MIN_TOTAL_CHARS = 120;

// ============ Веб-статья по URL ============

export async function extractFromUrl(url: string): Promise<ExtractResult> {
  const { text, viaReader } = await fetchPageText(url);
  const parsed = viaReader ? markdownToSections(text) : htmlToSections(text);
  const sections = parsed.sections.filter((s) => s.text.trim().length >= 40);
  if (sections.length === 0) {
    throw new Error('На странице не найден подходящий текст статьи (возможно, это приложение или видео)');
  }
  return { title: parsed.title, sections, viaReader };
}

async function fetchPageText(url: string): Promise<{ text: string; viaReader: boolean }> {
  if (isNativePlatform()) {
    // нативный HTTP: без CORS и mixed-content ограничений WebView;
    // веб-страница — не reasoning-LLM, долгий тайм-аут не нужен
    const res = await nativeRequest(url, { method: 'GET', timeoutMs: 60_000 });
    if (res.status >= 400) throw new Error(`Сервер ответил ${res.status}`);
    return { text: res.body, viaReader: false };
  }

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: 'text/html,text/plain,*/*' },
    });
    if (!res.ok) throw new Error(`Сервер ответил ${res.status}`);
    const text = await res.text();
    if (text.trim().length < 40) throw new Error('Пустой ответ');
    return { text, viaReader: false };
  } catch {
    // CORS/сеть/пустой ответ — reader-прокси: отдаёт markdown статьи и разрешает CORS
    const res = await fetch(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      throw new Error(
        `Не удалось загрузить страницу (${res.status}). В приложении (APK) загрузка работает без ограничений — или вставь текст вручную`
      );
    }
    return { text: await res.text(), viaReader: true };
  }
}

// ============ HTML → секции по заголовкам ============

export function htmlToSections(
  html: string
): { title: string; sections: ExtractedSection[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc
    .querySelectorAll(
      'script,style,noscript,svg,iframe,form,nav,header,footer,aside,template,button,select,dialog,figure'
    )
    .forEach((n) => n.remove());

  const docTitle =
    doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() ||
    doc.title.trim() ||
    doc.querySelector('h1')?.textContent?.trim() ||
    'Статья';

  const container =
    doc.querySelector('article') ??
    doc.querySelector('main') ??
    doc.querySelector('[role="main"]') ??
    doc.body;
  if (!container) return { title: docTitle, sections: [] };

  const blocks = Array.from(
    container.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,figcaption,dt,dd')
  );

  type Line = { kind: 'h1' | 'h2' | 'h3' | 'text'; text: string };
  const lines: Line[] = [];
  const seen = new Set<string>();

  for (const el of blocks) {
    const tag = el.tagName.toLowerCase();
    // вложенные списки: родительский li дублирует текст дочерних — пропускаем его
    if (tag === 'li' && el.querySelector('ul,ol')) continue;
    const raw = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (raw.length < 2) continue;
    const key = tag + '|' + raw.slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      lines.push({ kind: tag, text: raw });
    } else {
      lines.push({ kind: 'text', text: tag === 'li' ? `• ${raw}` : raw });
    }
  }

  const sections: ExtractedSection[] = [];
  let curTitle = '';
  let curLines: string[] = [];
  const flush = () => {
    const text = curLines.join('\n').trim();
    if (text.length > 0) {
      sections.push({
        id: `sec${sections.length}`,
        title: curTitle || 'Текст статьи',
        text: clamp(text),
      });
    }
  };
  for (const ln of lines) {
    if (ln.kind !== 'text') {
      flush();
      curTitle = ln.text.slice(0, 120);
      curLines = [];
    } else {
      curLines.push(ln.text);
    }
  }
  flush();

  return { title: docTitle, sections };
}

// ============ Markdown (reader-прокси) → секции ============

export function markdownToSections(
  md: string
): { title: string; sections: ExtractedSection[] } {
  const lines = md.split('\n');
  // заголовок ответа прокси: «Title: …» до контента
  const titleLine = lines.find((l) => /^#\s+\S/.test(l) || /^Title:\s*\S/.test(l));
  const title = (titleLine?.replace(/^(#\s+|Title:\s*)/, '') ?? 'Статья').trim().slice(0, 120);

  const sections: ExtractedSection[] = [];
  let curTitle = '';
  let curLines: string[] = [];
  const flush = () => {
    const text = curLines.join('\n').trim();
    if (text.length > 0) {
      sections.push({
        id: `sec${sections.length}`,
        title: curTitle || 'Текст статьи',
        text: clamp(text),
      });
    }
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (/^Title:|^URL Source:|^Markdown Content:/i.test(t)) continue;
    const h = raw.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flush();
      curTitle = h[2].trim().slice(0, 120) || 'Раздел';
      curLines = [];
      continue;
    }
    if (/^!\[|^<[^>]+>$/.test(t)) continue; // картинки и сырые теги
    if (!t) {
      if (curLines.length > 0 && curLines[curLines.length - 1] !== '') curLines.push('');
      continue;
    }
    curLines.push(raw.trimEnd());
  }
  flush();

  return { title, sections };
}

// ============ PDF (pdf.js) ============

interface OutlineItem {
  title?: string;
  dest?: unknown;
  items?: OutlineItem[];
}

export type PdfDoc = import('pdfjs-dist').PDFDocumentProxy;

export interface OpenedPdf {
  doc: PdfDoc;
  /** Завершить работу с документом: terminate воркера и освободить память */
  destroy: () => Promise<void>;
}

/** Открыть PDF (pdf.js): worker и cmaps настраиваются автоматически */
export async function openPdf(data: ArrayBuffer): Promise<OpenedPdf> {
  const pdfjs = await import('pdfjs-dist');
  // worker нужен только в браузере; в Node (тесты) pdf.js грузит worker-модуль сам
  const isNode = typeof process !== 'undefined' && !!process.versions?.node;
  if (!isNode) pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';

  // В pdf.js v5+ освобождение ресурсов — через loading task (у документа только cleanup)
  // wasmUrl обязателен с pdf.js v6: декодирование CCITT (факс-сканы) и JBIG2
  // переехало в WASM-модуль jbig2.wasm; без него страницы-сканы рендерятся белыми.
  const task = pdfjs.getDocument({
    data: new Uint8Array(data),
    cMapUrl: '/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/standard_fonts/',
    wasmUrl: '/wasm/',
  });
  const doc = await task.promise;
  return { doc, destroy: () => task.destroy() };
}

/** Метаданные + диапазоны страниц: по оглавлению, иначе — по страницам (по 1 или 5) */
export async function pdfPageSpans(
  doc: PdfDoc,
  fileName: string
): Promise<{ numPages: number; title: string; spans: { title: string; from: number; to: number }[] }> {
  const meta = await doc.getMetadata().catch(() => null);
  const metaTitle = (meta?.info as { Title?: string } | null)?.Title?.trim() ?? '';
  const title = (metaTitle || fileName.replace(/\.pdf$/i, '')).slice(0, 140);

  const spans: { title: string; from: number; to: number }[] = [];
  const outline = (await doc.getOutline().catch(() => null)) as OutlineItem[] | null;
  if (outline && outline.length > 0) {
    const flat: { title: string; page: number }[] = [];
    const walk = async (items: OutlineItem[], depth: number) => {
      for (const it of items) {
        const page = await destToPage(doc, it.dest);
        if (page != null) {
          flat.push({ title: `${'— '.repeat(depth)}${(it.title ?? '').trim()}`, page: page + 1 });
        }
        if (it.items && it.items.length > 0) await walk(it.items, depth + 1);
      }
    };
    await walk(outline, 0);
    for (let i = 0; i < flat.length; i++) {
      const from = flat[i].page;
      const to = (i + 1 < flat.length ? flat[i + 1].page : doc.numPages + 1) - 1;
      if (to < from) continue; // заголовок на той же странице, что и следующий — контент войдёт в соседнюю секцию
      spans.push({ title: flat[i].title, from, to });
    }
  }
  if (spans.length === 0) {
    const chunk = doc.numPages <= 60 ? 1 : 5;
    for (let p = 1; p <= doc.numPages; p += chunk) {
      const to = Math.min(p + chunk - 1, doc.numPages);
      spans.push({
        title:
          doc.numPages === 1
            ? 'Весь документ'
            : chunk === 1
              ? `Страница ${p}`
              : `Страницы ${p}–${to}`,
        from: p,
        to,
      });
    }
  }
  return { numPages: doc.numPages, title, spans };
}

/**
 * Отрендерить страницу PDF в JPEG data URL.
 * Используется и для миниатюр предпросмотра (небольшие maxWidth),
 * и для vision-OCR (широкий рендер ~2200 px, чтобы модель получила
 * читаемый текст: vision-API сами ужимают картинку до ~1–2 тыс. px,
 * поэтому отправлять надо уже большое изображение).
 */
export async function renderPdfPageToDataUrl(
  doc: PdfDoc,
  pageNumber: number,
  maxWidth = 1400,
  quality = 0.85
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  // 0.4 — миниатюры меньше страницы; 4 — запас для OCR-рендера крупным планом
  const scale = Math.min(4, Math.max(0.4, maxWidth / base.width));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // PDF может быть с прозрачным фоном — заливаем белым, иначе JPEG даст чёрный фон
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  await page.render({ canvas, viewport }).promise;
  return canvas.toDataURL('image/jpeg', quality);
}

export async function extractFromPdf(
  data: ArrayBuffer,
  fileName: string,
  onProgress?: (msg: string) => void
): Promise<ExtractResult> {
  const handle = await openPdf(data);
  const doc = handle.doc;
  const { title, spans } = await pdfPageSpans(doc, fileName);

  const pageText = async (n: number): Promise<string> => {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let out = '';
    for (const item of tc.items) {
      if ('str' in item) {
        out += item.str;
        out += item.hasEOL ? '\n' : ' ';
      }
    }
    return cleanText(out);
  };

  const sections: ExtractedSection[] = [];
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const pages: string[] = [];
    for (let p = sp.from; p <= Math.min(sp.to, doc.numPages); p++) {
      pages.push(await pageText(p));
      if (p % 5 === 0) onProgress?.(`Извлекаю текст: страница ${p} из ${doc.numPages}…`);
    }
    const text = pages.join('\n\n').trim();
    if (text.length < 20) continue; // пустые страницы (обложка и т.п.)
    sections.push({
      id: `sec${i}`,
      title: sp.title || `Раздел ${i + 1}`,
      text: clamp(text),
    });
  }

  if (sections.length === 0 || sections.reduce((n, s) => n + s.text.length, 0) < MIN_TOTAL_CHARS) {
    void handle.destroy();
    throw new Error(
      'В PDF не найден текстовый слой — похоже, это скан. Попробуй режим «LLM OCR» — он распознаёт страницы картинкой'
    );
  }

  const result: ExtractResult = {
    title,
    sections,
    warning:
      doc.numPages > 120
        ? `Документ большой (${doc.numPages} стр.) — выбери нужные разделы, остальное импортируй отдельными картами`
        : undefined,
  };
  void handle.destroy();
  return result;
}

// ============ DjVu (djvu.js) ============

export type DjVuDoc = import('djvujs-dist/library/src/DjVuDocument').default;

export interface OpenedDjvu {
  doc: DjVuDoc;
  /** Завершить работу с документом: сбросить декодированные структуры */
  destroy: () => void;
}

/** Проверка магии файла: «AT&TFORM» — единый формат IFF для DjVu */
export function isDjvuBuffer(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const magic = new Uint8Array(data, 0, 8);
  return (
    magic[0] === 0x41 && // A
    magic[1] === 0x54 && // T
    magic[2] === 0x26 && // &
    magic[3] === 0x54 && // T
    magic[4] === 0x46 && // F
    magic[5] === 0x4f && // O
    magic[6] === 0x52 && // R
    magic[7] === 0x4d //   M
  );
}

/** Открыть DjVu (djvu.js). Пользовательский файл — всегда однофайловый документ;
 *  «косвенные» (indirect, страница = отдельный файл) сразу отклоняем с ясной ошибкой. */
export async function openDjvu(data: ArrayBuffer): Promise<OpenedDjvu> {
  const { default: DjVuDocument } = await import('djvujs-dist/library/src/DjVuDocument');
  let doc: DjVuDoc;
  try {
    doc = new DjVuDocument(data);
  } catch {
    throw new Error('Это не похоже на DjVu-файл (нет сигнатуры AT&TFORM) или файл повреждён');
  }
  if (!doc.isBundled()) {
    throw new Error(
      'Это «косвенный» DjVu (indirect): каждая страница — отдельный файл. Собери его в один файл (например, djvm -c) и импортируй снова'
    );
  }
  return {
    doc,
    destroy: () => {
      try {
        doc.resetLastRequestedPage();
      } catch {
        // память всё равно освободится сборщиком мусора вместе с документом
      }
    },
  };
}

/**
 * Диапазоны страниц из плоского списка закладок оглавления:
 * соседняя закладка начинает следующую секцию, как в pdfPageSpans.
 * Закладки на одной странице (или пропущенные вперёд) сливаются в соседнюю секцию.
 */
export function spansFromOutline(
  flat: { title: string; page: number }[],
  numPages: number
): { title: string; from: number; to: number }[] {
  const spans: { title: string; from: number; to: number }[] = [];
  for (let i = 0; i < flat.length; i++) {
    const from = flat[i].page;
    const to = (i + 1 < flat.length ? flat[i + 1].page : numPages + 1) - 1;
    if (to < from) continue; // заголовок на той же странице, что и следующий — контент войдёт в соседнюю секцию
    spans.push({ title: flat[i].title, from, to });
  }
  return spans;
}

/** Диапазоны «по страницам» (без оглавления): по 1 до 60 страниц, дальше — по 5 */
export function autoPageSpans(numPages: number): { title: string; from: number; to: number }[] {
  const chunk = numPages <= 60 ? 1 : 5;
  const spans: { title: string; from: number; to: number }[] = [];
  for (let p = 1; p <= numPages; p += chunk) {
    const to = Math.min(p + chunk - 1, numPages);
    spans.push({
      title:
        numPages === 1 ? 'Весь документ' : chunk === 1 ? `Страница ${p}` : `Страницы ${p}–${to}`,
      from: p,
      to,
    });
  }
  return spans;
}

/** Метаданные + диапазоны страниц: по оглавлению (NAVM), иначе — по страницам */
export function djvuPageSpans(
  doc: DjVuDoc,
  fileName: string
): { numPages: number; title: string; spans: { title: string; from: number; to: number }[] } {
  const numPages = doc.getPagesQuantity();
  const title =
    fileName.replace(/\.(djvu|djv)$/i, '').trim().slice(0, 140) || 'Документ DjVu';

  const outline = doc.getContents();
  if (outline && outline.length > 0) {
    const flat: { title: string; page: number }[] = [];
    const walk = (items: import('djvujs-dist/library/src/DjVuDocument').DjVuBookmark[], depth: number) => {
      for (const it of items) {
        const page = it.url ? doc.getPageNumberByUrl(it.url) : null;
        const name = it.description.trim();
        if (page != null && name) {
          flat.push({ title: `${'— '.repeat(depth)}${name}`, page });
        }
        if (it.children && it.children.length > 0) walk(it.children, depth + 1);
      }
    };
    walk(outline, 0);
    const spans = spansFromOutline(flat, numPages);
    if (spans.length > 0) return { numPages, title, spans };
  }
  return { numPages, title, spans: autoPageSpans(numPages) };
}

/**
 * Отрендерить страницу DjVu в JPEG data URL — та же схема, что renderPdfPageToDataUrl:
 * миниатюры (небольшие maxWidth) и vision-OCR (широкий рендер ~2200 px).
 * Декодирование страницы (JB2/IW44) синхронное и целиком происходит внутри
 * getImageData() — для цветных страниц 300 dpi это секунды, поэтому вызовы
 * стоит сериализовать (адаптер в ImportPanel это делает).
 */
export async function renderDjvuPageToDataUrl(
  doc: DjVuDoc,
  pageNumber: number,
  maxWidth = 1400,
  quality = 0.85
): Promise<string> {
  const page = await doc.getPage(pageNumber);
  const imageData = page.getImageData();

  const src = document.createElement('canvas');
  src.width = imageData.width;
  src.height = imageData.height;
  const sctx = src.getContext('2d');
  if (!sctx) throw new Error('Canvas недоступен в этом окружении');
  sctx.putImageData(imageData, 0, 0);

  // как у PDF: 0.4 — миниатюры меньше страницы; 4 — запас для OCR-рендера крупным планом
  const scale = Math.min(4, Math.max(0.4, maxWidth / imageData.width));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(imageData.width * scale));
  out.height = Math.max(1, Math.round(imageData.height * scale));
  const octx = out.getContext('2d');
  if (!octx) throw new Error('Canvas недоступен в этом окружении');
  octx.fillStyle = '#ffffff';
  octx.fillRect(0, 0, out.width, out.height);
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(src, 0, 0, out.width, out.height);

  page.reset();
  return out.toDataURL('image/jpeg', quality);
}

/** Текстовый слой DjVu: секции по оглавлению или по страницам (зеркало extractFromPdf) */
export async function extractFromDjvu(
  data: ArrayBuffer,
  fileName: string,
  onProgress?: (msg: string) => void
): Promise<ExtractResult> {
  const handle = await openDjvu(data);
  const doc = handle.doc;
  const { title, spans, numPages } = djvuPageSpans(doc, fileName);

  const sections: ExtractedSection[] = [];
  for (let i = 0; i < spans.length; i++) {
    const sp = spans[i];
    const pages: string[] = [];
    for (let p = sp.from; p <= Math.min(sp.to, numPages); p++) {
      const page = await doc.getPage(p);
      pages.push(cleanText(page.getText()));
      if (p % 5 === 0) onProgress?.(`Извлекаю текст: страница ${p} из ${numPages}…`);
    }
    const text = pages.join('\n\n').trim();
    if (text.length < 20) continue; // пустые страницы (обложка и т.п.)
    sections.push({
      id: `sec${i}`,
      title: sp.title || `Раздел ${i + 1}`,
      text: clamp(text),
    });
  }

  handle.destroy();

  if (sections.length === 0 || sections.reduce((n, s) => n + s.text.length, 0) < MIN_TOTAL_CHARS) {
    throw new Error(
      'В DjVu нет текстового слоя — похоже, это скан без распознавания. Попробуй режим «LLM OCR» — он распознаёт страницы картинкой'
    );
  }

  const result: ExtractResult = {
    title,
    sections,
    warning:
      numPages > 120
        ? `Документ большой (${numPages} стр.) — выбери нужные разделы, остальное импортируй отдельными картами`
        : undefined,
  };
  return result;
}

async function destToPage(
  doc: import('pdfjs-dist').PDFDocumentProxy,
  dest: unknown
): Promise<number | null> {
  try {
    let arr: unknown[] | null = null;
    if (typeof dest === 'string') arr = (await doc.getDestination(dest)) as unknown[] | null;
    else if (Array.isArray(dest)) arr = dest;
    if (!arr || arr.length === 0) return null;
    const ref = arr[0];
    if (typeof ref === 'number') return ref;
    if (ref && typeof ref === 'object') {
      return await doc.getPageIndex(ref as Parameters<typeof doc.getPageIndex>[0]);
    }
    return null;
  } catch {
    return null;
  }
}

// ============ Утилиты ============

function clamp(text: string): string {
  return text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS) + '…' : text;
}

function cleanText(s: string): string {
  return s
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
