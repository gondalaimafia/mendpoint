import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluatePerformanceRun,
  FETTLER_PERFORMANCE_CONTRACT,
  metricDictionaryDigest,
  performanceContractDigest,
  resolvePerformanceTierId,
  validatePerformanceContract,
  type PerformanceContract,
  type PerformanceEvidenceBinding,
  type PerformanceObservation,
} from "./performance-contract.js";

const EVALUATED_AT = "2026-09-02T00:01:10.000Z";

function documentedDuration(milliseconds: number): string {
  if (milliseconds >= 120_000 && milliseconds % 60_000 === 0) return `${milliseconds / 60_000} minutes`;
  if (milliseconds === 60_000) return "1 minute";
  return `${milliseconds / 1_000} seconds`;
}

function contract(): PerformanceContract {
  return {
    version: "2026-09-02.v3",
    percentileMethod: "nearest_rank_v1",
    metricDictionaryVersion: "2026-09-02.v1",
    tiers: [{
      id: "small",
      repository: {
        minimumFiles: 1_000,
        files: 2_000,
        minimumSourceLines: 50_000,
        sourceLines: 100_000,
        minimumBytes: 25_000_000,
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
      { tierId: "small", metric: "first_result", p50Ms: 1_000, p95Ms: 2_000, p99Ms: 3_000 },
      { tierId: "small", metric: "complete_scan", p50Ms: 10_000, p95Ms: 20_000, p99Ms: 30_000 },
      { tierId: "small", metric: "verification", p50Ms: 5_000, p95Ms: 10_000, p99Ms: 15_000 },
      { tierId: "small", metric: "queue_wait", p50Ms: 500, p95Ms: 1_000, p99Ms: 1_500 },
      { tierId: "small", metric: "campaign_fanout", p50Ms: 2_000, p95Ms: 4_000, p99Ms: 6_000 },
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
      dimensions: [
        "tenant_id",
        "repository_id",
        "deployment_revision",
        "repository_revision",
        "fixture_digest",
        "correlation_id",
        "probe_source",
        "tier_id",
        "mode",
      ],
      exclusions: ["operator_cancelled"],
      freshnessSeconds: 300,
      qualityChecks: ["finite_duration", "successful_terminal_state", "revision_bound"],
    })),
  } as PerformanceContract;
}

function binding(overrides: Partial<PerformanceEvidenceBinding> = {}): PerformanceEvidenceBinding {
  return {
    tierId: "small",
    tenantId: "tenant-fettler-production",
    repositoryId: "github-1319732323",
    repositoryRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    fixtureDigest: `sha256:${"c".repeat(64)}`,
    correlationId: "corr-fettler-load-0001",
    source: "fettler-production-probe",
    repository: {
      files: 1_800,
      sourceLines: 90_000,
      bytes: 45_000_000,
      languages: ["typescript"],
      languageSourceLines: { typescript: 90_000 },
    },
    measuredConcurrency: 2,
    startedAt: "2026-09-02T00:00:00.000Z",
    endedAt: "2026-09-02T00:01:00.000Z",
    ...overrides,
  };
}

