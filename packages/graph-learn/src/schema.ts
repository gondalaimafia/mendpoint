/**
 * Minimal common node/edge schema for API Graph + Code Graph + outcomes.
 * Swap-ready for Kùzu/Neo4j; v1 uses SQLite property graph.
 */

export type GlNodeKind =
  | "provider"
  | "service"
  | "endpoint"
  | "schema"
  | "field"
  | "auth_scope"
  | "consumer"
  | "error_type"
  | "slo"
  | "change"
  | "surface"
  | "pr"
  | "file"
  | "symbol"
  | "callsite"
  | "table"
  | "business_rule"
  | "invariant"
  | "bsg_node"
  | "pattern";

export type GlEdgeKind =
  | "calls"
  | "depends_on"
  | "deprecated_by"
  | "breaks"
  | "secures"
  | "versions_of"
  | "monitors"
  | "impacts"
  | "imports"
  | "reads"
  | "writes"
  | "preserves_behavior"
  | "migrated_from"
  | "has_field"
  | "has_endpoint"
  | "outcome_merged"
  | "outcome_closed"
  | "outcome_broke"
  | "outcome_waived"
  | "related";

export type GlNode = {
  id: string;
  kind: GlNodeKind;
  label: string;
  props?: Record<string, unknown>;
};

export type GlEdge = {
  id: string;
  kind: GlEdgeKind;
  source: string;
  target: string;
  props?: Record<string, unknown>;
  /** For GNN later: positive/negative label from PR outcomes */
  label?: number;
};

export type GraphQuery =
  | { op: "who_consumes_provider"; providerSlug: string }
  | { op: "who_consumes_endpoint"; providerSlug: string; path: string; method?: string }
  | { op: "blast_radius"; nodeId: string; maxHops?: number }
  | { op: "neighbors"; nodeId: string; edgeKinds?: GlEdgeKind[]; direction?: "out" | "in" | "both" }
  | { op: "neighborhood"; nodeId: string; k?: number }
  | { op: "callers"; symbolId: string; maxHops?: number }
  | { op: "path"; fromId: string; toId: string; maxHops?: number }
  | { op: "depends_on_path"; nodeId: string; maxHops?: number }
  | { op: "outcomes_for_pattern"; pattern: string }
  | { op: "pattern_success_rates"; minSamples?: number }
  | { op: "stats" };

export type GraphQueryResult = {
  op: string;
  nodes: GlNode[];
  edges: GlEdge[];
  summary: string;
  rows?: Array<Record<string, unknown>>;
};
