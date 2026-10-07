/**
 * Предустановленные курсы.
 *
 * Приложение при каждом запуске читает манифест /preinstalled/index.json
 * и устанавливает ещё не установленные комплекты курсов из /preinstalled/.
 * Каждый установленный комплект отмечается в meta по своему bundleId,
 * поэтому повторных копий не появляется, а после переустановки приложения
 * (пустая база) курс ставится снова — так курс доступен сразу после
 * новой установки.
 *
 * Как предустановить курс: экспортируй его на вкладке «Карты», положи файл
 * в public/preinstalled/ и обнови манифест (npm run gen:preinstall).
 * Файлы public/ попадают в APK — предустановленный курс работает офлайн.
 */
import { toast } from 'sonner';
import { getMeta, setMeta } from './db';
import { importCoursePayload, parseCoursePayload } from './course-bundle';

const MARKER_PREFIX = 'preinstalled:';

let running: Promise<void> | null = null;

/** Запустить авто-установку предустановленных курсов (однократно за сессию) */
export function importPreinstalledCourses(): Promise<void> {
  running ??= runPreinstall();
  return running;
}

async function runPreinstall(): Promise<void> {
  let manifest: { bundles?: { file?: unknown }[] };
  try {
    const res = await fetch('/preinstalled/index.json', { cache: 'no-store' });
    if (!res.ok) return; // манифеста нет — предустановленных курсов тоже
    manifest = await res.json();
  } catch {
    return; // нет ассетов/сети — тихо выходим, это нормальная ситуация
  }
  const bundles = Array.isArray(manifest?.bundles) ? manifest.bundles : [];
  for (const b of bundles) {
    const file = typeof b?.file === 'string' ? b.file : null;
    // только плоские имена файлов внутри /preinstalled/
    if (!file || file.includes('/') || file.includes('\\') || file.includes('..')) continue;
    try {
      const res = await fetch(`/preinstalled/${encodeURIComponent(file)}`, { cache: 'no-store' });
      if (!res.ok) continue;
      const payload = parseCoursePayload(await res.text());
      const marker = MARKER_PREFIX + payload.bundleId;
      if ((await getMeta(marker)) === 'done') continue; // уже установлен
      const r = await importCoursePayload(payload);
      await setMeta(marker, 'done');
      toast.success(`Предустановленный курс «${r.title}» добавлен`, {
        description: `Карт: ${r.materials}, идей: ${r.nodes}, задач: ${r.tasks}`,
      });
    } catch (e) {
      // повреждённый комплект не должен ломать запуск — пропускаем
      console.warn('preinstall: не удалось установить комплект', file, e);
    }
  }
}
