/**
 * Demand-driven construction / refinement.
 *
 * For impact queries we often only need the subgraph around known API seeds.
 * Rather than requiring a complete always-fresh whole-program graph, we can
 * extract (and optionally deepen) just the relevant slice.
 */
import type { CallGraph, ImpactSubgraph } from "./types.js";
import { impactSubgraph, nodeAt, nodesByName, reverseReachability } from "./query.js";

export type DemandQuery = {
  /** Function names or file:line seeds */
  seeds: Array<
    | { kind: "name"; name: string }
    | { kind: "location"; filePath: string; line: number }
    | { kind: "nodeId"; id: string }
  >;
  maxDepth?: number;
};

/**
 * Resolve demand seeds to node ids in the current graph.
 */
export function resolveDemandSeeds(graph: CallGraph, query: DemandQuery): string[] {
  const ids: string[] = [];
  for (const s of query.seeds) {
    if (s.kind === "nodeId") {
      if (graph.nodes[s.id]) ids.push(s.id);
    } else if (s.kind === "name") {
      for (const n of nodesByName(graph, s.name)) ids.push(n.id);
    } else {
      const n = nodeAt(graph, s.filePath, s.line);
      if (n) ids.push(n.id);
    }
  }
  return [...new Set(ids)];
}

/**
 * Build only the impact subgraph needed for a query (demand-driven slice).
 * Does not mutate the global graph — pure projection.
 */
export function demandImpactSlice(graph: CallGraph, query: DemandQuery): ImpactSubgraph {
  const seedIds = resolveDemandSeeds(graph, query);
  return impactSubgraph(graph, seedIds, { maxDepth: query.maxDepth ?? 3 });
}

/**
 * List residual uncertainties: low-confidence edges in the demand slice
 * that downstream LLM confirmation should prioritize.
 */
export function residualUncertainties(
  graph: CallGraph,
  query: DemandQuery,
): Array<{ edgeId: string; caller: string; callee: string; confidence: string }> {
  const slice = demandImpactSlice(graph, query);
  const out: Array<{
    edgeId: string;
    caller: string;
    callee: string;
    confidence: string;
  }> = [];
  for (const e of slice.edges) {
    if (e.confidence === "low" || e.virtual) {
      const a = graph.nodes[e.callerId];
      const b = graph.nodes[e.calleeId];
      if (!a || !b) continue;
      out.push({
        edgeId: e.id,
        caller: a.qualifiedName,
        callee: b.qualifiedName,
        confidence: e.confidence,
      });
    }
  }
  // also surface deep paths
  for (const seed of slice.seedNodeIds) {
    for (const hit of reverseReachability(graph, seed, { maxDepth: query.maxDepth ?? 3 })) {
      if (hit.minEdgeConfidence === "low" && hit.depth >= 2) {
        out.push({
          edgeId: `path:${hit.path.join(">")}`,
          caller: hit.node.qualifiedName,
          callee: graph.nodes[seed]?.qualifiedName ?? seed,
          confidence: "low",
        });
      }
    }
  }
  return out;
}
