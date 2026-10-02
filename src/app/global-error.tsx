'use client';

/**
 * Глобальный error-boundary (ошибки на уровне layout). В статической
 * сборке рендерится со своими <html>/<body>, поэтому стили подключаем инлайном.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          background: '#16211c',
          color: '#e7efe9',
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: 24,
        }}
      >
        <p style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Приложение не смогло запуститься</p>
        <p style={{ fontSize: 14, opacity: 0.7, maxWidth: 420, margin: 0 }}>
          {error.message || 'Критическая ошибка интерфейса.'}
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={reset}
            style={{
              padding: '8px 16px',
              borderRadius: 10,
              border: '1px solid #4ade8066',
              background: 'transparent',
              color: '#e7efe9',
              fontSize: 14,
            }}
          >
            Повторить попытку
          </button>
          <button
            onClick={() => window.location.replace('/')}
            style={{
              padding: '8px 16px',
              borderRadius: 10,
              border: 'none',
              background: '#4ade80',
              color: '#10231a',
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Перезагрузить приложение
          </button>
        </div>
      </body>
    </html>
  );
}
