import type { Metadata, Viewport } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "Edu Game — учебник как игра",
  description:
    "Прототип: перекладывание учебников в игровой процесс — карта знаний, атомы идей, испытания Фейнмана, параметрические задачи, автопроверка и видимый прогресс.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#16211c",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" className="dark" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster position="top-center" richColors />
      </body>
    </html>
  );
}
