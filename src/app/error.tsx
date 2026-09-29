'use client';

import { useEffect } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Локальный error-boundary страницы: любая ошибка рендера больше не
 * оставляет пустой экран — предлагаем перезагрузку приложения.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error('Ошибка интерфейса:', error);
  }, [error]);

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <p className="text-lg font-semibold">Что-то сломалось</p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {error.message || 'Неизвестная ошибка интерфейса.'}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>
          Попробовать снова
        </Button>
        <Button onClick={() => window.location.replace('/')}>Перезагрузить приложение</Button>
      </div>
    </div>
  );
}
