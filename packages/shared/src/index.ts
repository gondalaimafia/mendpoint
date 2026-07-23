import { z } from "zod";

export const ChangeRiskSchema = z.enum([
  "breaking",
  "non_breaking",
  "new_capability",
]);
export type ChangeRisk = z.infer<typeof ChangeRiskSchema>;

/** Provider rollout intent: required migrations vs optional adoption */
export const ChangeSeveritySchema = z.enum([
  "required",
  "recommended",
  "optional",
]);
export type ChangeSeverity = z.infer<typeof ChangeSeveritySchema>;

export const ConfidenceSchema = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const PrStatusSchema = z.enum([
  "draft",
  "open",
  "merged",
  "closed",
  "low_confidence",
]);
export type PrStatus = z.infer<typeof PrStatusSchema>;

export const DiffOpSchema = z.enum([
  "path_removed",
  "path_added",
  "method_removed",
  "method_added",
  "method_changed",
  "request_field_added_required",
  "request_field_removed",
  "request_field_renamed",
  "response_field_removed",
  "response_field_added",
  "security_changed",
]);
export type DiffOp = z.infer<typeof DiffOpSchema>;

export const DiffEntrySchema = z.object({
  op: DiffOpSchema,
  path: z.string().optional(),
  method: z.string().optional(),
  field: z.string().optional(),
  fromField: z.string().optional(),
  toField: z.string().optional(),
  detail: z.string().optional(),
  breaking: z.boolean(),
});
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const StructuralDiffSchema = z.object({
  entries: z.array(DiffEntrySchema),
  risk: ChangeRiskSchema,
  summary: z.string(),
});
export type StructuralDiff = z.infer<typeof StructuralDiffSchema>;

/** Canonical surface the rest of the impact pipeline queries against. */
export const ImpactableSurfaceSchema = z.object({
  id: z.string(),
  /** e.g. POST /v1/charges, provider.charges.create, response.amount_cents */
  canonicalId: z.string(),
  kind: z.enum([
    "http_path",
    "http_method",
    "request_field",
    "response_field",
    "sdk_method",
    "auth",
    "other",
  ]),
  op: DiffOpSchema,
  path: z.string().optional(),
  method: z.string().optional(),
  field: z.string().optional(),
  fromField: z.string().optional(),
  toField: z.string().optional(),
  before: z.string().optional(),
  after: z.string().optional(),
  severity: ChangeRiskSchema,
  migrationStrategy: z.string(),
  explanation: z.string(),
  providerNotes: z.string().optional(),
  searchTokens: z.array(z.string()),
});
export type ImpactableSurface = z.infer<typeof ImpactableSurfaceSchema>;

export const ImpactTypeSchema = z.enum([
  "direct_call",
  "field_access",
  "http_path",
  "configuration",
  "wrapper",
  "test_only",
  "sdk_import",
  "unknown",
]);
export type ImpactType = z.infer<typeof ImpactTypeSchema>;

export const CandidateSourceSchema = z.enum([
  "sdk_graph",
  "syntactic",
  "string_heuristic",
  "import_expansion",
  "embedding",
]);
export type CandidateSource = z.infer<typeof CandidateSourceSchema>;

export const CandidateSiteSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  symbol: z.string(),
  functionName: z.string().optional(),
  surfaceIds: z.array(z.string()),
  sources: z.array(CandidateSourceSchema),
  initialConfidence: ConfidenceSchema,
  evidence: z.string(),
});
export type CandidateSite = z.infer<typeof CandidateSiteSchema>;

export const ExpandedContextSchema = z.object({
  candidate: CandidateSiteSchema,
  enclosingFunction: z.string().optional(),
  /** Simple name list (compat) */
  callers: z.array(z.string()).default([]),
  callees: z.array(z.string()).default([]),
  slice: z.string(),
  isTestFile: z.boolean().default(false),
  packageBoundary: z.string().optional(),
  /** Call-graph expansion: qualified upstream callers with depth */
  graphCallers: z
    .array(
      z.object({
        qualifiedName: z.string(),
        name: z.string(),
        filePath: z.string(),
        depth: z.number().int().nonnegative(),
        confidence: ConfidenceSchema,
      }),
    )
    .default([]),
  /** Service-layer wrappers detected via reverse reachability */
  wrappers: z.array(z.string()).default([]),
  /** Seed function node id in the call graph, if resolved */
  graphNodeId: z.string().optional(),
});
export type ExpandedContext = z.infer<typeof ExpandedContextSchema>;


export const ConfirmedImpactSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  symbol: z.string(),
  confidence: ConfidenceSchema,
  evidence: z.string(),
  impactType: ImpactTypeSchema,
  surfaceIds: z.array(z.string()),
  relatedOps: z.array(DiffOpSchema).default([]),
  fixHint: z.string().optional(),
  confirmationPath: z.enum(["static", "hybrid_llm", "heuristic"]),
});
export type ConfirmedImpact = z.infer<typeof ConfirmedImpactSchema>;

export const ImpactReportSchema = z.object({
  surfaces: z.array(ImpactableSurfaceSchema),
  sites: z.array(ConfirmedImpactSchema),
  overallRisk: ChangeRiskSchema,
  overallConfidence: ConfidenceSchema,
  strategySummary: z.string(),
  candidateCount: z.number().int().nonnegative(),
  confirmedCount: z.number().int().nonnegative(),
  lowConfidenceNotifications: z.array(ConfirmedImpactSchema).default([]),
});
export type ImpactReport = z.infer<typeof ImpactReportSchema>;

/** Backward-compatible finding shape used by DB/API layers. */
export const ImpactFindingSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  symbol: z.string(),
  confidence: ConfidenceSchema,
  evidence: z.string(),
  relatedOps: z.array(DiffOpSchema).default([]),
  impactType: ImpactTypeSchema.optional(),
  fixHint: z.string().optional(),
  surfaceIds: z.array(z.string()).optional(),
});
export type ImpactFinding = z.infer<typeof ImpactFindingSchema>;

export const MigrationDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  branchName: z.string(),
  patch: z.string(),
  risk: ChangeRiskSchema,
  confidence: ConfidenceSchema,
  fileEdits: z.array(
    z.object({
      path: z.string(),
      original: z.string(),
      updated: z.string(),
    }),
  ),
});
export type MigrationDraft = z.infer<typeof MigrationDraftSchema>;

export const FeedbackOutcomeSchema = z.enum(["merged", "closed", "modified"]);
export type FeedbackOutcome = z.infer<typeof FeedbackOutcomeSchema>;

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export type Result<T, E = string> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<E = string>(error: E): Result<never, E> {
  return { ok: false, error };
}

export const CONF_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function minConfidence(
  a: Confidence,
  b: Confidence,
): Confidence {
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}

export function maxConfidence(
  a: Confidence,
  b: Confidence,
): Confidence {
  return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

export function confirmedToFinding(c: ConfirmedImpact): ImpactFinding {
  return {
    filePath: c.filePath,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    symbol: c.symbol,
    confidence: c.confidence,
    evidence: c.evidence,
    relatedOps: c.relatedOps,
    impactType: c.impactType,
    fixHint: c.fixHint,
    surfaceIds: c.surfaceIds,
  };
}
