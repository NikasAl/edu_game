/**
 * Чистая логика вида карты: свёртка регионов в узлы-оболочки с прогрессом
 * и перестройка рёбер через границы свёртки; порядок навигации по узлам.
 * Без Dexie и React — тестируется в node (scripts/mapview-test).
 */
import type { EdgeKind, IdeaEdge, IdeaNode, NodeState, Region } from './types';

/** Узел-оболочка свёрнутого региона (рендерится как «раздел-суперузел») */
export interface RegionShell {
  id: string; // `region-<regionId>` — id RF-узла
  regionId: string;
  title: string;
  orderIndex: number;
  mastered: number;
  total: number;
}

export interface MapViewEdge {
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
}

export interface MapView {
  /** Узлы для layoutGraph: видимые атомы + оболочки (как IdeaNode-заглушки) */
  layoutNodes: IdeaNode[];
  /** Рёбра: внутренние для свёрнутых регионов выброшены, пересекающие — перестроены на оболочки, дубли слиты */
  layoutEdges: MapViewEdge[];
  /** Оболочки свёрнутых регионов (с прогрессом) */
  shells: RegionShell[];
  /** id атомов, скрытых свёрткой */
  hiddenIds: Set<string>;
}

export const shellIdOf = (regionId: string): string => `region-${regionId}`;

/**
 * Свернуть указанные регионы: их атомы скрываются, вместо них появляется
 * одна оболочка с прогрессом. Рёбра, пересекающие границу свёртки,
 * переподключаются к оболочке; рёбра целиком внутри свёрнутого региона
 * исчезают вместе с атомами. Конфликты видов решаются в пользу hard
 * (связь заметнее). Квотиент DAG остаётся DAG — циклы не возникают.
 */
export function buildMapView(
  nodes: IdeaNode[],
  edges: IdeaEdge[],
  regions: Region[],
  collapsed: Set<string>,
  states: Map<string, NodeState>
): MapView {
  const regionOf = new Map(nodes.map((n) => [n.id, n.regionId]));
  const knownRegions = new Set(regions.map((r) => r.id));
  // сворачиваем только атомы известных регионов: у неизвестного не будет ни
  // оболочки, ни заголовка — оставляем его видимым
  const hiddenIds = new Set(
    nodes.filter((n) => collapsed.has(n.regionId) && knownRegions.has(n.regionId)).map((n) => n.id)
  );
  const visible = nodes.filter((n) => !hiddenIds.has(n.id));

  const shells: RegionShell[] = [];
  for (const r of regions) {
    if (!collapsed.has(r.id)) continue;
    const members = nodes.filter((n) => n.regionId === r.id);
    if (members.length === 0) continue; // пустой регион не сворачиваем
    const mastered = members.filter((n) => states.get(n.id)?.status === 'mastered').length;
    shells.push({
      id: shellIdOf(r.id),
      regionId: r.id,
      title: r.title,
      orderIndex: r.orderIndex,
      mastered,
      total: members.length,
    });
  }
  const shellIds = new Set(shells.map((s) => s.id));

  const layoutNodes: IdeaNode[] = [
    ...visible,
    ...shells.map(
      (s) =>
        ({
          id: s.id,
          materialId: '',
          regionId: s.regionId,
          title: s.title,
          formulation: '',
          example: '',
          feynmanQuestion: '',
          keyTerms: [],
          orderIndex: s.orderIndex,
          createdAt: new Date(0),
        }) as IdeaNode
    ),
  ];
  const nodeIds = new Set(layoutNodes.map((n) => n.id));

  // Переподключение концов ребра: скрытый атом → оболочка его региона
  const endpoint = (id: string): string => {
    const r = regionOf.get(id);
    return r !== undefined && collapsed.has(r) && shellIds.has(shellIdOf(r))
      ? shellIdOf(r)
      : id;
  };

  const seen = new Map<string, EdgeKind>();
  for (const e of edges) {
    const from = endpoint(e.fromNodeId);
    const to = endpoint(e.toNodeId);
    if (from === to) continue; // ребро внутри одного свёрнутого региона / самосвязь
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue; // висячая ссылка
    const key = `${from}->${to}`;
    if (seen.get(key) === 'hard') continue;
    seen.set(key, e.kind === 'hard' ? 'hard' : (seen.get(key) ?? 'soft'));
  }

  const layoutEdges: MapViewEdge[] = [...seen.entries()].map(([key, kind]) => {
    const [fromNodeId, toNodeId] = key.split('->');
    return { fromNodeId, toNodeId, kind };
  });

  return { layoutNodes, layoutEdges, shells, hiddenIds };
}

/**
 * Порядок навигации по узлам: визуальный «читательский» — сверху вниз,
 * слева направо (по координатам раскладки).
 */
export function navOrder(
  positions: Map<string, { x: number; y: number }>,
  nodeIds: string[]
): string[] {
  return [...nodeIds].sort((a, b) => {
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) return 0;
    return pa.y - pb.y || pa.x - pb.x;
  });
}
