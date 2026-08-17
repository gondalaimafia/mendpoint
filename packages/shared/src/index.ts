import { z } from "zod";

export {
  explainError,
  normalizeErrorCode,
  cataloguedErrorCodes,
  type ExplainedError,
  type ErrorGuidanceEntry,
  type ExplainErrorInput,
} from "./error-guidance.js";

export {
  RENAMED_ENV,
  readRenamedEnv,
  resolveRenamedEnv,
  resolveEitherRenamedEnv,
  type RenamedEnvName,
} from "./renamed-env.js";

export {
  fetchBoundedText,
  type BoundedHttpOptions,
  type BoundedHttpResult,
} from "./bounded-http.js";

export {
  redactSourceForModel,
  type SourceRedactionCounts,
  type SourceRedactionExclusionReason,
  type SourceRedactionResult,
} from "./source-redaction.js";

export {
  DEPENDENCY_DIRECTORIES,
  PYTHON_VIRTUALENV_MARKER,
  classifyDependencyDirectory,
  type DependencyDirectoryDecision,
} from "./dependency-directories.js";

/**
 * Model egress boundary policy.
 *
 * Repository content is sent to a model provider as the chat-completions prompt.
 * The optional local_only mode enforces, at the application layer, that this
 * traffic can only reach a private, loopback, link-local, or operator
 * allowlisted host, so a customer can truthfully run within their own
 * infrastructure with control over where repository content goes.
 *
 * Default is external_allowed, which preserves the current behavior: any
 * reachable endpoint is permitted. This module is the single source of truth
 * for both resolve-time enforcement (agent) and boot validation (ops, warden
 * profile), so the two cannot drift.
 */

export type ModelEgressMode = "local_only" | "external_allowed";

export const MODEL_EGRESS_MODES: readonly ModelEgressMode[] = Object.freeze([
  "local_only",
  "external_allowed",
]);

export type ModelEgressViolation =
  | "model_egress_mode_invalid"
  | "model_egress_local_only_violation"
  | "warden_model_endpoint_invalid"
  | null;

export type ModelEgressAssessment = Readonly<{
  mode: ModelEgressMode;
  localOnly: boolean;
  endpointConfigured: boolean;
  endpointHost: string | null;
  localOnlySatisfied: boolean;
  violation: ModelEgressViolation;
}>;

type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * Resolve the configured egress mode. Any value other than the exact string
 * local_only (including unset) resolves to external_allowed so the default
 * preserves current behavior. Use isValidModelEgressMode to fail fast on typos.
 */
export function modelEgressMode(env: EnvLike = process.env): ModelEgressMode {
  return env.MENDPOINT_MODEL_EGRESS?.trim() === "local_only"
    ? "local_only"
    : "external_allowed";
}

/** True when the flag is unset, empty, or one of the two exact valid values. */
export function isValidModelEgressMode(value: string | undefined): boolean {
  const v = value?.trim();
  return v === undefined || v === "" || v === "local_only" || v === "external_allowed";
}

/**
 * The raw model endpoint the agent would call, using the same precedence as
 * resolveAgentModelEndpoint so boot validation matches resolve-time behavior.
 */
export function configuredModelEndpointUrl(env: EnvLike = process.env): string | null {
  return env.LLM_AGENT_URL?.trim() || env.OPENAI_BASE_URL?.trim() || null;
}

