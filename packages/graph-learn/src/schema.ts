/**
 * Graph Schema v0 — source of truth code mirror of /schema/v0.md
 * Node labels: PascalCase · Edge types: SCREAMING_SNAKE · props: snake_case
 * SQLite store; Kùzu-native naming for future migration.
 */
import { z } from "zod";

/** Universal node properties (plus kind-specific props in `props`). */
export type GlNode = {
  id: string;
  /** PascalCase label */
  kind: GlNodeKind;
  label: string;
  repo_id?: string;
  first_seen?: string;
  last_seen?: string;
  /** Optional RANGER-style embedding stub — not populated in Phase 1 */
  embedding?: number[];
  meta?: Record<string, string>;
  props?: Record<string, unknown>;
};

/** Universal edge properties */
export type GlEdge = {
  id: string;
  /** SCREAMING_SNAKE type */
  kind: GlEdgeKind;
  source: string;
  target: string;
  valid_from?: string;
  valid_to?: string | null;
  /** Provenance: ast | lsp | runtime | ci | git | spec | pr_outcome | human | pipeline */
  source_system?: string;
  confidence?: number;
  /** GNN / outcome label */
  label?: number;
  props?: Record<string, unknown>;
};

export type GlNodeKind =
  // base structural
  | "Repository"
  | "Commit"
  | "PullRequest"
  | "File"
  | "Module"
  | "Symbol"
  | "Test"
  // people / process
  | "Author"
  | "Reviewer"
  | "Agent"
  | "Run"
  | "Plan"
  // semantic
  | "Pattern"
  | "Invariant"
  | "Trace"
  | "Evidence"
  // Warden
  | "Service"
  | "Endpoint"
  | "Schema"
  | "Field"
  | "AuthScope"
  | "ErrorType"
  | "Consumer"
  | "SLO"
  | "RateLimit"
  | "Deployment"
  | "RepositorySnapshot"
  | "Provider"
  | "Change"
  | "Surface"
  // Transformer
  | "LegacySystem"
  | "TargetSystem"
  | "Campaign"
  | "MigrationUnit"
  | "BSGNode"
  | "DataStore"
  | "BusinessRule"
  | "DialectFeature";

export type GlEdgeKind =
  // structural
  | "CONTAINS"
  | "DEFINES"
  | "DECLARES"
  | "CALLS"
  | "IMPORTS"
  | "READS_FIELD"
  | "WRITES_FIELD"
  | "READS_TABLE"
  | "WRITES_TABLE"
  | "RETURNS"
  | "INHERITS_FROM"
  | "IMPLEMENTS"
  | "TESTS"
  // spec / contract
  | "EXPOSES"
  | "HAS_SCHEMA"
  | "HAS_FIELD"
  | "REQUIRES_SCOPE"
  | "RETURNS_ERROR"
  | "RATE_LIMITED_BY"
  | "GOVERNED_BY_SLO"
  | "IMPLEMENTED_BY"
  | "CONSUMES"
  | "DEPRECATES"
  | "VERSIONS"
  | "MONITORS"
  | "BREAKS"
  | "IMPACTS"
  | "HAS_ENDPOINT"
  // migration
  | "IN_CAMPAIGN"
  | "MIGRATES"
  | "DEPENDS_ON"
  | "EXTRACTED_FROM"
  | "REALIZED_BY"
  | "PRESERVES_INVARIANT"
  | "ENCODES_RULE"
  | "USES_DIALECT"
  | "MAPS_TO_TARGET"
  | "MIGRATED_FROM"
  // process
  | "AUTHORED"
  | "MODIFIES"
  | "INCLUDES_COMMIT"
  | "TOUCHES"
  | "REVIEWED"
  | "PRODUCED"
  | "EVIDENCES"
  | "EXECUTED_PLAN"
  | "RELATED"
  // outcome / learning
  | "SUCCEEDED_ON"
  | "BROKE"
  | "REQUIRED_HUMAN_FIX"
  | "REVERTED_FOR"
  | "MATCHED_PATTERN"
  | "PROMOTED"
  | "TRAINED_ON"
  | "OUTCOME_MERGED"
  | "OUTCOME_CLOSED"
  | "OUTCOME_BROKE"
  | "OUTCOME_WAIVED";

