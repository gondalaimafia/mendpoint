import { describe, expect, it } from "vitest";
import {
  evaluatePerformanceRun,
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  validatePerformanceContract,
  type PerformanceContract,
  type PerformanceObservation,
} from "./performance-contract.js";

const EVALUATED_AT = "2026-09-02T00:00:10.000Z";

function contract(): PerformanceContract {
  return {
    version: "2026-09-02.v2",
    percentileMethod: "nearest_rank_v1",
    metricDictionaryVersion: "2026-09-02.v1",
    tiers: [{
      id: "fettler-small",
      repository: {
        files: 5_000,
        bytes: 50_000_000,
        maxFileBytes: 1_000_000,
        languages: ["typescript"],
        languageMix: [{ language: "typescript", minimumPercent: 100 }],
      },
      concurrency: 2,
      minimumSamples: 4,
      loadDurationSeconds: 60,
      soakDurationSeconds: 1_800,
    }],
    objectives: [
      { metric: "first_result", p50Ms: 1_000, p95Ms: 2_000, p99Ms: 3_000 },
      { metric: "complete_scan", p50Ms: 10_000, p95Ms: 20_000, p99Ms: 30_000 },
      { metric: "verification", p50Ms: 5_000, p95Ms: 10_000, p99Ms: 15_000 },
      { metric: "queue_wait", p50Ms: 500, p95Ms: 1_000, p99Ms: 1_500 },
      { metric: "campaign_fanout", p50Ms: 2_000, p95Ms: 4_000, p99Ms: 6_000 },
    ],
    metricDictionary: [
      "first_result",
      "complete_scan",
      "verification",
      "queue_wait",
      "campaign_fanout",
    ].map((metric) => ({
      metric,
      eventSource: `fettler.performance.${metric}`,
      dimensions: ["deployment_revision", "repository_revision", "tier_id", "mode"],
      exclusions: ["operator_cancelled"],
      freshnessSeconds: 300,
      qualityChecks: ["finite_duration", "successful_terminal_state", "revision_bound"],
    })),
  } as PerformanceContract;
}

function observations(metric: PerformanceObservation["metric"], values: number[]) {
  return values.map((durationMs, index): PerformanceObservation => ({
    id: `${metric}-${index}`,
    tierId: "fettler-small",
    metric,
    mode: "load",
    durationMs,
    success: true,
    observedAt: `2026-09-02T00:00:0${index}.000Z`,
  }));
}

function completeObservations(): PerformanceObservation[] {
  return [
    ...observations("first_result", [500, 800, 1_000, 1_500]),
    ...observations("complete_scan", [5_000, 8_000, 9_000, 12_000]),
    ...observations("verification", [2_000, 3_000, 4_000, 6_000]),
    ...observations("queue_wait", [100, 200, 300, 500]),
    ...observations("campaign_fanout", [1_000, 1_200, 1_500, 2_500]),
  ];
}

describe("Fettler performance contract", () => {
  it("publishes production workload ceilings, language mix, concurrency, and metric quality", () => {
    const validated = validatePerformanceContract(FETTLER_PERFORMANCE_CONTRACT);

    expect(validated.tiers.map((tier) => tier.id)).toEqual([
      "fettler-small",
      "fettler-medium",
    ]);
    expect(validated.tiers[0]).toMatchObject({
      repository: {
        files: 5_000,
        bytes: 50_000_000,
        maxFileBytes: 1_000_000,
        languageMix: [{ language: "typescript", minimumPercent: 100 }],
      },
      concurrency: 2,
    });
    expect(validated.metricDictionary).toHaveLength(5);
    expect(validated.metricDictionary![0]).toMatchObject({
      eventSource: expect.stringMatching(/^fettler\.performance\./),
      dimensions: expect.arrayContaining(["deployment_revision", "repository_revision"]),
      freshnessSeconds: expect.any(Number),
    });
  });

  it("evaluates first result, complete run, concurrency, and nearest-rank percentiles", () => {
    const report = evaluatePerformanceRun(contract(), completeObservations(), "load", EVALUATED_AT);

    expect(report.ok).toBe(true);
    expect(report.contractDigest).toBe(performanceContractDigest(contract()));
    expect(report.metricDictionaryDigest).toBe(metricDictionaryDigest(contract()));
    expect(report.results.find((result) => result.metric === "first_result")).toMatchObject({
      tierId: "fettler-small",
      concurrency: 2,
      sampleCount: 4,
      p50Ms: 800,
      p95Ms: 1_500,
      p99Ms: 1_500,
      ok: true,
    });
    expect(report.results.find((result) => result.metric === "complete_scan")?.ok).toBe(true);
  });

  it("produces deterministic digests and changes them with contract content", () => {
    const base = contract();
    const reordered = {
      ...base,
      metricDictionary: base.metricDictionary!.map((definition) => ({ ...definition })),
    };
    expect(performanceContractDigest(reordered)).toBe(performanceContractDigest(base));

    const changed = contract();
    changed.metricDictionary![0] = {
      ...changed.metricDictionary![0]!,
      freshnessSeconds: changed.metricDictionary![0]!.freshnessSeconds + 1,
    };
    expect(performanceContractDigest(changed)).not.toBe(performanceContractDigest(base));
  });

  it("fails closed with stable codes for missing, duplicate, and stale observations", () => {
    expect(() => evaluatePerformanceRun(
      contract(),
      completeObservations(),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_observation_deployment_revision_invalid");

    expect(() => evaluatePerformanceRun(
      contract(),
      observations("first_result", [500, 600, 700]),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_samples_incomplete");

    const duplicate = completeObservations();
    duplicate[1] = { ...duplicate[1]!, id: duplicate[0]!.id };
    expect(() => evaluatePerformanceRun(contract(), duplicate, "load", EVALUATED_AT))
      .toThrow("performance_observation_duplicate");

    const stale = completeObservations().map((observation) => ({
      ...observation,
      observedAt: "2026-09-01T00:00:00.000Z",
    }));
    expect(() => evaluatePerformanceRun(contract(), stale, "load", EVALUATED_AT))
      .toThrow("performance_observation_stale");

    expect(() => evaluatePerformanceRun(contract(), stale, "load"))
      .toThrow("performance_observation_stale");
  });

  it("rejects ambiguous tiers, incomplete dictionaries, and inverted objectives", () => {
    const duplicateTier = contract();
    duplicateTier.tiers.push({ ...duplicateTier.tiers[0]! });
    expect(() => validatePerformanceContract(duplicateTier))
      .toThrow("performance_tier_duplicate");

    const incompleteDictionary = contract();
    incompleteDictionary.metricDictionary!.pop();
    expect(() => validatePerformanceContract(incompleteDictionary))
      .toThrow("performance_metric_dictionary_incomplete");

    const invalidObjective = contract();
    invalidObjective.objectives[0] = { ...invalidObjective.objectives[0]!, p95Ms: 500 };
    expect(() => validatePerformanceContract(invalidObjective))
      .toThrow("performance_objective_order_invalid");
  });
});
