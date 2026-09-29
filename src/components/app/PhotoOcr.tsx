'use client';

/**
 * ФотоOcr — кнопка «Фото с решением»: снимок с камеры (или галереи) →
 * ОБЯЗАТЕЛЬНОЕ выделение области с решением → OCR через LLM (vision) →
 * вставка распознанного текста в целевое поле.
 *
 * - Нативная среда (APK): @capacitor/camera (системный выбор «Камера/Галерея»).
 * - Браузер: <input type="file" capture="environment"> (на телефоне открывает камеру).
 * - Выделение области: рамка перетаскиванием по фото или за угловые маркеры
 *   (мышь и тач, pointer events + touch-action: none).
 *
 * Режимы: 'full' — весь текст решения (для объяснений), 'short' — только
 * итоговый ответ (для поля ответа задачи).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Camera as CameraIcon, Loader2, ScanText } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { isNativePlatform } from '@/lib/nativeHttp';
import { getMeta } from '@/lib/db';
import { ocrHandwritten } from '@/lib/llm-ops';
import { useAppStore } from '@/store/useAppStore';
import type { LLMProvider } from '@/lib/types';
import { cn } from '@/lib/utils';

interface Rect {
  x: number; // % от ширины фото
  y: number;
  w: number;
  h: number;
}

const DEFAULT_RECT: Rect = { x: 8, y: 8, w: 84, h: 84 };
const CORNERS = ['nw', 'ne', 'sw', 'se'] as const;

const CORNER_POS: Record<(typeof CORNERS)[number], { left: string; top: string }> = {
  nw: { left: '-8px', top: '-8px' },
  ne: { left: 'calc(100% - 8px)', top: '-8px' },
  sw: { left: '-8px', top: 'calc(100% - 8px)' },
  se: { left: 'calc(100% - 8px)', top: 'calc(100% - 8px)' },
};

export default function PhotoOcr({
  mode,
  onInsert,
  label,
  disabled,
  className,
}: {
  mode: 'full' | 'short';
  onInsert: (text: string) => void;
  /** Пустая строка — кнопка-иконка без текста */
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const providers = useAppStore((s) => s.providers);
  const activeProvider = providers.find((p) => p.isActive) ?? null;

  const [open, setOpen] = useState(false);
  const [photo, setPhoto] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect>(DEFAULT_RECT);
  const [busy, setBusy] = useState(false);
  // переопределение провайдера/модели для OCR из настроек
  const [ocrProviderId, setOcrProviderId] = useState('');
  const [ocrModel, setOcrModel] = useState('');

  const imgRef = useRef<HTMLImageElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    orig: Rect;
    mode: 'draw' | 'resize';
    corner?: (typeof CORNERS)[number];
  } | null>(null);

  useEffect(() => {
    void getMeta('ocrProviderId').then((v) => v && setOcrProviderId(v));
    void getMeta('ocrModel').then((v) => v && setOcrModel(v));
  }, []);

  const provider: LLMProvider | null = useMemo(() => {
    const base = (ocrProviderId && providers.find((p) => p.id === ocrProviderId)) || activeProvider;
    if (!base) return null;
    return ocrModel.trim() ? { ...base, model: ocrModel.trim() } : base;
  }, [ocrProviderId, ocrModel, providers, activeProvider]);

  const startCapture = async () => {
    if (isNativePlatform()) {
      try {
        const photo = await Camera.getPhoto({
          quality: 85,
          width: 2000,
          correctOrientation: true,
          resultType: CameraResultType.DataUrl,
          source: CameraSource.Prompt, // «Камера / Галерея»
        });
        setPhoto(photo.dataUrl ?? null);
        setRect(DEFAULT_RECT);
        setOpen(true);
      } catch {
        // пользователь отменил съёмку — не ошибка
      }
    } else {
      fileRef.current?.click();
    }
  };

  const onFilePicked = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setPhoto(typeof reader.result === 'string' ? reader.result : null);
      setRect(DEFAULT_RECT);
      setOpen(true);
    };
    reader.readAsDataURL(file);
  };

  // --- рамка выделения (pointer events: мышь + тач) ---

  const pointPct = (clientX: number, clientY: number) => {
    const box = containerRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    return {
      x: Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100)),
      y: Math.min(100, Math.max(0, ((clientY - box.top) / box.height) * 100)),
    };
  };

  const normRect = (x1: number, y1: number, x2: number, y2: number): Rect => {
    const x = Math.min(x1, x2);
    const y = Math.min(y1, y2);
    const w = Math.max(2, Math.abs(x2 - x1));
    const h = Math.max(2, Math.abs(y2 - y1));
    return { x, y, w: Math.min(w, 100 - x), h: Math.min(h, 100 - y) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (busy) return;
    const p = pointPct(e.clientX, e.clientY);
    dragRef.current = { startX: p.x, startY: p.y, orig: rect, mode: 'draw' };
    setRect({ x: p.x, y: p.y, w: 2, h: 2 });
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onHandleDown = (corner: (typeof CORNERS)[number]) => (e: React.PointerEvent) => {
    if (busy) return;
    e.stopPropagation();
    dragRef.current = { startX: 0, startY: 0, orig: rect, mode: 'resize', corner };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = pointPct(e.clientX, e.clientY);
    if (drag.mode === 'draw') {
      setRect(normRect(drag.startX, drag.startY, p.x, p.y));
      return;
    }
    // resize за угол
    const o = drag.orig;
    let x1 = o.x;
    let y1 = o.y;
    let x2 = o.x + o.w;
    let y2 = o.y + o.h;
    const c = drag.corner ?? 'se';
    if (c.includes('w')) x1 = p.x;
    if (c.includes('e')) x2 = p.x;
    if (c.includes('n')) y1 = p.y;
    if (c.includes('s')) y2 = p.y;
    setRect(normRect(x1, y1, x2, y2));
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  // --- кроп + OCR ---

  const cropAndRecognize = async () => {
    if (!photo || busy) return;
    if (!provider) {
      toast.error('OCR требует LLM-провайдера с vision-моделью (Настройки → OCR)');
      return;
    }
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return;

    const sx = Math.round((rect.x / 100) * img.naturalWidth);
    const sy = Math.round((rect.y / 100) * img.naturalHeight);
    const sw = Math.max(8, Math.round((rect.w / 100) * img.naturalWidth));
    const sh = Math.max(8, Math.round((rect.h / 100) * img.naturalHeight));

    setBusy(true);
    try {
      // кроп на canvas в натуральном разрешении
      const canvas = document.createElement('canvas');
      canvas.width = sw;
      canvas.height = sh;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas недоступен');
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
      const cropped = canvas.toDataURL('image/jpeg', 0.9);

      const text = await ocrHandwritten(provider, cropped, mode);
      if (!text) throw new Error('Модель вернула пустой ответ — попробуй другую vision-модель');
      onInsert(text);
      toast.success(mode === 'short' ? 'Ответ распознан и вставлен' : 'Текст распознан и вставлен');
      setOpen(false);
      setPhoto(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось распознать текст');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={label === '' ? 'icon' : 'sm'}
        className={cn(label === '' && 'h-10 w-10 shrink-0 text-muted-foreground', className)}
        onClick={() => void startCapture()}
        disabled={disabled || busy}
        title="Сфотографировать письменное решение"
        aria-label="Сфотографировать письменное решение"
      >
        <CameraIcon className={label === '' ? 'h-4 w-4' : 'mr-1 h-4 w-4'} />
        {label === '' ? null : label ?? 'Фото с решением'}
      </Button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFilePicked(f);
          e.target.value = '';
        }}
      />

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-h-[92dvh] max-w-[94vw] overflow-y-auto thin-scroll">
          <DialogHeader>
            <DialogTitle>Выдели область с решением</DialogTitle>
          </DialogHeader>

          {photo && (
            <div
              ref={containerRef}
              className={cn('relative touch-none select-none', busy && 'pointer-events-none opacity-70')}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <img
                ref={imgRef}
                src={photo}
                alt="Фото решения"
                draggable={false}
                className="pointer-events-none block max-h-[55dvh] w-full rounded-lg object-contain"
              />
              {/* затемнение вне рамки + сама рамка */}
              <div
                className="absolute border-2 border-emerald-400"
                style={{
                  left: `${rect.x}%`,
                  top: `${rect.y}%`,
                  width: `${rect.w}%`,
                  height: `${rect.h}%`,
                  boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
                }}
              >
                {CORNERS.map((c) => (
                  <span
                    key={c}
                    onPointerDown={onHandleDown(c)}
                    className="absolute h-5 w-5 rounded-sm border-2 border-emerald-200 bg-emerald-400/40"
                    style={CORNER_POS[c]}
                  />
                ))}
              </div>
            </div>
          )}

          <p className="text-xs leading-relaxed text-muted-foreground">
            Проведи пальцем по фото, чтобы нарисовать рамку заново, или тяни за угловые маркеры. В кадр должно
            попасть только решение — так модель распознает точнее.
          </p>

          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => void startCapture()}
              disabled={busy}
            >
              Другое фото
            </Button>
            <Button className="flex-1" onClick={() => void cropAndRecognize()} disabled={busy}>
              {busy ? (
                <>
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" /> Распознаю…
                </>
              ) : (
                <>
                  <ScanText className="mr-1 h-4 w-4" /> Распознать
                </>
              )}
            </Button>
          </div>
          {!provider && (
            <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
              LLM-провайдер не найден: OCR работает через vision-модель. Добавь провайдера в настройках и укажи
              модель, принимающую изображения.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
