import { describe, expect, it } from "vitest";
import {
  runImpactBenchmark,
  type ImpactBenchmarkContract,
  type ImpactPrediction,
} from "./impact-benchmark.js";

const revision = "d".repeat(40);
const digest = `sha256:${"e".repeat(64)}`;

function fixture(): ImpactBenchmarkContract {
  return {
    version: "2026-08-02.v1",
    tenantId: "tenant-a",
    repositorySnapshot: { id: "snapshot-22", exactCommit: revision },
    corpus: {
      id: "impact-held-out-v1",
      revision,
      digest,
      split: "held_out",
      createdAt: "2026-08-01T00:00:00.000Z",
      trainingCaseIds: ["training-only"],
    },
    scale: { tier: "small", nodeCount: 500, edgeCount: 1_000 },
    thresholds: {
      minPrecision: 0.75,
      minRecall: 0.75,
      minFullPathAccuracy: 0.5,
      maxP95LatencyMs: 250,
    },
    cases: [
      {
        id: "case-one",
        corpusRevision: revision,
        snapshotId: "snapshot-22",
        exactCommit: revision,
        expectedAffectedNodeIds: ["unit:a", "unit:b"],
        expectedDependencyPaths: [["unit:a", "unit:b"]],
        evidenceRefs: ["label://case-one"],
      },
      {
        id: "case-two",
        corpusRevision: revision,
        snapshotId: "snapshot-22",
        exactCommit: revision,
        expectedAffectedNodeIds: ["unit:c"],
        expectedDependencyPaths: [["unit:c"]],
        evidenceRefs: ["label://case-two"],
      },
    ],
    evidenceRefs: ["artifact://impact-corpus.json", "artifact://benchmark-run.json"],
  };
}

function prediction(value: Pick<ImpactPrediction, "affectedNodeIds" | "dependencyPaths" | "evidenceRefs">): ImpactPrediction {
  return {
    tenantId: "tenant-a",
    snapshotId: "snapshot-22",
    exactCommit: revision,
    corpusRevision: revision,
    ...value,
  };
}

describe("held out graph impact benchmark", () => {
  it("reports precision, recall, exact paths, latency, scale and provenance", () => {
    const predictions = new Map([
      ["case-one", prediction({ affectedNodeIds: ["unit:a", "unit:b"], dependencyPaths: [["unit:a", "unit:b"]], evidenceRefs: ["run://one"] })],
      ["case-two", prediction({ affectedNodeIds: ["unit:c", "unit:false-positive"], dependencyPaths: [["unit:c"]], evidenceRefs: ["run://two"] })],
    ]);
    const latencies = [12, 18];
    let cursor = 0;
    const report = runImpactBenchmark(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      predict: (benchmarkCase) => predictions.get(benchmarkCase.id)!,
      measureLatencyMs: () => latencies[cursor++]!,
    });

    expect(report.accepted).toBe(true);
    expect(report.metrics).toMatchObject({
      precision: 0.75,
      recall: 1,
      fullDependencyPathAccuracy: 1,
      latencyMs: { p50: 12, p95: 18, p99: 18, maximum: 18 },
    });
    expect(report.scale).toEqual({ tier: "small", nodeCount: 500, edgeCount: 1_000 });
    expect(report.corpus).toEqual({ id: "impact-held-out-v1", revision, digest });
    expect(report.evidenceRefs).toContain("run://one");
  });

  it.each([
    ["training corpus", (value: any) => { value.corpus.split = "training"; }, /impact_benchmark_corpus_not_held_out/],
    ["case leakage", (value: any) => { value.corpus.trainingCaseIds = ["case-one"]; }, /impact_benchmark_case_leakage/],
    ["missing labels", (value: any) => { value.cases[0].expectedAffectedNodeIds = []; value.cases[0].expectedDependencyPaths = []; }, /impact_benchmark_labels_required/],
    ["revision mismatch", (value: any) => { value.cases[0].corpusRevision = "f".repeat(40); }, /impact_benchmark_case_revision_mismatch/],
    ["snapshot mismatch", (value: any) => { value.cases[0].snapshotId = "other"; }, /impact_benchmark_case_snapshot_mismatch/],
    ["missing evidence", (value: any) => { value.evidenceRefs = []; }, /impact_benchmark_evidence_required/],
    ["weak threshold", (value: any) => { value.thresholds.minPrecision = 0.2; }, /impact_benchmark_threshold_unacceptable/],
  ])("fails closed for %s", (_name, mutate, expected) => {
    const value: any = fixture();
    mutate(value);
    expect(() => runImpactBenchmark(value, {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      predict: () => prediction({ affectedNodeIds: ["unit:a"], dependencyPaths: [["unit:a"]], evidenceRefs: ["run://evidence"] }),
      measureLatencyMs: () => 10,
    })).toThrow(expected);
  });

  it("rejects stale corpora, unexpected revisions and uncited predictions", () => {
    expect(() => runImpactBenchmark(fixture(), {
      expectedCorpusRevision: "f".repeat(40),
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      predict: () => prediction({ affectedNodeIds: [], dependencyPaths: [], evidenceRefs: ["run://evidence"] }),
    })).toThrow("impact_benchmark_corpus_revision_mismatch");

    expect(() => runImpactBenchmark(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-09-02T00:00:00.000Z",
      maxCorpusAgeMs: 7 * 24 * 60 * 60 * 1_000,
      predict: () => prediction({ affectedNodeIds: [], dependencyPaths: [], evidenceRefs: ["run://evidence"] }),
    })).toThrow("impact_benchmark_corpus_stale");

    expect(() => runImpactBenchmark(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      predict: () => prediction({ affectedNodeIds: [], dependencyPaths: [], evidenceRefs: [] }),
    })).toThrow("impact_benchmark_prediction_evidence_required");
  });

  it.each([
    ["tenant", { tenantId: "tenant-b" }, /impact_benchmark_prediction_tenant_mismatch/],
    ["snapshot", { snapshotId: "snapshot-other" }, /impact_benchmark_prediction_snapshot_mismatch/],
    ["revision", { corpusRevision: "f".repeat(40) }, /impact_benchmark_prediction_revision_mismatch/],
  ])("rejects prediction %s provenance mismatch", (_name, mismatch, expected) => {
    expect(() => runImpactBenchmark(fixture(), {
      expectedCorpusRevision: revision,
      evaluatedAt: "2026-08-02T00:00:00.000Z",
      predict: () => ({
        ...prediction({ affectedNodeIds: ["unit:a"], dependencyPaths: [["unit:a"]], evidenceRefs: ["run://evidence"] }),
        ...mismatch,
      }),
    })).toThrow(expected);
  });
});
