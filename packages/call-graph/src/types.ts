/**
 * Graph model for API impact analysis.
 *
 * Nodes = functions/methods; Edges = CALLS (caller → callee).
 * Prefer soundness (no missing edges) over precision; LLM stage filters noise.
 */

export type CallResolution =
  | "direct"
  | "name_match"
  | "cha"
  | "rta"
  | "import_context"
  | "virtual_approx"
  | "external_stub";

export type CallEdgeConfidence = "high" | "medium" | "low";

export type FunctionNode = {
  /** Stable id: filePath::name@lineStart */
  id: string;
  /** Human-readable qualified name e.g. src/payments.ts:chargeCustomer */
  qualifiedName: string;
  name: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: "typescript" | "javascript" | "python" | "go" | "java" | "other";
  /** Enclosing class/module if known */
  enclosingType?: string;
  isExternalApi: boolean;
  isTest: boolean;
  signature?: string;
  /** Content hash of function body for incremental rebuild */
  bodyHash?: string;
  /** Mendpoint-owned provenance for an alternate structural extractor. */
  structuralSource?: {
    tenantId: string;
    repositoryId: string;
    repositorySnapshotId: string;
    repositoryRevision: string;
    manifestDigest: string;
    structuralContentDigest: string;
    extractor: { id: string; version: string; digest: string };
    evidenceRefs: string[];
    epistemicState?: "observed" | "inferred" | "ambiguous";
  };
};

export type CallEdge = {
  id: string;
  callerId: string;
  calleeId: string;
  /** Call-site location in caller */
  callSiteFile: string;
  callSiteLine: number;
  resolution: CallResolution;
  confidence: CallEdgeConfidence;
  /** True if virtual/dynamic dispatch approximation */
  virtual: boolean;
  /** Mendpoint-owned provenance for an alternate structural extractor. */
  structuralSource?: {
    tenantId: string;
    repositoryId: string;
    repositorySnapshotId: string;
    repositoryRevision: string;
    manifestDigest: string;
    structuralContentDigest: string;
    extractor: { id: string; version: string; digest: string };
    evidenceRefs: string[];
    epistemicState?: "observed" | "inferred" | "ambiguous";
  };
};

export type TypeHierarchy = {
  /** type → parent types / interfaces */
  parentsOf: Record<string, string[]>;
  /** type → known instantiations (new X / X()) */
  instantiated: string[];
  /** method name → declaring types */
  methodsOfType: Record<string, string[]>;
};

export type IncrementalStrategy = "eager" | "conservative" | "hybrid";

/** Observability for reset-recompute updates. */
export type IncrementalStats = {
  strategy: IncrementalStrategy;
  mode: "full_rebuild" | "reset_recompute";
  changedFiles: string[];
  /** Files re-parsed after expansion of the affected region */
  resetFiles: string[];
  /** Method/function nodes pruned in reset phase */
  prunedNodes: number;
  /** Edges pruned in reset phase */
  prunedEdges: number;
  /** Nodes reused from previous graph */
  reusedNodes: number;
  /** Edges reused from previous graph */
  reusedEdges: number;
  /** Nodes inserted during recompute */
  recomputedNodes: number;
  /** Edges inserted during recompute */
  recomputedEdges: number;
  hierarchyDirty: boolean;
  importDirty?: boolean;
  structuralFallback?: boolean;
  /** Method-level classification counts */
  methodChanges?: {
    bodyEdits: number;
    signatureChanges: number;
    added: number;
    deleted: number;
  };
  changedMethodFraction?: number;
  /** Estimated speedup vs full rebuild (model) */
  estimatedSpeedupVsFull?: number;
  residualLowConfidenceEdges?: number;
  durationMs: number;
};


export type SkippedDirectory = {
  /** Repo-relative POSIX path of the pruned directory. */
  path: string;
  /**
   * Why traversal stopped here:
   * - `dependency-directory`: an unambiguous dependency/cache/tooling-output dir
   * - `virtualenv-marker`: a custom-named virtualenv confirmed by a pyvenv.cfg
   */
  reason: "dependency-directory" | "virtualenv-marker";
};

/** Auditable record of what the call-graph front-end pruned or could not analyze. */
export type CallGraphDiagnostics = {
  /** Directories pruned from traversal (dependency/cache/virtualenv trees). */
  skippedDirectories: SkippedDirectory[];
  /** Languages this front-end can extract functions for. */
  supportedLanguages: string[];
  /**
   * Source files seen during traversal whose language has no call-graph
   * front-end, so they contribute zero nodes/edges. Lets callers distinguish
   * "no edges found" from "this language is not in the call graph".
   */
  unsupportedLanguageFiles: Array<{ path: string; language: string }>;
};

export type CallGraph = {
  repoRoot: string;
  builtAt: string;
  algorithm: "name" | "cha" | "rta" | "hybrid";
  nodes: Record<string, FunctionNode>;
  edges: CallEdge[];
  /** Adjacency: callerId → edge ids */
  outEdges: Record<string, string[]>;
  /** Reverse adjacency: calleeId → edge ids */
  inEdges: Record<string, string[]>;
  /** name → node ids (for RA / name resolution) */
  byName: Record<string, string[]>;
  hierarchy: TypeHierarchy;
  stats: {
    nodeCount: number;
    edgeCount: number;
    directEdges: number;
    approxEdges: number;
  };
  /**
   * Traversal diagnostics: pruned directories and files skipped for lack of a
   * language front-end. Present on graphs produced by a full {@link buildCallGraph}.
   */
  diagnostics?: CallGraphDiagnostics;
  /** Present when graph was produced by incremental update */
  lastIncremental?: IncrementalStats;
};

/** Atomic semantic change derived from a file/method edit. */
export type AtomicChange =
  | { kind: "file_changed"; filePath: string }
  | { kind: "file_deleted"; filePath: string }
  | { kind: "file_added"; filePath: string }
  | { kind: "method_changed"; filePath: string; methodName: string; nodeId?: string }
  | {
      kind: "method_body_edit";
      filePath: string;
      methodName: string;
      nodeId?: string;
    }
  | {
      kind: "method_signature_change";
      filePath: string;
      methodName: string;
      nodeId?: string;
    }
  | { kind: "method_added"; filePath: string; methodName: string }
  | { kind: "method_deleted"; filePath: string; methodName: string; nodeId?: string }
  | { kind: "hierarchy_changed"; filePath: string }
  | { kind: "import_changed"; filePath: string }
  | { kind: "structural_change"; detail: string };

export type AffectedRegion = {
  strategy: IncrementalStrategy;
  seedFiles: string[];
  resetFiles: string[];
  resetNodeIds: string[];
  atomicChanges: AtomicChange[];
  hierarchyDirty: boolean;
  importDirty?: boolean;
  /** True when region is too large / unsafe — callers should full rebuild */
  shouldFullRebuild: boolean;
  reason?: string;
  methodChangeSummary?: {
    bodyEdits: number;
    signatureChanges: number;
    added: number;
    deleted: number;
  };
  changedMethodFraction?: number;
};



export type ReachabilityHit = {
  node: FunctionNode;
  depth: number;
  path: string[];
  minEdgeConfidence: CallEdgeConfidence;
};

export type ImpactSubgraph = {
  seedNodeIds: string[];
  nodes: FunctionNode[];
  edges: CallEdge[];
  upstream: ReachabilityHit[];
  wrappers: FunctionNode[];
};
