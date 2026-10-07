/**
 * Сохранить JSON-файл: на Android — системное меню «Поделиться»
 * (файл во временном кэше + Share), в браузере — обычное скачивание.
 * Один механизм и для полного бэкапа (Настройки), и для экспорта
 * курса (Карты) — поведение одинаковое в обеих средах.
 */
import { isNativePlatform } from './nativeHttp';

export type SaveFileResult =
  | 'shared' // отправлено через системное меню «Поделиться»
  | 'downloaded' // скачано файлом (браузер или фолбэк после сбоя Share)
  | 'cancelled'; // пользователь закрыл меню «Поделиться» без отправки

export async function saveJsonFile(
  json: string,
  fname: string,
  dialogTitle: string
): Promise<SaveFileResult> {
  if (isNativePlatform()) {
    try {
      const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const res = await Filesystem.writeFile({
        path: fname,
        data: json,
        directory: Directory.Cache,
        encoding: Encoding.UTF8,
      });
      await Share.share({ title: fname, files: [res.uri], dialogTitle });
      return 'shared';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/cancel|отмен/i.test(msg)) return 'cancelled';
      // не смогли открыть меню «Поделиться» — падаем на скачивание файла
    }
  }
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fname;
  a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
