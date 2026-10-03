/**
 * Runtime-тест сетевых сбоев и потоковой передачи callLLM (esbuild bundle + node).
 * Фон: у пользователя импорт падал с безликим «Failed to fetch» — шлюз провайдера
 * рвал «молчащее» соединение через ~126 с, пока reasoning-модель думала.
 * Здесь проверяем: SSE-сборку ответа, ясные причины сетевых сбоев, автоповторы.
 *
 * Сценарии:
 *  0. юнит: parseSseResponse / looksLikeSse (комментарии, [DONE], usage, битые строки);
 *  1. SSE-поток: ответ собирается из чатов; finish_reason/usage — в журнале;
 *  2. провайдер игнорирует stream и отвечает JSON — регрессия;
 *  3. сервер рвёт соединение сразу — «Не удалось подключиться…» + автоповтор (attempts=2);
 *  4. сервер молча рвёт соединение через ~1.5 с — «оборвалось через 2 с» + автоповтор;
 *  5. SSE обрывается посреди — «Поток ответа оборван…», частичный текст в журнале;
 *  6. сервер молчит + короткий тайм-аут — «Тайм-аут…», без автоповтора;
 *  7. 500 → автоповтор → успех (attempts=2).
 *
 * Запуск: npx esbuild scripts/test-llm-errors.ts --bundle --platform=node --format=cjs \
 *          --outfile=node_modules/.cache/test-llm-errors.cjs && node node_modules/.cache/test-llm-errors.cjs
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { callLLM, llmDebugClear, llmDebugSnapshot, parseSseResponse, looksLikeSse } from '../src/lib/llm-client';
import type { LLMProvider } from '../src/lib/types';

const INGEST_JSON = JSON.stringify({
  regions: [{ title: 'Р1' }],
  atoms: [{ regionIndex: 0, title: 'Атом 1', formulation: 'f', example: 'e', feynmanQuestion: 'q', keyTerms: ['t'], needs: [] }],
});

let failed = 0;
function check(name: string, cond: boolean, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  ${extra}`}`);
  if (!cond) failed++;
}

function mkProvider(port: number): LLMProvider {
  return {
    id: 'p' + port,
    name: 'mock',
    type: 'openai',
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'k',
    model: 'mock-model',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const chunkLine = (delta: unknown, finish: string | null = null) =>
  sseLine({ model: 'mock-model', choices: [{ index: 0, delta, finish_reason: finish }] });

function streamContent(res: http.ServerResponse, text: string, tail: { finish: string | null; done: boolean; usage: boolean }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(chunkLine({ role: 'assistant', content: '' }));
  for (let i = 0; i < text.length; i += 50) res.write(chunkLine({ content: text.slice(i, i + 50) }));
  if (tail.usage) {
    res.write(sseLine({ model: 'mock-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
  }
  if (tail.finish !== null) res.write(chunkLine({}, tail.finish));
  if (tail.done) res.write('data: [DONE]\n\n');
  res.end();
}

const readBody = (req: http.IncomingMessage, cb: (raw: string) => void) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => cb(body));
};

const servers: http.Server[] = [];

// A: нормальный сервер — SSE при stream:true, JSON иначе
servers.push(
  http.createServer((req, res) => {
    readBody(req, (raw) => {
      let wantsStream = false;
      try {
        wantsStream = JSON.parse(raw).stream === true;
      } catch {
        /* ignore */
      }
      if (!wantsStream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'mock-model',
            choices: [{ index: 0, message: { role: 'assistant', content: INGEST_JSON }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
          })
        );
        return;
      }
      streamContent(res, INGEST_JSON, { finish: 'stop', done: true, usage: true });
    });
  })
);

// B: принимает запрос и молча рвёт соединение через 1500 мс (без ответа)
servers.push(
  http.createServer((req, res) => {
    req.resume();
    setTimeout(() => res.destroy(), 1500);
  })
);

// C: рвёт соединение мгновенно
servers.push(
  http.createServer((req, res) => {
    req.resume();
    res.destroy();
  })
);

