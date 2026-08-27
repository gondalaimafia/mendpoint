import { z } from "zod";

export const REGAUGE_MISSION_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;

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
  RETIRED_ENV,
  RETIRED_ENV_ALIASES,
  readRenamedEnv,
  resolveRenamedEnv,
  resolveEitherRenamedEnv,
  type RenamedEnvName,
  type ActiveRenamedEnvName,
  type RetiredRenamedEnvName,
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
 * Egress-relevant slice of the model provider registry, keyed by provider id.
 * This mirrors, for boot validation only, how packages/agent's provider
 * registry resolves a provider's base URL: the ordered base-URL env vars
 * (first non-empty wins) and the hardcoded default used when none is set.
 *
 * It is a mirror, not the source of truth. Resolve-time enforcement in
 * packages/agent (`enforceModelEndpointEgress`, applied to the fully-resolved
 * endpoint) is authoritative and covers every provider unconditionally; this
 * table only lets boot validation report a would-be violation early. If it ever
 * drifts from the registry, an unrecognized provider id falls through to the
 * fail-closed branch in effectiveModelEndpointUrl / assessModelEgress (a
 * violation under local_only), never a silent pass.
 */
const MODEL_PROVIDER_EGRESS_ENDPOINTS: ReadonlyMap<
  string,
  Readonly<{ baseUrlEnvVars: readonly string[]; defaultBaseUrl: string | null }>
> = new Map([
  ["muse-spark", { baseUrlEnvVars: ["LLM_AGENT_URL", "OPENAI_BASE_URL"], defaultBaseUrl: null }],
  ["openai", { baseUrlEnvVars: ["OPENAI_BASE_URL"], defaultBaseUrl: "https://api.openai.com" }],
  ["xai", { baseUrlEnvVars: ["XAI_BASE_URL"], defaultBaseUrl: "https://api.x.ai" }],
  ["openai-gateway", { baseUrlEnvVars: ["LLM_AGENT_URL", "OPENAI_BASE_URL"], defaultBaseUrl: null }],
  ["anthropic", { baseUrlEnvVars: ["ANTHROPIC_BASE_URL"], defaultBaseUrl: "https://api.anthropic.com" }],
  ["gemini", { baseUrlEnvVars: ["GEMINI_BASE_URL"], defaultBaseUrl: "https://generativelanguage.googleapis.com" }],
]);