function observations(metric: PerformanceObservation["metric"], values: number[]) {
  const evidence = binding();
  return values.map((durationMs, index): PerformanceObservation => ({
    id: `${metric}-${index}`,
    tierId: "small",
    metric,
    mode: "load",
    durationMs,
    success: true,
    observedAt: `2026-09-02T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
    tenantId: evidence.tenantId,
    repositoryId: evidence.repositoryId,
    repositoryRevision: evidence.repositoryRevision,
    deploymentRevision: evidence.deploymentRevision,
    fixtureDigest: evidence.fixtureDigest,
    correlationId: evidence.correlationId,
    source: evidence.source,
    eventSource: `fettler.performance.${metric}`,
    bindingSource: "probe_observed",
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
  it("keeps every documented objective equal to the executable authority", () => {
    const documentation = readFileSync(resolve("docs/PERFORMANCE_CONTRACT.md"), "utf8");
    const labels = {
      first_result: "First result",
      complete_scan: "Complete scan",
      verification: "Verification",
      queue_wait: "Queue wait",
      campaign_fanout: "Campaign fanout",
    } as const;
    for (const objective of FETTLER_PERFORMANCE_CONTRACT.objectives) {
      expect(documentation).toContain(
        `| ${objective.tierId} | ${labels[objective.metric]} | ${documentedDuration(objective.p50Ms)} | ${documentedDuration(objective.p95Ms)} | ${documentedDuration(objective.p99Ms)} |`,
      );
    }
    expect(documentation).toContain("--repository-language-source-lines=typescript:50000");
  });
  it("publishes production workload ceilings, language mix, concurrency, and metric quality", () => {
    const validated = validatePerformanceContract(FETTLER_PERFORMANCE_CONTRACT);

    expect(validated.tiers.map((tier) => tier.id)).toEqual([
      "small",
      "medium",
      "large",
    ]);
    expect(validated.tiers.map((tier) => ({
      id: tier.id,
      minimumFiles: tier.repository.minimumFiles,
      minimumSourceLines: tier.repository.minimumSourceLines,
      sourceLines: tier.repository.sourceLines,
      files: tier.repository.files,
      languages: tier.repository.languages.length,
      concurrency: tier.concurrency,
    }))).toEqual([
      { id: "small", minimumFiles: 1_000, minimumSourceLines: 50_000, sourceLines: 100_000, files: 2_000, languages: 1, concurrency: 2 },
      { id: "medium", minimumFiles: 10_000, minimumSourceLines: 500_000, sourceLines: 1_000_000, files: 20_000, languages: 3, concurrency: 4 },
      { id: "large", minimumFiles: 50_000, minimumSourceLines: 2_500_000, sourceLines: 5_000_000, files: 100_000, languages: 6, concurrency: 8 },
    ]);
    expect(validated.objectives).toHaveLength(15);
    expect(validated.objectives.find((objective) =>
      objective.tierId === "large" && objective.metric === "complete_scan",
    )).toMatchObject({ p50Ms: 2_100_000, p95Ms: 4_500_000, p99Ms: 7_200_000 });
    expect(validated.metricDictionary).toHaveLength(5);
    expect(validated.metricDictionary![0]).toMatchObject({
      eventSource: expect.stringMatching(/^fettler\.performance\./),
      dimensions: expect.arrayContaining(["deployment_revision", "repository_revision"]),
      freshnessSeconds: expect.any(Number),
    });
  });

  it("evaluates first result, complete run, concurrency, and nearest-rank percentiles", () => {
    const report = evaluatePerformanceRun(
      contract(),
      completeObservations(),
      binding(),
      "load",
      EVALUATED_AT,
    );

    expect(report.ok).toBe(true);
    expect(report.contractDigest).toBe(performanceContractDigest(contract()));
    expect(report.metricDictionaryDigest).toBe(metricDictionaryDigest(contract()));
    expect(report.results.find((result) => result.metric === "first_result")).toMatchObject({
      tierId: "small",
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
      observations("first_result", [500, 600, 700]),
      binding(),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_samples_incomplete");

    const duplicate = completeObservations();
    duplicate[1] = { ...duplicate[1]!, id: duplicate[0]!.id };
    expect(() => evaluatePerformanceRun(contract(), duplicate, binding(), "load", EVALUATED_AT))
      .toThrow("performance_observation_duplicate");

    const stale = completeObservations().map((observation) => ({
      ...observation,
      observedAt: "2026-09-01T00:00:00.000Z",
    }));
    expect(() => evaluatePerformanceRun(contract(), stale, binding({
      startedAt: "2026-09-01T00:00:00.000Z",
      endedAt: "2026-09-01T00:01:00.000Z",
    }), "load", EVALUATED_AT))
      .toThrow("performance_observation_stale");
  });

  it("fails closed when production evidence is unbound or not actually measured", () => {
    const base = completeObservations();
    const unbound = base.map((observation) => ({ ...observation, tenantId: "" }));
    expect(() => evaluatePerformanceRun(contract(), unbound, binding(), "load", EVALUATED_AT))
      .toThrow("performance_observation_tenant_mismatch");

    const zeroDuration = base.map((observation) => ({ ...observation, durationMs: 0 }));
    expect(() => evaluatePerformanceRun(contract(), zeroDuration, binding(), "load", EVALUATED_AT))
      .toThrow("performance_observation_duration_invalid");

    const wrongEventSource = base.map((observation, index) => index === 0
      ? { ...observation, eventSource: "fettler.performance.untrusted" }
      : observation);
    expect(() => evaluatePerformanceRun(contract(), wrongEventSource, binding(), "load", EVALUATED_AT))
      .toThrow("performance_observation_event_source_mismatch");

    expect(() => evaluatePerformanceRun(
      contract(),
      base,
      binding({ measuredConcurrency: 1 }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_measured_concurrency_mismatch");

    expect(() => evaluatePerformanceRun(
      contract(),
      base,
      binding({ repository: { ...binding().repository, files: 2_001 } }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_repository_shape_exceeds_tier");

    expect(() => evaluatePerformanceRun(
      FETTLER_PERFORMANCE_CONTRACT,
      base,
      binding({
        endedAt: "2026-09-02T00:05:00.000Z",
        repository: {
        files: 999,
        sourceLines: 50_000,
        bytes: 25_000_000,
        languages: ["typescript"],
        languageSourceLines: { typescript: 50_000 },
        },
      }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_repository_shape_below_tier");

    const medium = FETTLER_PERFORMANCE_CONTRACT.tiers.find((tier) => tier.id === "medium")!;
    expect(() => evaluatePerformanceRun(
      { ...FETTLER_PERFORMANCE_CONTRACT, tiers: [medium], objectives: FETTLER_PERFORMANCE_CONTRACT.objectives.filter((item) => item.tierId === "medium") },
      base.map((item) => ({ ...item, tierId: "medium" })),
      binding({
        tierId: "medium",
        measuredConcurrency: 4,
        endedAt: "2026-09-02T00:10:00.000Z",
        repository: {
          files: 10_000,
          sourceLines: 500_000,
          bytes: 250_000_000,
          languages: ["javascript", "python", "typescript"],
          languageSourceLines: { javascript: 499_998, python: 1, typescript: 1 },
        },
      }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_repository_language_distribution_invalid");

    expect(() => evaluatePerformanceRun(
      { ...FETTLER_PERFORMANCE_CONTRACT, tiers: [medium], objectives: FETTLER_PERFORMANCE_CONTRACT.objectives.filter((item) => item.tierId === "medium") },
      base.map((item) => ({ ...item, tierId: "medium" })),
      binding({
        tierId: "medium",
        measuredConcurrency: 4,
        endedAt: "2026-09-02T00:10:00.000Z",
        repository: {
          files: 10_000,
          sourceLines: 500_000,
          bytes: 250_000_000,
          languages: ["javascript"],
          languageSourceLines: { javascript: 200_000, python: 150_000, typescript: 150_000 },
        },
      }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_repository_language_distribution_invalid");

    expect(() => evaluatePerformanceRun(
      contract(),
      base,
      binding({ endedAt: "2026-09-02T00:00:59.999Z" }),
      "load",
      EVALUATED_AT,
    )).toThrow("performance_run_duration_incomplete");
  });

  it("accepts legacy pilot tier inputs while emitting canonical tier identities", () => {
    expect(resolvePerformanceTierId("pilot-small")).toBe("small");
    expect(resolvePerformanceTierId("pilot-medium")).toBe("medium");
    expect(resolvePerformanceTierId("pilot-large")).toBe("large");
    expect(resolvePerformanceTierId("small")).toBe("small");
    expect(() => resolvePerformanceTierId("warden-small"))
      .toThrow("performance_tier_not_found");
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
