/**
 * Product-facing graph model for Mendpoint graph-native UX.
 */
export type GraphNodeKind =
  | "surface"
  | "finding"
  | "function"
  | "file"
  | "provider"
  | "version"
  | "change"
  | "consumer"
  | "pr"
  | "tenant"
  | "installation"
  | "field"
  | "operation";

export type GraphNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Optional grouping for layout (0 = root) */
  rank?: number;
  meta?: Record<string, unknown>;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: string;
  meta?: Record<string, unknown>;
};

export type ProductGraph = {
  id: string;
  title: string;
  description?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Simple layout hints for UI (rank → y band) */
  layoutHints?: {
    ranks?: Record<string, number>;
  };
  stats?: {
    nodeCount: number;
    edgeCount: number;
    byKind: Record<string, number>;
  };
};

export function withStats(g: Omit<ProductGraph, "stats">): ProductGraph {
  const byKind: Record<string, number> = {};
  for (const n of g.nodes) {
    byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  }
  return {
    ...g,
    stats: {
      nodeCount: g.nodes.length,
      edgeCount: g.edges.length,
      byKind,
    },
  };
}

export function node(
  id: string,
  kind: GraphNodeKind,
  label: string,
  meta?: Record<string, unknown>,
  rank?: number,
): GraphNode {
  return { id, kind, label, meta, rank };
}

export function edge(
  id: string,
  source: string,
  target: string,
  kind: string,
  meta?: Record<string, unknown>,
): GraphEdge {
  return { id, source, target, kind, meta };
}
