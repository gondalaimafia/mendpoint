import { describe, expect, it } from "vitest";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import type { LiveModelApprovedConfig } from "@mendpoint/eval/live-model";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord } from "./types.js";
import {
  buildLiveLanePayload,
  buildLiveResult,
  compareLanes,
  scoreRun,
  skippedLiveResult,
  type LaneScore,
  type LiveScenarioResult,
} from "./live-lane.js";
import {
  ANALYSIS_CORE_ARM,
  ARM_A_RAW_MUSE,
  ARM_B_GRAPH_MUSE,
  ARM_C_GRAPH_MUSE_VERIFIER,
  REPRESENTATION_ARMS,
  analysisCoreArmResult,
  buildArmSuitePayload,
  buildScenarioArms,
  compareArms,
  liveLaneArmOutcomes,
  liveResultAsArmResult,
  notMeasuredArmResult,
  renderArmSuiteReport,
  type ArmScenarioResult,
} from "./arms.js";

const APPROVED: LiveModelApprovedConfig = Object.freeze({
  host: "api.meta.ai",
  model: "muse-spark-1.2-contributor",
});

function gt(overrides: Partial<GroundTruth> = {}): GroundTruth {
  return {
    scenario_id: "fettler-x",
    repo_family: "payments",
    difficulty: 3,
    difficulty_rationale: "test",
    intended_product: ["fettler"],
    dataset_split: "development",
    correct_behavior: "flag_files",
    faults: [],
    expected_findings: ["src/a.ts", "src/b.ts"],
    acceptable_findings: [],
    false_positive_traps: ["src/trap.ts"],
    // Multi-hop by default so the sample scenarios classify as relationship-heavy.
    blast_radius_truth: { affectedFiles: 2, importChain: ["a -> b -> c"] },
    tags: [],
    ...overrides,
  } as GroundTruth;
}

function record(findings: string[], latency = 100): RunRecord {
  return {
    run_id: "r",
    timestamp: "2026-08-18T00:00:00.000Z",
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
  } as unknown as RunRecord;
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
  }) as LiveModelProvenanceRecord;
}

/** Find the aggregate for one arm on one family in a built payload. */
function agg(
  payload: ReturnType<typeof buildArmSuitePayload>,
  armId: string,
  family: "direct-reference" | "relationship-heavy",
) {
  const a = payload.aggregates.find((x) => x.arm === armId && x.family === family);
  if (!a) throw new Error(`no aggregate for ${armId}/${family}`);
  return a;
}

describe("generalization preserves the deterministic-vs-live numbers exactly", () => {
  // The existing live lane is the two-arm case of the N-arm space: det + arm A
  // (raw retrieval + Muse). Compute the same two scenarios through BOTH paths and
  // assert every number matches — the model-off/model-on comparison is unchanged.
  const g = gt();
  const det1 = scoreRun(record(["src/a.ts"]), g);
  const live1 = buildLiveResult(record(["src/a.ts", "src/b.ts"]), g, [provenance()], APPROVED);
  const det2 = scoreRun(record(["src/a.ts", "src/trap.ts"]), g);
  const live2 = buildLiveResult(record(["src/a.ts", "src/b.ts"]), g, [provenance()], APPROVED);

  const legacy = buildLiveLanePayload({
    gitCommit: "abc",
    liveRequested: true,
    laneStatus: "ready",
    approved: APPROVED,
    excluded: [],
    comparisons: [
      compareLanes(g, "s1", "fettler", det1, live1),
      compareLanes(g, "s2", "fettler", det2, live2),
    ],
    provenance: [provenance(), provenance()],
  });

  const suite = buildArmSuitePayload({
    gitCommit: "abc",
    arms: [ANALYSIS_CORE_ARM, ARM_A_RAW_MUSE],
    scenarios: [
      buildScenarioArms(g, "s1", "fettler", liveLaneArmOutcomes(det1, live1)),
      buildScenarioArms(g, "s2", "fettler", liveLaneArmOutcomes(det2, live2)),
    ],
  });

  it("reproduces the deterministic micro-average", () => {
    const d = agg(suite, ANALYSIS_CORE_ARM.id, "relationship-heavy");
    expect(d.micro?.precision).toBe(legacy.summary.deterministic.precisionMicro);
    expect(d.micro?.recall).toBe(legacy.summary.deterministic.recallMicro);
  });

  it("reproduces the live (arm A) micro-average", () => {
    const a = agg(suite, ARM_A_RAW_MUSE.id, "relationship-heavy");
    expect(a.micro?.precision).toBe(legacy.summary.live!.precisionMicro);
    expect(a.micro?.recall).toBe(legacy.summary.live!.recallMicro);
  });

  it("reproduces the paired model delta (precision, recall, findings, cost)", () => {
    const delta = compareArms(suite.scenarios, ANALYSIS_CORE_ARM.id, ARM_A_RAW_MUSE.id, "relationship-heavy");
    expect(delta.precision).toBe(legacy.summary.delta!.precision);
    expect(delta.recall).toBe(legacy.summary.delta!.recall);
    expect(delta.findingsAddedTotal).toBe(legacy.summary.delta!.findingsAddedTotal);
    expect(delta.findingsRemovedTotal).toBe(legacy.summary.delta!.findingsRemovedTotal);
    expect(delta.costUsd).toBe(legacy.summary.delta!.costUsd);
  });
});

