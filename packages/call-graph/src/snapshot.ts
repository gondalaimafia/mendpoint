/**
 * Short-window graph snapshots for rollback after failed / low-confidence updates.
 */
import type { CallGraph, IncrementalStats } from "./types.js";

export type GraphSnapshot = {
  id: string;
  savedAt: string;
  reason: string;
  graph: CallGraph;
};

export type SnapshotStore = {
  /** Newest last */
  snapshots: GraphSnapshot[];
  maxSize: number;
};

export function createSnapshotStore(maxSize = 3): SnapshotStore {
  return { snapshots: [], maxSize };
}

export function pushSnapshot(
  store: SnapshotStore,
  graph: CallGraph,
  reason = "pre_update",
): GraphSnapshot {
  const snap: GraphSnapshot = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: new Date().toISOString(),
    reason,
    // structured clone of essential fields
    graph: structuredClone(graph),
  };
  store.snapshots.push(snap);
  while (store.snapshots.length > store.maxSize) store.snapshots.shift();
  return snap;
}

export function latestSnapshot(store: SnapshotStore): GraphSnapshot | undefined {
  return store.snapshots[store.snapshots.length - 1];
}

/**
 * Roll back to the latest snapshot if incremental stats look unhealthy.
 */
export function maybeRollback(
  store: SnapshotStore,
  candidate: CallGraph,
  opts?: {
    /** If recomputed/pruned ratio too high without reuse, rollback */
    minReuseRatio?: number;
    force?: boolean;
  },
): { graph: CallGraph; rolledBack: boolean; reason?: string } {
  const stats = candidate.lastIncremental;
  if (opts?.force) {
    const prev = latestSnapshot(store);
    if (prev) return { graph: prev.graph, rolledBack: true, reason: "forced" };
  }
  if (!stats || stats.mode === "full_rebuild") {
    return { graph: candidate, rolledBack: false };
  }
  const total = stats.reusedNodes + stats.recomputedNodes;
  const reuseRatio = total === 0 ? 0 : stats.reusedNodes / total;
  const minReuse = opts?.minReuseRatio ?? 0.15;
  // Only rollback if we claimed incremental but reused almost nothing AND pruned a lot
  if (reuseRatio < minReuse && stats.prunedNodes > stats.reusedNodes && stats.prunedNodes > 3) {
    const prev = latestSnapshot(store);
    if (prev) {
      return {
        graph: prev.graph,
        rolledBack: true,
        reason: `low_reuse_ratio_${reuseRatio.toFixed(2)}`,
      };
    }
  }
  return { graph: candidate, rolledBack: false };
}

export function attachStats(graph: CallGraph, stats: IncrementalStats): CallGraph {
  return { ...graph, lastIncremental: stats };
}
