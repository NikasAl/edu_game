'use client';

/**
 * Вкладка «Прогресс»: агрегированная статистика прохождения, активность
 * по дням и прогноз освоения. Область — все карты вместе или конкретная карта
 * (выбор сохраняется в localStorage).
 */
import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  Flame,
  ListChecks,
  Sparkles,
  Target,
  TriangleAlert,
  Trophy,
  WandSparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db } from '@/lib/db';
import { computeStats, type DayActivity } from '@/lib/stats';
import { useAppStore } from '@/store/useAppStore';
import type { Material } from '@/lib/types';

const SCOPES = [14, 28, 60] as const;
type ScopeDays = (typeof SCOPES)[number];

function loadStoredScope(): string {
  try {
    return localStorage.getItem('edu-stats-scope') || 'all';
  } catch {
    return 'all';
  }
}

/** Глубина карты в дереве (для отступа в селекторе) */
function depthOf(m: Material, byId: Map<string, Material>): number {
  let d = 0;
  let cur: Material | undefined = m;
  const seen = new Set<string>();
  while (cur?.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId);
    cur = byId.get(cur.parentId);
    d++;
    if (d > 10) break; // защита от циклов
  }
  return d;
}

export default function StatsPanel() {
  const difficulty = useAppStore((s) => s.difficulty);
  const [scope, setScope] = useState<string>(() => loadStoredScope());
  const [windowDays, setWindowDays] = useState<ScopeDays>(28);

  const bundle = useLiveQuery(async () => {
    const [materials, nodes, edges, tasks, attempts, regions] = await Promise.all([
      db.materials.toArray(),
      db.nodes.toArray(),
      db.edges.toArray(),
      db.tasks.toArray(),
      db.attempts.toArray(),
      db.regions.toArray(),
    ]);
    return { materials, nodes, edges, tasks, attempts, regions };
  }, []);

  const view = useMemo(() => {
    if (!bundle) return null;
    const { materials, regions, ...rest } = bundle;
    let filtered = { ...rest };
    let scopeRegions: typeof regions = [];
    let title = 'Все карты';
    if (scope !== 'all') {
      const ids = new Set([scope]);
      filtered = {
        nodes: rest.nodes.filter((x) => ids.has(x.materialId)),
        edges: rest.edges.filter((x) => ids.has(x.materialId)),
        tasks: rest.tasks.filter((x) => ids.has(x.materialId)),
        attempts: rest.attempts.filter((x) => ids.has(x.materialId)),
      };
      scopeRegions = regions.filter((r) => r.materialId === scope).sort((a, b) => a.orderIndex - b.orderIndex);
      title = materials.find((m) => m.id === scope)?.title ?? 'Карта';
    }
    const stats = computeStats({ ...filtered, regions: scopeRegions }, windowDays, new Date(), difficulty);
    const sortedMaterials = [...materials].sort(
      (a, b) =>
        depthOf(a, new Map(materials.map((m) => [m.id, m]))) - depthOf(b, new Map(materials.map((m) => [m.id, m]))) ||
        a.orderIndex - b.orderIndex ||
        a.createdAt.getTime() - b.createdAt.getTime()
    );
    return { stats, materials: sortedMaterials, title };
  }, [bundle, scope, windowDays, difficulty]);

  if (!bundle || !view) {
    return <p className="pt-8 text-center text-sm text-muted-foreground">Загрузка…</p>;
  }

  const { stats, materials, title } = view;
  const percent =
    stats.nodesMasterable > 0 ? Math.round((stats.nodesMastered / stats.nodesMasterable) * 100) : 0;
  const scopeLabel = scope === 'all' ? 'Все карты' : title;

  const changeScope = (v: string) => {
    setScope(v);
    try {
      localStorage.setItem('edu-stats-scope', v);
    } catch {
      /* приватный режим — просто не сохраняем */
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15">
          <BarChart3 className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold leading-tight">Прогресс</h1>
          <p className="text-xs text-muted-foreground">Статистика прохождения и прогноз освоения</p>
        </div>
      </header>

      {/* Область: все карты или конкретная */}
      <div className="flex items-center gap-2">
        <Select value={scope} onValueChange={changeScope}>
          <SelectTrigger className="h-9 min-w-0 flex-1" aria-label="Область статистики">
            <SelectValue placeholder="Область" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все карты вместе</SelectItem>
            {materials.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {'\u00A0'.repeat(depthOf(m, new Map(materials.map((x) => [x.id, x]))) * 2)}
                {m.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={String(windowDays)} onValueChange={(v) => setWindowDays(Number(v) as ScopeDays)}>
          <SelectTrigger className="h-9 w-[104px] shrink-0" aria-label="Окно графика">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d} дней
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <p className="-mt-2 text-xs text-muted-foreground">Область: {scopeLabel}</p>

      {stats.nodesTotal === 0 ? (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            Пока нет узлов. Импортируй материал во вкладке «Импорт» — и здесь появится статистика.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Прогресс освоения */}
          <Card>
            <CardContent className="p-4">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Освоено узлов</span>
                <span className="font-medium text-foreground">
                  {stats.nodesMastered} из {stats.nodesMasterable} · {percent}%
                </span>
              </div>
              <Progress value={percent} className="h-2" />
              <div className="mt-3 grid grid-cols-4 gap-2 text-center">
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-emerald-400">{stats.nodesMastered}</p>
                  <p className="text-[11px] text-muted-foreground">освоено</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-amber-400">{stats.nodesInProgress}</p>
                  <p className="text-[11px] text-muted-foreground">в работе</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-sky-400">{stats.nodesAvailable}</p>
                  <p className="text-[11px] text-muted-foreground">доступно</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-rose-400">{stats.nodesLocked}</p>
                  <p className="text-[11px] text-muted-foreground">закрыто</p>
                </div>
              </div>
              {stats.nodesWithoutTasks > 0 && (
                <p className="mt-3 flex items-start gap-1.5 text-xs text-amber-400">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {stats.nodesWithoutTasks} узл(ов) без задач не могут быть освоены — догенерируй задачи в
                  редакторе узла. Прогноз учитывает только {stats.nodesMasterable}.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Прогноз */}
          <ForecastCard stats={stats} title={scopeLabel} />

          {/* Активность по дням */}
          <DailyChart daily={stats.daily} windowDays={windowDays} />

          {/* Активность: факты */}
          <Card>
            <CardContent className="p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
                <Flame className="h-4 w-4 text-orange-400" />
                Активность
              </h2>
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold">{stats.attemptsTotal}</p>
                  <p className="text-[11px] text-muted-foreground">попыток</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-emerald-400">{Math.round(stats.accuracy * 100)}%</p>
                  <p className="text-[11px] text-muted-foreground">точность</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold">{stats.activeDays}</p>
                  <p className="text-[11px] text-muted-foreground">дней занятий</p>
                </div>
                <div className="rounded-lg bg-muted/60 p-2">
                  <p className="text-base font-semibold text-orange-400">{stats.streakDays}</p>
                  <p className="text-[11px] text-muted-foreground">серия (дней)</p>
                </div>
              </div>

              {/* Испытания */}
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <TrialRow label="Объяснения (Фейнман)" icon={<Sparkles className="h-4 w-4 text-violet-400" />} data={stats.trials.feynman} />
                <TrialRow label="Задачи" icon={<ListChecks className="h-4 w-4 text-sky-400" />} data={stats.trials.task} />
                <TrialRow label="Свои задачи" icon={<WandSparkles className="h-4 w-4 text-emerald-400" />} data={stats.trials.own} />
              </div>
            </CardContent>
          </Card>

          {/* Регионы — только для конкретной карты */}
          {scope !== 'all' && stats.regionProgress.length > 0 && (
            <section aria-label="Регионы карты">
              <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Регионы карты</h2>
              <div className="flex flex-col gap-2">
                {stats.regionProgress.map((r) => {
                  const pct = r.nodes > 0 ? Math.round((r.mastered / r.nodes) * 100) : 0;
                  return (
                    <div key={r.id} className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
                      <div>
                        <p className="text-sm font-medium">{r.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.mastered}/{r.nodes} идей
                        </p>
                      </div>
                      <Badge variant={pct === 100 && r.nodes > 0 ? 'default' : 'secondary'} className="shrink-0">
                        {pct}%
                      </Badge>
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function ForecastCard({ stats, title }: { stats: ReturnType<typeof computeStats>; title: string }) {
  const f = stats.forecast;
  const etaStr = (d: Date) =>
    new Intl.DateTimeFormat('ru-RU', {
      day: 'numeric',
      month: 'long',
      ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}),
    }).format(d);

  return (
    <Card className="border-primary/40 bg-primary/5">
      <CardContent className="flex flex-col gap-2 p-4">
        <h2 className="flex items-center gap-2 text-sm font-medium text-primary">
          <Target className="h-4 w-4" />
          Прогноз освоения
        </h2>

        {!f ? (
          <p className="text-sm text-muted-foreground">
            Прогноз появится, когда будет освоен хотя бы один узел: темп считается по последним 14 дням,
            а если в них пусто — в среднем за всё время.
          </p>
        ) : f.done ? (
          <div className="flex items-center gap-3 py-1">
            <Trophy className="h-8 w-8 shrink-0 text-emerald-400" />
            <div>
              <p className="font-semibold">{title} — освоено полностью!</p>
              <p className="text-xs text-muted-foreground">
                Все {stats.nodesMasterable} осваиваемых узлов закрыты. Импортируй новый материал, чтобы продолжить.
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <p className="text-xl font-semibold">
                ≈ {f.etaDate ? etaStr(f.etaDate) : '—'}
              </p>
              {f.etaDays !== null && (
                <Badge variant="secondary" className="shrink-0">
                  через {f.etaDays} {pluralDays(f.etaDays)}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Осталось {f.remaining} из {stats.nodesMasterable} узл(ов) · темп ~
              {formatPace(f.pacePerDay)} узла/день{' '}
              ({f.paceSource === 'recent' ? 'последние 14 дней' : 'в среднем за всё время'})
            </p>
            <p className="text-[11px] text-muted-foreground">
              Оценка по текущему темпу освоения узлов; при изменении ритма прогноз пересчитается сам.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DailyChart({ daily, windowDays }: { daily: DayActivity[]; windowDays: number }) {
  const max = Math.max(1, ...daily.map((d) => d.attempts));
  const labelStep = windowDays <= 28 ? 7 : 10;
  const totalAttempts = daily.reduce((s, d) => s + d.attempts, 0);
  const totalMastered = daily.reduce((s, d) => s + d.mastered, 0);

  return (
    <Card>
      <CardContent className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <CalendarDays className="h-4 w-4 text-sky-400" />
            Активность по дням
          </h2>
          <span className="text-xs text-muted-foreground">
            {windowDays} дн: {totalAttempts} попыток
            {totalMastered > 0 ? `, освоено ${totalMastered}` : ''}
          </span>
        </div>

        <div className="flex h-28 items-end gap-[2px]" role="img" aria-label="График активности по дням">
          {daily.map((d, i) => {
            const h = d.attempts > 0 ? Math.max(6, Math.round((d.attempts / max) * 100)) : 0;
            const showLabel = i % labelStep === 0 || i === daily.length - 1;
            return (
              <div
                key={d.dayKey}
                className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1"
                title={`${d.label}: ${d.attempts} попыток, ${d.passes} зачётов${d.mastered ? `, освоено ${d.mastered} узл.` : ''}`}
              >
                {d.mastered > 0 && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400"
                    title={`Освоено узлов: ${d.mastered}`}
                  />
                )}
                <div
                  className={`w-full rounded-t-[2px] ${d.attempts > 0 ? 'bg-primary/70' : 'bg-muted/40'}`}
                  style={{ height: `${d.attempts > 0 ? h : 2}px` }}
                />
                {showLabel && <span className="text-[9px] leading-none text-muted-foreground">{d.label}</span>}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          Столбик — попытки в день; зелёная точка — в этот день узел доведён до зачёта по всем испытаниям.
        </p>
      </CardContent>
    </Card>
  );
}

function TrialRow({ label, icon, data }: { label: string; icon: React.ReactNode; data: { attempts: number; passes: number } }) {
  const pct = data.attempts > 0 ? Math.round((data.passes / data.attempts) * 100) : null;
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-3 py-2">
      <span className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="truncate">{label}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {data.passes}/{data.attempts}
        {pct !== null ? ` · ${pct}%` : ''}
      </span>
    </div>
  );
}

function pluralDays(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'день';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'дня';
  return 'дней';
}

function formatPace(v: number): string {
  const s = v >= 10 ? Math.round(v).toString() : v.toFixed(1).replace('.', ',');
  return s;
}
