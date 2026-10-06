'use client';

/**
 * CodeBlock — листинг кода моноширинным шрифтом с лёгкой подсветкой
 * (зависимостей нет: простой регэксп-токенизатор поверх экранированного React-текста).
 *
 * Подсветка нарочито грубая (комментарии / строки / числа / ключевые слова) —
 * её задача «читаемость на телефоне», а не IDE. Ошибки раскраски не ломают
 * содержимое: токены рендерятся как обычные <span>.
 *
 * Пропуски «___» (задачи code_fill) подсвечиваются отдельным стилем.
 */

type Token = { t: 'text' | 'comment' | 'string' | 'number' | 'keyword' | 'gap'; v: string };

const KEYWORDS = [
  'def', 'return', 'if', 'elif', 'else', 'for', 'while', 'in', 'not', 'and', 'or', 'is',
  'import', 'from', 'as', 'class', 'function', 'fn', 'const', 'let', 'var', 'new',
  'public', 'private', 'protected', 'static', 'void', 'int', 'float', 'double', 'str',
  'bool', 'boolean', 'char', 'string', 'print', 'println', 'echo', 'range', 'len',
  'True', 'False', 'None', 'true', 'false', 'null', 'nil', 'undefined',
  'try', 'except', 'catch', 'finally', 'raise', 'throw', 'throws', 'with', 'lambda',
  'yield', 'break', 'continue', 'pass', 'match', 'case', 'switch', 'default',
  'struct', 'enum', 'interface', 'type', 'this', 'self', 'super', 'async', 'await',
  'do', 'end', 'then', 'begin',
];

const TOKEN_RE = new RegExp(
  [
    '("(?:\\\\.|[^"\\\\\\n])*"?)', // строка в двойных кавычках (незакрытая — до конца строки)
    "('(?:\\\\.|[^'\\\\\\n])*'?)", // строка в одинарных кавычках
    '(`(?:\\\\.|[^`\\\\])*`?)', // шаблонная строка
    '(//[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?\\*/)', // комментарии // # /* */
    '(_{3,})', // пропуск задачи code_fill
    '(\\b\\d+(?:\\.\\d+)?\\b)', // число
    `(\\b(?:${KEYWORDS.join('|')})\\b)`, // ключевое слово
  ].join('|'),
  'g'
);

/** Разбить код на токены подсветки (без HTML-строк — только React-текст) */
export function tokenizeCode(code: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  for (const m of code.matchAll(TOKEN_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) tokens.push({ t: 'text', v: code.slice(last, idx) });
    if (m[1] !== undefined || m[2] !== undefined || m[3] !== undefined) tokens.push({ t: 'string', v: m[0] });
    else if (m[4] !== undefined) tokens.push({ t: 'comment', v: m[0] });
    else if (m[5] !== undefined) tokens.push({ t: 'gap', v: m[0] });
    else if (m[6] !== undefined) tokens.push({ t: 'number', v: m[0] });
    else tokens.push({ t: 'keyword', v: m[0] });
    last = idx + m[0].length;
  }
  if (last < code.length) tokens.push({ t: 'text', v: code.slice(last) });
  return tokens;
}

const TOKEN_CLASS: Record<Token['t'], string> = {
  text: '',
  comment: 'text-emerald-500/80 italic',
  string: 'text-amber-300',
  number: 'text-sky-300',
  keyword: 'text-violet-400',
  gap: 'rounded bg-amber-500/25 px-0.5 text-amber-200',
};

export default function CodeBlock({ code, className }: { code: string; className?: string }) {
  const tokens = tokenizeCode(code ?? '');
  return (
    <span
      className={cnBlock(
        'block overflow-x-auto whitespace-pre rounded-lg border border-border/70 bg-muted/60 p-3 font-mono text-[12.5px] leading-relaxed thin-scroll',
        className
      )}
    >
      {tokens.map((tok, i) =>
        tok.t === 'text' ? (
          <span key={i}>{tok.v}</span>
        ) : (
          <span key={i} className={TOKEN_CLASS[tok.t]}>
            {tok.v}
          </span>
        )
      )}
    </span>
  );
}

/** Локальный cn, чтобы не тянуть зависимость в общий компонент */
function cnBlock(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}
