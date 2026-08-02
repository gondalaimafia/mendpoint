import { createHash } from "node:crypto";

export const SERVICE_HEALTH_SCHEMA_VERSION = 1 as const;
export const CORRELATION_BOUNDARIES = [
  "request",
  "job",
  "graph",
  "model",
  "verification",
  "scm",
  "webhook",
] as const;

export type CorrelationBoundary = (typeof CORRELATION_BOUNDARIES)[number];

export type CorrelationContext = Readonly<{
  schemaVersion: typeof SERVICE_HEALTH_SCHEMA_VERSION;
  tenantId: string;
  traceId: string;
  correlationId: string;
  spanId: string;
  parentSpanId?: string;
  boundary: CorrelationBoundary;
}>;

export type CorrelatedBoundaryEvidence = Readonly<{
  context: CorrelationContext;
  service: string;
  occurredAt: string;
  outcome: "ok" | "error";
  errorClass?: string;
}>;

export type ErrorBudgetPolicy = Readonly<{
  schemaVersion: typeof SERVICE_HEALTH_SCHEMA_VERSION;
  availabilityTarget: number;
  windowMinutes: number;
  minimumRequests: number;
  degradedAtBudgetConsumed: number;
}>;

export type ServiceWindow = Readonly<{
  tenantId: string;
  service: string;
  windowStartedAt: string;
  windowEndedAt: string;
  requests: number;
  failures: number;
  dependencies: readonly Readonly<{
    name: string;
    status: "healthy" | "degraded" | "unavailable";
  }>[];
}>;