/** Map legacy lowercase kinds → v0 (for reads of old rows). */
export const LEGACY_NODE_KIND: Record<string, GlNodeKind> = {
  provider: "Provider",
  service: "Service",
  endpoint: "Endpoint",
  schema: "Schema",
  field: "Field",
  auth_scope: "AuthScope",
  consumer: "Consumer",
  error_type: "ErrorType",
  slo: "SLO",
  change: "Change",
  surface: "Surface",
  pr: "PullRequest",
  file: "File",
  symbol: "Symbol",
  callsite: "Symbol",
  table: "DataStore",
  business_rule: "BusinessRule",
  invariant: "Invariant",
  bsg_node: "BSGNode",
  pattern: "Pattern",
};

export const LEGACY_EDGE_KIND: Record<string, GlEdgeKind> = {
  calls: "CALLS",
  depends_on: "DEPENDS_ON",
  deprecated_by: "DEPRECATES",
  breaks: "BREAKS",
  secures: "REQUIRES_SCOPE",
  versions_of: "VERSIONS",
  monitors: "MONITORS",
  impacts: "IMPACTS",
  imports: "IMPORTS",
  reads: "READS_FIELD",
  writes: "WRITES_FIELD",
  preserves_behavior: "PRESERVES_INVARIANT",
  migrated_from: "MIGRATED_FROM",
  has_field: "HAS_FIELD",
  has_endpoint: "HAS_ENDPOINT",
  outcome_merged: "OUTCOME_MERGED",
  outcome_closed: "OUTCOME_CLOSED",
  outcome_broke: "OUTCOME_BROKE",
  outcome_waived: "OUTCOME_WAIVED",
  related: "RELATED",
};

export function normalizeNodeKind(k: string): GlNodeKind {
  if (LEGACY_NODE_KIND[k]) return LEGACY_NODE_KIND[k]!;
  return k as GlNodeKind;
}

export function normalizeEdgeKind(k: string): GlEdgeKind {
  if (LEGACY_EDGE_KIND[k]) return LEGACY_EDGE_KIND[k]!;
  return k as GlEdgeKind;
}

export type GraphQuery =
  | { op: "who_consumes_provider"; providerSlug: string }
  | { op: "who_consumes_endpoint"; providerSlug: string; path: string; method?: string }
  | { op: "blast_radius"; nodeId: string; maxHops?: number }
  | { op: "neighbors"; nodeId: string; edgeKinds?: GlEdgeKind[]; direction?: "out" | "in" | "both" }
  | { op: "neighborhood"; nodeId: string; k?: number }
  | { op: "callers"; symbolId: string; maxHops?: number }
  | { op: "path"; fromId: string; toId: string; maxHops?: number }
  | { op: "depends_on_path"; nodeId: string; maxHops?: number; maxPaths?: number }
  | { op: "outcomes_for_pattern"; pattern: string }
  | { op: "pattern_success_rates"; minSamples?: number }
  | { op: "consumers_of_field"; schemaName: string; fieldName: string }
  | { op: "broke_modes_for_endpoint"; operationId: string }
  | { op: "migration_ready_units"; campaignId: string; batchSize?: number }
  | { op: "invariants_for_symbol"; qualifiedName: string }
  | { op: "time_travel_calls"; at: string }
  | { op: "time_travel_modifies"; at: string; repoId?: string }
  | { op: "latency_stats" }
  | {
      op: "repository_evidence";
      repositoryId: string;
      snapshotId?: string;
      evidenceTypes?: Array<"runtime_trace" | "test_coverage" | "codeowners" | "ci" | "deployment" | "collector">;
      limit?: number;
    }
  | { op: "stats" };

/**
 * Runtime validator for {@link GraphQuery}. The POST /graph-learn/query route
 * parses request bodies through this instead of casting an untrusted body, so a
 * malformed query is rejected with 400 at the boundary rather than reaching the
 * engine and failing with 500. It validates the op discriminant and each field's
 * shape; numeric traversal bounds are accepted here (oversized values are clamped
 * by the engine, which owns the hard ceilings) but must be the correct type.
 */
