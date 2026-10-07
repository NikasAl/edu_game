import type { NextConfig } from "next";

// output: "export" — статическая сборка в out/ для Capacitor (Android APK).
// API-роуты не используются: приложение локально-first, LLM вызывается
// напрямую с клиента (в браузере — fetch, в APK — native HTTP без CORS).
const nextConfig: NextConfig = {
  output: "export",
  // Типы проверяются на сборке: tsconfig excludes не-проектные каталоги
  // (skills/, tools/, _staging/ и т.д.), поэтому tsc проходит чисто.
  reactStrictMode: false,
};

export default nextConfig;
