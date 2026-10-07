import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'url';

/**
 * Тесты покрывают чистую доменную логику lib/ — DOM не нужен.
 * Запуск: npm test (vitest run) / npm run test:watch.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
