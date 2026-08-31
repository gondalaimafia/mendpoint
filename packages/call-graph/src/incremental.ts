/**
 * Incremental Graph Update — Reset-Recompute
 *
 * Phase 1 Reset (invalidation): identify affected region, prune outdated nodes/edges.
 * Phase 2 Recompute (patch): re-analyze only reset files + minimal context; merge into survivor graph.
 *
 * Soundness first: when in doubt, over-reset or fall back to full rebuild.
 * Hybrid strategy (default): method-aware 1-hop expansion lifted to files;
 * hierarchy-dirty changes expand more aggressively.
 *
 * Inspired by industrial reset-recompute (e.g. Zhao et al., ICSE-SEIP 2023).
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildCallGraph,
  type BuildCallGraphOptions,
  reanalyzeFiles,
  rebuildAdjacency,
  emptyHierarchy,
  mergeHierarchies,
} from "./build.js";
import {
  classifyChanges,
  shouldFullRebuildFromChangeSet,
  type ChangeSet,
} from "./change-detect.js";
import { incrementalEfficiencyMetrics } from "./validate.js";
import type {
  AffectedRegion,
  AtomicChange,
  CallGraph,
  FunctionNode,
  IncrementalStats,
  IncrementalStrategy,
} from "./types.js";

export type IncrementalOptions = BuildCallGraphOptions & {
  strategy?: IncrementalStrategy;
  /**
   * If reset file fraction exceeds this (0–1), full rebuild.
   * Default 0.4 — file-level safety net.
   */
  fullRebuildFileFraction?: number;
  /**
   * If fraction of methods changed exceeds this, full rebuild.
   * Default 0.25 (practical band 15–30%).
   */
  methodFractionThreshold?: number;
  /** Max hop expansion from changed methods. Default 1 (hybrid); modest 1–2. */
  expansionHops?: number;
};

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Map file-level edits into atomic + method-classified changes.
 */
export function collectAtomicChanges(
  previous: CallGraph,
  changedFiles: string[],
  _repoRoot?: string,
): AtomicChange[] {
  const cs = classifyChanges(previous, changedFiles);
  return changeSetToAtomic(cs);
}

export function changeSetToAtomic(cs: ChangeSet): AtomicChange[] {
  const atomic: AtomicChange[] = [];
  for (const f of cs.changedFiles) atomic.push({ kind: "file_changed", filePath: f });
  for (const f of cs.addedFiles) atomic.push({ kind: "file_added", filePath: f });
  for (const f of cs.deletedFiles) atomic.push({ kind: "file_deleted", filePath: f });
  for (const m of cs.methods) {
    if (m.kind === "method_body_edit") {
      atomic.push({
        kind: "method_body_edit",
        filePath: m.filePath,
        methodName: m.methodName,
        nodeId: m.previousNodeId,
      });
    } else if (m.kind === "method_signature_change") {
      atomic.push({
        kind: "method_signature_change",
        filePath: m.filePath,
        methodName: m.methodName,
        nodeId: m.previousNodeId,
      });
    } else if (m.kind === "method_added") {
      atomic.push({
        kind: "method_added",
        filePath: m.filePath,
        methodName: m.methodName,
      });
    } else if (m.kind === "method_deleted") {
      atomic.push({
        kind: "method_deleted",
        filePath: m.filePath,
        methodName: m.methodName,
        nodeId: m.previousNodeId,
      });
    }
  }
  if (cs.structural.hierarchyChanged) {
    for (const f of [...cs.changedFiles, ...cs.addedFiles]) {
      atomic.push({ kind: "hierarchy_changed", filePath: f });
    }
  }
  if (cs.structural.importChanged) {
    for (const f of [...cs.changedFiles, ...cs.addedFiles]) {
      atomic.push({ kind: "import_changed", filePath: f });
    }
  }
  if (cs.structural.largeStructural) {
    atomic.push({ kind: "structural_change", detail: "large_structural" });
  }
  return atomic;
}