export type ServiceHealthEvidence = Readonly<{
  schemaVersion: typeof SERVICE_HEALTH_SCHEMA_VERSION;
  tenantId: string;
  service: string;
  status: "healthy" | "degraded" | "unavailable";
  customerVisible: boolean;
  page: boolean;
  errorRate: number;
  errorBudgetConsumed: number | null;
  errorBudgetRemaining: number | null;
  reasons: readonly string[];
  windowStartedAt: string;
  windowEndedAt: string;
  sha256: string;
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function assertId(value: string, error: string): void {
  if (!ID.test(value)) throw new Error(error);
}

export function createCorrelationContext(input: Omit<CorrelationContext, "schemaVersion">): CorrelationContext {
  assertId(input.tenantId, "correlation_tenant_invalid");
  assertId(input.traceId, "correlation_trace_invalid");
  assertId(input.correlationId, "correlation_id_invalid");
  assertId(input.spanId, "correlation_span_invalid");
  if (input.parentSpanId !== undefined) assertId(input.parentSpanId, "correlation_parent_span_invalid");
  if (!CORRELATION_BOUNDARIES.includes(input.boundary)) throw new Error("correlation_boundary_invalid");
  return Object.freeze({ schemaVersion: SERVICE_HEALTH_SCHEMA_VERSION, ...input });
}

export function childCorrelationContext(
  parent: CorrelationContext,
  boundary: CorrelationBoundary,
  spanId: string,
): CorrelationContext {
  return createCorrelationContext({
    tenantId: parent.tenantId,
    traceId: parent.traceId,
    correlationId: parent.correlationId,
    spanId,
    parentSpanId: parent.spanId,
    boundary,
  });
}

export function verifyCorrelationCoverage(
  evidence: readonly CorrelatedBoundaryEvidence[],
): Readonly<{ ok: boolean; checked: number; missing: readonly CorrelationBoundary[]; errors: readonly string[] }> {
  if (evidence.length === 0) {
    return { ok: false, checked: 0, missing: CORRELATION_BOUNDARIES, errors: ["correlation_evidence_empty"] };
  }
  const first = evidence[0]!.context;
  const errors: string[] = [];
  const seen = new Set<CorrelationBoundary>();
  for (const item of evidence) {
    seen.add(item.context.boundary);
    if (item.context.tenantId !== first.tenantId) errors.push(`correlation_tenant_mismatch:${item.context.boundary}`);
    if (item.context.traceId !== first.traceId) errors.push(`correlation_trace_mismatch:${item.context.boundary}`);
    if (item.context.correlationId !== first.correlationId) errors.push(`correlation_id_mismatch:${item.context.boundary}`);
    if (!Number.isFinite(Date.parse(item.occurredAt))) errors.push(`correlation_time_invalid:${item.context.boundary}`);
  }
  const missing = CORRELATION_BOUNDARIES.filter((boundary) => !seen.has(boundary));
  return Object.freeze({
    ok: missing.length === 0 && errors.length === 0,
    checked: evidence.length,
    missing: Object.freeze(missing),
    errors: Object.freeze([...new Set(errors)]),
  });
}

export function assessServiceHealth(
  window: ServiceWindow,
  policy: ErrorBudgetPolicy,
): ServiceHealthEvidence {
  assertId(window.tenantId, "service_health_tenant_invalid");
  assertId(window.service, "service_health_service_invalid");
  const started = Date.parse(window.windowStartedAt);
  const ended = Date.parse(window.windowEndedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) {
    throw new Error("service_health_window_invalid");
  }
  if (
    !Number.isSafeInteger(window.requests) ||
    !Number.isSafeInteger(window.failures) ||
    window.requests < 0 ||
    window.failures < 0 ||
    window.failures > window.requests
  ) {
    throw new Error("service_health_counts_invalid");
  }
  if (
    policy.schemaVersion !== SERVICE_HEALTH_SCHEMA_VERSION ||
    policy.availabilityTarget <= 0 ||
    policy.availabilityTarget >= 1 ||
    !Number.isSafeInteger(policy.windowMinutes) ||
    policy.windowMinutes < 1 ||
    !Number.isSafeInteger(policy.minimumRequests) ||
    policy.minimumRequests < 1 ||
    policy.degradedAtBudgetConsumed <= 0 ||
    policy.degradedAtBudgetConsumed > 1
  ) {
    throw new Error("service_health_policy_invalid");
  }
  const actualWindowMinutes = (ended - started) / 60_000;
  if (actualWindowMinutes > policy.windowMinutes) throw new Error("service_health_window_exceeds_policy");

  const reasons: string[] = [];
  const errorRate = window.requests === 0 ? 0 : window.failures / window.requests;
  const allowedErrorRate = 1 - policy.availabilityTarget;
  const errorBudgetConsumed = window.requests < policy.minimumRequests ? null : errorRate / allowedErrorRate;
  const errorBudgetRemaining = errorBudgetConsumed === null ? null : Math.max(0, 1 - errorBudgetConsumed);
  if (window.requests < policy.minimumRequests) reasons.push("insufficient_window_evidence");
  if (errorBudgetConsumed !== null && errorBudgetConsumed >= policy.degradedAtBudgetConsumed) {
    reasons.push(errorBudgetConsumed >= 1 ? "error_budget_exhausted" : "error_budget_at_risk");
  }
  if (window.dependencies.some((dependency) => dependency.status === "degraded")) {
    reasons.push("dependency_degraded");
  }
  if (window.dependencies.some((dependency) => dependency.status === "unavailable")) {
    reasons.push("dependency_unavailable");
  }
  const unavailable = reasons.includes("dependency_unavailable") || reasons.includes("error_budget_exhausted");
  const status = unavailable ? "unavailable" : reasons.length > 0 ? "degraded" : "healthy";
  const withoutDigest = Object.freeze({
    schemaVersion: SERVICE_HEALTH_SCHEMA_VERSION,
    tenantId: window.tenantId,
    service: window.service,
    status,
    customerVisible: status !== "healthy",
    page: unavailable,
    errorRate,
    errorBudgetConsumed,
    errorBudgetRemaining,
    reasons: Object.freeze(reasons),
    windowStartedAt: window.windowStartedAt,
    windowEndedAt: window.windowEndedAt,
  });
  return Object.freeze({ ...withoutDigest, sha256: digest(withoutDigest) });
}

export function verifyServiceHealthEvidence(evidence: ServiceHealthEvidence): boolean {
  const { sha256, ...withoutDigest } = evidence;
  return /^[a-f0-9]{64}$/.test(sha256) && digest(withoutDigest) === sha256;
}