/** Parse the operator allowlist of private hosts into a lowercased set. */
export function parseModelLocalHosts(value: string | undefined): Set<string> {
  const hosts = new Set<string>();
  if (!value) return hosts;
  for (const raw of value.split(/[,\s]+/)) {
    const host = raw.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isPrivateIpv6(host: string): boolean {
  if (host === "::1") return true; // loopback
  const firstHextet = host.startsWith("::")
    ? 0
    : Number.parseInt(host.split(":")[0] ?? "", 16);
  if (!Number.isFinite(firstHextet)) return false;
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return true; // fc00::/7 unique local
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return true; // fe80::/10 link-local
  return false;
}

/**
 * Decide whether a URL host stays within the customer's environment.
 * Private means: loopback (127.0.0.0/8, ::1), private IPv4 (10/8, 172.16/12,
 * 192.168/16), link-local (169.254/16, fe80::/10), unique local IPv6
 * (fc00::/7), the localhost / .local / .localhost names, or a host on the
 * operator allowlist. A public hostname or address (for example api.meta.ai)
 * is not private.
 */
export function isPrivateModelHost(
  hostname: string,
  allowlist: ReadonlySet<string> = new Set(),
): boolean {
  let host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const zoneIndex = host.indexOf("%");
  if (zoneIndex >= 0) host = host.slice(0, zoneIndex);
  if (!host) return false;

  if (allowlist.has(host)) return true;
  if (host === "localhost") return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;

  const v4 = IPV4.exec(host);
  if (v4) {
    const octets = v4.slice(1, 5).map((part) => Number.parseInt(part, 10));
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 127) return true; // loopback 127.0.0.0/8
    if (a === 10) return true; // private 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    return false;
  }
  if (host.includes(":")) return isPrivateIpv6(host);
  return false;
}

/**
 * Assess the current model egress posture for boot validation and readiness.
 * When local_only is active, a configured endpoint must resolve to a private
 * host; a missing endpoint is allowed (heuristic-only, no egress).
 */
export function assessModelEgress(env: EnvLike = process.env): ModelEgressAssessment {
  const modeValid = isValidModelEgressMode(env.MENDPOINT_MODEL_EGRESS);
  const mode = modelEgressMode(env);
  const configured = configuredModelEndpointUrl(env);
  const endpointConfigured = configured !== null;
  let endpointHost: string | null = null;
  let hostParseFailed = false;
  if (configured) {
    try {
      endpointHost = new URL(configured).hostname;
    } catch {
      hostParseFailed = true;
    }
  }

  let violation: ModelEgressViolation = null;
  let localOnlySatisfied = true;
  if (!modeValid) {
    violation = "model_egress_mode_invalid";
  } else if (mode === "local_only" && endpointConfigured) {
    if (hostParseFailed) {
      violation = "warden_model_endpoint_invalid";
      localOnlySatisfied = false;
    } else if (
      !isPrivateModelHost(
        endpointHost ?? "",
        parseModelLocalHosts(env.MENDPOINT_MODEL_LOCAL_HOSTS),
      )
    ) {
      violation = "model_egress_local_only_violation";
      localOnlySatisfied = false;
    }
  }

  return Object.freeze({
    mode,
    localOnly: mode === "local_only",
    endpointConfigured,
    endpointHost,
    localOnlySatisfied,
    violation,
  });
}

export const ReviewedVerificationCommandSchema = z.object({
  command: z.string().min(1).max(500),
  ok: z.literal(true),
  exitCode: z.literal(0),
  outputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type ReviewedVerificationCommand = z.infer<typeof ReviewedVerificationCommandSchema>;

export const ReviewedChangeEvidenceSchema = z.object({
  path: z.string().min(1).max(1_000),
  rationale: z.string().min(1).max(500).nullable(),
  category: z.string().min(1).max(100).nullable(),
  risk: z.enum(["low", "medium", "high"]).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  assessmentSource: z.enum(["planner", "verifier", "unavailable"]),
  verification: z.object({
    summary: z.string().min(1).max(500),
    commandOutputSha256: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(20),
  }),
});
export type ReviewedChangeEvidence = z.infer<typeof ReviewedChangeEvidenceSchema>;

const CandidateReviewEvidenceV1Schema = z.object({
  schemaVersion: z.literal(1),
  summary: z.string().min(1).max(1_000),
  verification: z.object({
    summary: z.string().min(1).max(500),
    commands: z.array(ReviewedVerificationCommandSchema).min(1).max(20),
  }),
  edits: z.array(ReviewedChangeEvidenceSchema).min(1).max(40),
});

export const ReviewedPreciseChangeEvidenceSchema = z.object({
  path: z.string().min(1).max(1_000),
  hypothesis: z.string().min(1).max(500),
  targetSymbol: z.string().min(1).max(500).nullable(),
  sourceEvidence: z.array(z.object({
    path: z.string().min(1).max(1_000),
    digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })).min(1).max(40),
  precondition: z.string().min(1).max(1_000),
  expectedObservation: z.string().min(1).max(1_000),
  postcondition: z.string().min(1).max(1_000),
  rollback: z.string().min(1).max(1_000),
  stopCondition: z.string().min(1).max(1_000),
  risk: z.enum(["low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  assessmentSource: z.enum(["planner", "heuristic"]),
  verification: z.object({
    summary: z.string().min(1).max(500),
    commandOutputSha256: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).min(1).max(20),
  }),
});
export type ReviewedPreciseChangeEvidence = z.infer<typeof ReviewedPreciseChangeEvidenceSchema>;

export const CandidateReviewEvidenceV2Schema = z.object({
  schemaVersion: z.literal(2),
  summary: z.string().min(1).max(1_000),
  verification: z.object({
    summary: z.string().min(1).max(500),
    commands: z.array(ReviewedVerificationCommandSchema).min(1).max(20),
  }),
  edits: z.array(ReviewedPreciseChangeEvidenceSchema).min(1).max(40),
});
export type CandidateReviewEvidenceV2 = z.infer<typeof CandidateReviewEvidenceV2Schema>;

export const CandidateReviewEvidenceSchema = z.discriminatedUnion("schemaVersion", [
  CandidateReviewEvidenceV1Schema,
  CandidateReviewEvidenceV2Schema,
]);
export type CandidateReviewEvidence = z.infer<typeof CandidateReviewEvidenceSchema>;

/** Maximum response body the authenticated web bridge will accept from the API. */
export const WEB_PROXY_RESPONSE_BYTES = 5 * 1024 * 1024;

export const FEED_SUCCESS_FUTURE_SKEW_MS = 30_000;

export type FeedFreshnessAssessment = Readonly<{
  ok: boolean;
  reason:
    | "fresh"
    | "freshness_bound_invalid"
    | "success_missing"
    | "success_in_future"
    | "success_stale"
    | "poll_started_at_invalid"
    | "poll_started_in_future"
    | "poll_overdue";
  successAgeMs?: number;
  pollAgeMs?: number;
}>;

/**
 * One freshness rule for worker evidence and public readiness. The schedule's
 * stale window is authoritative; clock skew is bounded to the smaller of that
 * window and the global allowance.
 */
export function assessFeedFreshness(input: Readonly<{
  lastSuccessAt?: string;
  staleAfterMs?: number;
  pollStartedAt?: string;
  nowMs?: number;
  futureSkewMs?: number;
}>): FeedFreshnessAssessment {
  const staleAfterMs = input.staleAfterMs;
  if (
    typeof staleAfterMs !== "number" ||
    !Number.isSafeInteger(staleAfterMs) ||
    staleAfterMs < 1_000
  ) {
    return { ok: false, reason: "freshness_bound_invalid" };
  }
  const configuredSkew = input.futureSkewMs ?? FEED_SUCCESS_FUTURE_SKEW_MS;
  if (!Number.isSafeInteger(configuredSkew) || configuredSkew < 0) {
    return { ok: false, reason: "freshness_bound_invalid" };
  }
  const futureSkewMs = Math.min(staleAfterMs, configuredSkew);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) {
    return { ok: false, reason: "freshness_bound_invalid" };
  }
  const successAt = Date.parse(input.lastSuccessAt ?? "");
  if (!Number.isFinite(successAt)) return { ok: false, reason: "success_missing" };
  const successAgeMs = nowMs - successAt;
  if (successAgeMs < -futureSkewMs) {
    return { ok: false, reason: "success_in_future", successAgeMs };
  }
  if (successAgeMs > staleAfterMs) {
    return { ok: false, reason: "success_stale", successAgeMs };
  }
  if (input.pollStartedAt !== undefined) {
    const pollStartedAt = Date.parse(input.pollStartedAt);
    if (!Number.isFinite(pollStartedAt)) {
      return { ok: false, reason: "poll_started_at_invalid", successAgeMs };
    }
    const pollAgeMs = nowMs - pollStartedAt;
    if (pollAgeMs < -futureSkewMs) {
      return { ok: false, reason: "poll_started_in_future", successAgeMs, pollAgeMs };
    }
    if (pollAgeMs > staleAfterMs) {
      return { ok: false, reason: "poll_overdue", successAgeMs, pollAgeMs };
    }
    return { ok: true, reason: "fresh", successAgeMs, pollAgeMs };
  }
  return { ok: true, reason: "fresh", successAgeMs };
}

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
  "request_field_added",
  "request_field_removed",
  "request_field_renamed",
  "request_field_ambiguous",
  "response_field_removed",
  "response_field_added",
  "response_field_ambiguous",
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
  /** For ambiguous field changes: the plausible successors a human must choose between. */
  candidates: z.array(z.string()).optional(),
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
  /** For ambiguous field changes: the plausible successors a human must choose between. */
  candidates: z.array(z.string()).optional(),
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

/**
 * A field change the tool refuses to auto-apply because it has more than one
 * plausible successor. Reported so a human can choose; never turned into a
 * confident per-site finding or an edit.
 */
export const AmbiguousChangeSchema = z.object({
  op: DiffOpSchema,
  path: z.string().optional(),
  method: z.string().optional(),
  fromField: z.string(),
  candidates: z.array(z.string()),
  reason: z.string(),
});
export type AmbiguousChange = z.infer<typeof AmbiguousChangeSchema>;

/**
 * A generated (non-hand-written) file that references a changed surface. Editing
 * it is wrong because the next codegen overwrites the edit; the fix is to
 * regenerate from the updated spec. Surfaced as its own outcome, not a finding.
 */
export const GeneratedReferenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  symbol: z.string(),
  evidence: z.string(),
  relatedOps: z.array(DiffOpSchema).default([]),
  note: z.string(),
});
export type GeneratedReference = z.infer<typeof GeneratedReferenceSchema>;

/**
 * A vendored third-party file (a committed copy of a provider's own SDK) that
 * references a changed surface. Editing it is wrong because the customer does
 * not own that code and a hand-edit conflicts on the next re-vendoring; the fix
 * is to update the vendored copy from upstream. Surfaced as its own outcome,
 * not a finding.
 */
export const VendoredReferenceSchema = z.object({
  filePath: z.string(),
  lineStart: z.number().int().positive(),
  symbol: z.string(),
  evidence: z.string(),
  relatedOps: z.array(DiffOpSchema).default([]),
  note: z.string(),
});
export type VendoredReference = z.infer<typeof VendoredReferenceSchema>;

export const ImpactReportSchema = z.object({
  surfaces: z.array(ImpactableSurfaceSchema),
  sites: z.array(ConfirmedImpactSchema),
  overallRisk: ChangeRiskSchema,
  overallConfidence: ConfidenceSchema,
  strategySummary: z.string(),
  candidateCount: z.number().int().nonnegative(),
  confirmedCount: z.number().int().nonnegative(),
  lowConfidenceNotifications: z.array(ConfirmedImpactSchema).default([]),
  /** Field changes with multiple plausible successors — abstained, human decides. */
  ambiguousChanges: z.array(AmbiguousChangeSchema).optional(),
  /** Generated files that reference a changed surface — regenerate, do not edit. */
  generatedReferences: z.array(GeneratedReferenceSchema).optional(),
  /** Vendored third-party files that reference a changed surface — update from upstream, do not edit. */
  vendoredReferences: z.array(VendoredReferenceSchema).optional(),
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
