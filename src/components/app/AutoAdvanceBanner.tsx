'use client';

/**
 * Баннер автоперехода между фазами импорта.
 *
 * Пауза между фазами (выбор разделов → разбор на атомы → генерация задач) нужна,
 * только если пользователь хочет что-то поправить. Если правки не нужны — ждать
 * действий скучно: через AUTO_ADVANCE_MS баннер сам продолжает процесс.
 *
 * Отмена: любое взаимодействие со страницей — прокрутка, тап, свайп, ввод с
 * клавиатуры — останавливает отсчёт, и пользователь продолжается вручную
 * (кнопки фазы остаются на месте). Взаимодействия внутри самого баннера
 * (его кнопки) отменой не считаются — у них свои обработчики.
 */
import { useEffect, useRef, useState } from 'react';
import { Timer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

/** Сколько ждать перед автопереходом к следующей фазе */
export const AUTO_ADVANCE_MS = 60_000;

type Status = 'running' | 'stopped' | 'done';

/**
 * @param nextLabel  куда перейдём — для строки «перейду к …» (форма слова целиком в пропсе)
 * @param onAdvance  продолжить сейчас; вернуть false, если продолжить нельзя
 *                   (например, валидация не прошла) — тогда отсчёт останавливается
 */
export default function AutoAdvanceBanner({
  nextLabel,
  onAdvance,
  ms = AUTO_ADVANCE_MS,
}: {
  nextLabel: string;
  onAdvance: () => boolean;
  ms?: number;
}) {
  const [remaining, setRemaining] = useState(Math.ceil(ms / 1000));
  const [status, setStatus] = useState<Status>('running');
  const bannerRef = useRef<HTMLDivElement | null>(null);
  // onAdvance в ref: таймер и слушатели переживают рендеры без перезапуска;
  // синхронизация в effect после каждого рендера (запись в ref в рендере запрещена)
  const advanceRef = useRef(onAdvance);
  useEffect(() => {
    advanceRef.current = onAdvance;
  });
  // одноразовость перехода/отмены: защит от двойного вызова onAdvance
  // (гонка tick/cancel, повторный тап по кнопке)
  const settledRef = useRef(false);

  useEffect(() => {
    if (status !== 'running') return;
    settledRef.current = false;

    const deadline = Date.now() + ms;
    // первые полсекунды игнорируем взаимодействия: на смене фазы мобильные
    // браузеры могут восстановить позицию прокрутки и создать ложный scroll
    const mountedAt = Date.now();
    let timer: ReturnType<typeof setInterval> | null = null;

    const settle = (kind: Status) => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (timer) clearInterval(timer);
      timer = null;
      setStatus(kind);
    };

    const tick = () => {
      const left = Math.ceil((deadline - Date.now()) / 1000);
      if (left <= 0) {
        let ok = false;
        try {
          ok = advanceRef.current() !== false;
        } catch {
          ok = false; // ошибка продолжения — стоп, пользователь действует кнопками фазы
        }
        settle(ok ? 'done' : 'stopped');
        return;
      }
      setRemaining(left);
    };

    const cancel = (e: Event) => {
      const el = bannerRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return; // свои кнопки — не отмена
      if (Date.now() - mountedAt < 500) return;
      settle('stopped');
    };

    // scroll не всплывает, но ловится на фазе захвата — так видно прокрутку
    // и страницы, и внутренних скролл-областей (предпросмотр разделов и т.п.)
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    window.addEventListener('scroll', cancel, opts);
    window.addEventListener('wheel', cancel, opts);
    window.addEventListener('touchmove', cancel, opts);
    window.addEventListener('pointerdown', cancel, opts);
    window.addEventListener('keydown', cancel);
    timer = setInterval(tick, 250);
    tick();

    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener('scroll', cancel, opts);
      window.removeEventListener('wheel', cancel, opts);
      window.removeEventListener('touchmove', cancel, opts);
      window.removeEventListener('pointerdown', cancel, opts);
      window.removeEventListener('keydown', cancel);
    };
  }, [ms, status]);

  if (status !== 'running') return null;

  const pct = Math.max(0, Math.min(100, (remaining / (ms / 1000)) * 100));

  const advanceNow = () => {
    if (settledRef.current) return;
    let ok = false;
    try {
      ok = advanceRef.current() !== false;
    } catch {
      ok = false;
    }
    settledRef.current = true;
    setStatus(ok ? 'done' : 'stopped');
  };

  return (
    <div
      ref={bannerRef}
      role="status"
      aria-live="polite"
      className="sticky top-0 z-20 -mx-4 mb-1 px-4 pt-1"
    >
      <div className="flex flex-col gap-1.5 rounded-xl border border-primary/30 bg-background/95 p-2.5 shadow-sm backdrop-blur">
        <p className="flex items-center gap-2 text-xs leading-snug text-muted-foreground">
          <Timer className="h-4 w-4 shrink-0 text-primary" />
          <span>
            Правки не нужны? Через{' '}
            <span className="font-semibold text-foreground">{remaining} с</span> перейду к{' '}
            {nextLabel}. Любая прокрутка или правка отменяет отсчёт.
          </span>
        </p>
        <Progress value={pct} className="h-1" />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 flex-1"
            onClick={() => {
              settledRef.current = true;
              setStatus('stopped');
            }}
          >
            Править вручную
          </Button>
          <Button size="sm" className="h-7 flex-1" onClick={advanceNow}>
            Продолжить сейчас
          </Button>
        </div>
      </div>
    </div>
  );
}
