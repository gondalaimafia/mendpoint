import { describe, expect, it } from "vitest";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import type { LiveModelApprovedConfig } from "@mendpoint/eval/live-model";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord } from "./types.js";
import {
  buildLiveLanePayload,
  buildLiveResult,
  compareLanes,
  microAverage,
  scoreRun,
  skippedLiveResult,
} from "./live-lane.js";

const APPROVED: LiveModelApprovedConfig = Object.freeze({
  host: "api.meta.ai",
  model: "muse-spark-1.2-contributor",
});

function gt(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    scenario_id: "fettler-x",
    repo_family: "payments",
    difficulty: 3,
    correct_behavior: "flag_files",
    expected_findings: ["src/a.ts", "src/b.ts"],
    acceptable_findings: [],
    false_positive_traps: ["src/trap.ts"],
    tags: [],
    dataset_split: "development",
    ...overrides,
  } as unknown as GroundTruth;
}

function record(findings: string[], latency = 100): RunRecord {
  return {
    run_id: "r",
    timestamp: "2026-08-17T00:00:00.000Z",
    git_commit: "abc",
    product: "fettler",
    product_version: "mendpoint@1.0.0+abc",
    scenario_id: "fettler-x",
    scenario_version: "1",
    invocation_path: "test",
    model: null,
    model_provider: null,
    routing_decisions: [],
    tokens: null,
    latency_ms: latency,
    estimated_cost_usd: null,
    activity: { filesExamined: 3 },
    findings,
    findingGraphPaths: [],
    confidence: "medium",
    produced_edit: false,
    grader_results: [],
    failures: [],
    passed: false,
    unmeasured_dimensions: [],
  };
}

function provenance(overrides: Partial<LiveModelProvenanceRecord> = {}): LiveModelProvenanceRecord {
  return Object.freeze({
    providerId: null,
    bodyRequestId: "chatcmpl-1",
    headerRequestId: "req-1",
    model: "muse-spark-1.2-contributor",
    promptTokens: 100,
    completionTokens: 40,
    totalTokens: 140,
    host: "api.meta.ai",
    protocol: "https:",
    costUsd: 0.00002,
    monotonicTimestampMs: 1,
    ...overrides,
  });
}

describe("scoreRun", () => {
  it("computes recall/precision and confusion counts from the grader", () => {
    const score = scoreRun(record(["src/a.ts", "src/b.ts"]), gt());
    expect(score.passed).toBe(true);
    expect(score.recall).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.truePositives).toBe(2);
    expect(score.falsePositives).toBe(0);
    expect(score.falseNegatives).toBe(0);
  });

  it("counts a trap as a false positive and a miss as a false negative", () => {
    const score = scoreRun(record(["src/a.ts", "src/trap.ts"]), gt());
    expect(score.passed).toBe(false);
    expect(score.truePositives).toBe(1);
    expect(score.falsePositives).toBe(1); // the trap
    expect(score.falseNegatives).toBe(1); // src/b.ts missed
  });
});

describe("compareLanes delta", () => {
  it("reports findings the live lane added and removed vs deterministic", () => {
    const det = scoreRun(record(["src/a.ts"]), gt());
    const live = buildLiveResult(record(["src/a.ts", "src/b.ts"]), gt(), [provenance()], APPROVED);
    const cmp = compareLanes(gt(), "fettler-x", "fettler", det, live);
    expect(cmp.delta.findingsAdded).toEqual(["src/b.ts"]);
    expect(cmp.delta.findingsRemoved).toEqual([]);
    expect(cmp.delta.recall).toBeCloseTo(0.5); // 1.0 - 0.5
  });

  it("leaves the delta null when the live lane was not measured", () => {
    const det = scoreRun(record(["src/a.ts"]), gt());
    const cmp = compareLanes(gt(), "fettler-x", "fettler", det, skippedLiveResult("not requested"));
    expect(cmp.delta.precision).toBeNull();
    expect(cmp.delta.recall).toBeNull();
    expect(cmp.delta.findingsAdded).toEqual([]);
  });
});

