/**
 * Безопасный вычислитель математических выражений.
 * Поддерживает: числа, + - * / ^, скобки, идентификаторы (параметры),
 * константы pi/e, функции sqrt, abs, min, max, round, ln, log, log2, exp,
 * floor, ceil, sign.
 * Используется для решателей параметрических задач (answerSpec.expr),
 * которые приходят из LLM/БД — eval() недопустим.
 *
 * Выражения перед вычислением нормализуются (normalizeExpr): %, ×, ÷, √, π,
 * юникодные минусы и «**» переводятся в синтаксис решателя, поэтому LLM-выражения
 * вида "a*50%" или "√(b²-4ac)" (без «²») не роняют вычисление.
 */

/**
 * Привести выражение из «человеческой» записи LLM к синтаксису решателя.
 * Не бросает исключений.
 */
function normalizeExpr(input: string): string {
  let s = input;
  // невидимые/юникодные пробелы → обычный пробел
  s = s.replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000]/g, ' ');
  // юникодные минусы и тире → '-'
  s = s.replace(/[\u2010-\u2015\u2043\u2212\u2796\uFE63\uFF0D]/g, '-');
  // знаки умножения/деления
  s = s.replace(/[\u00D7\u00B7\u2219\u22C5\u2022\uFF0A]/g, '*');
  s = s.replace(/[\u00F7\u2215\u2044\uFF0F]/g, '/');
  // '**' как возведение в степень
  s = s.replace(/\*\*/g, '^');
  // проценты: '50%' → '50/100', 'p%' → 'p/100'
  s = s.replace(/%/g, '/100');
  // греческая пи
  s = s.replace(/[\u03C0\u03A0]/g, 'pi');
  // десятичная запятая (цифра,цифра без пробелов) → точка; запятая с пробелом
  // («min(3, 1)») — разделитель аргументов функций, не десятичный разделитель
  s = s.replace(/(\d),(?=\d)/g, '$1.');
  // корень: √( → sqrt(; √9 → sqrt(9); √a → sqrt(a)
  s = s.replace(/\u221A\s*\(/g, 'sqrt(');
  s = s.replace(/\u221A\s*([0-9]+(?:\.[0-9]+)?)/g, 'sqrt($1)');
  s = s.replace(/\u221A\s*([a-zA-Z_][a-zA-Z_0-9]*)/g, 'sqrt($1)');
  s = s.replace(/\u221A/g, 'sqrt');
  return s;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp'; v: '(' }
  | { t: 'rp'; v: ')' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const s = normalizeExpr(input);
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
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
    if ('+-*/^,'.includes(c)) {
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
  ln: (a) => Math.log(a[0]),
  log: (a) => Math.log10(a[0]),
  log2: (a) => Math.log2(a[0]),
  exp: (a) => Math.exp(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  sign: (a) => Math.sign(a[0]),
};

/** Константы, доступные в выражениях, если имя не совпало с параметром */
const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };
const RIGHT_ASSOC = new Set(['^']);

/**
 * Вычислить выражение. Пример: evalExpr("2*a*t0", { a: 3, t0: 2 }) => 12
 * Бросает Error с понятным сообщением — для валидации в редакторе.
 * Для рендера/проверки ответов используй safeEvalExpr (не бросает).
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
      if (!(tok.v in vars)) {
        const konst = CONSTANTS[tok.v.toLowerCase()];
        if (konst !== undefined) return konst;
        throw new Error(`Неизвестный параметр: ${tok.v}`);
      }
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

/** Результат безопасного вычисления выражения */
export type SafeEvalResult = { ok: true; value: number } | { ok: false; error: string };

/**
 * Вычислить выражение без исключений: ошибки (битая формула из LLM/БД)
 * возвращаются как { ok: false, error } — рендер не должен падать.
 */
export function safeEvalExpr(expr: string, vars: Record<string, number> = {}): SafeEvalResult {
  try {
    return { ok: true, value: evalExpr(expr, vars) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Выражение не вычисляется' };
  }
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
