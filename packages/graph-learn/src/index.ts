export type {
  GlNodeKind,
  GlEdgeKind,
  GlNode,
  GlEdge,
  GraphQuery,
  GraphQueryResult,
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