/**
 * Identify the graph region that must be reset.
 *
 * Hybrid (default):
 * - Seed = methods in changed files
 * - Expand 1 hop along call edges (callers + callees) → lift to files
 * - If hierarchy dirty, also reset all files that declare related types (or all virtual edge endpoints)
 *
 * Eager: all transitively reachable files from seeds (BFS, capped)
 * Conservative: only the changed files themselves (still sound for edges internal to those files,
 * but re-resolves incident edges by also including 1-hop callers so call sites are re-analyzed)
 */
export function identifyAffectedRegion(
  previous: CallGraph,
  changedFiles: string[],
  opts: IncrementalOptions = {},
): AffectedRegion {
  const strategy: IncrementalStrategy = opts.strategy ?? "hybrid";
  const hops =
    opts.expansionHops ??
    (strategy === "eager" ? 99 : strategy === "conservative" ? 1 : 1);
  const seedFiles = [...new Set(changedFiles.map(normPath))];
  const changeSet = classifyChanges(previous, seedFiles, { sources: opts.sources });
  const atomicChanges = changeSetToAtomic(changeSet);
  const hierarchyDirty = changeSet.structural.hierarchyChanged;
  const importDirty = changeSet.structural.importChanged;

  const methodSummary = {
    bodyEdits: changeSet.methods.filter((m) => m.kind === "method_body_edit").length,
    signatureChanges: changeSet.methods.filter((m) => m.kind === "method_signature_change")
      .length,
    added: changeSet.methods.filter((m) => m.kind === "method_added").length,
    deleted: changeSet.methods.filter((m) => m.kind === "method_deleted").length,
  };

  if (!seedFiles.length) {
    return {
      strategy,
      seedFiles: [],
      resetFiles: [],
      resetNodeIds: [],
      atomicChanges: [],
      hierarchyDirty: false,
      shouldFullRebuild: true,
      reason: "no_changed_files",
      methodChangeSummary: methodSummary,
      changedMethodFraction: 0,
    };
  }

  // Method-fraction / structural full-rebuild heuristics (15–30% band, default 25%)
  const methodGate = shouldFullRebuildFromChangeSet(changeSet, {
    methodFractionThreshold: opts.methodFractionThreshold ?? 0.25,
  });
  if (methodGate.full) {
    return {
      strategy,
      seedFiles,
      resetFiles: seedFiles,
      resetNodeIds: Object.keys(previous.nodes),
      atomicChanges,
      hierarchyDirty,
      importDirty,
      shouldFullRebuild: true,
      reason: methodGate.reason,
      methodChangeSummary: methodSummary,
      changedMethodFraction: changeSet.changedMethodFraction,
    };
  }

  /**
   * Seed nodes by change kind:
   * - body edit: the method itself (outgoing edges recompute)
   * - signature / delete: method + will pull callers via expansion/closure
   * - added: file-level reparse (no prior node)
   * - fallback: all methods in seed files
   */
  const seedNodeIds = new Set<string>();
  for (const m of changeSet.methods) {
    if (m.previousNodeId) seedNodeIds.add(m.previousNodeId);
  }
  if (!seedNodeIds.size) {
    for (const n of Object.values(previous.nodes)) {
      if (seedFiles.includes(n.filePath)) seedNodeIds.add(n.id);
    }
  }

  // Signature / delete: force include direct callers immediately
  for (const m of changeSet.methods) {
    if (
      (m.kind === "method_signature_change" || m.kind === "method_deleted") &&
      m.previousNodeId
    ) {
      for (const eid of previous.inEdges[m.previousNodeId] ?? []) {
        const e = previous.edges.find((x) => x.id === eid);
        if (e) seedNodeIds.add(e.callerId);
      }
    }
  }

  // Expand modest hops along graph (call + implicit import via hierarchy/import dirty)
  const affectedNodeIds = new Set<string>(seedNodeIds);
  let frontier = [...seedNodeIds];
  const maxHops = strategy === "eager" ? Math.min(hops, 8) : hops;

  for (let h = 0; h < maxHops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      // always expand callers (soundness for edge re-emit)
      for (const eid of previous.inEdges[id] ?? []) {
        const e = previous.edges.find((x) => x.id === eid);
        if (e && !affectedNodeIds.has(e.callerId)) {
          affectedNodeIds.add(e.callerId);
          next.push(e.callerId);
        }
      }
      // callees: only for body edits / eager / hierarchy (resolution may change less)
      const expandCallees =
        strategy === "eager" ||
        hierarchyDirty ||
        changeSet.methods.some(
          (m) => m.previousNodeId === id && m.kind !== "method_body_edit",
        );
      if (expandCallees) {
        for (const eid of previous.outEdges[id] ?? []) {
          const e = previous.edges.find((x) => x.id === eid);
          if (e && !affectedNodeIds.has(e.calleeId)) {
            affectedNodeIds.add(e.calleeId);
            next.push(e.calleeId);
          }
        }
      }
    }
    frontier = next;
    if (!frontier.length) break;
  }

  // Hierarchy / import dirty: broaden virtual-edge endpoints
  if (hierarchyDirty || importDirty) {
    for (const e of previous.edges) {
      if (e.virtual || e.resolution === "cha" || e.resolution === "rta" || e.resolution === "import_context") {
        affectedNodeIds.add(e.callerId);
        affectedNodeIds.add(e.calleeId);
      }
    }
  }

  // Soundness closure: if callee reset → callers reset
  let closed = true;
  do {
    closed = true;
    for (const e of previous.edges) {
      if (affectedNodeIds.has(e.calleeId) && !affectedNodeIds.has(e.callerId)) {
        affectedNodeIds.add(e.callerId);
        closed = false;
      }
    }
  } while (!closed);

  // Lift nodes → files
  const resetFiles = new Set<string>([
    ...seedFiles,
    ...changeSet.addedFiles,
    ...changeSet.deletedFiles,
  ]);
  for (const id of affectedNodeIds) {
    const n = previous.nodes[id];
    if (n) resetFiles.add(n.filePath);
  }

  const resetFileList = [...resetFiles];
  const totalFiles = new Set(Object.values(previous.nodes).map((n) => n.filePath)).size || 1;
  const fraction = resetFileList.length / Math.max(totalFiles, seedFiles.length);
  const fullRebuildThreshold = opts.fullRebuildFileFraction ?? 0.4;

  if (fraction >= fullRebuildThreshold && resetFileList.length >= 5) {
    return {
      strategy,
      seedFiles,
      resetFiles: resetFileList,
      resetNodeIds: [...affectedNodeIds],
      atomicChanges,
      hierarchyDirty,
      importDirty,
      shouldFullRebuild: true,
      reason: `reset_file_fraction_${fraction.toFixed(2)}>=${fullRebuildThreshold}`,
      methodChangeSummary: methodSummary,
      changedMethodFraction: changeSet.changedMethodFraction,
    };
  }

  const resetNodeIds: string[] = [];
  for (const n of Object.values(previous.nodes)) {
    if (resetFiles.has(n.filePath)) resetNodeIds.push(n.id);
  }

  return {
    strategy,
    seedFiles,
    resetFiles: resetFileList,
    resetNodeIds,
    atomicChanges,
    hierarchyDirty,
    importDirty,
    shouldFullRebuild: false,
    methodChangeSummary: methodSummary,
    changedMethodFraction: changeSet.changedMethodFraction,
  };
}


