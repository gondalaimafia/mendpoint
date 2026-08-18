import type { GlEdge } from "./schema.js";
import { edgesFrom, getNode, type GraphLearnDb } from "./store.js";

export type DependencyPathTerminal = "leaf" | "cycle" | "max_hops";

export type DependencyPath = {
  rank: number;
  nodeIds: string[];
  edgeIds: string[];
  hops: number;
  terminal: DependencyPathTerminal;
  cycleNodeId?: string;
  minConfidence: number;
  repositoryIds: string[];
};

export type DependencyPathTruncation = {
  truncated: boolean;
  reasons: Array<"max_hops" | "max_paths">;
  maxHops: number;
  maxPaths: number;
  pathsReturned: number;
  omittedPathsAtLeast: number;
};

/**
 * Coverage of a dependency enumeration:
 *  - `complete`      — the seed node exists and every terminal path was enumerated.
 *  - `partial`       — the seed exists but a safety bound truncated enumeration.
 *  - `target_absent` — the seed node is not in the graph. An empty result then
 *    means "never seen", not "no dependencies". Reporting this as `truncated:
 *    false` (as the old code did) falsely asserts completeness for a node the
 *    graph has never contained.
 */
export type DependencyPathCoverage = "complete" | "partial" | "target_absent";

export type DependencyPathEnumeration = {
  paths: DependencyPath[];
  nodeIds: string[];
  edges: GlEdge[];
  truncation: DependencyPathTruncation;
  coverage: DependencyPathCoverage;
};

const DEFAULT_MAX_HOPS = 8;
const DEFAULT_MAX_PATHS = 100;
/** Shared traversal safety ceilings — reused by every bounded graph op so the
 *  engine speaks one limit vocabulary regardless of caller-supplied bounds. */
export const HARD_MAX_HOPS = 32;
export const HARD_MAX_PATHS = 1_000;

function boundedInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function compareDependencies(left: GlEdge, right: GlEdge): number {
  const confidence = (right.confidence ?? 1) - (left.confidence ?? 1);
  if (confidence !== 0) return confidence;
  const target = left.target.localeCompare(right.target);
  return target !== 0 ? target : left.id.localeCompare(right.id);
}

/** Enumerate every terminal simple dependency path within explicit safety bounds. */
export function enumerateDependencyPaths(
  db: GraphLearnDb,
  nodeId: string,
  options: { maxHops?: number; maxPaths?: number } = {},
): DependencyPathEnumeration {
  const maxHops = boundedInt(options.maxHops, DEFAULT_MAX_HOPS, 0, HARD_MAX_HOPS);
  const maxPaths = boundedInt(options.maxPaths, DEFAULT_MAX_PATHS, 1, HARD_MAX_PATHS);
  const paths: DependencyPath[] = [];
  const includedEdges = new Map<string, GlEdge>();
  let pathLimitReached = false;
  let depthLimitedPaths = 0;

  const addPath = (
    nodeIds: string[],
    edges: GlEdge[],
    terminal: DependencyPathTerminal,
    cycleNodeId?: string,
  ) => {
    for (const edge of edges) includedEdges.set(edge.id, edge);
    paths.push({
      rank: paths.length + 1,
      nodeIds,
      edgeIds: edges.map((edge) => edge.id),
      hops: edges.length,
      terminal,
      cycleNodeId,
      minConfidence: edges.length
        ? Math.min(...edges.map((edge) => edge.confidence ?? 1))
        : 1,
      repositoryIds: [...new Set(nodeIds
        .map((id) => getNode(db, id)?.repo_id)
        .filter((id): id is string => Boolean(id)))],
    });
  };

  const visit = (current: string, nodeIds: string[], pathEdges: GlEdge[]) => {
    const dependencies = edgesFrom(db, current, ["DEPENDS_ON"]).sort(
      compareDependencies,
    );
    if (pathEdges.length >= maxHops) {
      if (dependencies.length) {
        depthLimitedPaths++;
        addPath(nodeIds, pathEdges, "max_hops");
      } else {
        addPath(nodeIds, pathEdges, "leaf");
      }
      return;
    }
    if (!dependencies.length) {
      addPath(nodeIds, pathEdges, "leaf");
      return;
    }

    for (const edge of dependencies) {
      if (paths.length >= maxPaths) {
        pathLimitReached = true;
        return;
      }
      const nextNodes = [...nodeIds, edge.target];
      const nextEdges = [...pathEdges, edge];
      if (nodeIds.includes(edge.target)) {
        addPath(nextNodes, nextEdges, "cycle", edge.target);
        continue;
      }
      visit(edge.target, nextNodes, nextEdges);
    }
  };

  const nodePresent = Boolean(getNode(db, nodeId));
  if (nodePresent) visit(nodeId, [nodeId], []);

  const nodeIds = [...new Set(paths.flatMap((path) => path.nodeIds))];
  const reasons: DependencyPathTruncation["reasons"] = [];
  if (depthLimitedPaths) reasons.push("max_hops");
  if (pathLimitReached) reasons.push("max_paths");
  const truncated = reasons.length > 0;
  const coverage: DependencyPathCoverage = !nodePresent
    ? "target_absent"
    : truncated
      ? "partial"
      : "complete";
  return {
    paths,
    nodeIds,
    edges: [...includedEdges.values()],
    truncation: {
      truncated,
      reasons,
      maxHops,
      maxPaths,
      pathsReturned: paths.length,
      omittedPathsAtLeast: depthLimitedPaths + (pathLimitReached ? 1 : 0),
    },
    coverage,
  };
}
