'use client';

/**
 * RichText — рендер текста LLM, где код может быть обёрнут в ```-фенсы.
 * Сегменты без кода уходят в MathText (KaTeX), сегменты кода — в CodeBlock.
 *
 * Компонент сознательно рендерит код в <span class="block">…</span>, а не в <pre>:
 * RichText подставляется внутрь <p>/<li> — <pre> там запрещён браузерами
 * (validateDOMNesting), а block-спан даёт ту же раскладку без проблем.
 *
 * Незакрытый фенс (модель забыла ```) трактуется как код до конца текста.
 */

import { useMemo } from 'react';
import MathText from './MathText';
import CodeBlock from './CodeBlock';

type Part = { kind: 'text' | 'code'; value: string };

/** Разбить текст на текстовые сегменты и ```-блоки (одиночный проход) */
export function splitFences(input: string): Part[] {
  const parts: Part[] = [];
  let rest = input ?? '';
  for (;;) {
    const start = rest.indexOf('```');
    if (start < 0) {
      if (rest) parts.push({ kind: 'text', value: rest });
      break;
    }
    if (start > 0) parts.push({ kind: 'text', value: rest.slice(0, start) });
    const after = rest.slice(start + 3);
    const close = after.indexOf('```');
    if (close >= 0) {
      parts.push({ kind: 'code', value: stripLangMarker(after.slice(0, close)) });
      rest = after.slice(close + 3);
    } else {
      // незакрытый фенс — код до конца текста
      const body = stripLangMarker(after);
      if (body) parts.push({ kind: 'code', value: body });
      break;
    }
  }
  return parts;
}

/** Отрезать маркер языка: «python\nкод…» → «код…»; инлайн-блок без новой строки не трогаем */
function stripLangMarker(body: string): string {
  const nl = body.indexOf('\n');
  if (nl < 0) return body.replace(/\n$/, '');
  const marker = body.slice(0, nl);
  return /^[a-zA-Z0-9_+#-]{0,20}$/.test(marker.trim()) ? body.slice(nl + 1) : body.replace(/\n$/, '');
}

export default function RichText({ children, className }: { children: string | undefined | null; className?: string }) {
  const parts = useMemo(() => splitFences(children ?? ''), [children]);

  if (parts.length === 1 && parts[0].kind === 'text') {
    return <MathText className={className}>{parts[0].value}</MathText>;
  }

  return (
    <span className={className}>
      {parts.map((p, i) =>
        p.kind === 'code' ? (
          <CodeBlock key={i} code={p.value} className="my-1.5" />
        ) : (
          <MathText key={i}>{p.value}</MathText>
        )
      )}
    </span>
  );
}
