import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  PerformanceContract,
  PerformanceMetric,
} from "./performance-contract.js";
import { FETTLER_PERFORMANCE_CONTRACT } from "./performance-contract.js";
import {
  createHttpPerformanceProbe,
  persistPerformanceProbeReport,
  runPerformanceProbe,
  type PerformanceProbeMeasurement,
} from "./performance-runner.js";

const METRICS: readonly PerformanceMetric[] = [
  "first_result",
  "complete_scan",
  "verification",
  "queue_wait",
  "campaign_fanout",
];

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function contract(): PerformanceContract {
  return {
    version: "2026-08-02.v1",
    percentileMethod: "nearest_rank_v1",
    tiers: [{
      id: "test-tier",
      repository: { files: 10, bytes: 1_000, languages: ["typescript"] },
      concurrency: 2,
      minimumSamples: 2,
      loadDurationSeconds: 1,
      soakDurationSeconds: 2,
    }],
    objectives: METRICS.map((metric) => ({
      metric,
      p50Ms: 100,
      p95Ms: 200,
      p99Ms: 300,
    })),
  };
}

function measurement(durationMs = 10, success = true): PerformanceProbeMeasurement {
  return {
    metrics: Object.fromEntries(
      METRICS.map((metric) => [metric, { durationMs, success }]),
    ) as PerformanceProbeMeasurement["metrics"],
  };
}

function metadata() {
  return {
    repositoryRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    fixtureDigest: "c".repeat(64),
    dependencyVersions: { node: "22.17.0", vitest: "3.0.9" },
  };
}

describe("performance runner", () => {
  it("accepts documented legacy pilot tier identifiers and reports canonical identities", async () => {
    let now = 0;
    const small = FETTLER_PERFORMANCE_CONTRACT.tiers.find((tier) => tier.id === "small")!;
    const boundedContract: PerformanceContract = {
      ...FETTLER_PERFORMANCE_CONTRACT,
      tiers: [{
        ...small,
        minimumSamples: 2,
        loadDurationSeconds: 1,
        soakDurationSeconds: 2,
      }],
      objectives: FETTLER_PERFORMANCE_CONTRACT.objectives.filter(
        (objective) => objective.tierId === "small",
      ),
    };
    const report = await runPerformanceProbe({
      contract: boundedContract,
      tierId: "pilot-small",
      mode: "load",
      ...metadata(),
      tenantId: "tenant-fettler-production",
      repositoryId: "github-1319732323",
      correlationId: "corr-legacy-cli",
      source: "fettler-production-probe",
      repository: {
        files: 1_000,
        sourceLines: 50_000,
        bytes: 25_000_000,
        languages: ["typescript"],
      },
      now: () => now,
      probe: async () => {
        now += 500;
        return measurement();
      },
    });

    expect(report.tierId).toBe("small");
    expect(report.evaluation?.evidence).toMatchObject({
      tenantId: "tenant-fettler-production",
      repositoryId: "github-1319732323",
      measuredConcurrency: 2,
    });
  });

  it("honors tier concurrency and the load duration while recording every metric", async () => {
    let now = 0;
    let active = 0;
    let maximumActive = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async ({ signal }) => {
        expect(signal.aborted).toBe(false);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        now += 250;
        active -= 1;
        return measurement();
      },
    });

    expect(maximumActive).toBe(2);
    expect(report.status).toBe("completed");
    expect(report.plannedDurationMs).toBe(1_000);
    expect(report.concurrency).toBe(2);
    expect(report.observations).toHaveLength(20);
    expect(new Set(report.observations.map((item) => item.metric))).toEqual(new Set(METRICS));
    expect(report.evaluation?.results.every((result) => result.sampleCount === 4)).toBe(true);
    expect(report.ok).toBe(true);
  });

  it("evaluates only the explicitly selected workload tier", async () => {
    let now = 0;
    const twoTiers = contract();
    twoTiers.tiers.push({ ...twoTiers.tiers[0]!, id: "other-tier" });
    const report = await runPerformanceProbe({
      contract: twoTiers,
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async () => {
        now += 500;
        return measurement();
      },
    });

    expect(report.status).toBe("completed");
    expect(report.evaluation?.results).toHaveLength(5);
    expect(report.evaluation?.results.every((result) => result.tierId === "test-tier")).toBe(true);
  });

  it("uses the soak duration and fails closed when an invocation fails", async () => {
    let now = 0;
    let invocation = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "soak",
      ...metadata(),
      now: () => now,
      probe: async () => {
        invocation += 1;
        now += 500;
        if (invocation === 1) throw new Error("synthetic probe failure");
        return measurement();
      },
    });

    expect(report.plannedDurationMs).toBe(2_000);
    expect(report.observations).toHaveLength(20);
    expect(report.observations.slice(0, 5).every((item) => !item.success)).toBe(true);
    expect(report.evaluation?.results.every((result) => result.failureCount === 1)).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("propagates aborts and returns an explicitly incomplete report", async () => {
    const controller = new AbortController();
    let invoked = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      signal: controller.signal,
      probe: async ({ signal }) => {
        invoked += 1;
        controller.abort("operator_stop");
        expect(signal.aborted).toBe(true);
        return measurement();
      },
    });

    expect(invoked).toBeLessThanOrEqual(2);
    expect(report.status).toBe("aborted");
    expect(report.abortReason).toBe("operator_stop");
    expect(report.ok).toBe(false);
    expect(report.evaluation).toBeNull();
  });

  it("aborts hung in flight probes at the tier deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const signals: AbortSignal[] = [];
    const pending = runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      probe: ({ signal }) => {
        signals.push(signal);
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
        });
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const report = await pending;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(report.status).toBe("incomplete");
    expect(report.cancelledInvocationCount).toBe(2);
    expect(report.observations).toHaveLength(0);
    expect(report.ok).toBe(false);
  });

  it("atomically persists a revision bound JSON report", async () => {
    let now = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async () => {
        now += 500;
        return measurement();
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "performance-runner-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "reports", "load.json");

    expect(persistPerformanceProbeReport(output, report)).toBe(output);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      repositoryRevision: "a".repeat(40),
      deploymentRevision: "b".repeat(40),
      fixtureDigest: "c".repeat(64),
      mode: "load",
    });
  });

  it("rejects mutable revisions before doing work", async () => {
    let invoked = false;
    await expect(runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      repositoryRevision: "main",
      probe: async () => {
        invoked = true;
        return measurement();
      },
    })).rejects.toThrow("performance_repository_revision_invalid");
    expect(invoked).toBe(false);
  });

  it("uses an injected HTTP client and verifies the deployment revision", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        deploymentRevision: "b".repeat(40),
        fixtureDigest: "c".repeat(64),
      });
      return new Response(JSON.stringify({
        deploymentRevision: "b".repeat(40),
        ...measurement(),
      }), { status: 200 });
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.invalid/performance",
      fetch: request,
    });
    const result = await probe({
      invocationId: "test-tier.load.00000000",
      sequence: 0,
      mode: "load",
      tier: contract().tiers[0]!,
      repositoryRevision: "a".repeat(40),
      deploymentRevision: "b".repeat(40),
      fixtureDigest: "c".repeat(64),
      signal: new AbortController().signal,
    });

    expect(result).toEqual(measurement());
    expect(request).toHaveBeenCalledTimes(1);
  });
});