describe("buildLiveResult provenance grading", () => {
  it("grades matching provenance as passing", () => {
    const live = buildLiveResult(record(["src/a.ts", "src/b.ts"]), gt(), [provenance()], APPROVED);
    expect(live.status).toBe("measured");
    expect(live.modelCalls).toBe(1);
    expect(live.totalTokens).toBe(140);
    expect(live.provenanceGrade?.passed).toBe(true);
  });

  it("flags provenance whose echoed model differs from the approved model", () => {
    const live = buildLiveResult(
      record(["src/a.ts"]),
      gt(),
      [provenance({ model: "gpt-4o-mini" })],
      APPROVED,
    );
    expect(live.provenanceGrade?.passed).toBe(false);
    expect(live.provenanceGrade?.grades.find((g) => g.id === "model.exact_echo")?.passed).toBe(false);
  });

  it("treats zero model calls as measured-but-no-grade, not a failure", () => {
    const live = buildLiveResult(record(["src/a.ts", "src/b.ts"]), gt(), [], APPROVED);
    expect(live.status).toBe("measured");
    expect(live.modelCalls).toBe(0);
    expect(live.provenanceGrade).toBeUndefined();
  });
});

describe("microAverage", () => {
  it("micro-averages precision and recall across scores", () => {
    const s1 = scoreRun(record(["src/a.ts", "src/b.ts"]), gt());
    const s2 = scoreRun(record(["src/a.ts", "src/trap.ts"]), gt());
    const micro = microAverage([s1, s2]);
    // TP=2+1=3, FP=0+1=1, FN=0+1=1
    expect(micro.truePositives).toBe(3);
    expect(micro.falsePositives).toBe(1);
    expect(micro.falseNegatives).toBe(1);
    expect(micro.precision).toBeCloseTo(3 / 4);
    expect(micro.recall).toBeCloseTo(3 / 4);
  });
});

describe("buildLiveLanePayload honesty", () => {
  const det = scoreRun(record(["src/a.ts", "src/b.ts"]), gt());

  it("marks the live lane not-measured and null delta when skipped", () => {
    const skip = skippedLiveResult("live lane not requested");
    const cmp = compareLanes(gt(), "fettler-x", "fettler", det, skip);
    const payload = buildLiveLanePayload({
      gitCommit: "abc",
      liveRequested: false,
      laneStatus: "skipped",
      skipReason: "live lane not requested",
      excluded: [],
      comparisons: [cmp],
      provenance: [],
    });
    expect(payload.lane_status).toBe("skipped");
    expect(payload.summary.live).toBeNull();
    expect(payload.summary.delta).toBeNull();
    expect(payload.skip_reason).toContain("not requested");
    // deterministic numbers are still real and reported.
    expect(payload.summary.deterministic.precisionMicro).toBe(1);
  });

  it("reports both lanes and a union provenance grade when measured", () => {
    const live = buildLiveResult(record(["src/a.ts", "src/b.ts"]), gt(), [provenance()], APPROVED);
    const cmp = compareLanes(gt(), "fettler-x", "fettler", det, live);
    const payload = buildLiveLanePayload({
      gitCommit: "abc",
      liveRequested: true,
      laneStatus: "ready",
      approved: APPROVED,
      excluded: [],
      comparisons: [cmp],
      provenance: [provenance()],
    });
    expect(payload.lane_status).toBe("ready");
    expect(payload.summary.live).not.toBeNull();
    expect(payload.summary.delta).not.toBeNull();
    expect(payload.aggregate.totalModelCalls).toBe(1);
    expect(payload.aggregate.provenanceGrade?.passed).toBe(true);
    // The deterministic summary is unaffected by the presence of the live lane.
    expect(payload.summary.deterministic.precisionMicro).toBe(1);
    expect(payload.summary.deterministic.recallMicro).toBe(1);
  });

  it("surfaces a failed union provenance grade rather than reporting green", () => {
    const bad = provenance({ host: "api.evil.example" });
    const live = buildLiveResult(record(["src/a.ts"]), gt(), [bad], APPROVED);
    const cmp = compareLanes(gt(), "fettler-x", "fettler", det, live);
    const payload = buildLiveLanePayload({
      gitCommit: "abc",
      liveRequested: true,
      laneStatus: "ready",
      approved: APPROVED,
      excluded: [],
      comparisons: [cmp],
      provenance: [bad],
    });
    expect(payload.aggregate.provenanceGrade?.passed).toBe(false);
  });
});
