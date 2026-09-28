'use client';

/**
 * MathText — рендер текста с формулами LaTeX через KaTeX.
 *
 * Поддерживаемые разделители:
 *  - \[ ... \] и $$ ... $$ — выключная формула (отдельным блоком);
 *  - \( ... \) и $ ... $  — строчная формула.
 *
 * Текстовые сегменты рендерит React (с экранированием), формулы — KaTeX
 * с throwOnError:false (битая формула показывается красным текстом, а не роняет UI).
 * Сегменты без признаков математики рендерятся как обычный текст (быстрый путь).
 */
import { useMemo } from 'react';
import katex from 'katex';

type Seg = { kind: 'text' | 'inline' | 'block'; value: string };

const MATH_RE =
  /\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$|\\\(([\s\S]*?)\\\)|(?<![\\$])\$(?!\s)((?:[^$\n\\]|\\.)+?)(?<!\s)\$/g;

export function parseMathSegments(input: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of input.matchAll(MATH_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) segs.push({ kind: 'text', value: input.slice(last, idx) });
    if (m[1] !== undefined || m[2] !== undefined) {
      segs.push({ kind: 'block', value: (m[1] ?? m[2]).trim() });
    } else {
      segs.push({ kind: 'inline', value: (m[3] ?? m[4]).trim() });
    }
    last = idx + m[0].length;
  }
  if (last < input.length) segs.push({ kind: 'text', value: input.slice(last) });
  return segs;
}

function renderKatex(latex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(latex, {
      displayMode,
      throwOnError: false,
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch {
    return latex;
  }
}

function hasMath(s: string): boolean {
  return s.includes('\\(') || s.includes('\\[') || s.includes('$$') || /\$[^$\s]/.test(s);
}

export default function MathText({ children, className }: { children: string | undefined | null; className?: string }) {
  const text = children ?? '';
  const segments = useMemo(() => (hasMath(text) ? parseMathSegments(text) : null), [text]);

  if (!segments) return <span className={className}>{text}</span>;

  return (
    <span className={className}>
      {segments.map((s, i) => {
        if (s.kind === 'text') {
          return (
            <span key={i} className="whitespace-pre-wrap">
              {s.value}
            </span>
          );
        }
        return (
          <span
            key={i}
            dangerouslySetInnerHTML={{
              __html: renderKatex(s.value, s.kind === 'block'),
            }}
            className={
              s.kind === 'block'
                ? 'katex-block my-1 block overflow-x-auto thin-scroll text-center'
                : 'katex-inline'
            }
          />
        );
      })}
    </span>
  );
}
