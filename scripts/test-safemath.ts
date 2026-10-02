/** Тест нормализации выражений (safeMath) и защиты движка задач (task-engine) */
import { safeEvalExpr } from '../src/lib/safeMath';
import { instantiateTask, taskProblems } from '../src/lib/task-engine';
import type { Task } from '../src/lib/types';

let failures = 0;
function eq(expr: string, vars: Record<string, number>, expected: number, tol = 1e-9) {
  const r = safeEvalExpr(expr, vars);
  if (!r.ok) {
    console.log(`FAIL ${expr} → error: ${r.error}`);
    failures++;
    return;
  }
  if (Math.abs(r.value - expected) > tol) {
    console.log(`FAIL ${expr} → ${r.value}, ожидалось ${expected}`);
    failures++;
    return;
  }
  console.log(`ok   ${expr} = ${r.value}`);
}
function throws(expr: string, vars: Record<string, number> = {}) {
  const r = safeEvalExpr(expr, vars);
  if (r.ok) {
    console.log(`FAIL ${expr} — ожидалась ошибка, получено ${r.value}`);
    failures++;
    return;
  }
  console.log(`ok   ${expr} → ошибка: ${r.error}`);
}

// — проценты (главный баг пользователя) —
eq('50% * a', { a: 200 }, 100);
eq('a*50%', { a: 4 }, 2);
eq('a + 10%', { a: 50 }, 50.1);
eq('p%*v', { p: 50, v: 8 }, 4);
// — юникодные операторы —
eq('−5 + 10', {}, 5);
eq('10 ÷ 4', {}, 2.5);
eq('3 × 4 + 2', {}, 14);
eq('2**3', {}, 8);
// — запятые: десятичные и как разделители аргументов —
eq('3,5 + a', { a: 1 }, 4.5);
eq('min(a, b)', { a: 3, b: 5 }, 3);
eq('max(a, b) + 0,5', { a: 3, b: 5 }, 5.5);
eq('round(3,7)', {}, 4);
// — корень и константы —
eq('√9', {}, 3);
eq('√(a+1)', { a: 8 }, 3);
eq('√a', { a: 16 }, 4);
eq('2*pi', {}, 2 * Math.PI);
eq('x*π', { x: 2 }, 2 * Math.PI);
eq('ln(e)', {}, 1);
eq('abs(−7)', {}, 7);
// — понятные ошибки вместо падения —
throws('a $ b', {});
throws('(a + 1', { a: 1 });
throws('a +', { a: 1 });
// — старое поведение не сломалось —
eq('2*a*t0', { a: 3, t0: 2 }, 12);
eq('a/b', { a: 1, b: 4 }, 0.25);

// — движок: битая формула больше не бросает исключение —
const mkTask = (over: Partial<Task>): Task => ({
  id: 't1',
  nodeId: 'n1',
  materialId: 'm1',
  type: 'numeric',
  prompt: 'условие {{a}}',
  params: [{ name: 'a', choices: [2, 4] }],
  answerSpec: { kind: 'numeric', expr: 'a*2', tolerance: 0.02 },
  explanation: '',
  hints: [],
  orderIndex: 0,
  createdAt: new Date(),
  ...over,
});

const good = instantiateTask(mkTask({}));
if (good.answerError) { console.log('FAIL: хорошая формула получила answerError'); failures++; }
else console.log(`ok   instantiateTask хорошая: answer=${good.answer}`);

const brokenInst = instantiateTask(
  mkTask({ answerSpec: { kind: 'numeric', expr: 'a*50% + 2 $ x', tolerance: 0.02 } })
);
if (!brokenInst.answerError) { console.log('FAIL: битая формула не дала answerError'); failures++; }
else console.log(`ok   instantiateTask битая: answerError="${brokenInst.answerError}"`);

const p1 = taskProblems(mkTask({}));
if (p1.length !== 0) { console.log(`FAIL: хорошая задача дала проблемы: ${p1}`); failures++; }
else console.log('ok   taskProblems хорошая: []');

const p2 = taskProblems(mkTask({ answerSpec: { kind: 'numeric', expr: 'a ∗ 50%' } }));
if (p2.length === 0) { console.log('FAIL: битая формула не дала проблем'); failures++; }
else console.log(`ok   taskProblems битая: ${p2[0]}`);

const p3 = taskProblems(
  mkTask({ type: 'choice', answerSpec: { kind: 'choice', options: ['только один'], correctIndex: 0 } })
);
if (p3.length === 0) { console.log('FAIL: 1 вариант не дал проблем'); failures++; }
else console.log(`ok   taskProblems choice: ${p3[0]}`);

const p4 = taskProblems(
  mkTask({ type: 'choice', answerSpec: { kind: 'choice', options: ['а', 'б', 'в'], correctIndex: 5 } })
);
if (p4.length === 0) { console.log('FAIL: корректныйIndex вне диапазона не дал проблем'); failures++; }
else console.log(`ok   taskProblems correctIndex: ${p4[0]}`);

const p5 = taskProblems(mkTask({ type: 'exact', answerSpec: { kind: 'exact', value: '  ' } }));
if (p5.length === 0) { console.log('FAIL: пустой exact не дал проблем'); failures++; }
else console.log(`ok   taskProblems exact: ${p5[0]}`);

// choice-инстанс не должен падать
const ch = instantiateTask(mkTask({ type: 'choice', params: undefined, answerSpec: { kind: 'choice', options: ['а', 'б'], correctIndex: 1 } }));
if (ch.answer !== '1') { console.log(`FAIL: choice answer=${ch.answer}`); failures++; }
else console.log('ok   instantiateTask choice: answer=1');

if (failures > 0) {
  console.log(`\nПРОВАЛЕНО: ${failures}`);
  process.exit(1);
}
console.log('\nВсе проверки прошли');
