#!/usr/bin/env node
/**
 * Перегенерировать манифест предустановленных курсов:
 *   node tools/preinstall/gen-index.mjs   (или npm run gen:preinstall)
 *
 * Сканирует public/preinstalled/*.json (кроме самого index.json), читает из
 * каждого файла bundleId и название курса и пишет public/preinstalled/index.json.
 *
 * Как предустановить курс в приложение:
 *   1. Экспортируй курс на вкладке «Карты» (файл edu-game-course-*.json).
 *   2. Положи файл в public/preinstalled/.
 *   3. Запусти npm run gen:preinstall.
 *   4. Пересобери APK (npm run apk:debug) — при первом запуске приложения
 *      курс установится автоматически (без прогресса). Отметка об установке
 *      хранится в базе по bundleId: повторных копий не будет, а после
 *      переустановки приложения курс поставится снова.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const dir = join(process.cwd(), 'public', 'preinstalled');
const bundles = [];

let names = [];
try {
  names = readdirSync(dir).sort();
} catch {
  console.error(`Каталог ${dir} не найден — создай public/preinstalled/`);
  process.exit(1);
}

for (const name of names) {
  if (!name.endsWith('.json') || name === 'index.json') continue;
  try {
    const data = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (data?.app !== 'edu_game' || data?.kind !== 'course') {
      console.warn(`  ! ${name}: это не файл курса edu_game (kind: "course") — пропущен`);
      continue;
    }
    if (!data.bundleId || !Array.isArray(data.materials) || data.materials.length === 0) {
      console.warn(`  ! ${name}: повреждённый комплект (нет bundleId или карт) — пропущен`);
      continue;
    }
    bundles.push({ file: name, title: data.title ?? basename(name, '.json'), bundleId: data.bundleId });
    console.log(`  + ${name}: «${data.title}» (карт: ${data.materials.length}, идей: ${data.nodes?.length ?? 0})`);
  } catch {
    console.warn(`  ! ${name}: не читается как JSON — пропущен`);
  }
}

writeFileSync(join(dir, 'index.json'), JSON.stringify({ bundles }, null, 2) + '\n');
console.log(`\nindex.json обновлён: предустановленных курсов ${bundles.length}`);