export const GraphQuerySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("who_consumes_provider"), providerSlug: z.string() }),
  z.object({
    op: z.literal("who_consumes_endpoint"),
    providerSlug: z.string(),
    path: z.string(),
    method: z.string().optional(),
  }),
  z.object({
    op: z.literal("blast_radius"),
    nodeId: z.string(),
    maxHops: z.number().optional(),
  }),
  z.object({
    op: z.literal("neighbors"),
    nodeId: z.string(),
    edgeKinds: z.array(z.custom<GlEdgeKind>()).optional(),
    direction: z.enum(["out", "in", "both"]).optional(),
  }),
  z.object({
    op: z.literal("neighborhood"),
    nodeId: z.string(),
    k: z.number().optional(),
  }),
  z.object({
    op: z.literal("callers"),
    symbolId: z.string(),
    maxHops: z.number().optional(),
  }),
  z.object({
    op: z.literal("path"),
    fromId: z.string(),
    toId: z.string(),
    maxHops: z.number().optional(),
  }),
  z.object({
    op: z.literal("depends_on_path"),
    nodeId: z.string(),
    maxHops: z.number().optional(),
    maxPaths: z.number().optional(),
  }),
  z.object({ op: z.literal("outcomes_for_pattern"), pattern: z.string() }),
  z.object({
    op: z.literal("pattern_success_rates"),
    minSamples: z.number().optional(),
  }),
  z.object({
    op: z.literal("consumers_of_field"),
    schemaName: z.string(),
    fieldName: z.string(),
  }),
  z.object({ op: z.literal("broke_modes_for_endpoint"), operationId: z.string() }),
  z.object({
    op: z.literal("migration_ready_units"),
    campaignId: z.string(),
    batchSize: z.number().optional(),
  }),
  z.object({ op: z.literal("invariants_for_symbol"), qualifiedName: z.string() }),
  z.object({ op: z.literal("time_travel_calls"), at: z.string() }),
  z.object({
    op: z.literal("time_travel_modifies"),
    at: z.string(),
    repoId: z.string().optional(),
  }),
  z.object({ op: z.literal("latency_stats") }),
  z.object({
    op: z.literal("repository_evidence"),
    repositoryId: z.string(),
    snapshotId: z.string().optional(),
    evidenceTypes: z
      .array(
        z.enum([
          "runtime_trace",
          "test_coverage",
          "codeowners",
          "ci",
          "deployment",
          "collector",
        ]),
      )
      .optional(),
    limit: z.number().optional(),
  }),
  z.object({ op: z.literal("stats") }),
]);

/**
 * Coverage assessment for a graph query result. Every op carries one so a caller
 * can never mistake an empty result for a definitive "nothing depends on this":
 *
 *  - `complete`      — the result enumerates everything within the query's scope.
 *  - `partial`       — a safety bound (max hops/paths) stopped enumeration early;
 *    there may be more than what is returned.
 *  - `target_absent` — the queried node/entity is not in the (tenant) graph, so
 *    an empty result means "we have never seen it", NOT "it has no relationships".
 */
export type GraphQueryCoverage = {
  basis: "complete" | "partial" | "target_absent";
  reason?: string;
};

export type GraphQueryResult = {
  op: string;
  nodes: GlNode[];
  edges: GlEdge[];
  summary: string;
  rows?: Array<Record<string, unknown>>;
  /**
   * Coverage of this result. Optional only for backward-compatibility with
   * results built before this field existed; {@link runGraphQuery} normalizes
   * every returned result to carry one (defaulting to `complete`).
   */
  coverage?: GraphQueryCoverage;
  truncation?: {
    truncated: boolean;
    reasons: Array<"max_hops" | "max_paths">;
    maxHops: number;
    maxPaths: number;
    pathsReturned: number;
    omittedPathsAtLeast: number;
  };
};

/** Kùzu-shaped DDL string for escape hatch docs / generators */
export const KUZU_DDL_V0 = `
CREATE NODE TABLE IF NOT EXISTS Node(
  id STRING,
  kind STRING,
  label STRING,
  repo_id STRING,
  first_seen STRING,
  last_seen STRING,
  props STRING,
  PRIMARY KEY(id)
);
CREATE REL TABLE IF NOT EXISTS Edge(
  FROM Node TO Node,
  kind STRING,
  valid_from STRING,
  valid_to STRING,
  source_system STRING,
  confidence DOUBLE,
  label DOUBLE,
  props STRING
);
`.trim();
