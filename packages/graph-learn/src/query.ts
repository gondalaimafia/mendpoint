/**
 * Graph-RAG query layer — deterministic multi-hop templates for planners.
 */
import type { GlEdge, GlNode, GraphQuery, GraphQueryResult } from "./schema.js";
import {
  countStats,
  edgesFrom,
  edgesTo,
  getNode,
  listNodesByKind,
  type GraphLearnDb,
} from "./store.js";

function collectNodes(db: GraphLearnDb, ids: Iterable<string>): GlNode[] {
  const out: GlNode[] = [];
  for (const id of ids) {
    const n = getNode(db, id);
    if (n) out.push(n);
  }
  return out;
}

/** BFS multi-hop neighborhood. */
export function blastRadius(
  db: GraphLearnDb,
  nodeId: string,
  maxHops = 2,
): { nodes: GlNode[]; edges: GlEdge[] } {
  const seen = new Set<string>([nodeId]);
  const edgeAcc: GlEdge[] = [];
  let frontier = [nodeId];
  for (let h = 0; h < maxHops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const e of [...edgesFrom(db, id), ...edgesTo(db, id)]) {
        edgeAcc.push(e);
        const other = e.source === id ? e.target : e.source;
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }
  return { nodes: collectNodes(db, seen), edges: edgeAcc };
}

export function runGraphQuery(db: GraphLearnDb, q: GraphQuery): GraphQueryResult {
  switch (q.op) {
    case "stats": {
      const s = countStats(db);
      return {
        op: "stats",
        nodes: [],
        edges: [],
        summary: `${s.nodes} nodes, ${s.edges} edges`,
        rows: [s],
      };
    }
    case "who_consumes_provider": {
      const pId = `provider:${q.providerSlug}`;
      const edges = edgesTo(db, pId, ["monitors"]);
      const consumerIds = edges.map((e) => e.source);
      const nodes = collectNodes(db, [pId, ...consumerIds]);
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${consumerIds.length} consumer(s) monitor ${q.providerSlug}`,
        rows: consumerIds.map((id) => ({ consumerId: id.replace(/^consumer:/, "") })),
      };
    }
    case "who_consumes_endpoint": {
      const eid = `endpoint:${q.providerSlug}:${(q.method ?? "ANY").toUpperCase()}:${q.path}`;
      // consumers that monitor provider (endpoint-level if we lack direct edge)
      const p = runGraphQuery(db, {
        op: "who_consumes_provider",
        providerSlug: q.providerSlug,
      });
      const breakEdges = edgesTo(db, eid, ["breaks"]);
      return {
        op: q.op,
        nodes: [...p.nodes, ...collectNodes(db, [eid])],
        edges: [...p.edges, ...breakEdges],
        summary: `endpoint ${q.method ?? ""} ${q.path} — ${p.rows?.length ?? 0} provider consumer(s); ${breakEdges.length} break edge(s)`,
        rows: p.rows,
      };
    }
    case "blast_radius": {
      const r = blastRadius(db, q.nodeId, q.maxHops ?? 2);
      return {
        op: q.op,
        nodes: r.nodes,
        edges: r.edges,
        summary: `blast radius from ${q.nodeId}: ${r.nodes.length} nodes, ${r.edges.length} edges`,
      };
    }
    case "neighbors": {
      const dir = q.direction ?? "both";
      const outE =
        dir === "in" ? [] : edgesFrom(db, q.nodeId, q.edgeKinds);
      const inE = dir === "out" ? [] : edgesTo(db, q.nodeId, q.edgeKinds);
      const edges = [...outE, ...inE];
      const ids = new Set<string>([q.nodeId]);
      for (const e of edges) {
        ids.add(e.source);
        ids.add(e.target);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, ids),
        edges,
        summary: `${edges.length} neighbor edge(s)`,
      };
    }
    case "depends_on_path": {
      const path: string[] = [q.nodeId];
      const edges: GlEdge[] = [];
      let cur = q.nodeId;
      for (let i = 0; i < (q.maxHops ?? 8); i++) {
        const deps = edgesFrom(db, cur, ["depends_on"]);
        if (!deps.length) break;
        edges.push(deps[0]!);
        cur = deps[0]!.target;
        path.push(cur);
      }
      return {
        op: q.op,
        nodes: collectNodes(db, path),
        edges,
        summary: `depends_on path length ${path.length - 1}`,
        rows: path.map((id, i) => ({ step: i, nodeId: id })),
      };
    }
    case "outcomes_for_pattern": {
      const allOut = [
        ...listNodesByKind(db, "pr"),
      ];
      // edges with outcome kinds matching pattern in props
      const rows: Array<Record<string, unknown>> = [];
      const edges: GlEdge[] = [];
      const nodes: GlNode[] = [];
      for (const n of allOut) {
        if (
          n.label.toLowerCase().includes(q.pattern.toLowerCase()) ||
          JSON.stringify(n.props ?? {}).toLowerCase().includes(q.pattern.toLowerCase())
        ) {
          nodes.push(n);
          const es = edgesFrom(db, n.id);
          edges.push(...es);
          rows.push({ pr: n.id, label: n.label, props: n.props });
        }
      }
      // also scan outcome edges
      for (const kind of ["outcome_merged", "outcome_closed", "outcome_broke"] as const) {
        const consumers = listNodesByKind(db, "consumer");
        for (const c of consumers) {
          for (const e of edgesFrom(db, c.id, [kind])) {
            if (
              JSON.stringify(e.props ?? {})
                .toLowerCase()
                .includes(q.pattern.toLowerCase()) ||
              e.target.includes(q.pattern)
            ) {
              edges.push(e);
              rows.push({ edge: e.id, kind: e.kind, label: e.label });
            }
          }
        }
      }
      return {
        op: q.op,
        nodes,
        edges,
        summary: `${rows.length} outcome hit(s) for pattern ${JSON.stringify(q.pattern)}`,
        rows,
      };
    }
    default:
      return { op: "unknown", nodes: [], edges: [], summary: "unknown query" };
  }
}

/** Planner tool surface — string templates */
export const GRAPH_RAG_TOOLS = [
  "who_consumes_provider",
  "who_consumes_endpoint",
  "blast_radius",
  "neighbors",
  "depends_on_path",
  "outcomes_for_pattern",
  "stats",
] as const;

export function formatQueryForPlanner(r: GraphQueryResult): string {
  return [
    `### Graph-RAG: ${r.op}`,
    r.summary,
    r.rows?.length
      ? r.rows
          .slice(0, 12)
          .map((row) => `- ${JSON.stringify(row)}`)
          .join("\n")
      : r.nodes
          .slice(0, 12)
          .map((n) => `- (${n.kind}) ${n.label} \`${n.id}\``)
          .join("\n"),
  ].join("\n");
}
