'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Страница «не найдено» (в статической сборке становится 404.html).
 *
 * Зачем это важно для Android: если WebView по какой-то причине оказался
 * на несуществующем пути (сбой рендерера, восстановление после убийства
 * процесса, файловый пикер), Capacitor отдаёт именно эту страницу.
 * Авто-возврат в корень «самозалечивает» приложение вместо пустого экрана.
 */
export default function NotFound() {
  useEffect(() => {
    const t = setTimeout(() => {
      window.location.replace('/');
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <p className="text-4xl font-bold text-primary">404</p>
      <p className="text-sm text-muted-foreground">
        Страница не найдена. Возвращаюсь в приложение…
      </p>
      <Button onClick={() => window.location.replace('/')}>Открыть приложение</Button>
    </div>
  );
}
