export type {
  GlNodeKind,
  GlEdgeKind,
  GlNode,
  GlEdge,
  GraphQuery,
  GraphQueryResult,
} from "./schema.js";
export {
  LEGACY_NODE_KIND,
  LEGACY_EDGE_KIND,
  normalizeNodeKind,
  normalizeEdgeKind,
  KUZU_DDL_V0,
  GraphQuerySchema,
} from "./schema.js";

export {
  openGraphLearnDb,
  openGraphLearnMemory,
  upsertNode,
  upsertEdge,
  getNode,
  deleteNode,
  deleteEdge,
  deleteFileSubgraph,
  listAllNodes,
  listAllEdges,
  listNodesByKind,
  edgesFrom,
  edgesTo,
  edgesByKindAt,
  countStats,
  type GraphLearnDb,
} from "./store.js";

export {
  createTenantGraphView,
  graphNodeBelongsToTenant,
  tenantPatternSuccessRows,
  type GraphTenantScope,
} from "./tenant-scope.js";

export {
  enumerateDependencyPaths,
  type DependencyPath,
  type DependencyPathEnumeration,
  type DependencyPathTerminal,
  type DependencyPathTruncation,
} from "./dependency-paths.js";

export {
  ingestControlPlane,
  ingestSpecDiff,
  ingestImpactFindings,
  labelPrOutcome,
} from "./ingest.js";

export {
  ingestRepositoryEvidence,
  repositorySnapshotNodeId,
  type RepositoryEvidence,
  type RepositoryEvidenceType,
  type RuntimeTraceEvidence,
  type TestCoverageEvidence,
  type CodeownersEvidence,
  type CiEvidence,
  type DeploymentEvidence,
  type CollectorEvidence,
  type IngestRepositoryEvidenceInput,
} from "./runtime-evidence.js";

export {
  runGraphQuery,
  blastRadius,
  formatQueryForPlanner,
  GRAPH_RAG_TOOLS,
} from "./query.js";

export { getGraphLearnDb, resetGraphLearnDbForTests } from "./singleton.js";

export { runGraphBenchmark, BENCH_CASES } from "./benchmark.js";

export {
  CONFIDENCE_CALIBRATION_VERSION,
  evaluateConfidenceCalibration,
  type ConfidencePhase,
  type ConfidencePhasePolicy,
  type ConfidenceCalibrationSample,
  type ConfidenceCalibrationContract,
  type CalibrationBin,
  type ConfidencePhaseReport,
  type ConfidenceCalibrationReport,
} from "./confidence-calibration.js";

export {
  IMPACT_BENCHMARK_VERSION,
  runImpactBenchmark,
  type ImpactScaleTier,
  type ImpactBenchmarkCase,
  type ImpactPrediction,
  type ImpactBenchmarkContract,
  type ImpactBenchmarkReport,
} from "./impact-benchmark.js";

export {
  backfillGitTemporal,
  seedSyntheticTemporal,
  parseGitLog,
  type GitTemporalOptions,
  type GitTemporalResult,
} from "./git-temporal.js";

export {
  recordLatency,
  resetLatencySamples,
  latencyReport,
  latencyForOp,
  checkSlos,
  formatLatencyReport,
  setSloTargets,
  percentile,
  DEFAULT_SLO_TARGETS,
  type SloTarget,
  type OpLatency,
} from "./slo.js";

export {
  extractSymbolsFromSource,
  ingestAstRepo,
  ingestAstFile,
  listCodeFiles,
  reconcileAstCallTargets,
  type AstIngestResult,
} from "./ast-ingest.js";

export {
  heuristicTsBackend,
  heuristicPythonBackend,
  ingestLspSymbols,
  lspSymbolsForFile,
  lspWorkspaceRootHint,
  type LspSymbol,
  type LspBackend,
  type LspIngestResult,
} from "./lsp-ingest.js";

export {
  incrementalReingest,
  loadSnapshot,
  saveSnapshot,
  clearSnapshot,
  type IncrementalResult,
  type FileHashSnapshot,
} from "./incremental.js";

export {
  hashEmbedding,
  embedGraphNodes,
  getNodeEmbedding,
  cosineSimilarity,
  type EmbedResult,
} from "./embeddings.js";

export {
  kuzuStatus,
  exportSqliteToKuzuScript,
  tryOpenKuzu,
  type KuzuStatus,
  type KuzuExportScript,
} from "./kuzu-path.js";

export {
  pickGraphQuery,
  rankOpsByOutcomes,
  type QueryPick,
} from "./query-pick.js";

export {
  exportGnnFeatures,
  writeGnnExport,
  type GnnExport,
  type GnnNodeFeature,
  type GnnEdgeFeature,
} from "./gnn-export.js";

export {
  promotePatterns,
  listPromotedPatterns,
  type Promotion,
  type PromoteOptions,
} from "./meta-graph.js";

export {
  measureAbLift,
  formatAbReport,
  type AbReport,
  type AbArm,
} from "./ab.js";
