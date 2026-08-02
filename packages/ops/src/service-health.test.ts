import { describe, expect, it } from "vitest";
import {
  CORRELATION_BOUNDARIES,
  SERVICE_HEALTH_SCHEMA_VERSION,
  assessServiceHealth,
  childCorrelationContext,
  createCorrelationContext,
  verifyCorrelationCoverage,
  verifyServiceHealthEvidence,
  type CorrelatedBoundaryEvidence,
} from "./service-health.js";

const policy = {
  schemaVersion: SERVICE_HEALTH_SCHEMA_VERSION,
  availabilityTarget: 0.99,
  windowMinutes: 60,
  minimumRequests: 100,
  degradedAtBudgetConsumed: 0.5,
} as const;

describe("correlated service health", () => {
  it("carries one tenant trace and correlation ID across all required boundaries", () => {
    const root = createCorrelationContext({
      tenantId: "tenant-a",
      traceId: "trace-a",
      correlationId: "correlation-a",
      spanId: "span-request",
      boundary: "request",
    });
    const evidence: CorrelatedBoundaryEvidence[] = CORRELATION_BOUNDARIES.map((boundary, index) => ({
      context:
        boundary === "request" ? root : childCorrelationContext(root, boundary, `span-${index}`),
      service: `service-${boundary}`,
      occurredAt: `2026-08-02T00:00:0${index}.000Z`,
      outcome: "ok",
    }));
    expect(verifyCorrelationCoverage(evidence)).toEqual({
      ok: true,
      checked: 7,
      missing: [],
      errors: [],
    });
  });

  it("fails coverage for missing or cross-tenant telemetry", () => {
    const root = createCorrelationContext({
      tenantId: "tenant-a",
      traceId: "trace-a",
      correlationId: "correlation-a",
      spanId: "span-request",
      boundary: "request",
    });
    const result = verifyCorrelationCoverage([
      { context: root, service: "api", occurredAt: "2026-08-02T00:00:00.000Z", outcome: "ok" },
      {
        context: createCorrelationContext({
          tenantId: "tenant-b",
          traceId: "trace-a",
          correlationId: "correlation-a",
          spanId: "span-job",
          parentSpanId: "span-request",
          boundary: "job",
        }),
        service: "worker",
        occurredAt: "2026-08-02T00:00:01.000Z",
        outcome: "error",
      },
    ]);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("graph");
    expect(result.errors).toContain("correlation_tenant_mismatch:job");
  });

  it("emits healthy immutable error-budget evidence", () => {
    const evidence = assessServiceHealth(
      {
        tenantId: "tenant-a",
        service: "warden-api",
        windowStartedAt: "2026-08-02T00:00:00.000Z",
        windowEndedAt: "2026-08-02T01:00:00.000Z",
        requests: 1000,
        failures: 1,
        dependencies: [{ name: "database", status: "healthy" }],
      },
      policy,
    );
    expect(evidence).toMatchObject({ status: "healthy", customerVisible: false, page: false });
    expect(evidence.errorBudgetConsumed).toBeCloseTo(0.1);
    expect(verifyServiceHealthEvidence(evidence)).toBe(true);
  });

  it("makes exhausted budgets and unavailable dependencies page-worthy", () => {
    const evidence = assessServiceHealth(
      {
        tenantId: "tenant-a",
        service: "transformer-worker",
        windowStartedAt: "2026-08-02T00:00:00.000Z",
        windowEndedAt: "2026-08-02T00:30:00.000Z",
        requests: 100,
        failures: 2,
        dependencies: [{ name: "model", status: "unavailable" }],
      },
      policy,
    );
    expect(evidence).toMatchObject({ status: "unavailable", customerVisible: true, page: true });
    expect(evidence.reasons).toEqual(["error_budget_exhausted", "dependency_unavailable"]);
  });

  it("reports insufficient samples as degraded evidence rather than false health", () => {
    const evidence = assessServiceHealth(
      {
        tenantId: "tenant-a",
        service: "graph",
        windowStartedAt: "2026-08-02T00:00:00.000Z",
        windowEndedAt: "2026-08-02T00:10:00.000Z",
        requests: 2,
        failures: 0,
        dependencies: [],
      },
      policy,
    );
    expect(evidence).toMatchObject({
      status: "degraded",
      customerVisible: true,
      page: false,
      errorBudgetConsumed: null,
      reasons: ["insufficient_window_evidence"],
    });
  });

  it("detects altered health evidence", () => {
    const evidence = assessServiceHealth(
      {
        tenantId: "tenant-a",
        service: "api",
        windowStartedAt: "2026-08-02T00:00:00.000Z",
        windowEndedAt: "2026-08-02T00:10:00.000Z",
        requests: 100,
        failures: 0,
        dependencies: [],
      },
      policy,
    );
    expect(verifyServiceHealthEvidence({ ...evidence, failures: 1 } as never)).toBe(false);
  });
});
