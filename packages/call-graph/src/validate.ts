/**
 * Periodic soundness validation: compare incremental graph to full rebuild.
 */
import { buildCallGraph } from "./build.js";
import { graphCallPairs, stableKey } from "./incremental.js";
import type { CallGraph } from "./types.js";

export type SoundnessReport = {
  ok: boolean;
  missingEdges: string[];
  extraEdges: string[];
  missingNodes: string[];
  /** Recall of incremental vs full (1 = no missing edges) */
  edgeRecall: number;
  nodeRecall: number;
  fullNodeCount: number;
  incrementalNodeCount: number;
  checkedAt: string;
};

/**
 * Validate that every edge in a full rebuild appears in the candidate graph
 * (soundness for impact: no missing call edges).
 */
export function validateAgainstFullRebuild(
  candidate: CallGraph,
  opts?: { repoRoot?: string },
): SoundnessReport {
  const root = opts?.repoRoot ?? candidate.repoRoot;
  const full = buildCallGraph(root, { algorithm: candidate.algorithm });
  const pInc = graphCallPairs(candidate);
  const pFull = graphCallPairs(full);

  const missingEdges: string[] = [];
  for (const e of pFull) {
    if (!pInc.has(e)) missingEdges.push(e);
  }
  const extraEdges: string[] = [];
  for (const e of pInc) {
    if (!pFull.has(e)) extraEdges.push(e);
  }

  const fullNodes = new Set(Object.values(full.nodes).map(stableKey));
  const incNodes = new Set(Object.values(candidate.nodes).map(stableKey));
  const missingNodes: string[] = [];
  for (const n of fullNodes) {
    if (!incNodes.has(n)) missingNodes.push(n);
  }

  const edgeRecall = pFull.size === 0 ? 1 : (pFull.size - missingEdges.length) / pFull.size;
  const nodeRecall = fullNodes.size === 0 ? 1 : (fullNodes.size - missingNodes.length) / fullNodes.size;

  return {
    ok: missingEdges.length === 0,
    missingEdges,
    extraEdges,
    missingNodes,
    edgeRecall,
    nodeRecall,
    fullNodeCount: fullNodes.size,
    incrementalNodeCount: incNodes.size,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Metrics comparing incremental update to estimated full rebuild cost.
 */
export function incrementalEfficiencyMetrics(
  previous: CallGraph,
  updated: CallGraph,
): {
  resetRegionFileCount: number;
  resetRegionMethodFraction: number;
  reuseRatio: number;
  estimatedSpeedupVsFull: number;
  residualLowConfidenceEdges: number;
} {
  const stats = updated.lastIncremental;
  const resetFiles = stats?.resetFiles.length ?? 0;
  const totalFiles =
    new Set(Object.values(previous.nodes).map((n) => n.filePath)).size || 1;
  const reused = stats?.reusedNodes ?? 0;
  const recomputed = stats?.recomputedNodes ?? 0;
  const reuseRatio = reused + recomputed === 0 ? 0 : reused / (reused + recomputed);
  // crude speedup model: inverse of recompute fraction, clamped
  const recomputeFraction =
    previous.stats.nodeCount === 0
      ? 1
      : Math.min(1, (stats?.prunedNodes ?? previous.stats.nodeCount) / previous.stats.nodeCount);
  const estimatedSpeedupVsFull = Math.max(1, 1 / Math.max(0.05, recomputeFraction));

  const residualLowConfidenceEdges = updated.edges.filter(
    (e) => e.confidence === "low" || e.virtual,
  ).length;

  return {
    resetRegionFileCount: resetFiles,
    resetRegionMethodFraction: recomputeFraction,
    reuseRatio,
    estimatedSpeedupVsFull: Number(estimatedSpeedupVsFull.toFixed(2)),
    residualLowConfidenceEdges,
  };
}
