import { describe, it, expect } from 'vitest';
import {
  findQuoteOffset,
  normalizeForSearch,
  sameSourceName,
  savedTextDedupeKey,
} from '@/lib/saved-texts';

describe('normalizeForSearch', () => {
  it('регистр и ё/е не важны', () => {
    expect(normalizeForSearch('Ёлка и ЁЖ')).toBe('елка и еж');
  });

  it('любая последовательность пробелов — один пробел', () => {
    expect(normalizeForSearch('а\n\n  б\t\tв')).toBe('а б в');
  });

  it('пробелы по краям срезаются', () => {
    expect(normalizeForSearch('  текст  ')).toBe('текст');
  });
});

describe('findQuoteOffset — точное вхождение', () => {
  const text = 'Первая строка.\nВторая строка про производную.\nТретья строка.';

  it('цитата совпадает дословно', () => {
    expect(findQuoteOffset(text, 'Вторая строка про производную')).toBe(15);
  });

  it('начало текста', () => {
    expect(findQuoteOffset(text, 'Первая строка')).toBe(0);
  });

  it('цитаты нет в тексте — null', () => {
    expect(findQuoteOffset(text, 'Этого предложения здесь нет')).toBeNull();
  });

  it('пустая цитата — null', () => {
    expect(findQuoteOffset(text, '')).toBeNull();
    expect(findQuoteOffset(text, '   ')).toBeNull();
  });

  it('пустой текст — null', () => {
    expect(findQuoteOffset('', 'что-то')).toBeNull();
  });
});

describe('findQuoteOffset — гибкие пробелы (OCR переформатирует строки)', () => {
  // В тексте переносы строк и двойные пробелы, цитата — одной строкой
  const text = 'Скорость тела\n  определяется как производная\n\nкоординаты по времени.';
  const quote = 'Скорость тела определяется как производная координаты по времени.';

  it('переносы строк и лишние пробелы не мешают находить цитату', () => {
    expect(findQuoteOffset(text, quote)).toBe(0);
  });

  it('и наоборот: переносы в цитате совпадают с пробелами текста', () => {
    const flat = 'один два три четыре';
    const broken = ['один', 'два  три', 'четыре'].join('\n');
    expect(findQuoteOffset(flat, broken)).toBe(0);
  });

  it('смещение считается по исходному тексту', () => {
    const t = 'Вступление. Далее следует\nмногострочное\nвысказывание про интеграл.';
    expect(findQuoteOffset(t, 'Далее следует многострочное высказывание про интеграл')).toBe(12);
  });
});

describe('findQuoteOffset — нормализованное окно (регистр, ё/е)', () => {
  it('разница в регистре и ё/е перекрывается', () => {
    const text = 'Жёлтый дом стоит\nна углу улицы.';
    const quote = 'жёлтый дом стоит на углу улицы';
    expect(findQuoteOffset(text, quote)).toBe(0);
  });

  it('возвращается смещение в исходном тексте, а не в нормализованном', () => {
    const text = 'Раз, два,\n   три — жёлтый дом на углу.';
    // нормализованное смещение меньше исходного из-за схлопнутых пробелов
    const at = findQuoteOffset(text, 'Жёлтый дом на углу');
    expect(at).toBe(text.indexOf('жёлтый'));
  });

  it('цитата, разбитая мусором между словами, не находится — null', () => {
    expect(findQuoteOffset('слово1 что-то совсем другое слово2', 'слово1 слово2')).toBeNull();
  });
});

describe('sameSourceName — папки-источники', () => {
  it('одно имя в разном регистре — совпадение', () => {
    expect(sameSourceName('Учебник.pdf', 'учебник.pdf')).toBe(true);
  });

  it('пробелы по краям не влияют', () => {
    expect(sameSourceName('  Книга.djvu ', 'Книга.djvu')).toBe(true);
  });

  it('разные имена не совпадают', () => {
    expect(sameSourceName('Книга 1.pdf', 'Книга 2.pdf')).toBe(false);
  });

  it('пустое имя не совпадает ни с чем', () => {
    expect(sameSourceName('', '')).toBe(false);
    expect(sameSourceName('  ', 'учебник.pdf')).toBe(false);
  });
});

describe('savedTextDedupeKey — дедупликация сохранений', () => {
  it('тот же title+text — тот же ключ', () => {
    const a = savedTextDedupeKey('Глава 1', 'Текст главы номер один.');
    const b = savedTextDedupeKey('Глава 1', 'Текст главы номер один.');
    expect(a).toBe(b);
  });

  it('разный текст — разные ключи', () => {
    const a = savedTextDedupeKey('Глава 1', 'Первый вариант текста.');
    const b = savedTextDedupeKey('Глава 1', 'Второй вариант текста.');
    expect(a).not.toBe(b);
  });

  it('тот же текст под другим названием — другой ключ', () => {
    const a = savedTextDedupeKey('Глава 1', 'Общий текст.');
    const b = savedTextDedupeKey('Глава 2', 'Общий текст.');
    expect(a).not.toBe(b);
  });

  it('регистр названия и первые 400 знаков текста входят в ключ', () => {
    // одинаковые по смыслу названия не плодят дубли
    expect(savedTextDedupeKey('Глава 1', 'x')).toBe(savedTextDedupeKey('глава 1', 'x'));
    // длина текста входит в ключ: дописанный хвост — уже другой текст
    const long = 'а'.repeat(500);
    expect(savedTextDedupeKey('Т', long)).not.toBe(savedTextDedupeKey('Т', long + 'хвост'));
  });
});
