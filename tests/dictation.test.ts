import { describe, expect, it } from 'vitest';
import { appendChunk, previewTail } from '../src/lib/dictation';

describe('appendChunk — дописывание фраз диктовки', () => {
  it('в пустое поле кусок становится текстом', () => {
    expect(appendChunk('', 'привет')).toBe('привет');
    expect(appendChunk('   ', 'привет')).toBe('привет');
  });

  it('к обычному тексту добавляет через пробел', () => {
    expect(appendChunk('раз', 'два')).toBe('раз два');
  });

  it('не дублирует разделитель, если текст уже кончается пробелом', () => {
    expect(appendChunk('раз ', 'два')).toBe('раз два');
    expect(appendChunk('раз\n', 'два')).toBe('раз\nдва');
  });

  it('склеивает серию фраз без потери слов', () => {
    let acc = '';
    for (const chunk of ['предел', 'функции', 'в точке']) {
      acc = appendChunk(acc, chunk);
    }
    expect(acc).toBe('предел функции в точке');
  });
});

describe('previewTail — живая подсказка диктовки', () => {
  it('короткий текст возвращается как есть', () => {
    expect(previewTail('привет', 120)).toBe('привет');
  });

  it('длинный текст обрезается до хвоста с многоточием', () => {
    const long = 'а'.repeat(200);
    const out = previewTail(long, 120);
    expect(out.length).toBe(120);
    expect(out.startsWith('…')).toBe(true);
    expect(out.slice(1)).toBe('а'.repeat(119));
  });

  it('граничная длина возвращается без многоточия', () => {
    expect(previewTail('б'.repeat(120), 120)).toBe('б'.repeat(120));
    expect(previewTail('б'.repeat(121), 120)).toBe('…' + 'б'.repeat(119));
  });

  it('пустой текст — пустая подсказка', () => {
    expect(previewTail('')).toBe('');
  });
});