// D: SSE обрывается посреди генерации (без finish_reason и [DONE]) — шлюз закрыл ответ чисто
servers.push(
  http.createServer((req, res) => {
    readBody(req, () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunkLine({ role: 'assistant', content: '' }));
      res.write(chunkLine({ content: INGEST_JSON.slice(0, 130) }));
      res.write(chunkLine({ content: INGEST_JSON.slice(130, 260) }));
      setTimeout(() => res.end(), 300); // финала не шлём, но ответ закрываем аккуратно
    });
  })
);

// E: один 500, затем успешный SSE (автоповтор на 5xx)
let eHits = 0;
servers.push(
  http.createServer((req, res) => {
    readBody(req, () => {
      eHits++;
      if (eHits === 1) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model temporarily unavailable' } }));
        return;
      }
      streamContent(res, INGEST_JSON, { finish: 'stop', done: true, usage: false });
    });
  })
);

// F: никогда не отвечает (для тайм-аута)
servers.push(http.createServer(() => {/* молчим */}));

const lastEntry = () => llmDebugSnapshot()[llmDebugSnapshot().length - 1];

async function main() {
  for (const s of servers) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const [portA, portB, portC, portD, portE, portF] = servers.map((s) => (s.address() as AddressInfo).port);
  // порт с погасшим сервером → ECONNREFUSED (для сценария «отказ подключения»)
  const dead = http.createServer(() => {});
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const portDead = (dead.address() as AddressInfo).port;
  dead.close();

  // --- 0. юнит-проверки парсера ---
  const sse = [
    ': ping',
    sseLine({ model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }),
    '',
    sseLine({ model: 'm', choices: [{ index: 0, delta: { content: 'Привет' }, finish_reason: null }] }),
    'data: {битая строка',
    sseLine({ model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    sseLine({ model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    'data: [DONE]',
    '',
  ].join('\n');
  const p = parseSseResponse(sse);
  const pc = (p?.data.choices as Array<{ message: { content: string } }> | undefined)?.[0]?.message?.content;
  check('юнит: looksLikeSse true/false', looksLikeSse(sse) === true && looksLikeSse('{"a":1}') === false);
  check('юнит: content собран из чатов, битая строка пропущена', pc === 'Привет', `content=${JSON.stringify(pc)}`);
  check('юнит: complete по finish_reason+[DONE]', p?.complete === true);
  check('юнит: usage вытащен', JSON.stringify((p?.data.usage as { total_tokens: number } | undefined)?.total_tokens) === '3');
  const trunc = parseSseResponse(sseLine({ model: 'm', choices: [{ index: 0, delta: { content: 'abc' }, finish_reason: null }] }));
  check('юнит: без финала complete=false', trunc?.complete === false);

  // --- 1. SSE-поток: успех ---
  const r1 = await callLLM(mkProvider(portA), [{ role: 'user', content: 'тест' }], { op: 'ingest', maxTokens: 50000 });
  const e1 = lastEntry();
  check('SSE: контент собран', JSON.parse(r1.content).atoms.length === 1);
  check('SSE: модель из потока', r1.model === 'mock-model', r1.model);
  check('SSE: usage попал в журнал', e1?.usage?.total_tokens === 30, JSON.stringify(e1?.usage));
  check('SSE: finish_reason=stop, 1 попытка', e1?.finishReason === 'stop' && e1?.attempts === 1 && e1?.ok === true);

  // --- 2. провайдер игнорирует stream и отвечает JSON ---
  llmDebugClear();
  const r2 = await callLLM(mkProvider(portA), [{ role: 'user', content: 'тест' }], { op: 'ingest', jsonMode: false });
  check('JSON-фолбэк: ответ разобран', JSON.parse(r2.content).regions.length === 1);

  // --- 3. мгновенный обрыв (сервер принял и сбросил) → «оборвалось…» + автоповтор ---
  llmDebugClear();
  let err3: Error | null = null;
  try {
    await callLLM(mkProvider(portC), [{ role: 'user', content: 'тест' }], { op: 'ingest' });
  } catch (e) {
    err3 = e as Error;
  }
  const e3 = lastEntry();
  check(
    'мгновенный обрыв: ясное сообщение',
    !!err3 && err3.message.includes('оборвалось через 1 с') && err3.message.includes('сервер закрыл запрос'),
    err3?.message
  );
  check('мгновенный обрыв: был автоповтор (attempts=2)', e3?.attempts === 2, `attempts=${e3?.attempts}`);
  check('мгновенный обрыв: errorKind=dropped', e3?.errorKind === 'dropped', String(e3?.errorKind));

  // --- 3b. отказ подключения (порт без сервера) → «отклонил подключение» ---
  llmDebugClear();
  let err3b: Error | null = null;
  try {
    await callLLM(mkProvider(portDead), [{ role: 'user', content: 'тест' }], { op: 'ingest' });
  } catch (e) {
    err3b = e as Error;
  }
  const e3b = lastEntry();
  check(
    'отказ подключения: ясное сообщение про адрес/порт',
    !!err3b && err3b.message.includes('отклонил подключение'),
    err3b?.message
  );
  check('отказ подключения: errorKind=connect', e3b?.errorKind === 'connect', String(e3b?.errorKind));

  // --- 4. молчаливый обрыв через 1.5 с → «оборвалось через 2 с» ---
  llmDebugClear();
  let err4: Error | null = null;
  try {
    await callLLM(mkProvider(portB), [{ role: 'user', content: 'тест' }], { op: 'ingest' });
  } catch (e) {
    err4 = e as Error;
  }
  const e4 = lastEntry();
  check(
    'молчаливый обрыв: причина + длительность',
    !!err4 && err4.message.includes('оборвалось через 2 с') && err4.message.includes('сервер закрыл запрос'),
    err4?.message
  );
  check('молчаливый обрыв: был автоповтор', e4?.attempts === 2, `attempts=${e4?.attempts}`);
  check('молчаливый обрыв: errorKind=dropped, HTTP —', e4?.errorKind === 'dropped' && e4?.status === undefined, `kind=${e4?.errorKind}`);

  // --- 5. SSE оборван посреди генерации ---
  llmDebugClear();
  let err5: Error | null = null;
  try {
    await callLLM(mkProvider(portD), [{ role: 'user', content: 'тест' }], { op: 'ingest' });
  } catch (e) {
    err5 = e as Error;
  }
  const e5 = lastEntry();
  check('обрыв потока: ясное сообщение с числом символов', !!err5 && /Поток ответа оборван.*получено \d+ симв/.test(err5.message), err5?.message);
  check('обрыв потока: частичный текст в журнале', (e5?.content.length ?? 0) === INGEST_JSON.length, `len=${e5?.content.length}`);
  check('обрыв потока: сырой SSE в журнале', (e5?.rawResponse ?? '').startsWith('data:'), e5?.rawResponse.slice(0, 40));

  // --- 6. тайм-аут без ответа сервера ---
  llmDebugClear();
  let err6: Error | null = null;
  try {
    await callLLM(mkProvider(portF), [{ role: 'user', content: 'тест' }], { op: 'ingest', timeoutMs: 1200 });
  } catch (e) {
    err6 = e as Error;
  }
  const e6 = lastEntry();
  check('тайм-аут: ясное сообщение', !!err6 && err6.message.startsWith('Тайм-аут: ответ не получен за'), err6?.message);
  check('тайм-аут: без автоповтора (attempts=1)', e6?.attempts === 1, `attempts=${e6?.attempts}`);
  check('тайм-аут: errorKind=timeout', e6?.errorKind === 'timeout', String(e6?.errorKind));

  // --- 7. 500 → автоповтор → успех ---
  llmDebugClear();
  const r7 = await callLLM(mkProvider(portE), [{ role: 'user', content: 'тест' }], { op: 'ingest' });
  const e7 = lastEntry();
  check('5xx: автоповтор привёл к успеху', JSON.parse(r7.content).atoms.length === 1 && e7?.attempts === 2, `attempts=${e7?.attempts}`);

  for (const s of servers) s.close();
  console.log(failed === 0 ? '\nALL PASS' : `\nFAILED: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('TEST CRASH:', e);
  process.exit(1);
});
