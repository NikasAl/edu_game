/**
 * Безопасный вычислитель математических выражений.
 * Поддерживает: числа, + - * / ^, скобки, идентификаторы (параметры),
 * функции sqrt, abs, min, max, round.
 * Используется для решателей параметрических задач (answerSpec.expr),
 * которые приходят из БД — eval() недопустим.
 */

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp'; v: '(' }
  | { t: 'rp'; v: ')' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = input.replace(/,/g, '.');
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      const num = parseFloat(s.slice(i, j));
      if (Number.isNaN(num)) throw new Error(`Некорректное число: ${s.slice(i, j)}`);
      tokens.push({ t: 'num', v: num });
      i = j;
      continue;
    }
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z_0-9]/.test(s[j])) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/^'.includes(c)) {
      tokens.push({ t: 'op', v: c });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lp', v: '(' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rp', v: ')' });
      i++;
      continue;
    }
    throw new Error(`Недопустимый символ: "${c}"`);
  }
  return tokens;
}

const FUNCS: Record<string, (args: number[]) => number> = {
  sqrt: (a) => Math.sqrt(a[0]),
  abs: (a) => Math.abs(a[0]),
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  round: (a) => Math.round(a[0]),
};

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
const RIGHT_ASSOC = new Set(['^']);

/**
 * Вычислить выражение. Пример: evalExpr("2*a*t0", { a: 3, t0: 2 }) => 12
 */
export function evalExpr(expr: string, vars: Record<string, number> = {}): number {
  const tokens = tokenize(expr);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr(minPrec: number): number {
    let left = parseUnary();
    for (;;) {
      const tok = peek();
      if (!tok || tok.t !== 'op') break;
      const prec = PREC[tok.v];
      if (prec === undefined || prec < minPrec) break;
      const op = next().v as string;
      const nextMin = RIGHT_ASSOC.has(op) ? prec : prec + 1;
      const right = parseExpr(nextMin);
      left = applyOp(op, left, right);
    }
    return left;
  }

  function applyOp(op: string, a: number, b: number): number {
    switch (op) {
      case '+':
        return a + b;
      case '-':
        return a - b;
      case '*':
        return a * b;
      case '/':
        return a / b;
      case '^':
        return Math.pow(a, b);
      default:
        throw new Error(`Неизвестная операция: ${op}`);
    }
  }

  function parseUnary(): number {
    const tok = peek();
    if (tok && tok.t === 'op' && (tok.v === '-' || tok.v === '+')) {
      next();
      const v = parseUnary();
      return tok.v === '-' ? -v : v;
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const tok = next();
    if (!tok) throw new Error('Неожиданный конец выражения');
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'id') {
      // функция?
      const after = peek();
      if (after && after.t === 'lp') {
        const fn = FUNCS[tok.v];
        if (!fn) throw new Error(`Неизвестная функция: ${tok.v}`);
        next(); // consume '('
        const args: number[] = [];
        if (peek() && peek().t !== 'rp') {
          args.push(parseExpr(0));
          while (peek() && peek().t === 'op' && peek().v === ',') {
            next();
            args.push(parseExpr(0));
          }
        }
        if (!peek() || peek().t !== 'rp') throw new Error('Ожидалась закрывающая скобка');
        next(); // consume ')'
        return fn(args);
      }
      if (!(tok.v in vars)) throw new Error(`Неизвестный параметр: ${tok.v}`);
      return vars[tok.v];
    }
    if (tok.t === 'lp') {
      const v = parseExpr(0);
      if (!peek() || peek().t !== 'rp') throw new Error('Ожидалась закрывающая скобка');
      next();
      return v;
    }
    throw new Error(`Неожиданный токен: ${JSON.stringify(tok)}`);
  }

  const result = parseExpr(0);
  if (pos !== tokens.length) throw new Error('Лишние символы в конце выражения');
  if (!Number.isFinite(result)) throw new Error('Результат не является конечным числом');
  return result;
}

/** Сравнение численных ответов с допуском */
export function numericEquals(user: number, expected: number, tolerance = 0.01): boolean {
  const tol = Math.max(tolerance, Math.abs(expected) * 0.001);
  return Math.abs(user - expected) <= tol;
}

/** Парсинг ввода пользователя: принимает запятую как десятичный разделитель */
export function parseUserNumber(input: string): number | null {
  const cleaned = input.trim().replace(/\s+/g, '').replace(',', '.');
  if (!cleaned || !/^[+-]?[0-9.]+([eE][+-]?[0-9]+)?$/.test(cleaned)) return null;
  const v = parseFloat(cleaned);
  return Number.isFinite(v) ? v : null;
}

/** Нормализация текстового ответа для exact-сравнения */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, '')
    .replace(/[.,!?;:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
