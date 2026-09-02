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
  parsePerformanceCliArguments,
  persistPerformanceProbeReport,
  runPerformanceCli,
  runPerformanceProbe,
  type PerformanceProbeContext,
  type PerformanceProbeMeasurement,
} from "./performance-runner.js";

const METRICS: readonly PerformanceMetric[] = [
  "first_result",
  "complete_scan",
  "verification",
  "queue_wait",
  "campaign_fanout",
];
const EXPECTED_OBSERVATION_LIMIT = 10_000;
const EXPECTED_RESPONSE_BYTE_LIMIT = 1_048_576;

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

function measurement(
  durationMs = 10,
  success = true,
  observedOverrides: Partial<PerformanceProbeMeasurement["observed"]> = {},
): PerformanceProbeMeasurement {
  return {
    observed: {
      tenantId: "tenant-fettler-production",
      repositoryId: "github-1319732323",
      repositoryRevision: "a".repeat(40),
      deploymentRevision: "b".repeat(40),
      fixtureDigest: `sha256:${"c".repeat(64)}`,
      correlationId: "corr-fettler-performance",
      probeSource: "fettler-production-probe",
      invocationId: "test-tier.load.00000000",
      invocationNonce: "nonce-test-tier-load-00000000",
      sequence: 0,
      observedAt: "1970-01-01T00:00:00.000Z",
      repository: {
        files: 10,
        sourceLines: 100,
        bytes: 1_000,
        maxFileBytes: 100,
        languages: ["typescript"],
        languageSourceLines: { typescript: 100 },
      },
      ...observedOverrides,
    },
    metrics: Object.fromEntries(
      METRICS.map((metric) => [metric, {
        durationMs,
        success,
        eventSource: `fettler.performance.${metric}`,
      }]),
    ) as PerformanceProbeMeasurement["metrics"],
  };
}

function metadata() {
  return {
    tenantId: "tenant-fettler-production",
    repositoryId: "github-1319732323",
    repositoryRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    fixtureDigest: "c".repeat(64),
    correlationId: "corr-fettler-performance",
    source: "fettler-production-probe",
    repository: {
      files: 10,
      sourceLines: 100,
      bytes: 1_000,
      maxFileBytes: 100,
      languages: ["typescript"],
      languageSourceLines: { typescript: 100 },
    },
    dependencyVersions: { node: "22.17.0", vitest: "3.0.9" },
  };
}

function probeContext(correlationId = "corr-fettler-performance") {
  return {
    invocationId: "test-tier.load.00000000",
    invocationNonce: "nonce-test-tier-load-00000000",
    invokedAt: "1970-01-01T00:00:00.000Z",
    sequence: 0,
    mode: "load" as const,
    tier: contract().tiers[0]!,
    repositoryRevision: "a".repeat(40),
    deploymentRevision: "b".repeat(40),
    fixtureDigest: "c".repeat(64),
    tenantId: "tenant-fettler-production",
    repositoryId: "github-1319732323",
    correlationId,
    source: "fettler-production-probe",
    repository: metadata().repository,
    metricEventSources: Object.fromEntries(
      METRICS.map((metric) => [metric, `fettler.performance.${metric}`]),
    ) as Record<PerformanceMetric, string>,
    signal: new AbortController().signal,
  };
}

function measurementFor(
  context: Pick<PerformanceProbeContext,
    "invocationId" | "invocationNonce" | "invokedAt" | "sequence">,
  durationMs = 10,
  success = true,
  observedOverrides: Partial<PerformanceProbeMeasurement["observed"]> = {},
): PerformanceProbeMeasurement {
  return measurement(durationMs, success, {
    invocationId: context.invocationId,
    invocationNonce: context.invocationNonce,
    sequence: context.sequence,
    observedAt: context.invokedAt,
    ...observedOverrides,
  });
}

