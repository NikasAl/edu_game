import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'ru.nikasal.edugame',
  appName: 'Edu Game',
  webDir: 'out',
  server: {
    androidScheme: 'https',
    // при любой ошибке локального сервера (в т.ч. 404 после сбоя WebView)
    // грузим index.html вместо системной «Page not found» — приложение
    // самовосстанавливается, а не показывает пустой экран
    errorPath: 'index.html',
  },
  android: {
    backgroundColor: '#16211c',
  },
};

export default config;
