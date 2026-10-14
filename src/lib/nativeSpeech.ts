/**
 * Обёртка над собственным нативным плагином ContinuousSpeech (Android).
 *
 * Плагин живёт в android/app/src/main/java/ru/nikasal/edugame/ContinuousSpeechPlugin.java
 * и держит ОДНУ непрерывную сессию распознавания: пауза на раздумье до 12/30 сек
 * не завершает её (extras тишины), а при завершении плагин сам открывает новую
 * сессию внутри Java — без круга через JS-мост, окно выключенного микрофона
 * минимально. Системный попап Google не показывается: индикатор записи —
 * пульсирующая кнопка и живая подсказка в интерфейсе.
 *
 * События:
 * - partial {text} — кумулятивный черновой текст текущей сессии (пересматривается);
 * - final {text} — завершённый текст сессии (или догон последнего partial,
 *   если сессия кончилась без финала) — дописывать в поле;
 * - fatal {code, message} — плагин сдался (нет микрофона/сервиса) — сессию
 *   пора закрыть и показать пользователю сообщение.
 *
 * Модуль импортируется динамически и только в нативной среде; на веб-сборке
 * registerPlugin лишь создаёт прокси, методы не вызываются.
 */
import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

export interface ContinuousSpeechPlugin {
  start(options?: {
    /** Язык распознавания (BCP-47), по умолчанию ru-RU */
    lang?: string;
    /** Полный порог тишины до завершения сессии, мс (30 000) */
    completeSilenceMillis?: number;
    /** Порог «возможно закончил» — даёт финал и догон текста, мс (12 000) */
    possibleSilenceMillis?: number;
    /** Приглушать системные сигналы микрофона на переходах (по умолчанию да) */
    muteSounds?: boolean;
  }): Promise<void>;
  stop(): Promise<void>;
  isListening(): Promise<{ listening: boolean }>;
  addListener(
    eventName: 'partial',
    listenerFunc: (data: { text: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'final',
    listenerFunc: (data: { text: string }) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'fatal',
    listenerFunc: (data: { code: string; message?: string }) => void
  ): Promise<PluginListenerHandle>;
}

export const ContinuousSpeech = registerPlugin<ContinuousSpeechPlugin>('ContinuousSpeech');
