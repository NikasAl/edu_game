'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronRight, Lock, Map as MapIcon, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Progress } from '@/components/ui/progress';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { useMapStats } from '@/hooks/useMapStats';
import { childrenOf, getPathToRoot } from '@/lib/maps';
import { COL_W, LAYER_H, layoutGraph } from '@/lib/progress';
import { NODE_STATUS_META, type IdeaNode, type NodeState, type Region } from '@/lib/types';

const REGION_COLORS = ['#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#f87171'];

type GameNodeData = {
  title: string;
  status: NodeState['status'];
  risky: boolean;
  trialsDone: number;
  regionColor: string;
  isNext: boolean;
  missingHardTitles: string[];
};

function GameMapNode({ data }: { data: GameNodeData }) {
  const meta = NODE_STATUS_META[data.status];
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

const nodeTypes = { game: GameMapNode, portal: MapPortalNode };

export default function MapPanel() {
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const setActiveMaterialId = useAppStore((s) => s.setActiveMaterialId);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const openNode = useAppStore((s) => s.openNode);
  const theme = useAppStore((s) => s.theme);
  const data = useMaterialData(activeMaterialId);
  const { ready: statsReady, materials, stats } = useMapStats();
  const rfRef = useRef<ReactFlowInstance | null>(null);

  const path = useMemo(
    () => (statsReady ? getPathToRoot(materials, activeMaterialId) : []),
    [statsReady, materials, activeMaterialId]
  );
  const current = path.length > 0 ? path[path.length - 1] : null;
  const ancestors = path.slice(0, -1);
  const childMaps = useMemo(
    () => (statsReady && activeMaterialId ? childrenOf(materials, activeMaterialId) : []),
    [statsReady, materials, activeMaterialId]
  );

  const { nodes: rfNodes, edges: rfEdges } = useMemo(() => {
    if (!data.ready) return { nodes: [] as RFNode[], edges: [] as RFEdge[] };
    const positions =
      data.nodes.length > 0 ? layoutGraph(data.nodes, data.edges, data.regions as Region[]) : new Map();
    const regionColor = new Map<string, string>();
    data.regions.forEach((r, i) => regionColor.set(r.id, REGION_COLORS[i % REGION_COLORS.length]));
    const titleById = new Map<string, string>(data.nodes.map((n) => [n.id, n.title]));

    const rfNodes: RFNode[] = data.nodes.map((n: IdeaNode) => {
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
        } satisfies GameNodeData,
      };
    });

    // порталы дочерних карт — отдельный нижний слой
    const maxY = rfNodes.length > 0 ? Math.max(...rfNodes.map((n) => n.position.y)) : -LAYER_H;
    childMaps.forEach((c, i) => {
      const st = stats.get(c.id);
      rfNodes.push({
        id: `portal-${c.id}`,
        type: 'portal',
        position: {
          x: (i - (childMaps.length - 1) / 2) * COL_W,
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

    const rfEdges: RFEdge[] = data.edges.map((e) => ({
      id: e.id,
      source: e.fromNodeId,
      target: e.toNodeId,
      animated: false,
      style: {
        stroke: e.kind === 'hard' ? 'oklch(0.72 0.16 162 / 0.5)' : 'oklch(0.71 0.012 155 / 0.35)',
        strokeWidth: e.kind === 'hard' ? 2 : 1.2,
        strokeDasharray: e.kind === 'hard' ? undefined : '6 4',
      },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [data, childMaps, stats]);

  const onNodeClick = useCallback(
    (_: unknown, node: RFNode) => {
      if (node.type === 'portal') {
        const d = node.data as PortalNodeData;
        setActiveTab('map'); // закрывает открытый узел, остаёмся на карте
        void setActiveMaterialId(node.id.replace(/^portal-/, ''));
        toast(`Входим: «${d.title}»`);
        return;
      }
      const d = node.data as GameNodeData;
      if (d.status === 'locked') {
        toast('Узел закрыт', {
          description: `Сначала освой: ${d.missingHardTitles.join(' · ') || 'предыдущие идеи'}`,
        });
        return;
      }
      openNode(node.id);
    },
    [openNode, setActiveMaterialId, setActiveTab]
  );

  // Подгонка масштаба под все узлы (вкл. порталы): RF измеряет узлы асинхронно,
  // поэтому несколько повторов после смены набора узлов/карты
  useEffect(() => {
    if (rfNodes.length === 0) return;
    const timers = [150, 500, 1200].map((ms) =>
      setTimeout(() => {
        void rfRef.current?.fitView({ padding: 0.12, maxZoom: 0.95 });
      }, ms)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [rfNodes.length, activeMaterialId]);

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

      {/* Легенда регионов */}
      {regions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {regions.map((r, i) => (
            <span
              key={r.id}
              className="flex items-center gap-1.5 rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              <span className="h-2 w-2 rounded-full" style={{ background: REGION_COLORS[i % REGION_COLORS.length] }} />
              {r.title}
            </span>
          ))}
        </div>
      )}

      {/* Карта */}
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card/40">
        {!hasContent ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <p>Карта пуста. Импортируй материал или создай подраздел во вкладке «Карты».</p>
          </div>
        ) : (
          <ReactFlow
            key={activeMaterialId ?? 'none'}
            colorMode={theme}
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onInit={(inst) => {
              rfRef.current = inst;
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
