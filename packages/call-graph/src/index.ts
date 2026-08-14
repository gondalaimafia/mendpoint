/**
 * @mendpoint/call-graph
 *
 * Graph-based call graph construction & querying for API impact analysis.
 * Expands direct API usage sites to wrappers, helpers, and transitive callers.
 * Supports method-level reset-recompute incremental updates.
 */

export type {
  AtomicChange,
  AffectedRegion,
  CallEdge,
  CallEdgeConfidence,
  CallGraph,
  CallGraphDiagnostics,
  CallResolution,
  FunctionNode,
  ImpactSubgraph,
  IncrementalStats,
  IncrementalStrategy,
  ReachabilityHit,
  SkippedDirectory,
  TypeHierarchy,
} from "./types.js";

export { buildCallGraph, type BuildCallGraphOptions } from "./build.js";

export {
  buildCallGraphIncremental,
  resetRecomputeCallGraph,
  identifyAffectedRegion,
  collectAtomicChanges,
  changeSetToAtomic,
  pruneAffectedRegion,
  graphCallPairs,
  stableKey,
  type IncrementalOptions,
} from "./incremental.js";

export {
  classifyChanges,
  shouldFullRebuildFromChangeSet,
  extractMethodsFromSource,
  methodStableKey,
  type ChangeSet,
  type ClassifiedMethodChange,
  type MethodChangeKind,
  type StructuralFlags,
} from "./change-detect.js";

export {
  createSnapshotStore,
  pushSnapshot,
  latestSnapshot,
  maybeRollback,
  type GraphSnapshot,
  type SnapshotStore,
} from "./snapshot.js";

export {
  createRedGreenCache,
  redGreenQuery,
  markRed,
  syncCacheToGraph,
  graphVersion,
  type RedGreenCache,
} from "./red-green.js";

export {
  demandImpactSlice,
  resolveDemandSeeds,
  residualUncertainties,
  type DemandQuery,
} from "./demand.js";

export {
  validateAgainstFullRebuild,
  incrementalEfficiencyMetrics,
  type SoundnessReport,
} from "./validate.js";

export {
  createPersistentStore,
  commitGraphVersion,
  commitAfterIncremental,
  materializeVersion,
  versionsEqual,
  diffVersions,
  tagVersion,
  findVersionByTag,
  registerLibrary,
  saveStoreToDisk,
  loadStoreFromDisk,
  compactVersionIndex,
  gcUnreferenced,
  latestSharingRatio,
  structuralHash,
  hashRoot,
  nodeStableKey as persistentNodeStableKey,
  type PersistentGraphStore,
  type GraphVersionMeta,
  type ContentHash,
  type StoredNodePayload,
  type StoredEdgePayload,
  type LibraryRef,
} from "./persistent.js";

export {
  nodesByName,
  nodeAt,
  nodeByFileName,
  reverseReachability,
  forwardReachability,
  findWrappers,
  impactSubgraph,
  directCallers,
  directCallees,
  propagateConfidence,
} from "./query.js";

export { confRank, minConf } from "./build.js";
