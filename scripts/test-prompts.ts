/**
 * Runtime-тест промптов llm-ops: убеждаемся, что в реально отправляемых
 * сообщениях формулы описаны через $...$ / $$...$$ и что одиночные бэкслэши
 * больше не теряются при экранировании JS-строк (баг «( ... )» вместо \( ... \)).
 */
import { genTasksForAtom, ocrTextbookPage, checkIdeaLLM } from '../src/lib/llm-ops';
import type { LLMProvider } from '../src/lib/types';

const provider: LLMProvider = {
  id: 'test',
  name: 'test',
  type: 'openai',
  baseUrl: 'https://mock.local/v1',
  apiKey: 'k',
  model: 'mock',
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

interface Captured {
  system: string | Array<Record<string, unknown>>;
  user: string;
}
let captured: Captured | null = null;

// мок fetch: раскладываем ответ по типу запроса
(globalThis as unknown as { fetch: unknown }).fetch = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(String(init.body));
  const m0 = body.messages[0].content;
  const m1 = typeof body.messages[1]?.content === 'string' ? body.messages[1].content : '';
  captured = { system: m0, user: m1 };
  let content = '{"ok":true,"problems":[],"feedback":"ok"}';
  if (m1.includes('"tasks"')) {
    content = JSON.stringify({
      feynmanQuestion: '?',
      tasks: [
        {
          type: 'numeric',
          prompt: 'p $a$ {{a}}',
          params: [{ name: 'a', choices: [1] }],
          expr: 'a',
          hints: ['h1', 'h2'],
          explanation: 'e',
        },
      ],
    });
  } else if (Array.isArray(m0)) {
    content = 'OCR $$\\int_0^1 x\\,dx$$';
  }
  return {
    status: 200,
    text: async () => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
  };
};

let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failed++;
}

const sys = (c: Captured['system']) => (typeof c === 'string' ? c : '');

// 1. SYSTEM (общий) через genTasksForAtom
const t1 = await genTasksForAtom(provider, { title: 'T', formulation: 'F', example: 'E' });
check('gen_tasks: вернулся ответ', t1.tasks.length === 1);
check('SYSTEM: содержит $...$', sys(captured!.system).includes('$...$'));
check('SYSTEM: содержит $$...$$', sys(captured!.system).includes('$$...$$'));
check('SYSTEM: пример $v(t) = 2at$', sys(captured!.system).includes('$v(t) = 2at$'));
check('SYSTEM: НЕТ потерянных \\(', !sys(captured!.system).includes('\\('));
check('SYSTEM: НЕТ потерянных \\[', !sys(captured!.system).includes('\\['));
check('SYSTEM: \\frac сохранился (одинарный слэш)', sys(captured!.system).includes('\\frac'));
check('TASKS_PROMPT: формулы вида $...$', captured!.user.includes('$...$'));

// 2. OCR страницы (vision)
await ocrTextbookPage(provider, 'data:image/jpeg;base64,xxx');
const ocrText = (captured!.system as Array<Record<string, unknown>>)[0]?.text as string;
check('OCR_PAGE: $...$', ocrText.includes('$...$'));
check('OCR_PAGE: $$...$$', ocrText.includes('$$...$$'));
check('OCR_PAGE: \\int сохранился', ocrText.includes('\\int_0^1'));
check('OCR_PAGE: НЕТ \\(', !ocrText.includes('\\('));

// 3. check_idea — тот же SYSTEM
await checkIdeaLLM(provider, {
  title: 'T',
  formulation: 'F',
  example: 'E',
  feynmanQuestion: 'Q',
  keyTerms: ['k'],
});
check('check_idea: SYSTEM с $...$', sys(captured!.system).includes('$...$'));

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
