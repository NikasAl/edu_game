/**
 * Мок OpenAI-совместимого LLM-сервера для E2E-тестов импорта.
 * Слушает POST /v1/chat/completions, по маркерам промпта возвращает
 * валидные ответы для: ингеста (split_into_ideas), ИИ-прохода графа
 * (build_graph) и генерации задач (gen_tasks). CORS — разрешить всё,
 * чтобы браузерный fetch с localhost:3000 проходил.
 *
 * Запуск: node scripts/mock-llm-server.mjs [порт=9999]
 */
import http from 'node:http';

const port = Number(process.argv[2] ?? 9999);

const ingestAnswer = {
  regions: [{ title: 'Мок-раздел' }],
  atoms: [
    {
      regionIndex: 0,
      title: 'Мок-атом сложения',
      formulation: 'Сложение — операция объединения двух количеств в одно.',
      example: '2 яблока + 3 яблока = 5 яблок.',
      misconception: 'Сложение это всегда увеличение — при 0 и отрицательных нет.',
      sourceQuote: 'Сложение — базовая арифметическая операция.',
      feynmanQuestion: 'Объясни своими словами, что такое сложение, с примером из жизни.',
      keyTerms: ['сложение', 'сумма', 'слагаемые'],
      atomKind: 'procedure',
      code: '',
      needs: [],
    },
    {
      regionIndex: 0,
      title: 'Мок-атом умножения',
      formulation: 'Умножение — многократное сложение одинаковых слагаемых.',
      example: '3 × 4 = 3 + 3 + 3 + 3 = 12.',
      misconception: '',
      sourceQuote: '',
      feynmanQuestion: 'Объясни, почему умножение быстрее повторного сложения.',
      keyTerms: ['умножение', 'множитель', 'произведение'],
      atomKind: 'procedure',
      code: '',
      needs: [{ title: 'Мок-атом сложения', kind: 'hard' }],
    },
    {
      regionIndex: 0,
      title: 'Мок-атом скобок',
      formulation: 'Скобки меняют порядок вычислений — сначала действия внутри них.',
      example: '(2 + 3) × 4 = 20, а 2 + 3 × 4 = 14.',
      misconception: 'Порядок слева направо всегда главнее скобок.',
      sourceQuote: '',
      feynmanQuestion: 'Объясни, зачем нужны скобки в выражениях.',
      keyTerms: ['скобки', 'порядок действий'],
      atomKind: 'concept',
      code: '',
      needs: [
        { title: 'Мок-атом сложения', kind: 'hard' },
        { title: 'Мок-атом умножения', kind: 'soft' },
      ],
    },
  ],
};

const graphAnswer = { edges: [{ from: 1, to: 3, kind: 'soft' }] };

const feynmanAnswer = {
  verdict: 'pass',
  accuracy: 2,
  completeness: 2,
  ownWords: 1,
  misconceptions: [],
  feedback: 'Мок: объяснение верное и своими словами.',
};

const essayAnswer = { verdict: 'pass', score: 1, missed: [], feedback: 'Мок: ответ зачтён.' };

const ownTaskAnswer = {
  verdict: 'pass',
  onTopic: true,
  solvable: true,
  answer: '5 секунд',
  feedback: 'Мок: задача на тему и решаема.',
};

const tasksAnswer = {
  feynmanQuestion: 'Объясни идею атома своими словами и приведи свой пример.',
  tasks: [
    {
      type: 'choice',
      prompt: 'Какой пример иллюстрирует суть идеи?',
      options: ['Верный вариант', 'Дистрактор А', 'Дистрактор Б'],
      correctIndex: 0,
      hints: ['Вспомни формулировку идеи'],
      explanation: 'Первый вариант точно соответствует определению.',
    },
    {
      type: 'essay',
      prompt: 'Объясни идею своими словами, приведи пример.',
      expectation: ['верная суть идеи', 'собственный пример', 'без фактических ошибок'],
      hints: ['Начни с определения'],
      explanation: 'Полный ответ раскрывает суть и приводит пример.',
    },
  ],
};

function pickAnswer(userContent, allContent) {
  // обсуждение идеи (наставник): системный промпт содержит маркер; ответ — обычный текст
  if (allContent.includes('наставник-собеседник')) {
    return `Хороший вопрос! Суть идеи — в её формулировке и примере: попробуй проговорить её своими словами и проверить на примере. Мок-ответ наставника: идея работает именно так, как описано в примере. Хочешь, разберём ещё один случай?`;
  }
  if (userContent.includes('Перепиши эссе-задачу')) {
    return {
      prompt: 'Мок: даны три отношения на множестве — проверь каждое на рефлексивность и сравнимость элементов; какой из них частичный порядок и почему?',
      expectation: ['понимание рефлексивности', 'понимание сравнимости пар', 'верный вывод про частичный порядок'],
    };
  }
  if (userContent.includes('ОБЪЯСНЕНИЕ СТУДЕНТА')) return feynmanAnswer; // grade_feynman
  if (userContent.includes('Ключевые пункты полного ответа')) return essayAnswer; // check_essay
  if (userContent.includes('ЗАДАЧА СТУДЕНТА')) return ownTaskAnswer; // validate own task
  if (userContent.includes('АТОМЫ ПАКЕТА') || userContent.includes('связи между атомами')) {
    return graphAnswer;
  }
  if (userContent.includes('выдели атомарные идеи')) {
    return ingestAnswer;
  }
  return tasksAnswer; // gen_tasks / fix / classify — задачи подходят везде
}

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method !== 'POST' || !req.url.includes('/chat/completions')) {
    res.writeHead(404, cors);
    res.end('not found');
    return;
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const parsed = JSON.parse(body || '{}');
      const userMsg = (parsed.messages ?? []).filter((m) => m.role === 'user').map((m) => m.content).join('\n');
      const allMsg = (parsed.messages ?? []).map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      const answer = pickAnswer(userMsg, allMsg);
      const isText = typeof answer === 'string';
      console.log(`[mock-llm] ${req.url} → ${isText ? 'text' : answer === ingestAnswer ? 'ingest' : answer === graphAnswer ? 'graph' : 'tasks'} (${userMsg.length} chars)`);
      // небольшая задержка — как у настоящей модели, чтобы видеть фазы в UI
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(
          JSON.stringify({
            id: 'mock-1',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'mock-model',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: isText ? answer : JSON.stringify(answer) },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      }, 300);
    } catch (e) {
      res.writeHead(400, cors);
      res.end(String(e));
    }
  });
});

server.listen(port, () => console.log(`[mock-llm] listening on http://localhost:${port}/v1`));
