/**
 * Генератор фикстуры для tests/text-sim.test.ts: берёт РЕАЛЬНЫЕ пары
 * «эссе ↔ фейнмановский вопрос» из экспортированного курса матанализа,
 * считает containment зеркалом src/lib/text-sim.ts и выбирает пары
 * (3 дубликата — верх списка, 2 недубликата — из середины/низа).
 * Результат: tests/fixtures/essay-pairs.json
 *
 * Запуск: node scripts/gen_sim_fixture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PATH = join(ROOT, 'upload', 'edu-game-course-matanfull-nikitin-ezhik-2026-10-08.json');

const MIN_WORD_LEN = 3;
const tokens = (s) => {
  const out = new Set();
  for (const w of s.toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/)) {
    if (w.length >= MIN_WORD_LEN) out.add(w);
  }
  return out;
};
const containment = (a, b) => {
  const wa = tokens(a);
  const wb = tokens(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  let hit = 0;
  for (const w of small) if (big.has(w)) hit++;
  return hit / small.size;
};

const payload = JSON.parse(readFileSync(PATH, 'utf-8'));
const nodes = new Map(payload.nodes.map((n) => [n.id, n]));
const rows = [];
for (const t of payload.tasks) {
  if (t.type !== 'essay') continue;
  const node = nodes.get(t.nodeId);
  if (!node?.feynmanQuestion) continue;
  rows.push({
    essay: t.prompt,
    feynman: node.feynmanQuestion,
    title: node.title,
    sim: containment(t.prompt, node.feynmanQuestion),
  });
}
rows.sort((a, b) => b.sim - a.sim);

// 3 дубликата (верх) + 2 недубликата (0.53 и 0.40 — ниже порога 0.55, но не случайные)
const chosenTrue = rows.slice(0, 3);
const notDup = [rows.find((r) => r.sim < 0.55 && r.sim >= 0.45), rows.find((r) => r.sim < 0.45)];
const fixture = {
  source: 'edu-game-course-matanfull-nikitin-ezhik-2026-10-08',
  threshold: 0.55,
  pairs: [
    ...chosenTrue.map((r) => ({ ...r, expect: true })),
    ...notDup.filter(Boolean).map((r) => ({ ...r, expect: false })),
  ],
};

const outDir = join(ROOT, 'tests', 'fixtures');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'essay-pairs.json'), JSON.stringify(fixture, null, 2) + '\n');
console.log('Фикстура записана. Пары:');
for (const p of fixture.pairs) console.log(`  ${p.sim.toFixed(2)} expect=${p.expect} «${p.title}»`);
