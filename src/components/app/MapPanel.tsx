'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Lock,
  Map as MapIcon,
  Search,
  TriangleAlert,
  Waypoints,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { useMapStats } from '@/hooks/useMapStats';
import { childrenOf, getPathToRoot } from '@/lib/maps';
import { enrichGraph } from '@/lib/graph-db';
import { buildMapView, navOrder, type RegionShell } from '@/lib/map-view';
import { COL_W, LAYER_H, layoutGraph } from '@/lib/progress';
import {
  NODE_STATUS_META,
  type IdeaEdge,
  type IdeaNode,
  type NodeState,
  type Region,
} from '@/lib/types';

const REGION_COLORS = ['#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

/** Ниже этого зума узлы превращаются в кружки (обзор большой карты) */
const LOD_ZOOM = 0.6;
/** Зум «в фокусе»: узел читается целиком */
const FOCUS_ZOOM = 0.95;
/** Центр узла относительно его позиции (левый верхний угол) */
const NODE_CENTER_X = COL_W / 2;
const NODE_CENTER_Y = 48;

type GameNodeData = {
  title: string;
  status: NodeState['status'];
  risky: boolean;
  trialsDone: number;
  regionColor: string;
  isNext: boolean;
  missingHardTitles: string[];
  compact: boolean;
};

function GameMapNode({ data }: { data: GameNodeData }) {
  const meta = NODE_STATUS_META[data.status];

  // Дальняя обзорка: узел-кружок (раскладка не меняется, рёбра на месте)
  if (data.compact) {
    return (
      <div
        className={`map-node flex h-9 w-9 items-center justify-center rounded-full border-2 bg-card shadow-lg ${meta.ring} ${
          data.isNext ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
        }`}
      >
        <Handle
          type="target"
          position={Position.Top}
          className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
          isConnectable={false}
        />
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: data.regionColor }} />
        <Handle
          type="source"
          position={Position.Bottom}
          className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
          isConnectable={false}
        />
      </div>
    );
  }

  return (
    <div
      className={`map-node w-[210px] rounded-xl border-2 bg-card px-3 py-2.5 shadow-lg ${meta.ring} ${
        data.isNext ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
      }`}
    >
      {/* якоря рёбер: невидимы, но без них React Flow не отрисовывает связи */}
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
      <div className="flex items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: data.regionColor }} />
        <span className={`text-[10px] font-medium uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
        {data.risky && <TriangleAlert className="ml-auto h-3.5 w-3.5 text-amber-400" />}
        {data.status === 'locked' && <Lock className="ml-auto h-3.5 w-3.5 text-rose-400" />}
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug">{data.title}</p>
      <div className="mt-1.5 flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`h-1.5 w-5 rounded-full ${
              i < data.trialsDone ? 'bg-emerald-400' : 'bg-muted-foreground/30'
            }`}
          />
        ))}
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
    </div>
  );
}

type RegionShellData = {
  title: string;
  mastered: number;
  total: number;
  color: string;
};

/** Узел-оболочка свёрнутого региона: прогресс раздела, клик — развернуть */
function MapRegionShellNode({ data }: { data: RegionShellData }) {
  const percent = data.total > 0 ? Math.round((data.mastered / data.total) * 100) : 0;
  return (
    <div
      className="map-node w-[210px] cursor-pointer rounded-xl border-2 bg-card px-3 py-2.5 shadow-lg transition-shadow hover:shadow-xl"
      style={{ borderColor: data.color }}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
      <div className="flex items-center gap-1.5">
        <ChevronRight className="h-3.5 w-3.5" style={{ color: data.color }} />
        <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: data.color }}>
          Раздел
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug">{data.title}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <Progress value={percent} className="h-1.5 flex-1" />
        <span className="text-[10px] text-muted-foreground">
          {data.mastered}/{data.total}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
    </div>
  );
}

type PortalNodeData = {
  title: string;
  mastered: number;
  total: number;
  subMaps: number;
};

/** Узел-портал: вход в дочернюю карту */
function MapPortalNode({ data }: { data: PortalNodeData }) {
  const percent = data.total > 0 ? Math.round((data.mastered / data.total) * 100) : 0;
  return (
    <div className="map-node w-[210px] cursor-pointer rounded-xl border-2 border-violet-400/60 bg-violet-500/10 px-3 py-2.5 shadow-lg transition-shadow hover:shadow-violet-500/20">
      <Handle
        type="target"
        position={Position.Top}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
      <div className="flex items-center gap-1.5">
        <MapIcon className="h-3.5 w-3.5 text-violet-300" />
        <span className="text-[10px] font-medium uppercase tracking-wide text-violet-300">
          Карта{data.subMaps > 0 ? ` +${data.subMaps}` : ''}
        </span>
      </div>
      <p className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug">{data.title}</p>
      <div className="mt-1.5 flex items-center gap-2">
        <Progress value={percent} className="h-1.5 flex-1" />
        <span className="text-[10px] text-muted-foreground">
          {data.mastered}/{data.total}
        </span>
      </div>
      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-1.5 !w-1.5 !border-0 !bg-transparent !opacity-0"
        isConnectable={false}
      />
    </div>
  );
}

const nodeTypes = { game: GameMapNode, region: MapRegionShellNode, portal: MapPortalNode };

/** Свёрнутые регионы живут, пока открыто приложение (переключение вкладок не сбрасывает) */
const collapsedCache = new Map<string, Set<string>>();

export default function MapPanel() {
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  if (!activeMaterialId) {
    return <p className="pt-8 text-center text-sm text-muted-foreground">Загрузка…</p>;
  }
  // key по карте: смена материала перемонтирует панель и сбрасывает
  // локальное состояние (поиск, навигация, LOD); свёртка регионов
  // переживает переключения в collapsedCache
  return <MapPanelInner key={activeMaterialId} materialId={activeMaterialId} />;
}

function MapPanelInner({ materialId }: { materialId: string }) {
  const setActiveMaterialId = useAppStore((s) => s.setActiveMaterialId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const openNode = useAppStore((s) => s.openNode);
  const theme = useAppStore((s) => s.theme);
  const providers = useAppStore((s) => s.providers);
  const data = useMaterialData(materialId);
  const { ready: statsReady, materials, stats } = useMapStats();
  const rfRef = useRef<ReactFlowInstance | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildMsg, setBuildMsg] = useState<string | null>(null);
  const [collapsedRegions, setCollapsedRegions] = useState<Set<string>>(
    () => collapsedCache.get(materialId) ?? new Set()
  );
  const [listOpen, setListOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [compact, setCompact] = useState(false);
  const [navIdx, setNavIdx] = useState(0);
  const activeProvider = providers.find((p) => p.isActive) ?? null;

  const dataRef = useRef<typeof data | null>(null);
  useEffect(() => {
    dataRef.current = data;
  });
  const programmaticRef = useRef(false); // камера двигается кодом (не считать за взаимодействие)
  const interactedRef = useRef(false); // пользователь уже двигал карту

  const toggleRegion = useCallback(
    (regionId: string) => {
      if (!materialId) return;
      setCollapsedRegions((prev) => {
        const next = new Set(prev);
        if (next.has(regionId)) next.delete(regionId);
        else next.add(regionId);
        collapsedCache.set(materialId, next);
        return next;
      });
    },
    [materialId]
  );

  const regionColor = useMemo(
    () =>
      new Map<string, string>(
        data.regions.map((r, i): [string, string] => [r.id, REGION_COLORS[i % REGION_COLORS.length]])
      ),
    [data.regions]
  );
  const regionCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of data.nodes) m.set(n.regionId, (m.get(n.regionId) ?? 0) + 1);
    return m;
  }, [data.nodes]);

  /** Вид карты: свёртка регионов + перестроенные рёбра (чистая логика в lib/map-view) */
  const view = useMemo(
    () =>
      data.ready
        ? buildMapView(data.nodes, data.edges, data.regions, collapsedRegions, data.states)
        : null,
    [data, collapsedRegions]
  );

  const { nodes: rfNodes, edges: rfEdges, positions } = useMemo(() => {
    if (!view) return { nodes: [] as RFNode[], edges: [] as RFEdge[], positions: new Map<string, { x: number; y: number }>() };
    const positions =
      view.layoutNodes.length > 0
        ? layoutGraph(
            view.layoutNodes as IdeaNode[],
            view.layoutEdges as unknown as IdeaEdge[],
            data.regions as Region[]
          )
        : new Map<string, { x: number; y: number }>();
    const shellById = new Map<string, RegionShell>(view.shells.map((s): [string, RegionShell] => [s.id, s]));
    const titleById = new Map<string, string>(data.nodes.map((n): [string, string] => [n.id, n.title]));

    const rfNodes: RFNode[] = view.layoutNodes.map((n: IdeaNode) => {
      const shell = shellById.get(n.id);
      if (shell) {
        return {
          id: shell.id,
          type: 'region',
          position: positions.get(shell.id) ?? { x: 0, y: 0 },
          data: {
            title: shell.title,
            mastered: shell.mastered,
            total: shell.total,
            color: regionColor.get(shell.regionId) ?? REGION_COLORS[0],
          } satisfies RegionShellData,
        };
      }
      const st = data.states.get(n.id)!;
      return {
        id: n.id,
        type: 'game',
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        data: {
          title: n.title,
          status: st.status,
          risky: st.risky,
          trialsDone: st.trialsDone,
          regionColor: regionColor.get(n.regionId) ?? REGION_COLORS[0],
          isNext: data.nextNode?.id === n.id && st.status !== 'mastered',
          missingHardTitles: st.missingHard.map((id) => titleById.get(id) ?? '—'),
          compact,
        } satisfies GameNodeData,
      };
    });

    // порталы дочерних карт — отдельный нижний слой
    const maxY = rfNodes.length > 0 ? Math.max(...rfNodes.map((n) => n.position.y)) : -LAYER_H;
    const childMapsList = childrenOf(materials ?? [], materialId ?? null);
    childMapsList.forEach((c, i) => {
      const st = stats.get(c.id);
      rfNodes.push({
        id: `portal-${c.id}`,
        type: 'portal',
        position: {
          x: (i - (childMapsList.length - 1) / 2) * COL_W,
          y: maxY + LAYER_H,
        },
        data: {
          title: c.title,
          mastered: st?.subtreeMastered ?? 0,
          total: st?.subtreeAtoms ?? 0,
          subMaps: st?.subtreeMaps ?? 0,
        } satisfies PortalNodeData,
      });
    });

    const rfEdges: RFEdge[] = view.layoutEdges.map((e) => ({
      id: `${e.fromNodeId}=>${e.toNodeId}`,
      source: e.fromNodeId,
      target: e.toNodeId,
      animated: false,
      style: {
        stroke: e.kind === 'hard' ? 'oklch(0.72 0.16 162 / 0.5)' : 'oklch(0.71 0.012 155 / 0.35)',
        strokeWidth: e.kind === 'hard' ? 2 : 1.2,
        strokeDasharray: e.kind === 'hard' ? undefined : '6 4',
      },
    }));

    return { nodes: rfNodes, edges: rfEdges, positions };
  }, [view, data, materials, materialId, stats, regionColor, compact]);

  const shellIds = useMemo(() => new Set(view?.shells.map((s) => s.id) ?? []), [view]);

  // Порядок навигации: атомы в «читательском» порядке раскладки (сверху вниз, слева направо)
  const navList = useMemo(() => {
    if (!view || positions.size === 0) return [] as string[];
    return navOrder(
      positions,
      view.layoutNodes.filter((n) => !shellIds.has(n.id)).map((n) => n.id)
    );
  }, [view, positions, shellIds]);
  const navListRef = useRef(navList);
  useEffect(() => {
    navListRef.current = navList;
  });
  const navIdxRef = useRef(0);

  const positionsRef = useRef<Map<string, { x: number; y: number }> | null>(null);
  useEffect(() => {
    positionsRef.current = positions;
  });

  const focusNode = useCallback((id: string, opts?: { zoom?: number; duration?: number }) => {
    const pos = positionsRef.current?.get(id);
    if (!pos || !rfRef.current) return;
    const duration = opts?.duration ?? 400;
    programmaticRef.current = true;
    void rfRef.current.setCenter(pos.x + NODE_CENTER_X, pos.y + NODE_CENTER_Y, {
      zoom: opts?.zoom ?? FOCUS_ZOOM,
      duration,
    });
    window.setTimeout(() => {
      programmaticRef.current = false;
    }, duration + 120);
  }, []);

  /** Прыжок к узлу по индексу (с циклизацией) — стрелки и список */
  const jumpTo = useCallback(
    (idx: number, focus = true) => {
      const list = navListRef.current;
      if (list.length === 0) return;
      const i = ((idx % list.length) + list.length) % list.length;
      navIdxRef.current = i;
      setNavIdx(i);
      if (focus) focusNode(list[i], { zoom: FOCUS_ZOOM, duration: 350 });
    },
    [focusNode]
  );

  /** ИИ-проход графа: достроить связи между идеями карты */
  const runGraphPass = useCallback(async () => {
    if (!materialId || building) return;
    if (!activeProvider) {
      toast.error('LLM-провайдер не подключён — настрой его во вкладке «Настройки»');
      return;
    }
    if (data.nodes.length < 2) {
      toast.info('Для построения связей нужно хотя бы две идеи');
      return;
    }
    setBuilding(true);
    // Прогресс — пилюлей внизу карты (не тостом: тот перекрывает шапку, процесс долгий)
    setBuildMsg(`ИИ-проход графа: ищу связи между ${data.nodes.length} идеями…`);
    try {
      const r = await enrichGraph(activeProvider, materialId, { onProgress: setBuildMsg });
      if (r.added === 0 && r.upgraded === 0) {
        toast.info('Новых связей не нашлось — граф уже полон');
      } else {
        toast.success(
          `Граф дополнен: +${r.added} связей${r.upgraded > 0 ? `, ${r.upgraded} стали обязательными (hard)` : ''}`
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось достроить связи графа');
    } finally {
      setBuilding(false);
      setBuildMsg(null);
    }
  }, [materialId, activeProvider, building, data.nodes.length]);

  /**
   * При открытии карты камера встаёт на текущий узел (золотой путь) —
   * он в фокусе и читается. Пока пользователь сам не подвигал карту,
   * повторяем через паузу (React Flow доизмеряет узлы асинхронно).
   */
  useEffect(() => {
    if (!data.ready) return;
    interactedRef.current = false;
    const timers = [250, 900].map((ms) =>
      setTimeout(() => {
        if (interactedRef.current) return;
        const d = dataRef.current;
        if (!d) return;
        const candidates = [d.nextNode?.id, d.nodes[0]?.id].filter(Boolean) as string[];
        const target = candidates.find((id) => positionsRef.current?.has(id));
        if (target) {
          focusNode(target, { zoom: FOCUS_ZOOM, duration: 600 });
          const idx = navListRef.current.indexOf(target);
          if (idx >= 0) {
            navIdxRef.current = idx;
            setNavIdx(idx);
          }
        } else if (d.nodes.length > 0) {
          programmaticRef.current = true;
          void rfRef.current?.fitView({ padding: 0.12, maxZoom: 0.95 });
          window.setTimeout(() => {
            programmaticRef.current = false;
          }, 700);
        }
      }, ms)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [materialId, data.ready, focusNode]);

  const path = useMemo(
    () => (statsReady ? getPathToRoot(materials ?? [], materialId) : []),
    [statsReady, materials, materialId]
  );
  const current = path.length > 0 ? path[path.length - 1] : null;
  const ancestors = path.slice(0, -1);

  const onNodeClick = useCallback(
    (_: unknown, node: RFNode) => {
      if (node.type === 'portal') {
        const d = node.data as PortalNodeData;
        setActiveTab('map'); // закрывает открытый узел, остаёмся на карте
        void setActiveMaterialId(node.id.replace(/^portal-/, ''));
        toast(`Входим: «${d.title}»`);
        return;
      }
      if (node.type === 'region') {
        toggleRegion(node.id.replace(/^region-/, ''));
        return;
      }
      const idx = navListRef.current.indexOf(node.id);
      if (idx >= 0) jumpTo(idx, false);
      const d = node.data as GameNodeData;
      if (d.status === 'locked') {
        toast('Узел закрыт', {
          description: `Сначала освой: ${d.missingHardTitles.join(' · ') || 'предыдущие идеи'}`,
        });
        return;
      }
      openNode(node.id);
    },
    [jumpTo, openNode, setActiveMaterialId, setActiveTab, toggleRegion]
  );

  // Строки бокового списка: поиск по названию/формулировке/терминам, книжный порядок
  const regionOrder = useMemo(
    () => new Map<string, number>(data.regions.map((r, i): [string, number] => [r.id, i])),
    [data.regions]
  );
  const listRows = useMemo(() => {
    if (!data.ready) return [] as IdeaNode[];
    const q = query.trim().toLowerCase();
    return data.nodes
      .filter(
        (n) =>
          !q ||
          n.title.toLowerCase().includes(q) ||
          n.formulation.toLowerCase().includes(q) ||
          n.keyTerms.some((t) => t.toLowerCase().includes(q))
      )
      .sort(
        (a, b) =>
          (regionOrder.get(a.regionId) ?? 99) - (regionOrder.get(b.regionId) ?? 99) ||
          a.orderIndex - b.orderIndex
      );
  }, [data, query, regionOrder]);

  if (!data.ready || !statsReady) {
    return <p className="pt-8 text-center text-sm text-muted-foreground">Загрузка…</p>;
  }

  const { regions } = data;
  const hasContent = rfNodes.length > 0;

  return (
    <div
      className="flex flex-col gap-2"
      style={{ height: 'calc(100dvh - 95px - env(safe-area-inset-bottom))' }}
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-lg font-semibold">
            {current?.title ?? 'Карта знаний'}
          </h1>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant={listOpen ? 'secondary' : 'outline'}
              size="icon"
              className="size-8"
              onClick={() => setListOpen((v) => !v)}
              title="Список узлов и поиск"
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void runGraphPass()}
              disabled={building || !activeProvider || data.nodes.length < 2}
              title={
                !activeProvider
                  ? 'Нужен LLM-провайдер (Настройки)'
                  : 'LLM достроит недостающие связи между идеями карты (существующие сохранятся)'
              }
            >
              {building ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Waypoints className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Достроить связи</span>
            </Button>
          </div>
        </div>
        {/* Хлебные крошки: путь от корневой карты */}
        {ancestors.length > 0 && (
          <nav className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground" aria-label="Путь по картам">
            {ancestors.map((m) => (
              <span key={m.id} className="flex items-center gap-0.5">
                <button
                  onClick={() => void setActiveMaterialId(m.id)}
                  className="max-w-[160px] truncate hover:text-primary hover:underline"
                >
                  {m.title}
                </button>
                <ChevronRight className="h-3 w-3 shrink-0" />
              </span>
            ))}
          </nav>
        )}
      </header>

      {/* Легенда регионов: клик сворачивает/разворачивает раздел */}
      {regions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {regions.map((r, i) => {
            const isCollapsed = collapsedRegions.has(r.id);
            const count = regionCounts.get(r.id) ?? 0;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => toggleRegion(r.id)}
                disabled={count === 0}
                title={
                  count === 0
                    ? 'В разделе нет идей'
                    : isCollapsed
                      ? 'Развернуть раздел'
                      : 'Свернуть раздел в узел с прогрессом'
                }
                className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] text-muted-foreground transition-colors ${
                  count === 0 ? 'bg-muted/40 opacity-60' : 'bg-muted/70 hover:bg-muted'
                }`}
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: REGION_COLORS[i % REGION_COLORS.length] }}
                />
                {r.title}
                <span className="text-[10px] opacity-70">{count}</span>
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${isCollapsed ? '-rotate-90' : ''}`}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* Карта */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card/40">
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <p>Карта пуста. Импортируй материал или создай подраздел во вкладке «Карты».</p>
          </div>
        ) : (
          <ReactFlow
            key={materialId ?? 'none'}
            colorMode={theme}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onInit={(inst) => {
              rfRef.current = inst;
            }}
            onMoveStart={() => {
              if (!programmaticRef.current) interactedRef.current = true;
            }}
            onMove={(_, vp) => {
              const next = vp.zoom < LOD_ZOOM;
              setCompact((prev) => (prev === next ? prev : next));
            }}
            minZoom={0.25}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            nodesConnectable={false}
            elementsSelectable={false}
            nodesDraggable={false}
          >
            <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="oklch(0.45 0.03 160 / 0.35)" />
            <Controls showInteractive={false} position="bottom-right" />

            {/* Навигация по узлам: предыдущий / счётчик / следующий */}
            <Panel position="bottom-left">
              <div className="flex items-center gap-0.5 rounded-full border border-border bg-card/95 p-1 shadow-lg">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => jumpTo(navIdxRef.current - 1)}
                  disabled={navList.length < 2}
                  title="Предыдущий узел"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="min-w-[44px] text-center text-[11px] tabular-nums text-muted-foreground">
                  {navList.length > 0 ? `${Math.min(navIdx, navList.length - 1) + 1}/${navList.length}` : '—'}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => jumpTo(navIdxRef.current + 1)}
                  disabled={navList.length < 2}
                  title="Следующий узел"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </Panel>

            {/* Прогресс долгого ИИ-прохода графа — пилюлей внизу, не перекрывает навигацию */}
            {building && (
              <Panel position="bottom-center">
                <div className="flex items-center gap-2 rounded-full border border-border bg-card/95 px-4 py-2 text-xs shadow-lg">
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
                  <span className="max-w-[60vw] truncate">{buildMsg}</span>
                </div>
              </Panel>
            )}

            {/* Боковой список узлов с поиском */}
            <Panel position="top-left">
              {listOpen && (
                <div className="flex max-h-[70vh] w-72 flex-col overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl">
                  <div className="flex items-center gap-2 border-b border-border p-2">
                    <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Поиск по идеям…"
                      className="h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        setListOpen(false);
                        setQuery('');
                      }}
                      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Закрыть"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-1">
                    {listRows.map((n) => {
                      const st = data.states.get(n.id);
                      const meta = st ? NODE_STATUS_META[st.status] : null;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => {
                            const idx = navListRef.current.indexOf(n.id);
                            if (idx >= 0) jumpTo(idx);
                            setListOpen(false);
                            setQuery('');
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted/60"
                        >
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: regionColor.get(n.regionId) ?? REGION_COLORS[0] }}
                          />
                          <span className="min-w-0 flex-1 truncate text-xs">{n.title}</span>
                          {meta && <span className={`shrink-0 text-[10px] ${meta.color}`}>{meta.label}</span>}
                        </button>
                      );
                    })}
                    {listRows.length === 0 && (
                      <p className="p-3 text-xs text-muted-foreground">Ничего не найдено</p>
                    )}
                  </div>
                </div>
              )}
            </Panel>
          </ReactFlow>
        )}
      </div>

      {/* Легенда статусов */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-400" /> освоен</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-amber-400" /> в работе</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-emerald-500/60" /> доступен</span>
        <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-full bg-rose-400" /> закрыт</span>
        <span className="flex items-center gap-1"><TriangleAlert className="h-3 w-3 text-amber-400" /> рискованно</span>
        <span className="flex items-center gap-1"><MapIcon className="h-3 w-3 text-violet-300" /> вход в карту</span>
      </div>

    </div>
  );
}
