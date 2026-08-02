import { describe, expect, it } from "vitest";
import {
  evaluatePerformanceRun,
  validatePerformanceContract,
  WARDEN_PERFORMANCE_CONTRACT,
  type PerformanceContract,
  type PerformanceObservation,
} from "./performance-contract.js";

function contract(): PerformanceContract {
  return {
    version: "2026-08-02.v1",
    percentileMethod: "nearest_rank_v1",
    tiers: [{
      id: "pilot-small",
      repository: {
        files: 5_000,
        bytes: 50_000_000,
        languages: ["typescript"],
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
  };
}

function observations(metric: PerformanceObservation["metric"], values: number[]) {
  return values.map((durationMs, index): PerformanceObservation => ({
    id: `${metric}-${index}`,
    tierId: "pilot-small",
    metric,
    mode: "load",
    durationMs,
    success: true,
    observedAt: `2026-08-02T00:00:0${index}.000Z`,
  }));
}

describe("performance contract", () => {
  it("ships a valid small and medium Warden workload contract", () => {
    expect(validatePerformanceContract(WARDEN_PERFORMANCE_CONTRACT).tiers.map((tier) => tier.id)).toEqual([
      "pilot-small",
      "pilot-medium",
    ]);
  });

  it("evaluates p50, p95, and p99 against versioned objectives", () => {
    const input = [
      ...observations("first_result", [500, 800, 1_000, 1_500]),
      ...observations("complete_scan", [5_000, 8_000, 9_000, 12_000]),
      ...observations("verification", [2_000, 3_000, 4_000, 6_000]),
      ...observations("queue_wait", [100, 200, 300, 500]),
      ...observations("campaign_fanout", [1_000, 1_200, 1_500, 2_500]),
    ];
    const report = evaluatePerformanceRun(contract(), input);

    expect(report.ok).toBe(true);
    expect(report.results.find((result) => result.metric === "first_result")).toMatchObject({
      sampleCount: 4,
      p50Ms: 800,
      p95Ms: 1_500,
      p99Ms: 1_500,
      ok: true,
    });
  });

  it("fails closed for missing samples, failed work, or missed objectives", () => {
    const missing = observations("first_result", [500, 600, 700]);
    expect(() => evaluatePerformanceRun(contract(), missing)).toThrow("performance_samples_incomplete");

    const failed = [
      ...observations("first_result", [500, 600, 700, 800]),
      ...observations("complete_scan", [5_000, 6_000, 7_000, 8_000]),
      ...observations("verification", [2_000, 3_000, 4_000, 5_000]),
      ...observations("queue_wait", [100, 200, 300, 400]),
      ...observations("campaign_fanout", [1_000, 1_100, 1_200, 1_300]),
    ];
    failed[0] = { ...failed[0]!, success: false };
    expect(evaluatePerformanceRun(contract(), failed).ok).toBe(false);

    const slow = failed.map((item) => ({ ...item, success: true }));
    slow[0] = { ...slow[0]!, durationMs: 30_001 };
    expect(evaluatePerformanceRun(contract(), slow).ok).toBe(false);
  });

  it("rejects ambiguous tiers and incomplete percentile objectives", () => {
    const duplicate = contract();
    duplicate.tiers.push({ ...duplicate.tiers[0]! });
    expect(() => validatePerformanceContract(duplicate)).toThrow("performance_tier_duplicate");

    const invalid = contract();
    invalid.objectives[0] = { ...invalid.objectives[0]!, p95Ms: 500 };
    expect(() => validatePerformanceContract(invalid)).toThrow("performance_objective_order_invalid");
  });
});