function firstModelEnvValue(keys: readonly string[], env: EnvLike): string | undefined {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export type EffectiveModelEndpoint = Readonly<{
  /** Base URL the agent would call, or null when nothing would be contacted. */
  url: string | null;
  /**
   * False only when MENDPOINT_MODEL_PROVIDER names a provider this boot-time
   * mirror does not recognize, so its endpoint cannot be determined and must
   * fail closed under local_only rather than be assumed local.
   */
  determinable: boolean;
}>;

/**
 * The base URL the agent would actually call under the current configuration,
 * matching resolveModelBackend's precedence so boot validation sees the same
 * endpoint the model path would use:
 * - MENDPOINT_MODEL_PROVIDER unset => LLM_AGENT_URL || OPENAI_BASE_URL (today's
 *   default path), or null when neither is set (heuristic-only, no egress).
 * - a recognized provider id => its first configured base-URL env var, else its
 *   hardcoded default, else null (no base URL and no default => nothing called).
 * - an unrecognized provider id => not determinable (fails closed under
 *   local_only).
 */
export function effectiveModelEndpointUrl(env: EnvLike = process.env): EffectiveModelEndpoint {
  const provider = env.MENDPOINT_MODEL_PROVIDER?.trim();
  if (!provider) {
    return Object.freeze({ url: configuredModelEndpointUrl(env), determinable: true });
  }
  const descriptor = MODEL_PROVIDER_EGRESS_ENDPOINTS.get(provider);
  if (!descriptor) {
    return Object.freeze({ url: null, determinable: false });
  }
  const baseUrl = firstModelEnvValue(descriptor.baseUrlEnvVars, env) ?? descriptor.defaultBaseUrl;
  return Object.freeze({ url: baseUrl ?? null, determinable: true });
}

/**
 * Model endpoints that carry repository content but are resolved OUTSIDE
 * resolveAgentModelEndpoint / resolveProviderEndpoint, so effectiveModelEndpointUrl
 * cannot see them. Boot validation must inspect these explicitly, otherwise
 * local_only can be satisfied by the primary endpoint being private while a
 * bespoke lane egresses to a public host (the LLM_AGENT_URL-private /
 * LLM_REPAIR_URL-public exploit).
 *
 * Currently the repair planner resolves LLM_REPAIR_URL and code-impact live
 * confirmation resolves OPENAI_API_BASE or XAI_API_BASE. These variable names
 * are not part of the primary provider registry, so primary resolution cannot
 * see them. This is a boot-time mirror, not the source of truth:
 * resolve-time enforcement in the lane (enforceModelEndpointEgress at the fetch
 * call site) is authoritative; this only lets boot validation report a would-be
 * violation early.
 */
export function auxiliaryModelEgressEndpoints(env: EnvLike = process.env): string[] {
  const endpoints = new Set<string>();
  for (const key of [
    "LLM_REPAIR_URL",
    // The repair lane falls back to OPENAI_BASE_URL even when the selected
    // primary provider has already chosen a higher-precedence LLM_AGENT_URL.
    "OPENAI_BASE_URL",
  ] as const) {
    const endpoint = env[key]?.trim();
    if (endpoint) endpoints.add(endpoint);
  }
  // OPENAI_API_BASE / XAI_API_BASE are read ONLY by the code-impact confirm
  // lane, which is opt-in and off by default. Adding them unconditionally
  // refused a local_only boot for a stale base URL whose lane could never
  // egress (resolveLlmConfirmMode() === "off"). Treat them as egress-relevant
  // only when that lane is actually enabled, mirroring resolveLlmConfirmMode's
  // "live" predicate below (explicit opt-in AND a usable key). @mendpoint/shared
  // cannot import @mendpoint/code-impact without a cycle, so the predicate is
  // replicated here; resolve-time enforceModelEndpointEgress stays authoritative.
  const confirmMode = env.LLM_CONFIRM_MODE?.trim().toLowerCase();
  const confirmRequested =
    confirmMode === "live" ||
    env.LLM_CONFIRM === "1" ||
    env.LLM_CONFIRM?.trim().toLowerCase() === "true";
  if (confirmRequested) {
    if (env.XAI_API_KEY?.trim()) {
      endpoints.add(env.XAI_API_BASE?.trim() || "https://api.x.ai/v1");
    } else if (env.OPENAI_API_KEY?.trim()) {
      endpoints.add(env.OPENAI_API_BASE?.trim() || "https://api.openai.com/v1");
    }
  }
  return [...endpoints];
}

/**
 * Assess the current model egress posture for boot validation and readiness.
 * When local_only is active, every endpoint the codebase would call for
 * repository content must resolve to a private host: the primary endpoint the
 * agent would use (including a selected provider's resolved base URL or its
 * hardcoded default) and every auxiliary lane endpoint
 * ({@link auxiliaryModelEgressEndpoints}, e.g. the repair planner's
 * LLM_REPAIR_URL). A missing endpoint is allowed (heuristic-only, no egress),
 * while a selected-but-unresolvable provider fails closed.
 */
export function assessModelEgress(env: EnvLike = process.env): ModelEgressAssessment {
  const modeValid = isValidModelEgressMode(env.MENDPOINT_MODEL_EGRESS);
  const mode = modelEgressMode(env);
  const effective = effectiveModelEndpointUrl(env);
  const configured = effective.url;
  let endpointConfigured = configured !== null;
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
  } else if (mode === "local_only") {
    const allowlist = parseModelLocalHosts(env.MENDPOINT_MODEL_LOCAL_HOSTS);
    if (!effective.determinable) {
      // A selected provider whose endpoint cannot be determined cannot be proven
      // to stay local, so it fails closed rather than passing.
      violation = "model_egress_local_only_violation";
      localOnlySatisfied = false;
    } else if (endpointConfigured) {
      if (hostParseFailed) {
        violation = "warden_model_endpoint_invalid";
        localOnlySatisfied = false;
      } else if (!isPrivateModelHost(endpointHost ?? "", allowlist)) {
        violation = "model_egress_local_only_violation";
        localOnlySatisfied = false;
      }
    }
    // Auxiliary lanes (e.g. the repair planner's LLM_REPAIR_URL) are resolved
    // outside the primary endpoint, so check each one: a public auxiliary host
    // is a violation even when the primary endpoint is private.
    if (violation === null) {
      for (const aux of auxiliaryModelEgressEndpoints(env)) {
        let auxHost: string;
        try {
          auxHost = new URL(aux).hostname;
        } catch {
          violation = "warden_model_endpoint_invalid";
          localOnlySatisfied = false;
          break;
        }
        if (!isPrivateModelHost(auxHost, allowlist)) {
          violation = "model_egress_local_only_violation";
          localOnlySatisfied = false;
          // Surface the offending auxiliary host so an operator sees which lane
          // failed rather than only the (private) primary endpoint.
          endpointHost = auxHost;
          endpointConfigured = true;
          break;
        }
      }
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

/**
 * Enforce the local_only egress control for an already-resolved model endpoint
 * URL, so every model path (agent and verifier alike) refuses external egress
 * through the same rule rather than each hardcoding its own host. When the mode
 * is external_allowed this is a no-op. When it is local_only the endpoint host
 * must be private, loopback, link-local, unique-local, or operator allowlisted;
 * any other host raises model_egress_local_only_violation. A URL that does not
 * parse raises warden_model_endpoint_invalid so a malformed endpoint fails
 * closed rather than silently egressing.
 */
export function enforceModelEndpointEgress(url: string, env: EnvLike = process.env): void {
  if (modelEgressMode(env) !== "local_only") return;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("warden_model_endpoint_invalid");
  }
  if (!isPrivateModelHost(host, parseModelLocalHosts(env.MENDPOINT_MODEL_LOCAL_HOSTS))) {
    throw new Error("model_egress_local_only_violation");
  }
}

export const ReviewedVerificationCommandSchema = z.object({
  command: z.string().min(1).max(500),
  ok: z.literal(true),
  exitCode: z.literal(0),
  outputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
export type ReviewedVerificationCommand = z.infer<typeof ReviewedVerificationCommandSchema>;

/**
 * The record of an OBSERVED verification run, kept deliberately distinct from
 * {@link ReviewedVerificationCommandSchema} above. A single type was quietly
 * doing two incompatible jobs; these two schemas separate them:
 *
 *   - `ReviewedVerificationCommandSchema` ASSERTS a candidate is approvable, so
 *     it admits only a passing command (`ok: true`, `exitCode: 0`). That literal
 *     is correct there — an approved candidate must have passed — and stays as
 *     it is. The transformer sealing gate (adaptive-candidate.ts) enforces the
 *     same guarantee on its own review evidence.
 *   - `ObservedVerificationCommandSchema` RECORDS what a run actually observed, so
 *     `ok` is a real boolean and `exitCode` a real number: a failed run
 *     (`ok: false`, nonzero exit) is a fact that must be representable, never an
 *     impossibility. `outcome` carries the three genuinely-distinct states so a
 *     refusal (`not_verified` — the command never ran) is never collapsed into a
 *     failure, and `ok` stays the fail-closed boolean companion (`ok === true`
 *     iff `outcome === "verified"`), mirroring the executor's own contract in
 *     packages/repair/src/verify.ts.
 *
 * A failed verification is therefore representable without weakening any approval
 * guarantee: the guarantee lives on the reviewed schema and the sealing gate, not
 * on this observation record.
 */
export const ObservedVerificationCommandSchema = z.object({
  command: z.string().min(1).max(500),
  ok: z.boolean(),
  exitCode: z.number().int(),
  outcome: z.enum(["verified", "failed", "not_verified"]),
  outputSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  sandboxBackend: z.string().min(1).max(100).nullable(),
});
export type ObservedVerificationCommand = z.infer<typeof ObservedVerificationCommandSchema>;

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


/**
 * Safety bounds for graph-path emission. Centralized here so this layer and
 * @mendpoint/graph-learn's dependency-path enumeration (which imports the same
 * two constants) can never drift into parallel limits. `HARD_MAX_HOPS` caps the
 * length of an emitted provider->code path; `HARD_MAX_PATHS` caps multi-path
 * enumeration (used by dependency-path walking — an impact finding emits a
 * single shortest path per file, so it does not bind here, but the bound is
 * shared to keep one source of truth).
 */
export const HARD_MAX_HOPS = 32;
export const HARD_MAX_PATHS = 1_000;

/**
 * How a {@link GraphPath} walk ended. `anchor` — the walk reached a provider
 * anchor, so the path is complete. `cycle` / `max_hops` — the walk was stopped
 * by a safety bound (an import cycle, or the hop cap) and the emitted path is
 * truncated, never silently trimmed. `no_anchor` — the predecessor chain ran
 * out before reaching an anchor (a reachable node with no predecessor, only
 * possible on a malformed/detached predecessor map); the path is NOT complete
 * and must never be reported as if it reached an anchor. The `cycle` /
 * `max_hops` vocabulary mirrors the dependency-path terminals in
 * @mendpoint/graph-learn.
 */
export const GraphPathTerminalSchema = z.enum([
  "anchor",
  "cycle",
  "max_hops",
  "no_anchor",
]);
export type GraphPathTerminal = z.infer<typeof GraphPathTerminalSchema>;

/**
 * The provider->code dependency path behind a material impact finding (FET-016,
 * spec 8.8): the evidence for why the tool believes a file is affected. `nodes`
 * runs from the provider anchor to the affected file inclusive, each entry
 * importing the one before it. `partial` coverage (with a `cycle` / `max_hops`
 * terminal) means the path was bounded and the real chain is longer than shown.
 * The ABSENCE of a GraphPath on a finding means "not computed" (no provider
 * anchor was locatable), which is distinct from a computed path that is short.
 */
export const GraphPathSchema = z.object({
  nodes: z.array(z.string()),
  hops: z.number().int().nonnegative(),
  terminal: GraphPathTerminalSchema,
  truncated: z.boolean(),
  coverage: z.enum(["complete", "partial"]),
});
export type GraphPath = z.infer<typeof GraphPathSchema>;

/**
 * Format-agnostic display decision for a {@link GraphPath} (FET-016), the single
 * source of truth every renderer (the PR-body markdown formatter and the web
 * console) must share so the "direct provider usage vs bounded chain" logic
 * cannot drift between them. A zero-hop path is `direct` ONLY when it actually
 * terminated at an anchor (not truncated): a one-node path that was truncated is
 * the sole shape a `no_anchor` walk can take, so short-circuiting on node count
 * alone would mislabel an incomplete detached path as direct provider usage.
 * `bound` names why a chain stopped so it never reads as complete.
 */
export type GraphPathDisplay =
  | { readonly kind: "direct"; readonly node: string }
  | {
      readonly kind: "chain";
      readonly nodes: readonly string[];
      readonly bound: "cycle" | "no_anchor" | "max_hops" | null;
      readonly hops: number;
    };

export function graphPathDisplay(p: GraphPath): GraphPathDisplay {
  if (p.nodes.length <= 1 && !p.truncated) {
    return { kind: "direct", node: p.nodes[0] ?? "?" };
  }
  const bound = p.truncated
    ? p.terminal === "cycle"
      ? "cycle"
      : p.terminal === "no_anchor"
        ? "no_anchor"
        : "max_hops"
    : null;
  return { kind: "chain", nodes: p.nodes, bound, hops: p.hops };
}

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
  /** Provider->code path proving this file's reachability (FET-016). */
  graphPath: GraphPathSchema.optional(),
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

/**
 * Report-level confidence. Unlike per-site {@link ConfidenceSchema} (which is
 * always high/medium/low because a site only exists once it has been confirmed),
 * the overall confidence of a whole analysis MUST admit a fourth value:
 * `unknown`. An empty result under incomplete coverage is not "low confidence
 * that there is no impact" — it is the absence of evidence either way. Collapsing
 * it into `low` is the §11.7 bug: it makes "we found nothing" and "we found weak
 * evidence" indistinguishable. See {@link ImpactCoverageSchema}.
 */
export const OverallConfidenceSchema = z.enum(["high", "medium", "low", "unknown"]);
export type OverallConfidence = z.infer<typeof OverallConfidenceSchema>;

/** A typed reason some part of the codebase in scope was not covered by analysis. */
export const CoverageGapReasonSchema = z.enum([
  /** Source files whose language has no analysis front-end, so calls in them are unseen. */
  "unsupported_language",
  /** A directory pruned from traversal (dependency/cache/virtualenv tree). */
  "skipped_directory",
  /** The file-count cap was hit; not every in-scope file was inspected. */
  "file_cap",
  /** A byte cap was hit; not every in-scope file was inspected. */
  "byte_cap",
  /** A graph/dependency query stopped at a safety bound before enumerating everything. */
  "query_truncated",
]);
export type CoverageGapReason = z.infer<typeof CoverageGapReasonSchema>;

export const CoverageGapSchema = z.object({
  reason: CoverageGapReasonSchema,
  detail: z.string(),
  /** Concrete count where the signal carries one (files/dirs/languages affected). */
  count: z.number().int().nonnegative().optional(),
});
export type CoverageGap = z.infer<typeof CoverageGapSchema>;

/**
 * Whether — and how completely — the codebase was analyzed. This is the §11.7 /
 * §12.4 discriminator: it lets a reader distinguish the three states the spec
 * requires be kept apart, which an empty `sites` list alone cannot express:
 *
 *  - `analyzed`  — the repo was analyzed with full coverage. An empty `sites`
 *    list here is COMPLETE EVIDENCE OF NO IMPACT (clean), not merely "nothing
 *    found".
 *  - `partial`   — the repo was analyzed but coverage has typed gaps (unsupported
 *    languages present, caps hit, queries truncated). An empty `sites` list here
 *    is "no KNOWN impact"; there may be impact in code we could not see.
 *  - `not_analyzed` — no analysis ran against real code (repo never cloned, no
 *    supported language present, discovery pruned to nothing). Absence of
 *    findings carries no information at all.
 */
export const CoverageBasisSchema = z.enum(["analyzed", "partial", "not_analyzed"]);
export type CoverageBasis = z.infer<typeof CoverageBasisSchema>;

export const ImpactCoverageSchema = z.object({
  basis: CoverageBasisSchema,
  /** Human-readable why. Always present for `partial` / `not_analyzed`. */
  reason: z.string().optional(),
  /** Typed gaps that degraded coverage. Empty when `basis === "analyzed"`. */
  gaps: z.array(CoverageGapSchema).default([]),
  /** Files actually inspected vs files in analysis scope, where known. */
  filesInspected: z.number().int().nonnegative().optional(),
  filesInScope: z.number().int().nonnegative().optional(),
  /** Languages the analysis front-end supports vs languages actually present. */
  languagesSupported: z.array(z.string()).optional(),
  languagesPresent: z.array(z.string()).optional(),
});
export type ImpactCoverage = z.infer<typeof ImpactCoverageSchema>;

export const ImpactReportSchema = z.object({
  surfaces: z.array(ImpactableSurfaceSchema),
  sites: z.array(ConfirmedImpactSchema),
  overallRisk: ChangeRiskSchema,
  overallConfidence: OverallConfidenceSchema,
  /**
   * Coverage/basis discriminator (§11.7, §12.4). Distinguishes a clean result
   * (analyzed, no impact) from an unknown one (analysis was incomplete or never
   * ran). Optional only for backward-compatibility with reports serialized
   * before this channel existed; the analyzer always populates it.
   */
  coverage: ImpactCoverageSchema.optional(),
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
  /**
   * Provider->code path behind this finding (FET-016, spec 8.8). Optional and
   * nullable-by-absence: existing findings carry no path, and an absent value
   * reads as "not computed" (no locatable provider anchor), never "no path".
   */
  graphPath: GraphPathSchema.optional(),
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
    ...(c.graphPath ? { graphPath: c.graphPath } : {}),
  };
}