describe("a declared-but-unavailable arm is reported, never averaged in", () => {
  const g = gt();
  const det = scoreRun(record(["src/a.ts", "src/b.ts"]), g);
  const live = buildLiveResult(record(["src/a.ts", "src/b.ts"]), g, [provenance()], APPROVED);
  const results: Record<string, ArmScenarioResult> = {
    [ANALYSIS_CORE_ARM.id]: analysisCoreArmResult(det),
    [ARM_A_RAW_MUSE.id]: liveResultAsArmResult(live),
    [ARM_B_GRAPH_MUSE.id]: notMeasuredArmResult("projection not wired into packages/code-impact"),
    [ARM_C_GRAPH_MUSE_VERIFIER.id]: notMeasuredArmResult("packages/verifier not on main"),
  };
  const suite = buildArmSuitePayload({
    gitCommit: "abc",
    arms: REPRESENTATION_ARMS,
    scenarios: [buildScenarioArms(g, "s1", "fettler", results)],
  });

  it("keeps arm B present in the report with its reason", () => {
    const b = agg(suite, ARM_B_GRAPH_MUSE.id, "relationship-heavy");
    expect(b.status).toBe("not-measured");
    expect(b.reason).toContain("packages/code-impact");
    expect(suite.arms.map((a) => a.id)).toContain("B");
  });

  it("does not average arm B as zero — its micro and efficiency are null (not measured)", () => {
    const b = agg(suite, ARM_B_GRAPH_MUSE.id, "relationship-heavy");
    expect(b.micro).toBeNull();
    expect(b.totalModelCalls).toBeNull();
    expect(b.totalTokens).toBeNull();
    expect(b.totalCostUsd).toBeNull();
    expect(b.measured).toBe(0);
  });

  it("yields a null (honest) delta against an unavailable arm — never a tie", () => {
    const delta = compareArms(suite.scenarios, ARM_A_RAW_MUSE.id, ARM_B_GRAPH_MUSE.id, "relationship-heavy");
    expect(delta.measurable).toBe(false);
    expect(delta.sharedScenarios).toBe(0);
    expect(delta.precision).toBeNull();
    expect(delta.recall).toBeNull();
  });

  it("renders every declared arm, marking B and C NOT MEASURED with a reason", () => {
    const md = renderArmSuiteReport(suite);
    expect(md).toContain("| B |");
    expect(md).toContain("| C |");
    expect(md).toContain("NOT MEASURED");
    expect(md).toContain("packages/code-impact");
    expect(md).toContain("packages/verifier");
  });
});

describe("the model-off arm reports efficiency as not-measured, never zero", () => {
  it("null model calls/tokens/cost on the analysis-core arm (no model ran)", () => {
    const r = analysisCoreArmResult(scoreRun(record(["src/a.ts", "src/b.ts"]), gt()));
    expect(r.status).toBe("measured"); // retrieval IS measured
    expect(r.efficiency.measured).toBe(false); // efficiency is NOT
    expect(r.efficiency.modelCalls).toBeNull();
    expect(r.efficiency.totalTokens).toBeNull();
    expect(r.efficiency.costUsd).toBeNull();
  });
});

describe("task families are reported separately and never pooled", () => {
  const relScore: LaneScore = scoreRun(record(["src/a.ts", "src/b.ts"]), gt());
  const dirGt = gt({
    scenario_id: "dir",
    blast_radius_truth: { affectedFiles: 1, importChain: ["a single direct import"] },
  });
  const dirScore = scoreRun(record(["src/a.ts", "src/trap.ts"]), dirGt);

  const suite = buildArmSuitePayload({
    gitCommit: "abc",
    arms: [ANALYSIS_CORE_ARM],
    scenarios: [
      buildScenarioArms(gt(), "rel", "fettler", { [ANALYSIS_CORE_ARM.id]: analysisCoreArmResult(relScore) }),
      buildScenarioArms(dirGt, "dir", "fettler", { [ANALYSIS_CORE_ARM.id]: analysisCoreArmResult(dirScore) }),
    ],
  });

  it("scores each family only over its own scenarios", () => {
    const rel = agg(suite, ANALYSIS_CORE_ARM.id, "relationship-heavy");
    const dir = agg(suite, ANALYSIS_CORE_ARM.id, "direct-reference");
    expect(rel.scenarios).toBe(1);
    expect(dir.scenarios).toBe(1);
    // Perfect recall in the relationship-heavy scenario, a miss in the direct one:
    // pooling would blend these; separate reporting keeps them apart.
    expect(rel.micro?.recall).toBe(1);
    expect(dir.micro?.recall).toBeCloseTo(0.5);
    expect(rel.micro?.recall).not.toBe(dir.micro?.recall);
  });

  it("never emits a single blended headline number across families", () => {
    const families = new Set(suite.aggregates.map((a) => a.family));
    expect(families).toEqual(new Set(["direct-reference", "relationship-heavy"]));
  });
});

describe("skipped live result adapts to a not-measured arm", () => {
  it("carries the live lane's stated skip reason onto the arm", () => {
    const live: LiveScenarioResult = skippedLiveResult("live lane not requested");
    const r = liveResultAsArmResult(live);
    expect(r.status).toBe("not-measured");
    expect(r.reason).toBe("live lane not requested");
    expect(r.efficiency.measured).toBe(false);
  });
});