/** Deep-clone graph shell for mutation. */
export function cloneGraphShell(g: CallGraph): CallGraph {
  return {
    repoRoot: g.repoRoot,
    builtAt: g.builtAt,
    algorithm: g.algorithm,
    nodes: { ...g.nodes },
    edges: [...g.edges],
    outEdges: {},
    inEdges: {},
    byName: {},
    hierarchy: {
      parentsOf: { ...g.hierarchy.parentsOf },
      instantiated: [...g.hierarchy.instantiated],
      methodsOfType: { ...g.hierarchy.methodsOfType },
    },
    stats: { ...g.stats },
  };
}

/**
 * Reset phase: remove nodes in reset set and all incident edges.
 */
export function pruneAffectedRegion(graph: CallGraph, resetNodeIds: Set<string>): {
  graph: CallGraph;
  prunedNodes: number;
  prunedEdges: number;
} {
  const g = cloneGraphShell(graph);
  let prunedNodes = 0;
  for (const id of resetNodeIds) {
    if (g.nodes[id]) {
      delete g.nodes[id];
      prunedNodes++;
    }
  }
  const before = g.edges.length;
  g.edges = g.edges.filter(
    (e) => !resetNodeIds.has(e.callerId) && !resetNodeIds.has(e.calleeId),
  );
  const prunedEdges = before - g.edges.length;
  rebuildAdjacency(g);
  return { graph: g, prunedNodes, prunedEdges };
}

