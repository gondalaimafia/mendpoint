import { createHash } from "node:crypto";
import { recordCounter } from "./telemetry.js";

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
  recordCounter("service_health_total", 1, { service: window.service, status });
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

// ---------------------------------------------------------------------------
// Live SLO / error-budget instrumentation.
//
// Feeds the ErrorBudgetPolicy / ServiceWindow model above with ACTUAL measured
// signals (readiness outcomes, request latencies, job outcomes) so it produces a
// live per-SLO error-budget evidence object instead of an empty schema. Each SLO
// is evaluated by reusing assessServiceHealth, so the burn accounting stays
// identical to the existing model.
// ---------------------------------------------------------------------------

export const SLO_SCHEMA_VERSION = 1 as const;

export type SloName = "availability" | "latency" | "job_success";

export type SloBurnState = "healthy" | "at_risk" | "exhausted" | "insufficient_evidence";

export type SloTarget = Readonly<{
  slo: SloName;
  objective: number;
  windowMinutes: number;
  minimumSamples: number;
  burnAlertAtConsumed: number;
  latencyThresholdMs?: number;
}>;

/**
 * Concrete SLOs a single-node tier can meet:
 *  - availability: fraction of readiness probes passing
 *  - latency: fraction of requests under the latency budget
 *  - job_success: fraction of background jobs succeeding
 */
export const DEFAULT_SLO_TARGETS: readonly SloTarget[] = Object.freeze([
  Object.freeze({
    slo: "availability" as const,
    objective: 0.99,
    windowMinutes: 60,
    minimumSamples: 20,
    burnAlertAtConsumed: 0.5,
  }),
  Object.freeze({
    slo: "latency" as const,
    objective: 0.95,
    windowMinutes: 60,
    minimumSamples: 20,
    burnAlertAtConsumed: 0.5,
    latencyThresholdMs: 1_000,
  }),
  Object.freeze({
    slo: "job_success" as const,
    objective: 0.98,
    windowMinutes: 60,
    minimumSamples: 10,
    burnAlertAtConsumed: 0.5,
  }),
]);

export type SloSignal = Readonly<{
  slo: SloName;
  occurredAt: string;
  good?: boolean;
  latencyMs?: number;
}>;

export type SloEvidence = Readonly<{
  schemaVersion: typeof SLO_SCHEMA_VERSION;
  slo: SloName;
  objective: number;
  samples: number;
  badSamples: number;
  observedRatio: number;
  errorBudgetConsumed: number | null;
  errorBudgetRemaining: number | null;
  burnState: SloBurnState;
  windowStartedAt: string;
  windowEndedAt: string;
  sha256: string;
}>;

export type SloReport = Readonly<{
  schemaVersion: typeof SLO_SCHEMA_VERSION;
  tenantId: string;
  service: string;
  windowStartedAt: string;
  windowEndedAt: string;
  slos: readonly SloEvidence[];
  status: "healthy" | "degraded" | "unavailable";
  sha256: string;
}>;

export function availabilitySignal(readinessPassed: boolean, occurredAt: string): SloSignal {
  return { slo: "availability", occurredAt, good: readinessPassed };
}

export function jobSuccessSignal(jobSucceeded: boolean, occurredAt: string): SloSignal {
  return { slo: "job_success", occurredAt, good: jobSucceeded };
}

export function latencySignal(latencyMs: number, occurredAt: string): SloSignal {
  return { slo: "latency", occurredAt, latencyMs };
}

function signalIsGood(signal: SloSignal, target: SloTarget): boolean {
  if (target.slo === "latency" && typeof signal.latencyMs === "number") {
    return signal.latencyMs <= (target.latencyThresholdMs ?? Number.POSITIVE_INFINITY);
  }
  return signal.good === true;
}

function burnStateFor(consumed: number | null, target: SloTarget): SloBurnState {
  if (consumed === null) return "insufficient_evidence";
  if (consumed >= 1) return "exhausted";
  if (consumed >= target.burnAlertAtConsumed) return "at_risk";
  return "healthy";
}

/**
 * Evaluate one SLO against a window of measured signals, reusing the existing
 * error-budget model. tenantId/service/window come from the enclosing report.
 */
export function evaluateSlo(
  target: SloTarget,
  input: {
    tenantId: string;
    service: string;
    windowStartedAt: string;
    windowEndedAt: string;
    signals: readonly SloSignal[];
  },
): SloEvidence {
  if (
    target.objective <= 0 ||
    target.objective >= 1 ||
    !Number.isSafeInteger(target.windowMinutes) ||
    target.windowMinutes < 1 ||
    !Number.isSafeInteger(target.minimumSamples) ||
    target.minimumSamples < 1 ||
    target.burnAlertAtConsumed <= 0 ||
    target.burnAlertAtConsumed > 1
  ) {
    throw new Error("slo_target_invalid");
  }
  const relevant = input.signals.filter((signal) => signal.slo === target.slo);
  const samples = relevant.length;
  const goodSamples = relevant.filter((signal) => signalIsGood(signal, target)).length;
  const badSamples = samples - goodSamples;

  const health = assessServiceHealth(
    {
      tenantId: input.tenantId,
      service: `${input.service}:${target.slo}`,
      windowStartedAt: input.windowStartedAt,
      windowEndedAt: input.windowEndedAt,
      requests: samples,
      failures: badSamples,
      dependencies: [],
    },
    {
      schemaVersion: SERVICE_HEALTH_SCHEMA_VERSION,
      availabilityTarget: target.objective,
      windowMinutes: target.windowMinutes,
      minimumRequests: target.minimumSamples,
      degradedAtBudgetConsumed: target.burnAlertAtConsumed,
    },
  );

  const withoutDigest = Object.freeze({
    schemaVersion: SLO_SCHEMA_VERSION,
    slo: target.slo,
    objective: target.objective,
    samples,
    badSamples,
    observedRatio: samples === 0 ? 1 : goodSamples / samples,
    errorBudgetConsumed: health.errorBudgetConsumed,
    errorBudgetRemaining: health.errorBudgetRemaining,
    burnState: burnStateFor(health.errorBudgetConsumed, target),
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
  });
  return Object.freeze({ ...withoutDigest, sha256: digest(withoutDigest) });
}

/**
 * Build a live SLO report from measured signals across the default (or supplied)
 * SLOs. The overall status escalates with the worst per-SLO burn state.
 */
export function evaluateSloReport(input: {
  tenantId: string;
  service: string;
  windowStartedAt: string;
  windowEndedAt: string;
  signals: readonly SloSignal[];
  targets?: readonly SloTarget[];
}): SloReport {
  assertId(input.tenantId, "slo_tenant_invalid");
  assertId(input.service, "slo_service_invalid");
  const targets = input.targets ?? DEFAULT_SLO_TARGETS;
  const slos = targets.map((target) => evaluateSlo(target, input));
  const status: SloReport["status"] = slos.some((slo) => slo.burnState === "exhausted")
    ? "unavailable"
    : slos.some((slo) => slo.burnState === "at_risk" || slo.burnState === "insufficient_evidence")
      ? "degraded"
      : "healthy";
  const withoutDigest = Object.freeze({
    schemaVersion: SLO_SCHEMA_VERSION,
    tenantId: input.tenantId,
    service: input.service,
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
    slos: Object.freeze(slos),
    status,
  });
  return Object.freeze({ ...withoutDigest, sha256: digest(withoutDigest) });
}

export function verifySloReport(report: SloReport): boolean {
  const { sha256, ...withoutDigest } = report;
  return /^[a-f0-9]{64}$/.test(sha256) && digest(withoutDigest) === sha256;
}
