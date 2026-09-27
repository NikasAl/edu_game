import type { NextConfig } from "next";

// output: "export" — статическая сборка в out/ для Capacitor (Android APK).
// API-роуты не используются: приложение локально-first, LLM вызывается
// напрямую с клиента (в браузере — fetch, в APK — native HTTP без CORS).
const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