/**
 * Full reset-recompute pipeline.
 */
export function resetRecomputeCallGraph(
  previous: CallGraph,
  changedFiles: string[],
  opts: IncrementalOptions = {},
): { graph: CallGraph; stats: IncrementalStats } {
  const t0 = Date.now();
  const strategy: IncrementalStrategy = opts.strategy ?? "hybrid";
  const region = identifyAffectedRegion(previous, changedFiles, opts);

  if (region.shouldFullRebuild) {
    const graph = buildCallGraph(previous.repoRoot, opts);
    const stats: IncrementalStats = {
      strategy,
      mode: "full_rebuild",
      changedFiles: region.seedFiles,
      resetFiles: region.resetFiles,
      prunedNodes: previous.stats.nodeCount,
      prunedEdges: previous.stats.edgeCount,
      reusedNodes: 0,
      reusedEdges: 0,
      recomputedNodes: graph.stats.nodeCount,
      recomputedEdges: graph.stats.edgeCount,
      hierarchyDirty: region.hierarchyDirty,
      importDirty: region.importDirty,
      structuralFallback: true,
      methodChanges: region.methodChangeSummary,
      changedMethodFraction: region.changedMethodFraction,
      estimatedSpeedupVsFull: 1,
      residualLowConfidenceEdges: graph.edges.filter((e) => e.confidence === "low").length,
      durationMs: Date.now() - t0,
    };
    graph.lastIncremental = stats;
    return { graph, stats };
  }


  const resetNodeIds = new Set(region.resetNodeIds);
  // Also prune any node still in reset files (ids may have shifted)
  for (const n of Object.values(previous.nodes)) {
    if (region.resetFiles.includes(n.filePath)) resetNodeIds.add(n.id);
  }

  const { graph: surviving, prunedNodes, prunedEdges } = pruneAffectedRegion(
    previous,
    resetNodeIds,
  );

  // When an exact captured source set is supplied, it is the sole existence
  // authority. Never probe the mutable repository between capture and graph
  // recomputation.
  const filesToReanalyze = region.resetFiles.filter((f) =>
    opts.sources
      ? opts.sources.has(resolve(previous.repoRoot, f))
      : existsSync(join(previous.repoRoot, f)),
  );

  const partial = reanalyzeFiles(previous.repoRoot, filesToReanalyze, surviving, opts);

  // Merge nodes
  for (const [id, node] of Object.entries(partial.nodes)) {
    surviving.nodes[id] = node;
  }
  // Merge edges (skip if endpoints missing — shouldn't happen)
  const edgeIds = new Set(surviving.edges.map((e) => e.id));
  let recomputedEdges = 0;
  for (const e of partial.edges) {
    if (!surviving.nodes[e.callerId] || !surviving.nodes[e.calleeId]) continue;
    if (edgeIds.has(e.id)) continue;
    surviving.edges.push(e);
    edgeIds.add(e.id);
    recomputedEdges++;
  }

  // Hierarchy: if dirty, rebuild from survivors + partial; else merge
  if (region.hierarchyDirty) {
    surviving.hierarchy = mergeHierarchies(emptyHierarchy(), partial.hierarchy);
    // re-merge survivor-only types: rebuild hierarchy cheaply via full file scan of non-reset is expensive;
    // keep partial hierarchy union previous parents for non-reset types
    surviving.hierarchy = mergeHierarchies(previous.hierarchy, partial.hierarchy);
  } else {
    surviving.hierarchy = mergeHierarchies(surviving.hierarchy, partial.hierarchy);
  }

  rebuildAdjacency(surviving);
  surviving.builtAt = new Date().toISOString();
  surviving.algorithm = opts.algorithm ?? previous.algorithm;
  surviving.repoRoot = previous.repoRoot;

  const reusedNodes = Object.keys(surviving.nodes).length - Object.keys(partial.nodes).length;
  surviving.stats = {
    nodeCount: Object.keys(surviving.nodes).length,
    edgeCount: surviving.edges.length,
    directEdges: surviving.edges.filter((e) => e.resolution === "direct").length,
    approxEdges: surviving.edges.filter((e) => e.resolution !== "direct").length,
  };

  const provisional: IncrementalStats = {
    strategy,
    mode: "reset_recompute",
    changedFiles: region.seedFiles,
    resetFiles: region.resetFiles,
    prunedNodes,
    prunedEdges,
    reusedNodes: Math.max(0, reusedNodes),
    reusedEdges: Math.max(0, surviving.edges.length - recomputedEdges),
    recomputedNodes: Object.keys(partial.nodes).length,
    recomputedEdges,
    hierarchyDirty: region.hierarchyDirty,
    importDirty: region.importDirty,
    structuralFallback: false,
    methodChanges: region.methodChangeSummary,
    changedMethodFraction: region.changedMethodFraction,
    durationMs: Date.now() - t0,
  };
  surviving.lastIncremental = provisional;
  const eff = incrementalEfficiencyMetrics(previous, surviving);
  provisional.estimatedSpeedupVsFull = eff.estimatedSpeedupVsFull;
  provisional.residualLowConfidenceEdges = eff.residualLowConfidenceEdges;
  provisional.durationMs = Date.now() - t0;
  surviving.lastIncremental = provisional;

  return { graph: surviving, stats: provisional };
}


