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
} from "./schema.js";

export {
  openGraphLearnDb,
  openGraphLearnMemory,
  upsertNode,
  upsertEdge,
  getNode,
  listNodesByKind,
  edgesFrom,
  edgesTo,
  countStats,
  type GraphLearnDb,
} from "./store.js";

export {
  ingestControlPlane,
  ingestSpecDiff,
  ingestImpactFindings,
  labelPrOutcome,
} from "./ingest.js";

export {
  runGraphQuery,
  blastRadius,
  formatQueryForPlanner,
  GRAPH_RAG_TOOLS,
} from "./query.js";

export { getGraphLearnDb, resetGraphLearnDbForTests } from "./singleton.js";

export { runGraphBenchmark, BENCH_CASES } from "./benchmark.js";
