'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Check,
  Copy,
  Download,
  Loader2,
  Moon,
  Pencil,
  Plug,
  Plus,
  ScrollText,
  Share2,
  Sun,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { exportAll, importAll, resetMaterialProgress, getMeta, setMeta } from '@/lib/db';
import { isNativePlatform } from '@/lib/nativeHttp';
import {
  llmDebugClear,
  llmDebugSnapshot,
  llmDebugSubscribe,
  testProvider,
  type LLMLogEntry,
} from '@/lib/llm-client';
import { useAppStore, type Theme } from '@/store/useAppStore';
import { PROVIDER_PRESETS, type LLMProvider, type ProviderType } from '@/lib/types';

/** Платформенная среда неизменна за сессию — подписка не нужна */
const subscribeNoop = () => () => {};

export default function SettingsPanel() {
  const providers = useAppStore((s) => s.providers);
  const addProvider = useAppStore((s) => s.addProvider);
  const updateProvider = useAppStore((s) => s.updateProvider);
  const deleteProvider = useAppStore((s) => s.deleteProvider);
  const activateProvider = useAppStore((s) => s.activateProvider);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);

  const [dlgOpen, setDlgOpen] = useState(false);
  // id провайдера в диалоге редактирования (null = добавление нового)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pType, setPType] = useState<ProviderType>('openrouter');
  const [pName, setPName] = useState('');
  const [pUrl, setPUrl] = useState(PROVIDER_PRESETS.openrouter.baseUrl);
  const [pModel, setPModel] = useState(PROVIDER_PRESETS.openrouter.model);
  const [pKey, setPKey] = useState('');
  // id провайдера, у которого прямо сейчас идёт проверка соединения
  const [testingId, setTestingId] = useState<string | null>(null);

  const fileRef = useRef<HTMLInputElement>(null);

  // «Поделиться» доступно только в нативной среде (Android/Capacitor).
  // useSyncExternalStore: false на сервере/в статике, реальное значение — на клиенте,
  // без setState в эффекте и без расхождения гидратации
  const isNative = useSyncExternalStore(
    subscribeNoop,
    isNativePlatform,
    () => false
  );

  const [importing, setImporting] = useState(false);

  // настройки OCR (фото → текст через vision-модель)
  const [ocrProviderId, setOcrProviderId] = useState('');
  const [ocrModel, setOcrModel] = useState('');
  useEffect(() => {
    void getMeta('ocrProviderId').then((v) => v && setOcrProviderId(v));
    void getMeta('ocrModel').then((v) => v && setOcrModel(v));
  }, []);

  const applyPreset = (t: ProviderType) => {
    setPType(t);
    setPUrl(PROVIDER_PRESETS[t].baseUrl);
    setPModel(PROVIDER_PRESETS[t].model);
  };

  const openAdd = () => {
    setEditingId(null);
    applyPreset('openrouter');
    setPName('');
    setPKey('');
  };

  const openEdit = (p: LLMProvider) => {
    setEditingId(p.id);
    setPType(p.type);
    setPName(p.name);
    setPUrl(p.baseUrl);
    setPModel(p.model);
    setPKey('');
    setDlgOpen(true);
  };

  const submitProvider = async () => {
    if (!pUrl.trim().startsWith('http')) {
      toast.error('Base URL должен начинаться с http(s)://');
      return;
    }
    if (!pModel.trim()) {
      toast.error('Укажи имя модели');
      return;
    }
    if (editingId) {
      // при редактировании пустой ключ означает «оставить прежний»
      const prev = providers.find((x) => x.id === editingId);
      await updateProvider(editingId, {
        name: pName.trim() || PROVIDER_PRESETS[pType].label,
        type: pType,
        baseUrl: pUrl.trim().replace(/\/+$/, ''),
        model: pModel.trim(),
        apiKey: pKey.trim() || prev?.apiKey || '',
      });
      toast.success('Провайдер обновлён');
    } else {
      await addProvider({
        name: pName.trim() || PROVIDER_PRESETS[pType].label,
        type: pType,
        baseUrl: pUrl.trim().replace(/\/+$/, ''),
        apiKey: pKey.trim(),
        model: pModel.trim(),
      });
      toast.success('Провайдер добавлен');
    }
    setDlgOpen(false);
    setEditingId(null);
    setPName('');
    setPKey('');
  };

  const runTest = async (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    setTestingId(id);
    try {
      const res = await testProvider(p);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
    } finally {
      setTestingId(null);
    }
  };

  const downloadBackup = (json: string, fname: string) => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fname;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Бэкап скачан');
  };

  const doExport = async () => {
    const json = await exportAll();
    const fname = `edu-game-backup-${new Date().toISOString().split('T')[0]}.json`;
    if (isNative) {
      try {
        // на Android — системное меню «Поделиться»: файл можно отправить
        // в мессенджер/почту и передать на другое устройство
        const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
        const { Share } = await import('@capacitor/share');
        const res = await Filesystem.writeFile({
          path: fname,
          data: json,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
        });
        await Share.share({ title: fname, files: [res.uri], dialogTitle: 'Отправить бэкап…' });
        toast.success('Бэкап сохранён во временный файл — отправь его себе в мессенджере');
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/cancel|отмен/i.test(msg)) return;
        toast.error(`Не удалось открыть меню «Поделиться» (${msg}) — скачиваю файл`);
      }
    }
    downloadBackup(json, fname);
  };

  const runImport = async (json: string, onDone?: () => void) => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await importAll(json);
      if (res.ok) toast.success(res.message);
      else toast.error(res.message);
      onDone?.();
    } finally {
      setImporting(false);
    }
  };

  const doImport = async (file: File) => {
    const text = await file.text();
    await runImport(text);
  };

  const logEntries = useSyncExternalStore(llmDebugSubscribe, llmDebugSnapshot);
  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(logEntries, null, 2));
      toast.success('Журнал скопирован в буфер обмена');
    } catch {
      toast.error('Не удалось скопировать — скачай бэкап или скопируй вручную из полей ниже');
    }
  };
  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtMsg = (m: LLMLogEntry['requestMessages'][number]) => `${m.role.toUpperCase()}:\n${m.content}`;

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-lg font-semibold">Настройки</h1>
      </header>

      {/* Провайдеры */}
      <section>
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="text-sm font-medium text-muted-foreground">LLM-провайдеры (OpenAI-совместимые)</h2>
          <Dialog open={dlgOpen} onOpenChange={setDlgOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="outline" onClick={openAdd}>
                <Plus className="mr-1 h-4 w-4" /> Добавить
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] overflow-y-auto thin-scroll">
              <DialogHeader>
                <DialogTitle>{editingId ? 'Редактирование провайдера' : 'Новый провайдер'}</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-3 pt-1">
                <div>
                  <Label className="mb-1.5 block">Тип</Label>
                  <Select value={pType} onValueChange={(v) => applyPreset(v as ProviderType)}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {Object.entries(PROVIDER_PRESETS).map(([k, v]) => (
                        <SelectItem key={k} value={k}>{v.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[11px] text-muted-foreground">{PROVIDER_PRESETS[pType].hint}</p>
                </div>
                <div>
                  <Label className="mb-1.5 block">Название</Label>
                  <Input value={pName} onChange={(e) => setPName(e.target.value)} placeholder="Моё имя провайдера" />
                </div>
                <div>
                  <Label className="mb-1.5 block">Base URL</Label>
                  <Input value={pUrl} onChange={(e) => setPUrl(e.target.value)} placeholder="https://…/v1" />
                </div>
                <div>
                  <Label className="mb-1.5 block">Модель</Label>
                  <Input value={pModel} onChange={(e) => setPModel(e.target.value)} placeholder="gpt-4o-mini" />
                </div>
                <div>
                  <Label className="mb-1.5 block">
                    API-ключ
                    {editingId
                      ? ' (оставь пустым, чтобы сохранить текущий)'
                      : PROVIDER_PRESETS[pType].needsKey
                        ? ''
                        : ' (не нужен)'}
                  </Label>
                  <Input value={pKey} onChange={(e) => setPKey(e.target.value)} type="password" placeholder="sk-…" />
                </div>
                <Button onClick={submitProvider}>{editingId ? 'Сохранить изменения' : 'Сохранить'}</Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {providers.length === 0 ? (
          <Card>
            <CardContent className="p-4 text-sm text-muted-foreground">
              Провайдеров нет. Без LLM работает демо-режим: автопроверка задач и локальный оценщик объяснений.
              Полноценная проверка фейнмана, «своих задач» и импорт материалов требуют модель.
            </CardContent>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {providers.map((p) => {
              const typeLabel = PROVIDER_PRESETS[p.type]?.label ?? p.type;
              return (
                <Card key={p.id} className={p.isActive ? 'border-primary/50' : ''}>
                  <CardContent className="p-4">
                    {/* имя + тип — на всю ширину, без зажатой правой колонки кнопок */}
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="min-w-0 truncate text-sm font-medium" title={p.name}>
                        {p.name}
                      </p>
                      <span className="shrink-0 truncate text-[11px] text-muted-foreground/80" title={typeLabel}>
                        {typeLabel}
                      </span>
                    </div>
                    {/* реквизиты — на всю ширину карточки; URL переносится, а не обрезается */}
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">{p.baseUrl}</p>
                    <p className="truncate text-xs text-muted-foreground" title={p.model}>
                      модель: <span className="font-mono">{p.model}</span>
                    </p>
                    {/* действия — отдельной строкой снизу: статус/выбор слева, иконки справа */}
                    <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-border/60 pt-2.5">
                      {p.isActive ? (
                        <Badge className="gap-1">
                          <Check className="h-3 w-3" /> активен
                        </Badge>
                      ) : (
                        <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => activateProvider(p.id)}>
                          Выбрать
                        </Button>
                      )}
                      <div className="-mr-1 flex shrink-0">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground"
                          onClick={() => runTest(p.id)}
                          disabled={testingId === p.id}
                          aria-label="Проверить соединение"
                          title="Проверить соединение"
                        >
                          {testingId === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground"
                          onClick={() => openEdit(p)}
                          aria-label="Редактировать"
                          title="Редактировать"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => deleteProvider(p.id)}
                          aria-label="Удалить"
                          title="Удалить"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </section>

      {/* Тема */}
      <section>
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Внешний вид</h2>
        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <span className="text-sm">Тема</span>
            <div className="flex gap-1">
              <Button size="sm" variant={theme === 'dark' ? 'default' : 'outline'} onClick={() => setTheme('dark' as Theme)}>
                <Moon className="mr-1 h-4 w-4" /> Тёмная
              </Button>
              <Button size="sm" variant={theme === 'light' ? 'default' : 'outline'} onClick={() => setTheme('light' as Theme)}>
                <Sun className="mr-1 h-4 w-4" /> Светлая
              </Button>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Данные */}
      <section className="pb-2">
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Данные (локальная база)</h2>
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Все данные хранятся локально (IndexedDB). Экспорт — один JSON-файл: материалы, карты, задачи, попытки,
              черновики, провайдеры. На телефоне файл открывается в системном меню «Поделиться» — отправь его себе в
              мессенджере, чтобы перенести на другое устройство. Импорт восстанавливает или объединяет данные.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={doExport} disabled={importing}>
                {isNative ? (
                  <>
                    <Share2 className="mr-1 h-4 w-4" /> Поделиться
                  </>
                ) : (
                  <>
                    <Download className="mr-1 h-4 w-4" /> Экспорт
                  </>
                )}
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => fileRef.current?.click()} disabled={importing}>
                <Upload className="mr-1 h-4 w-4" /> Из файла
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void doImport(f);
                  e.target.value = '';
                }}
              />
            </div>
            <Button
              variant="ghost"
              className="mt-1 text-muted-foreground hover:text-destructive"
              onClick={async () => {
                if (activeMaterialId) {
                  await resetMaterialProgress(activeMaterialId);
                  toast.success('Прогресс материала сброшен');
                }
              }}
            >
              Сбросить прогресс активного материала
            </Button>
          </CardContent>
        </Card>
      </section>
      {/* OCR с фото */}
      <section className="pb-2">
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">OCR с фото (распознавание рукописного)</h2>
        <Card>
          <CardContent className="flex flex-col gap-3 p-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Кнопка «Фото с решением» в узле отправляет снимок в vision-модель. По умолчанию используется активный
              провайдер и его модель; если модель не принимает изображения — выбери отдельного провайдера и/или
              укажи vision-модель (gpt-4o-mini, gemini-flash, qwen-vl-plus и т.п.).
            </p>
            <div>
              <Label className="mb-1.5 block">Провайдер для OCR</Label>
              <Select
                value={ocrProviderId || 'active'}
                onValueChange={(v) => {
                  const id = v === 'active' ? '' : v;
                  setOcrProviderId(id);
                  void setMeta('ocrProviderId', id);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Активный провайдер</SelectItem>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} ({p.model})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1.5 block">Модель для OCR (пусто = модель провайдера)</Label>
              <Input
                value={ocrModel}
                onChange={(e) => setOcrModel(e.target.value)}
                onBlur={() => void setMeta('ocrModel', ocrModel.trim())}
                placeholder="gpt-4o-mini"
              />
            </div>
          </CardContent>
        </Card>
      </section>
      {/* Журнал LLM (отладка) */}
      <section className="pb-2">
        <div className="mb-2 flex items-center justify-between px-1">
          <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <ScrollText className="h-4 w-4" /> Журнал LLM
            {logEntries.length > 0 && <Badge variant="secondary">{logEntries.length}</Badge>}
          </h2>
          <div className="flex gap-1">
            <Button size="sm" variant="outline" onClick={copyLog} disabled={logEntries.length === 0}>
              <Copy className="mr-1 h-3.5 w-3.5" /> Копировать всё
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={llmDebugClear}
              disabled={logEntries.length === 0}
              aria-label="Очистить журнал"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            {logEntries.length === 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                Пока пусто. Каждое обращение к LLM попадает сюда: промпт, сырой ответ, статус и время. Если видишь
                ошибку вроде «LLM вернул некорректный JSON» — открой последнюю запись и посмотри, что реально вернула
                модель.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {[...logEntries]
                  .reverse()
                  .slice(0, 20)
                  .map((e) => (
                    <details key={e.id} className="rounded-md border border-border/60">
                      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-2 text-xs">
                        <Badge variant={e.ok ? 'default' : 'destructive'} className="shrink-0">
                          {e.ok ? 'OK' : 'ошибка'}
                        </Badge>
                        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{fmtTime(e.ts)}</span>
                        <span className="shrink-0 font-medium">{e.op}</span>
                        <span className="truncate text-muted-foreground">
                          HTTP {e.status ?? '—'} · {e.durationMs} мс · попыток {e.attempts}
                        </span>
                      </summary>
                      <div className="flex flex-col gap-2 border-t border-border/60 px-2.5 py-2">
                        <p className="text-[11px] text-muted-foreground">
                          модель: <span className="font-mono">{e.model}</span>
                          {e.finishReason && (
                            <>
                              {' '}
                              · finish_reason: <span className="font-mono">{e.finishReason}</span>
                            </>
                          )}
                          {e.usage && (
                            <>
                              {' '}
                              · токены: <span className="font-mono">{e.usage.total_tokens}</span> (вопрос{' '}
                              <span className="font-mono">{e.usage.prompt_tokens}</span> / ответ{' '}
                              <span className="font-mono">{e.usage.completion_tokens}</span>)
                            </>
                          )}
                        </p>
                        {e.error && (
                          <p className="rounded bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">{e.error}</p>
                        )}
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-muted-foreground">Запрос (промпт)</p>
                          <pre className="max-h-40 overflow-y-auto thin-scroll whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-relaxed">
                            {e.requestMessages.map(fmtMsg).join('\n\n')}
                          </pre>
                        </div>
                        <div>
                          <p className="mb-1 text-[11px] font-medium text-muted-foreground">Ответ (сырой)</p>
                          <pre className="max-h-40 overflow-y-auto thin-scroll whitespace-pre-wrap break-words rounded bg-muted/50 p-2 text-[11px] leading-relaxed">
                            {e.rawResponse || '(пусто)'}
                          </pre>
                        </div>
                      </div>
                    </details>
                  ))}
                {logEntries.length > 20 && (
                  <p className="text-[11px] text-muted-foreground">Показаны последние 20 из {logEntries.length}.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
