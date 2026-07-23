/**
 * Query layer for impact analysis:
 * - reverse reachability (callers up to depth k)
 * - direct call sites of a function
 * - wrappers that abstract API-touching leaves
 * - impact subgraph around seeds
 */
import type {
  CallEdge,
  CallEdgeConfidence,
  CallGraph,
  FunctionNode,
  ImpactSubgraph,
  ReachabilityHit,
} from "./types.js";
import { confRank, minConf } from "./build.js";

function edgeById(graph: CallGraph, id: string): CallEdge | undefined {
  return graph.edges.find((e) => e.id === id);
}

/** Nodes that match a simple name (RA lookup). */
export function nodesByName(graph: CallGraph, name: string): FunctionNode[] {
  return (graph.byName[name] ?? [])
    .map((id) => graph.nodes[id])
    .filter(Boolean) as FunctionNode[];
}

/** Find function node covering a file:line. */
export function nodeAt(
  graph: CallGraph,
  filePath: string,
  line: number,
): FunctionNode | undefined {
  return Object.values(graph.nodes).find(
    (n) => n.filePath === filePath && line >= n.lineStart && line <= n.lineEnd,
  );
}

/** Find by file + function name. */
export function nodeByFileName(
  graph: CallGraph,
  filePath: string,
  name: string,
): FunctionNode | undefined {
  return Object.values(graph.nodes).find(
    (n) => n.filePath === filePath && n.name === name,
  );
}

/**
 * Reverse reachability: all functions that (transitively) call `seedId`, up to depth k.
 * Prefer soundness — includes low-confidence edges unless minConfidence set.
 */
export function reverseReachability(
  graph: CallGraph,
  seedId: string,
  opts: {
    maxDepth?: number;
    minConfidence?: CallEdgeConfidence;
    excludeTests?: boolean;
  } = {},
): ReachabilityHit[] {
  const maxDepth = opts.maxDepth ?? 3;
  const minC = opts.minConfidence ?? "low";
  const minRank = confRank(minC);
  const hits: ReachabilityHit[] = [];
  const visited = new Set<string>([seedId]);
  // BFS: queue = nodeId, depth, path, conf
  type Q = {
    id: string;
    depth: number;
    path: string[];
    conf: CallEdgeConfidence;
  };
  const queue: Q[] = [{ id: seedId, depth: 0, path: [seedId], conf: "high" }];

  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const incoming = graph.inEdges[cur.id] ?? [];
    for (const eid of incoming) {
      const edge = edgeById(graph, eid);
      if (!edge) continue;
      if (confRank(edge.confidence) < minRank) continue;
      const caller = graph.nodes[edge.callerId];
      if (!caller) continue;
      if (opts.excludeTests && caller.isTest) continue;
      if (visited.has(caller.id)) continue;
      visited.add(caller.id);
      const conf = minConf(cur.conf, edge.confidence);
      const path = [...cur.path, caller.id];
      const depth = cur.depth + 1;
      hits.push({
        node: caller,
        depth,
        path,
        minEdgeConfidence: conf,
      });
      queue.push({ id: caller.id, depth, path, conf });
    }
  }
  return hits;
}

/** Forward callees up to depth k. */
export function forwardReachability(
  graph: CallGraph,
  seedId: string,
  opts: { maxDepth?: number; minConfidence?: CallEdgeConfidence } = {},
): ReachabilityHit[] {
  const maxDepth = opts.maxDepth ?? 2;
  const minRank = confRank(opts.minConfidence ?? "low");
  const hits: ReachabilityHit[] = [];
  const visited = new Set<string>([seedId]);
  type Q = { id: string; depth: number; path: string[]; conf: CallEdgeConfidence };
  const queue: Q[] = [{ id: seedId, depth: 0, path: [seedId], conf: "high" }];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const eid of graph.outEdges[cur.id] ?? []) {
      const edge = edgeById(graph, eid);
      if (!edge || confRank(edge.confidence) < minRank) continue;
      const callee = graph.nodes[edge.calleeId];
      if (!callee || visited.has(callee.id)) continue;
      visited.add(callee.id);
      const conf = minConf(cur.conf, edge.confidence);
      const path = [...cur.path, callee.id];
      const depth = cur.depth + 1;
      hits.push({ node: callee, depth, path, minEdgeConfidence: conf });
      queue.push({ id: callee.id, depth, path, conf });
    }
  }
  return hits;
}

/**
 * Wrappers: functions that call into seed (or seeds) and have few callees —
 * typical service-layer abstraction over an API.
 */
export function findWrappers(
  graph: CallGraph,
  seedIds: string[],
  opts: { maxCallees?: number; maxDepth?: number } = {},
): FunctionNode[] {
  const maxCallees = opts.maxCallees ?? 5;
  const upstream = new Map<string, FunctionNode>();
  for (const seed of seedIds) {
    for (const hit of reverseReachability(graph, seed, { maxDepth: opts.maxDepth ?? 2 })) {
      const outCount = (graph.outEdges[hit.node.id] ?? []).length;
      if (outCount > 0 && outCount <= maxCallees) {
        upstream.set(hit.node.id, hit.node);
      }
    }
  }
  return [...upstream.values()];
}

/**
 * Build the impact subgraph used by context expansion:
 * seeds (direct API-touching functions) + upstream callers ≤ k hops.
 */
export function impactSubgraph(
  graph: CallGraph,
  seedIds: string[],
  opts: { maxDepth?: number; minConfidence?: CallEdgeConfidence } = {},
): ImpactSubgraph {
  const maxDepth = opts.maxDepth ?? 3;
  const nodeMap = new Map<string, FunctionNode>();
  const edgeMap = new Map<string, CallEdge>();
  const allUpstream: ReachabilityHit[] = [];

  for (const seed of seedIds) {
    const n = graph.nodes[seed];
    if (n) nodeMap.set(seed, n);
    for (const hit of reverseReachability(graph, seed, {
      maxDepth,
      minConfidence: opts.minConfidence,
    })) {
      allUpstream.push(hit);
      nodeMap.set(hit.node.id, hit.node);
      // collect edges along path
      for (let i = 0; i < hit.path.length - 1; i++) {
        const callee = hit.path[i]!;
        const caller = hit.path[i + 1]!;
        for (const eid of graph.inEdges[callee] ?? []) {
          const e = edgeById(graph, eid);
          if (e && e.callerId === caller) edgeMap.set(e.id, e);
        }
      }
    }
  }

  const wrappers = findWrappers(graph, seedIds, { maxDepth: Math.min(2, maxDepth) });

  return {
    seedNodeIds: seedIds,
    nodes: [...nodeMap.values()],
    edges: [...edgeMap.values()],
    upstream: allUpstream,
    wrappers,
  };
}

/** Direct callers of a node (depth 1). */
export function directCallers(graph: CallGraph, nodeId: string): FunctionNode[] {
  return reverseReachability(graph, nodeId, { maxDepth: 1 }).map((h) => h.node);
}

/** Direct callees. */
export function directCallees(graph: CallGraph, nodeId: string): FunctionNode[] {
  return forwardReachability(graph, nodeId, { maxDepth: 1 }).map((h) => h.node);
}

/**
 * Adjust impact confidence by path length and edge confidence.
 * Longer paths and approximate edges reduce confidence.
 */
export function propagateConfidence(
  base: CallEdgeConfidence,
  hit: ReachabilityHit,
): CallEdgeConfidence {
  let c = minConf(base, hit.minEdgeConfidence);
  if (hit.depth >= 3 && c === "high") c = "medium";
  if (hit.depth >= 4) c = "low";
  return c;
}
