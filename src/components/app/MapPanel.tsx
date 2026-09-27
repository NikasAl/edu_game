'use client';

import { useCallback, useMemo } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge as RFEdge,
  type Node as RFNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Lock, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAppStore } from '@/store/useAppStore';
import { useMaterialData } from '@/hooks/useMaterialData';
import { layoutGraph } from '@/lib/progress';
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
    </div>
  );
}

const nodeTypes = { game: GameMapNode };

export default function MapPanel() {
  const activeMaterialId = useAppStore((s) => s.activeMaterialId);
  const openNode = useAppStore((s) => s.openNode);
  const data = useMaterialData(activeMaterialId);

  const { nodes: rfNodes, edges: rfEdges } = useMemo(() => {
    if (!data.ready || data.nodes.length === 0) return { nodes: [] as RFNode[], edges: [] as RFEdge[] };
    const positions = layoutGraph(data.nodes, data.edges, data.regions as Region[]);
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
  }, [data]);

  const onNodeClick = useCallback(
    (_: unknown, node: RFNode) => {
      const d = node.data as GameNodeData;
      if (d.status === 'locked') {
        toast('Узел закрыт', {
          description: `Сначала освой: ${d.missingHardTitles.join(' · ') || 'предыдущие идеи'}`,
        });
        return;
      }
      openNode(node.id);
    },
    [openNode]
  );

  if (!data.ready) {
    return <p className="pt-8 text-center text-sm text-muted-foreground">Загрузка…</p>;
  }

  const { regions } = data;

  return (
    <div className="flex h-full flex-col gap-2">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Карта знаний</h1>
      </header>

      {/* Легенда регионов */}
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

      {/* Карта */}
      <div className="min-h-[480px] flex-1 overflow-hidden rounded-xl border border-border bg-card/40">
        {rfNodes.length === 0 ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
            Карта пуста. Загрузи материал во вкладке «Импорт».
          </div>
        ) : (
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            fitView
            fitViewOptions={{ padding: 0.12, maxZoom: 0.95 }}
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
      </div>
    </div>
  );
}