/**
 * Public entry: incremental update or full build.
 */
export function buildCallGraphIncremental(
  repoRoot: string,
  previous: CallGraph | null | undefined,
  changedFiles?: string[],
  opts: IncrementalOptions = {},
): CallGraph {
  if (!previous || !changedFiles?.length) {
    const g = buildCallGraph(repoRoot, opts);
    g.lastIncremental = {
      strategy: opts.strategy ?? "hybrid",
      mode: "full_rebuild",
      changedFiles: changedFiles ?? [],
      resetFiles: [],
      prunedNodes: 0,
      prunedEdges: 0,
      reusedNodes: 0,
      reusedEdges: 0,
      recomputedNodes: g.stats.nodeCount,
      recomputedEdges: g.stats.edgeCount,
      hierarchyDirty: false,
      durationMs: 0,
    };
    return g;
  }
  // Ensure previous.repoRoot matches
  const base = { ...previous, repoRoot: previous.repoRoot || repoRoot };
  return resetRecomputeCallGraph(base, changedFiles, opts).graph;
}

/** Compare two graphs for structural equivalence of call relationships (by stable keys). */
export function stableKey(n: FunctionNode): string {
  return `${n.filePath}::${n.enclosingType ?? ""}::${n.name}`;
}

export function graphCallPairs(g: CallGraph): Set<string> {
  const pairs = new Set<string>();
  for (const e of g.edges) {
    const a = g.nodes[e.callerId];
    const b = g.nodes[e.calleeId];
    if (!a || !b) continue;
    pairs.add(`${stableKey(a)}=>${stableKey(b)}`);
  }
  return pairs;
}
