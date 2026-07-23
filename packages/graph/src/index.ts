export {
  type GraphNodeKind,
  type GraphNode,
  type GraphEdge,
  type ProductGraph,
  withStats,
  node,
  edge,
} from "./types.js";

export { buildApiChangeGraph } from "./api-surface.js";

export {
  buildImpactGraph,
  mergeGraphs,
  surfacesFromImpactable,
  type FindingLike,
  type BuildImpactGraphInput,
} from "./impact.js";

export { buildProductKnowledgeGraph, type ProductGraphFocus } from "./product.js";

export {
  buildChangeImpactGraph,
  buildProviderApiGraph,
  invalidateGraphCaches,
} from "./build-from-db.js";

export { TtlCache, callGraphCache, productGraphCache, changeGraphCache } from "./cache.js";