function testPerformanceTransport(request: typeof fetch) {
  return {
    resolveHostname: async () => ["93.184.216.34"],
    pinnedRequest: async (endpoint: URL, _approvedAddress: string, init: RequestInit) =>
      request(endpoint, init),
  };
}

describe("performance runner", () => {
  it("executes canonical CLI bindings through persisted report bytes", async () => {
    let now = 0;
    const directory = mkdtempSync(join(tmpdir(), "performance-cli-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "reports", "load.json");
    const args = [
      "--mode=load", "--tier=test-tier", "--endpoint=https://deployment.example/probe",
      "--tenant-id=tenant-fettler-production", "--repository-id=github-1319732323",
      `--repository-revision=${"a".repeat(40)}`, `--deployment-revision=${"b".repeat(40)}`,
      `--fixture-digest=sha256:${"c".repeat(64)}`, "--correlation-id=corr-fettler-performance",
      "--probe-source=fettler-production-probe", "--repository-files=10",
      "--repository-source-lines=100", "--repository-bytes=1000",
      "--repository-max-file-bytes=100",
      "--repository-languages=typescript", "--repository-language-source-lines=typescript:100",
      `--output=${output}`,
    ];

    const report = await runPerformanceCli(args, {
      contract: contract(),
      dependencyVersions: { node: "test" },
      now: () => now,
      probe: async (context) => {
        now += 500;
        return measurementFor(context);
      },
    });

    expect(report.ok).toBe(true);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      tenantId: "tenant-fettler-production",
      repositoryRevision: "a".repeat(40),
      repository: { languages: ["typescript"] },
      measuredRepository: { languageSourceLines: { typescript: 100 } },
      ok: true,
    });
  });
  it("parses every canonical operator binding including measured language distribution", () => {
    expect(parsePerformanceCliArguments([
      "--mode=load",
      "--tier=small",
      "--endpoint=https://deployment.example/internal/performance-probe",
      "--tenant-id=tenant-example",
      "--repository-id=repository-example",
      `--repository-revision=${"a".repeat(40)}`,
      `--deployment-revision=${"b".repeat(40)}`,
      `--fixture-digest=sha256:${"c".repeat(64)}`,
      "--correlation-id=correlation-example",
      "--probe-source=fettler-production-probe",
      "--repository-files=1000",
      "--repository-source-lines=50000",
      "--repository-bytes=25000000",
      "--repository-max-file-bytes=1000000",
      "--repository-languages=typescript",
      "--repository-language-source-lines=typescript:50000",
      "--output=runs/performance/load.json",
    ])).toMatchObject({
      mode: "load",
      tierId: "small",
      repositoryRevision: "a".repeat(40),
      source: "fettler-production-probe",
      repository: {
        files: 1_000,
        sourceLines: 50_000,
        bytes: 25_000_000,
        maxFileBytes: 1_000_000,
        languages: ["typescript"],
        languageSourceLines: { typescript: 50_000 },
      },
    });
  });

  it("rejects a CLI language set that differs from its measured distribution", () => {
    expect(() => parsePerformanceCliArguments([
      "--mode=load", "--tier=small", "--endpoint=https://deployment.example/probe",
      "--tenant-id=tenant-example", "--repository-id=repository-example",
      `--repository-revision=${"a".repeat(40)}`, `--deployment-revision=${"b".repeat(40)}`,
      `--fixture-digest=sha256:${"c".repeat(64)}`, "--correlation-id=correlation-example",
      "--probe-source=fettler-production-probe", "--repository-files=1000",
      "--repository-source-lines=50000", "--repository-bytes=25000000",
      "--repository-max-file-bytes=1000000",
      "--repository-languages=typescript", "--repository-language-source-lines=javascript:50000",
      "--output=runs/performance/load.json",
    ])).toThrow("performance_repository_language_distribution_invalid");
  });
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
        maxFileBytes: 1_000_000,
        languages: ["typescript"],
        languageSourceLines: { typescript: 50_000 },
      },
      now: () => now,
      probe: async (context) => {
        now += 500;
        return measurementFor(context, 10, true, {
          correlationId: "corr-legacy-cli",
          repository: {
            files: 1_000,
            sourceLines: 50_000,
            bytes: 25_000_000,
            maxFileBytes: 1_000_000,
            languages: ["typescript"],
            languageSourceLines: { typescript: 50_000 },
          },
        });
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
      probe: async (context) => {
        const { signal } = context;
        expect(signal.aborted).toBe(false);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        now += 250;
        active -= 1;
        return measurementFor(context);
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

  it("completes high-throughput probes with bounded representative evidence and sealed aggregates", async () => {
    let now = 0;
    let invocations = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async (context) => {
        invocations += 1;
        now += 0.1;
        return measurementFor(context);
      },
    });

    expect(report.status).toBe("completed");
    expect(report.ok).toBe(true);
    expect(report.abortReason).toBeNull();
    expect(report.observations.length).toBeLessThanOrEqual(EXPECTED_OBSERVATION_LIMIT);
    expect(invocations).toBeGreaterThan(EXPECTED_OBSERVATION_LIMIT / METRICS.length);
    expect(report.aggregation).toMatchObject({
      samplingPolicy: "deterministic_stride_v1",
      totalInvocationCount: invocations,
      retainedObservationCount: report.observations.length,
      droppedObservationCount: invocations * METRICS.length - report.observations.length,
    });
    expect(report.aggregation.aggregateDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.aggregation.metrics.every((metric) =>
      metric.sampleCount === invocations &&
      metric.failureCount === 0 &&
      metric.withinObjectiveP99Count === invocations &&
      metric.histogram.reduce((total, bucket) => total + bucket.count, 0) === invocations,
    )).toBe(true);
  });

  it("uses complete aggregate objective counts when bounded raw sampling omits slow invocations", async () => {
    let now = 0;
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async (context) => {
        now += 0.1;
        return measurementFor(context, context.sequence % 2 === 0 ? 10 : 1_000);
      },
    });

    expect(report.status).toBe("completed");
    expect(report.aggregation.droppedObservationCount).toBeGreaterThan(0);
    expect(report.evaluation?.ok).toBe(true);
    expect(report.aggregation.metrics.every((metric) =>
      metric.withinObjectiveP99Count < Math.ceil(metric.sampleCount * 0.99),
    )).toBe(true);
    expect(report.ok).toBe(false);
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
      probe: async (context) => {
        now += 500;
        return measurementFor(context);
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
      probe: async (context) => {
        invocation += 1;
        now += 500;
        return measurementFor(context, 10, invocation !== 1);
      },
    });

    expect(report.plannedDurationMs).toBe(2_000);
    expect(report.observations).toHaveLength(20);
    expect(report.observations.slice(0, 5).every((item) => !item.success)).toBe(true);
    expect(report.evaluation?.results.every((result) => result.failureCount === 1)).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("retains a same-tick unobserved failure as a nonzero failed sample and incomplete report", async () => {
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => 0,
      probe: async () => { throw new Error("same tick failure"); },
    });

    expect(report.status).toBe("incomplete");
    expect(report.ok).toBe(false);
    expect(report.aggregation.totalInvocationCount).toBe(1);
    expect(report.observations).toHaveLength(5);
    expect(report.observations.every((item) => item.durationMs === 1 && !item.success)).toBe(true);
    expect(report.observations.every((item) => item.bindingSource === "request_context")).toBe(true);
    expect(report.abortReason).toBe("probe_failure_unobserved");
    expect(report.evaluation).toBeNull();
  });

  it("retains the same internal abort reason for invalid producer measurements", async () => {
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => 0,
      probe: async (context) => ({ ...measurementFor(context), metrics: {} }) as PerformanceProbeMeasurement,
    });

    expect(report.status).toBe("incomplete");
    expect(report.abortReason).toBe("probe_failure_unobserved");
    expect(report.observations.every((item) => !item.success)).toBe(true);
  });

  it.each([
    ["wrong invocation nonce at the deadline", 1_000, (value: PerformanceProbeMeasurement) => ({
      ...value,
      observed: { ...value.observed, invocationNonce: "forged-nonce" },
    })],
    ["wrong invocation identifier after the deadline", 1_001, (value: PerformanceProbeMeasurement) => ({
      ...value,
      observed: { ...value.observed, invocationId: "forged-invocation" },
    })],
    ["stale producer timestamp at the deadline", 1_000, (value: PerformanceProbeMeasurement) => ({
      ...value,
      observed: { ...value.observed, observedAt: "1969-12-31T23:00:00.000Z" },
    })],
    ["missing producer provenance after the deadline", 1_001, (value: PerformanceProbeMeasurement) => ({
      ...value,
      observed: undefined,
    }) as unknown as PerformanceProbeMeasurement],
  ])("fails closed for %s instead of laundering it as cancellation", async (_name, returnedAt, mutate) => {
    let now = 0;
    const singleInvocationContract = contract();
    singleInvocationContract.tiers[0] = {
      ...singleInvocationContract.tiers[0]!,
      concurrency: 1,
      minimumSamples: 1,
    };
    const report = await runPerformanceProbe({
      contract: singleInvocationContract,
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      now: () => now,
      probe: async (context) => {
        const result = mutate(measurementFor(context));
        now = returnedAt;
        return result;
      },
    });

    expect(report.status).toBe("incomplete");
    expect(report.ok).toBe(false);
    expect(report.abortReason).toBe("probe_failure_unobserved");
    expect(report.cancelledInvocationCount).toBe(0);
    expect(report.aggregation.totalInvocationCount).toBe(1);
    expect(report.observations).toHaveLength(5);
    expect(report.observations.every((item) =>
      !item.success && item.bindingSource === "request_context"
    )).toBe(true);
  });

  it("retains malformed producer evidence when abort wins between response and validation", async () => {
    let responseReturned = false;
    const external = new AbortController();
    const singleInvocationContract = contract();
    singleInvocationContract.tiers[0] = {
      ...singleInvocationContract.tiers[0]!,
      concurrency: 1,
      minimumSamples: 1,
    };
    const report = await runPerformanceProbe({
      contract: singleInvocationContract,
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      signal: external.signal,
      now: () => {
        if (responseReturned && !external.signal.aborted) external.abort("deadline_race");
        return responseReturned ? 1_000 : 0;
      },
      probe: async (context) => {
        responseReturned = true;
        return measurementFor(context, 10, true, { invocationNonce: "forged-nonce" });
      },
    });

    expect(report.status).toBe("aborted");
    expect(report.abortReason).toBe("deadline_race");
    expect(report.ok).toBe(false);
    expect(report.cancelledInvocationCount).toBe(0);
    expect(report.aggregation.totalInvocationCount).toBe(1);
    expect(report.observations).toHaveLength(5);
    expect(report.observations.every((item) =>
      !item.success && item.bindingSource === "request_context"
    )).toBe(true);
  });

  it("rejects a producer-observed repository shape that differs from the requested fixture", async () => {
    const report = await runPerformanceProbe({
      contract: contract(),
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      probe: async (context) => ({
        ...measurementFor(context),
        observed: {
          ...measurementFor(context).observed,
          repository: { ...metadata().repository, files: metadata().repository.files + 1 },
        },
      }),
    });

    expect(report.status).toBe("incomplete");
    expect(report.ok).toBe(false);
    expect(report.evaluation).toBeNull();
    expect(report.measuredRepository).toBeNull();
    expect(report.aggregation.totalInvocationCount).toBe(2);
    expect(report.observations).toHaveLength(10);
    expect(report.observations.every((item) => !item.success && item.bindingSource === "request_context")).toBe(true);
  });

  it("accepts a semantically identical repository shape regardless of object insertion order", async () => {
    let now = 0;
    const twoLanguageContract = contract();
    twoLanguageContract.tiers[0] = {
      ...twoLanguageContract.tiers[0]!,
      repository: { ...twoLanguageContract.tiers[0]!.repository, languages: ["typescript", "javascript"] },
    };
    const expectedRepository = {
      files: 10,
      sourceLines: 100,
      bytes: 1_000,
      maxFileBytes: 100,
      languages: ["typescript", "javascript"],
      languageSourceLines: { typescript: 80, javascript: 20 },
    };
    const report = await runPerformanceProbe({
      contract: twoLanguageContract,
      tierId: "test-tier",
      mode: "load",
      ...metadata(),
      repository: expectedRepository,
      now: () => now,
      probe: async (context) => {
        now += 500;
        return measurementFor(context, 10, true, {
          repository: {
            languageSourceLines: { javascript: 20, typescript: 80 },
            languages: ["javascript", "typescript"],
            maxFileBytes: 100,
            bytes: 1_000,
            sourceLines: 100,
            files: 10,
          },
        });
      },
    });

    expect(report.status).toBe("completed");
    expect(report.ok).toBe(true);
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
      probe: async (context) => {
        const { signal } = context;
        invoked += 1;
        controller.abort("operator_stop");
        expect(signal.aborted).toBe(true);
        return measurementFor(context);
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
    expect(report.abortReason).toBe("duration_elapsed");
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
      probe: async (context) => {
        now += 500;
        return measurementFor(context);
      },
    });
    const directory = mkdtempSync(join(tmpdir(), "performance-runner-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "reports", "load.json");

    expect(persistPerformanceProbeReport(output, report)).toBe(output);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      schemaVersion: 3,
      repositoryRevision: "a".repeat(40),
      deploymentRevision: "b".repeat(40),
      fixtureDigest: `sha256:${"c".repeat(64)}`,
      tenantId: "tenant-fettler-production",
      repositoryId: "github-1319732323",
      correlationId: "corr-fettler-performance",
      source: "fettler-production-probe",
      mode: "load",
      observations: expect.arrayContaining([
        expect.objectContaining({
          invocationId: "test-tier.load.00000000",
          invocationNonce: expect.any(String),
          producerSequence: 0,
        }),
      ]),
    });
  });

  it("allows only byte-identical report replay and rejects different evidence at the same path", async () => {
    let now = 0;
    const report = await runPerformanceProbe({
      contract: contract(), tierId: "test-tier", mode: "load", ...metadata(), now: () => now,
      probe: async (context) => { now += 500; return measurementFor(context); },
    });
    const directory = mkdtempSync(join(tmpdir(), "performance-immutable-"));
    temporaryDirectories.push(directory);
    const output = join(directory, "reports", "load.json");

    expect(persistPerformanceProbeReport(output, report)).toBe(output);
    expect(persistPerformanceProbeReport(output, report)).toBe(output);
    expect(() => persistPerformanceProbeReport(output, {
      ...report,
      deploymentRevision: "d".repeat(40),
    })).toThrow("performance_report_conflict");
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      deploymentRevision: "b".repeat(40),
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
      probe: async (context) => {
        invoked = true;
        return measurementFor(context);
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
        ...measurement(10, true, { correlationId: "corr-http-probe" }),
      }), { status: 200 });
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.invalid/performance",
      ...testPerformanceTransport(request),
    });
    const result = await probe(probeContext("corr-http-probe"));

    expect(result).toEqual(measurement(10, true, { correlationId: "corr-http-probe" }));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects remote plaintext endpoints when a bearer token is configured", () => {
    expect(() => createHttpPerformanceProbe({
      endpoint: "http://probe.example/performance",
      bearerToken: "do-not-expose",
    })).toThrow("performance_probe_https_required");
  });

  it("requires an exact approved destination before configuring a credentialed probe", () => {
    expect(() => createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      bearerToken: "secret-value",
    })).toThrow("performance_probe_approved_destination_required");
    expect(() => createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://other.example/performance",
      bearerToken: "secret-value",
    })).toThrow("performance_probe_approved_destination_mismatch");
  });

  it("rejects every DNS answer when any resolved performance destination is unsafe", async () => {
    const pinnedRequest = vi.fn();
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://probe.example/performance",
      bearerToken: "secret-value",
      resolveHostname: async () => ["93.184.216.34", "169.254.169.254"],
      pinnedRequest,
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_destination_blocked");
    expect(pinnedRequest).not.toHaveBeenCalled();
  });

  it("pins each performance request to the address approved for that invocation", async () => {
    const pinnedRequest = vi.fn(async (
      _endpoint: URL,
      approvedAddress: string,
    ) => {
      expect(approvedAddress).toBe("93.184.216.34");
      return new Response(JSON.stringify(measurement()), { status: 200 });
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://probe.example/performance",
      bearerToken: "secret-value",
      resolveHostname: async () => ["93.184.216.34"],
      pinnedRequest,
    });

    await expect(probe(probeContext())).resolves.toEqual(measurement());
    expect(pinnedRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects a replayed producer response for a different invocation nonce", async () => {
    const cached = measurement();
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://probe.example/performance",
      bearerToken: "secret-value",
      ...testPerformanceTransport(async () => new Response(JSON.stringify(cached), { status: 200 })),
    });

    await expect(probe(probeContext())).resolves.toEqual(cached);
    await expect(probe({
      ...probeContext(),
      invocationId: "test-tier.load.00000001",
      invocationNonce: "nonce-test-tier-load-00000001",
      sequence: 1,
    })).rejects.toThrow("performance_probe_invocation_mismatch");
  });

  it("rejects producer evidence without exact invocation binding", async () => {
    const valid = measurement();
    const { invocationNonce: _omitted, ...unboundObserved } = valid.observed;
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      ...testPerformanceTransport(async () => new Response(JSON.stringify({
        ...valid,
        observed: unboundObserved,
      }), { status: 200 })),
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_invocation_nonce_mismatch");
  });

  it("rejects stale producer timestamps even when the identity matches", async () => {
    const context = {
      ...probeContext(),
      invokedAt: "2026-09-02T12:00:00.000Z",
    };
    const stale = measurementFor(context, 10, true, {
      observedAt: "2026-09-02T11:00:00.000Z",
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      ...testPerformanceTransport(async () => new Response(JSON.stringify(stale), { status: 200 })),
    });

    await expect(probe(context)).rejects.toThrow("performance_probe_observed_at_invalid");
  });

  it("rejects metrics without producer event provenance", async () => {
    const valid = measurement();
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      ...testPerformanceTransport(async () => new Response(JSON.stringify({
        ...valid,
        metrics: {
          ...valid.metrics,
          verification: { durationMs: 10, success: true },
        },
      }), { status: 200 })),
    });

    await expect(probe(probeContext())).rejects.toThrow(
      "performance_probe_metric_event_source_mismatch",
    );
  });

  it("blocks a credentialed literal private address before opening a connection", async () => {
    const pinnedRequest = vi.fn();
    const probe = createHttpPerformanceProbe({
      endpoint: "https://127.0.0.1/performance",
      approvedDestination: "https://127.0.0.1/performance",
      bearerToken: "secret-value",
      pinnedRequest,
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_destination_blocked");
    expect(pinnedRequest).not.toHaveBeenCalled();
  });

  it("blocks loopback-equivalent IPv4 addresses embedded in IPv6 before opening a connection", async () => {
    for (const address of ["64:ff9b::7f00:1", "::127.0.0.1"]) {
      const pinnedRequest = vi.fn();
      const probe = createHttpPerformanceProbe({
        endpoint: "https://probe.example/performance",
        approvedDestination: "https://probe.example/performance",
        bearerToken: "secret-value",
        resolveHostname: async () => [address],
        pinnedRequest,
      });

      await expect(probe(probeContext())).rejects.toThrow("performance_probe_destination_blocked");
      expect(pinnedRequest).not.toHaveBeenCalled();
    }
  });

  it("resolves again before every invocation and blocks DNS rebinding", async () => {
    const resolveHostname = vi.fn()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["127.0.0.1"]);
    const pinnedRequest = vi.fn(async () =>
      new Response(JSON.stringify(measurement()), { status: 200 }));
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://probe.example/performance",
      bearerToken: "secret-value",
      resolveHostname,
      pinnedRequest,
    });

    await expect(probe(probeContext())).resolves.toEqual(measurement());
    await expect(probe(probeContext())).rejects.toThrow("performance_probe_destination_blocked");
    expect(resolveHostname).toHaveBeenCalledTimes(2);
    expect(pinnedRequest).toHaveBeenCalledTimes(1);
  });

  it("allows plaintext only for explicit loopback development without credentials", () => {
    expect(() => createHttpPerformanceProbe({ endpoint: "http://127.0.0.1:3000/probe" })).not.toThrow();
    expect(() => createHttpPerformanceProbe({ endpoint: "http://localhost:3000/probe" })).not.toThrow();
    expect(() => createHttpPerformanceProbe({
      endpoint: "http://127.0.0.1:3000/probe",
      bearerToken: "do-not-expose",
    })).toThrow("performance_probe_https_required");
    expect(() => createHttpPerformanceProbe({ endpoint: "http://probe.example/probe" }))
      .toThrow("performance_probe_https_required");
  });

  it("rejects endpoint URLs containing embedded credentials", () => {
    expect(() => createHttpPerformanceProbe({
      endpoint: "https://user:password@probe.example/performance",
    })).toThrow("performance_probe_url_credentials_forbidden");
  });

  it("disables redirects so bearer authority cannot be forwarded", async () => {
    const request = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: "Bearer secret-value" });
      return new Response(null, { status: 302, headers: { location: "https://attacker.example/" } });
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.example/performance",
      approvedDestination: "https://probe.example/performance",
      bearerToken: "secret-value",
      ...testPerformanceTransport(request),
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_http_302");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a probe response that does not observe the exact requested identity", async () => {
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.invalid/performance",
      ...testPerformanceTransport(async () => new Response(JSON.stringify({
        ...measurement(),
        observed: { ...measurement().observed, repositoryId: "github-wrong" },
      }), { status: 200 })),
    });
    await expect(probe(probeContext())).rejects.toThrow("performance_probe_repository_mismatch");
  });

  it("rejects an oversized declared response before reading its body", async () => {
    const read = vi.fn();
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.invalid/performance",
      ...testPerformanceTransport(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(EXPECTED_RESPONSE_BYTE_LIMIT + 1) }),
        body: { getReader: () => ({ read }) },
      }) as unknown as Response),
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_response_too_large");
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels and rejects an undeclared streaming response overrun with a stable code", async () => {
    let cancelled = 0;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        if (emitted === 1) controller.enqueue(new Uint8Array(EXPECTED_RESPONSE_BYTE_LIMIT));
        else controller.enqueue(new Uint8Array(1));
      },
      cancel() {
        cancelled += 1;
      },
    });
    const probe = createHttpPerformanceProbe({
      endpoint: "https://probe.invalid/performance",
      ...testPerformanceTransport(async () => new Response(body, { status: 200 })),
    });

    await expect(probe(probeContext())).rejects.toThrow("performance_probe_response_too_large");
    expect(cancelled).toBe(1);
  });
});
