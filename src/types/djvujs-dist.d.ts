/**
 * Минимальные декларации для djvu.js (npm: djvujs-dist) — парсер/рендерер DjVu
 * на чистом JS (без wasm, работает офлайн). Библиотека без собственных типов,
 * здесь описана только используемая часть API (см. library/API.md в пакете).
 *
 * Важно: import идёт по глубокому пути 'djvujs-dist/library/src/DjVuDocument',
 * минуя index.js пакета — тот тянет DjVuWorker (создание воркера из собственного
 * кода через ObjectURL), который для синхронного API не нужен.
 */

declare module 'djvujs-dist/library/src/DjVuDocument' {
  /** Страница DjVu-документа (лениво декодируется при обращении) */
  export interface DjVuPageLike {
    getWidth(): number;
    getHeight(): number;
    getDpi(): number;
    /** Текст из скрытого слоя (TXTa/TXTz); '' — если слоя нет */
    getText(): string;
    /** Полное изображение страницы в пикселях (уже с учётом разворота) */
    getImageData(rotate?: boolean): ImageData;
    /** Освободить временные структуры декодера */
    reset(): void;
  }

  /** Закладка оглавления (чанк NAVM); url — '#pageId' или '#5' */
  export interface DjVuBookmark {
    description: string;
    url: string;
    children?: DjVuBookmark[];
  }

  export default class DjVuDocument {
    constructor(buffer: ArrayBuffer, options?: { baseUrl?: string; memoryLimit?: number });
    /** Число страниц (1 — для одностраничного FORMDJVU) */
    getPagesQuantity(): number;
    /** true — однофайловый документ; false — «косвенный» (страницы отдельными файлами) */
    isBundled(): boolean;
    /** Оглавление из NAVM-чанка; null — если оглавления нет */
    getContents(): DjVuBookmark[] | null;
    /** Номер страницы (с 1) по url закладки; null — не найдено */
    getPageNumberByUrl(url: string): number | null;
    /** Страница по номеру с 1; сбрасывает предыдущую запрошенную страницу */
    getPage(pageNumber: number): Promise<DjVuPageLike>;
    /** Сбросить последнюю запрошенную страницу (освободить память) */
    resetLastRequestedPage(): void;
  }
}
