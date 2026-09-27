'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ArrowRight, BookOpen, Sparkles, TriangleAlert, Trophy } from 'lucide-react';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { getMeta, setMeta } from '@/lib/db';
import { useEffect, useState } from 'react';
import type { IdeaNode } from '@/lib/types';

export default function HomePanel() {
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const openNode = useAppStore((s) => s.openNode);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const data = useMaterialData(activeMaterialId);
  const [lastNodeId, setLastNodeId] = useState<string | null>(null);

  useEffect(() => {
    void getMeta('lastNodeId').then(setLastNodeId);
  }, [data.ready]);

  if (!data.ready) {
    return <p className="pt-8 text-center text-sm text-muted-foreground">Загрузка…</p>;
  }

  const { nodes, material, states, nextNode } = data;
  const total = nodes.length;
  const mastered = nodes.filter((n) => states.get(n.id)?.status === 'mastered').length;
  const percent = total > 0 ? Math.round((mastered / total) * 100) : 0;

  const resumeNode =
    nodes.find((n) => n.id === lastNodeId && states.get(n.id)?.status !== 'mastered') ?? nextNode;

  const lastVisit = lastNodeId ? nodes.find((n) => n.id === lastNodeId) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* Шапка материала */}
      <header className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/15">
          <BookOpen className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">{material?.title ?? 'Нет материала'}</h1>
          <p className="text-xs text-muted-foreground">
            {mastered} из {total} идей освоено · {percent}%
          </p>
        </div>
      </header>

      {/* Общий прогресс */}
      <Card>
        <CardContent className="p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
            <span>Прогресс по материалу</span>
            <span className="font-medium text-foreground">{percent}%</span>
          </div>
          <Progress value={percent} className="h-2" />
          <div className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-muted/60 p-2">
              <p className="text-base font-semibold text-emerald-400">{mastered}</p>
              <p className="text-[11px] text-muted-foreground">освоено</p>
            </div>
            <div className="rounded-lg bg-muted/60 p-2">
              <p className="text-base font-semibold text-amber-400">
                {nodes.filter((n) => states.get(n.id)?.status === 'in_progress').length}
              </p>
              <p className="text-[11px] text-muted-foreground">в работе</p>
            </div>
            <div className="rounded-lg bg-muted/60 p-2">
              <p className="text-base font-semibold text-rose-400">
                {nodes.filter((n) => states.get(n.id)?.status === 'locked').length}
              </p>
              <p className="text-[11px] text-muted-foreground">закрыто</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Продолжить / Текущая цель */}
      {resumeNode ? (
        <Card className="border-primary/40 bg-primary/5">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-primary">
              <Sparkles className="h-4 w-4" />
              {lastVisit && lastVisit.id === resumeNode.id ? 'Возвращаемся к месту, где остановились' : 'Текущая цель'}
            </div>
            <ResumeCard node={resumeNode} risky={states.get(resumeNode.id)?.risky ?? false} />
            <Button className="w-full" onClick={() => openNode(resumeNode.id)}>
              Продолжить обучение
              <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      ) : total > 0 && mastered === total ? (
        <Card className="border-emerald-500/40 bg-emerald-500/5">
          <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
            <Trophy className="h-10 w-10 text-emerald-400" />
            <p className="font-semibold">Материал пройден полностью!</p>
            <p className="text-sm text-muted-foreground">
              Все {total} идей освоены. Загрузи новый материал во вкладке «Импорт».
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">
            Нет доступных узлов. Загрузи материал во вкладке «Импорт».
          </CardContent>
        </Card>
      )}

      {/* Регионы: сводка */}
      <section aria-label="Регионы карты">
        <h2 className="mb-2 px-1 text-sm font-medium text-muted-foreground">Регионы карты</h2>
        <div className="flex flex-col gap-2">
          {data.regions.map((region) => {
            const regionNodes = nodes.filter((n) => n.regionId === region.id);
            const regionMastered = regionNodes.filter((n) => states.get(n.id)?.status === 'mastered').length;
            const percentR = regionNodes.length > 0 ? Math.round((regionMastered / regionNodes.length) * 100) : 0;
            return (
              <button
                key={region.id}
                onClick={() => setActiveTab('map')}
                className="flex items-center justify-between rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary/40"
              >
                <div>
                  <p className="text-sm font-medium">{region.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {regionMastered}/{regionNodes.length} идей
                  </p>
                </div>
                <Badge variant={percentR === 100 ? 'default' : 'secondary'} className="shrink-0">
                  {percentR}%
                </Badge>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ResumeCard({ node, risky }: { node: IdeaNode; risky: boolean }) {
  return (
    <div>
      <p className="font-medium leading-snug">{node.title}</p>
      <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{node.formulation}</p>
      {risky && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-400">
          <TriangleAlert className="h-3.5 w-3.5" />
          Не все смежные идеи освоены — возможно, будет сложновато
        </p>
      )}
    </div>
  );
}

void setMeta;
