'use client';

import { useRef, useState, useSyncExternalStore } from 'react';
import { Check, Copy, Download, Moon, Plug, Plus, ScrollText, Sun, Trash2, Upload } from 'lucide-react';
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
import { exportAll, importAll, resetMaterialProgress } from '@/lib/db';
import {
  llmDebugClear,
  llmDebugSnapshot,
  llmDebugSubscribe,
  testProvider,
  type LLMLogEntry,
} from '@/lib/llm-client';
import { useAppStore, type Theme } from '@/store/useAppStore';
import { PROVIDER_PRESETS, type ProviderType } from '@/lib/types';

export default function SettingsPanel() {
  const providers = useAppStore((s) => s.providers);
  const addProvider = useAppStore((s) => s.addProvider);
  const deleteProvider = useAppStore((s) => s.deleteProvider);
  const activateProvider = useAppStore((s) => s.activateProvider);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);

  const [dlgOpen, setDlgOpen] = useState(false);
  const [pType, setPType] = useState<ProviderType>('openrouter');
  const [pName, setPName] = useState('');
  const [pUrl, setPUrl] = useState(PROVIDER_PRESETS.openrouter.baseUrl);
  const [pModel, setPModel] = useState(PROVIDER_PRESETS.openrouter.model);
  const [pKey, setPKey] = useState('');
  const [testing, setTesting] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const applyPreset = (t: ProviderType) => {
    setPType(t);
    setPUrl(PROVIDER_PRESETS[t].baseUrl);
    setPModel(PROVIDER_PRESETS[t].model);
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
    await addProvider({
      name: pName.trim() || PROVIDER_PRESETS[pType].label,
      type: pType,
      baseUrl: pUrl.trim().replace(/\/+$/, ''),
      apiKey: pKey.trim(),
      model: pModel.trim(),
    });
    toast.success('Провайдер добавлен');
    setDlgOpen(false);
    setPName('');
    setPKey('');
  };

  const runTest = async (id: string) => {
    const p = providers.find((x) => x.id === id);
    if (!p) return;
    setTesting(true);
    const res = await testProvider(p);
    setTesting(false);
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
  };

  const doExport = async () => {
    const json = await exportAll();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `edu-game-backup-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Бэкап скачан');
  };

  const doImport = async (file: File) => {
    const text = await file.text();
    const res = await importAll(text);
    if (res.ok) toast.success(res.message);
    else toast.error(res.message);
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
              <Button size="sm" variant="outline">
                <Plus className="mr-1 h-4 w-4" /> Добавить
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] overflow-y-auto thin-scroll">
              <DialogHeader>
                <DialogTitle>Новый провайдер</DialogTitle>
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
                  <Label className="mb-1.5 block">API-ключ {PROVIDER_PRESETS[pType].needsKey ? '' : '(не нужен)'}</Label>
                  <Input value={pKey} onChange={(e) => setPKey(e.target.value)} type="password" placeholder="sk-…" />
                </div>
                <Button onClick={submitProvider}>Сохранить</Button>
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
            {providers.map((p) => (
              <Card key={p.id} className={p.isActive ? 'border-primary/50' : ''}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {p.name}
                        {p.isActive && <Badge className="gap-1"><Check className="h-3 w-3" /> активен</Badge>}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{p.baseUrl}</p>
                      <p className="text-xs text-muted-foreground">модель: {p.model}</p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {!p.isActive && (
                        <Button size="sm" variant="outline" onClick={() => activateProvider(p.id)}>
                          Выбрать
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground" onClick={() => runTest(p.id)} disabled={testing} aria-label="Проверить">
                        <Plug className="h-4 w-4" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => deleteProvider(p.id)} aria-label="Удалить">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
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
              Все данные хранятся локально (IndexedDB). Экспорт — один JSON-файл: материалы, карта, задачи, попытки,
              провайдеры. Импорт восстанавливает или объединяет.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={doExport}>
                <Download className="mr-1 h-4 w-4" /> Экспорт
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => fileRef.current?.click()}>
                <Upload className="mr-1 h-4 w-4" /> Импорт
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".json"
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
