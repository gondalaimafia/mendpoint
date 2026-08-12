import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_ROUTER_ENV,
  adaptiveAggregateKey,
  aggregateRouterOutcomes,
  effectiveRoutingMetrics,
  indexAdaptiveStats,
  isAdaptiveRoutingEnabled,
  type RouterOutcomeAggregate,
} from "./router-adaptive.js";
import type { RouterEvidenceEvent } from "./router-runtime.js";

function baseline() {
  return { qualityScore: 0.85, costUsd: 2, latencyMs: 5_000 };
}

function aggregate(
  overrides: Partial<RouterOutcomeAggregate> = {},
): RouterOutcomeAggregate {
  return {
    executorId: "model-a",
    taskKind: "api-migration",
    providerId: "provider-a",
    samples: 0,
    acceptedSamples: 0,
    costSamples: 0,
    totalCostUsd: 0,
    latencySamples: 0,
    totalLatencyMs: 0,
    ...overrides,
  };
}

function preparedEvent(
  envelopeId: string,
  taskKind: string,
): RouterEvidenceEvent {
  return {
    eventId: `${envelopeId}-prepared`,
    envelopeId,
    sequence: 1,
    previousEventId: null,
    recordedAt: "2026-08-01T12:00:00.000Z",
    type: "prepared",
    data: { task: { kind: taskKind } },
  } as unknown as RouterEvidenceEvent;
}

function attemptEvent(
  envelopeId: string,
  sequence: number,
  attempt: {
    executorId: string;
    providerId: string;
    outcome: "succeeded" | "failed" | "cancelled";
    verdict: "passed" | "failed" | "unknown";
    actualCostUsd: number | null;
    actualLatencyMs: number;
  },
): RouterEvidenceEvent {
  return {
    eventId: `${envelopeId}-attempt-${sequence}`,
    envelopeId,
    sequence,
    previousEventId: `${envelopeId}-${sequence - 1}`,
    recordedAt: "2026-08-01T12:00:00.000Z",
    type: "attempt",
    data: {
      dispatch: {
        executorId: attempt.executorId,
        providerId: attempt.providerId,
      },
      outcome: attempt.outcome,
      actualCostUsd: attempt.actualCostUsd,
      actualLatencyMs: attempt.actualLatencyMs,
      verification: { verdict: attempt.verdict },
    },
  } as unknown as RouterEvidenceEvent;
}

describe("router adaptive scoring", () => {
  it("reads the opt-in flag and treats only \"1\" as enabled", () => {
    expect(isAdaptiveRoutingEnabled({})).toBe(false);
    expect(isAdaptiveRoutingEnabled({ [ADAPTIVE_ROUTER_ENV]: "0" })).toBe(false);
    expect(isAdaptiveRoutingEnabled({ [ADAPTIVE_ROUTER_ENV]: "true" })).toBe(
      false,
    );
    expect(isAdaptiveRoutingEnabled({ [ADAPTIVE_ROUTER_ENV]: "1" })).toBe(true);
  });

  it("returns the static baseline unchanged for a cold-start (no history)", () => {
    const metrics = effectiveRoutingMetrics(baseline(), undefined);
    expect(metrics).toEqual(baseline());
    const zero = effectiveRoutingMetrics(baseline(), aggregate({ samples: 0 }));
    expect(zero).toEqual(baseline());
  });

  it("raises effective quality for a high-acceptance history", () => {
    const metrics = effectiveRoutingMetrics(
      baseline(),
      aggregate({ samples: 8, acceptedSamples: 8 }),
    );
    expect(metrics.qualityScore).toBeGreaterThan(baseline().qualityScore);
    expect(metrics.qualityScore).toBeLessThanOrEqual(1);
  });

  it("lowers effective quality for a low-acceptance history", () => {
    const metrics = effectiveRoutingMetrics(
      baseline(),
      aggregate({ samples: 8, acceptedSamples: 0 }),
    );
    expect(metrics.qualityScore).toBeLessThan(baseline().qualityScore);
    expect(metrics.qualityScore).toBeGreaterThanOrEqual(0);
  });

  it("blends effective cost and latency toward the observed mean", () => {
    const metrics = effectiveRoutingMetrics(
      baseline(),
      aggregate({
        samples: 4,
        acceptedSamples: 4,
        costSamples: 4,
        totalCostUsd: 16, // observed mean 4 vs baseline 2
        latencySamples: 4,
        totalLatencyMs: 4_000, // observed mean 1000 vs baseline 5000
      }),
    );
    expect(metrics.costUsd).toBeGreaterThan(baseline().costUsd);
    expect(metrics.costUsd).toBeLessThan(4);
    expect(metrics.latencyMs).toBeLessThan(baseline().latencyMs);
    expect(metrics.latencyMs).toBeGreaterThan(1_000);
  });

  it("is deterministic given the same aggregate", () => {
    const agg = aggregate({ samples: 5, acceptedSamples: 3, costSamples: 2, totalCostUsd: 3 });
    expect(effectiveRoutingMetrics(baseline(), agg)).toEqual(
      effectiveRoutingMetrics(baseline(), agg),
    );
  });

  it("aggregates recorded outcomes per executor, task-kind, and provider", () => {
    const events: RouterEvidenceEvent[] = [
      preparedEvent("env-1", "api-migration"),
      attemptEvent("env-1", 2, {
        executorId: "model-a",
        providerId: "provider-a",
        outcome: "succeeded",
        verdict: "passed",
        actualCostUsd: 1,
        actualLatencyMs: 1_000,
      }),
      preparedEvent("env-2", "api-migration"),
      attemptEvent("env-2", 2, {
        executorId: "model-a",
        providerId: "provider-a",
        outcome: "failed",
        verdict: "failed",
        actualCostUsd: null,
        actualLatencyMs: 2_000,
      }),
      preparedEvent("env-3", "other-kind"),
      attemptEvent("env-3", 2, {
        executorId: "model-a",
        providerId: "provider-a",
        outcome: "succeeded",
        verdict: "passed",
        actualCostUsd: 3,
        actualLatencyMs: 3_000,
      }),
    ];

    const stats = aggregateRouterOutcomes(events);
    const index = indexAdaptiveStats(stats);

    const migration = index.get(
      adaptiveAggregateKey("model-a", "api-migration", "provider-a"),
    );
    expect(migration).toMatchObject({
      samples: 2,
      acceptedSamples: 1,
      costSamples: 1, // null cost is excluded
      totalCostUsd: 1,
      latencySamples: 2,
      totalLatencyMs: 3_000,
    });

    const other = index.get(
      adaptiveAggregateKey("model-a", "other-kind", "provider-a"),
    );
    expect(other).toMatchObject({ samples: 1, acceptedSamples: 1 });

    // Deterministic, order-independent result.
    expect(aggregateRouterOutcomes([...events].reverse())).toEqual(stats);
  });

  it("ignores envelopes with no recorded attempts", () => {
    const events: RouterEvidenceEvent[] = [preparedEvent("env-1", "api-migration")];
    expect(aggregateRouterOutcomes(events)).toEqual([]);
  });
});
