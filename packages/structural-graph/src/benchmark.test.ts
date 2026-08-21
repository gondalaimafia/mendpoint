import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gradeGraphifyBenchmark, graphifyBenchmarkCohortDigest, stageGraphifyBenchmark, type GraphifyBenchmarkCase, type GraphifyBenchmarkKey, type StagedGraphifyBenchmark } from "./benchmark.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const cases: GraphifyBenchmarkCase[] = Array.from({ length: 18 }, (_, index) => ({
  // Opaque caseId: it carries no ordinal or parity signal, so a predictor cannot
  // recover the indirect label from the identifier the way the earlier fixture let it.
  caseId: `case-${digest(`graphify-case-${index}`).slice(7, 19)}`,
  familyDigest: digest(String.fromCharCode(97 + index)),
  split: index < 6 ? "development" : index < 12 ? "validation" : "holdout",
  indirect: index % 2 === 1,
  language: "typescript",
  inputDigest: digest(String.fromCharCode(97 + index)),
}));
const cohortDigest = graphifyBenchmarkCohortDigest(cases);
const key: GraphifyBenchmarkKey = {
  cohortDigest,
  cases: cases.map((item) => ({
    caseId: item.caseId,
    familyDigest: item.familyDigest,
    split: item.split,
    indirect: item.indirect,
    language: item.language,
    inputDigest: item.inputDigest,
    expectedNodes: ["endpoint", "sdk", "wrapper", ...(item.indirect ? ["service", "test"] : [])],
    expectedEdges: ["sdk->endpoint", "wrapper->sdk", ...(item.indirect ? ["service->wrapper", "test->service"] : [])],
    expectedIndirectEdges: item.indirect ? ["service->wrapper", "test->service"] : [],
  })) as GraphifyBenchmarkKey["cases"],
};

describe("Graphify adoption benchmark contract", () => {
  it("keeps labels out of predictors, requires three arms and a sealed holdout, and cannot manufacture an indirect-value delta without the labels", async () => {
    // A genuinely label-free predictor: it receives only the narrowed payload,
    // never closes over the sealed answer key, and cannot recover the indirect
    // label from the opaque caseId. With nothing to condition on it returns the
    // same fixed structural guess for every arm and every case, so any arm-C
    // advantage would have to come from a leak. There is none: the honest delta
    // is exactly zero. GRAPHIFY_BENCHMARK.md treats the >=10-point figure only as
    // a future adoption requirement, never as a measured result, so nothing
    // downstream depends on a non-zero delta here.
    const predict = vi.fn(async (input: { arm: "A" | "B" | "C"; caseId: string; inputDigest: string; language: string }) => {
      expect(Object.keys(input).sort()).toEqual(["arm", "caseId", "inputDigest", "language"]);
      expect(input).not.toHaveProperty("expectedNodes");
      expect(input).not.toHaveProperty("expectedEdges");
      expect(input).not.toHaveProperty("indirect");
      return {
        nodes: ["endpoint", "sdk", "wrapper"],
        edges: ["sdk->endpoint", "wrapper->sdk"],
        elapsedMs: 7,
        peakMemoryBytes: 1_200,
        ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
      };
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    const report = gradeGraphifyBenchmark(staged, key);
    expect(predict).toHaveBeenCalledTimes(54);
    expect(report.cohort).toEqual({ total: 18, development: 6, validation: 6, holdout: 6, indirect: 9 });
    expect(Object.values(report.arms).every((arm) => arm.semanticStatus === "not_measured")).toBe(true);
    // The harness scores every arm, but a label-free predictor sees identical
    // inputs across arms and returns identical structure, so arm C has no
    // indirect-value advantage over arm A. The delta is zero, not >=0.1.
    // This cohort has a non-empty indirect denominator, so recall is a measured number here.
    expect(report.arms.A.indirectRecall).not.toBeNull();
    expect(report.arms.A.indirectRecall).toBe(report.arms.C.indirectRecall);
    expect(report.arms.C.indirectRecall! - report.arms.A.indirectRecall!).toBe(0);
    expect(report.modelCalls).toBe(0);
    expect(report.decision).toBe("KEEP AS INTERNAL TOOL ONLY");
    expect(report.adoptionBlockedBy).toEqual([
      "exact_path_accuracy_not_measured",
      "trap_correctness_not_measured",
      "incremental_equivalence_not_measured",
      "network_denial_not_measured",
      "sealed_external_holdout_not_executed",
    ]);
  });

  it("refuses to grade a cohort that is not the pinned 18 cases, so an empty artifact cannot report a flattering zero latency or memory", () => {
    const emptyCohortDigest = graphifyBenchmarkCohortDigest([]);
    const emptyStaged: StagedGraphifyBenchmark = {
      schemaVersion: "mendpoint.graphify-benchmark-staged.v1",
      cohortDigest: emptyCohortDigest,
      cases: [],
      predictions: [],
    };
    const emptyKey: GraphifyBenchmarkKey = { cohortDigest: emptyCohortDigest, cases: [] };
    expect(() => gradeGraphifyBenchmark(emptyStaged, emptyKey)).toThrow("GRAPHIFY_BENCHMARK_COHORT_INVALID");
  });

  it("fails closed on family leakage, missing arms, and a mismatched sealed key", async () => {
    const leaky = cases.map((item, index) => index === 6 ? { ...item, familyDigest: cases[0].familyDigest } : item);
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({ nodes: [], edges: [], elapsedMs: 1, peakMemoryBytes: 1, ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}) });
    await expect(stageGraphifyBenchmark({ cases: leaky, cohortDigest: graphifyBenchmarkCohortDigest(leaky), predict })).rejects.toThrow("GRAPHIFY_BENCHMARK_LEAKAGE");
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    expect(() => gradeGraphifyBenchmark(staged, { ...key, cohortDigest: digest("e") })).toThrow("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  });

  it("does not award perfect precision or indirect recall to an empty or direct-only predictor", async () => {
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({
      nodes: [],
      edges: [],
      elapsedMs: 1,
      peakMemoryBytes: 1,
      ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
    });
    const empty = gradeGraphifyBenchmark(
      await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict }),
      key,
    );
    expect(empty.arms.A.nodePrecision).toBeNull();
    expect(empty.arms.A.edgePrecision).toBeNull();
    expect(empty.arms.A.indirectRecall).toBe(0);

    const directOnly = async (input: { arm: "A" | "B" | "C"; caseId: string }) => {
      const truth = key.cases.find((item) => item.caseId === input.caseId)!;
      return {
        nodes: truth.expectedNodes,
        edges: truth.expectedEdges.slice(0, 2),
        elapsedMs: 1,
        peakMemoryBytes: 1,
        ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
      };
    };
    const report = gradeGraphifyBenchmark(
      await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict: directOnly }),
      key,
    );
    expect(report.arms.A.indirectRecall).toBe(0);
  });

  it("returns null recall for an empty ground-truth denominator and fails the gate", async () => {
    // A cohort whose sealed key expects no nodes measured no node recall. Recall over a zero
    // denominator must be null and fail the gate, not fold a flattering 0 into the report.
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({
      nodes: [],
      edges: [],
      elapsedMs: 1,
      peakMemoryBytes: 1,
      ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    const zeroNodeKey: GraphifyBenchmarkKey = {
      ...key,
      cases: key.cases.map((item) => ({ ...item, expectedNodes: [] })) as GraphifyBenchmarkKey["cases"],
    };
    expect(() => gradeGraphifyBenchmark(staged, zeroNodeKey)).toThrow("GRAPHIFY_BENCHMARK_METRICS_UNMEASURED");
  });

  it("deep-freezes the staged evidence before the sealed key is loaded", async () => {
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({
      nodes: [], edges: [], elapsedMs: 1, peakMemoryBytes: 1,
      ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    expect(Object.isFrozen(staged.cases)).toBe(true);
    expect(Object.isFrozen(staged.cases[0])).toBe(true);
    expect(Object.isFrozen(staged.predictions[0].output.nodes)).toBe(true);
  });

  it("rejects reloaded cohort metadata drift and deep-freezes the graded evidence", async () => {
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({
      nodes: [], edges: [], elapsedMs: 1, peakMemoryBytes: 1,
      ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    const drifted = structuredClone(staged);
    [drifted.cases[6].split, drifted.cases[12].split] = [drifted.cases[12].split, drifted.cases[6].split];
    expect(() => gradeGraphifyBenchmark(drifted, key)).toThrow("GRAPHIFY_BENCHMARK_KEY_MISMATCH");

    const report = gradeGraphifyBenchmark(staged, key);
    expect(Object.isFrozen(report.arms)).toBe(true);
    expect(Object.isFrozen(report.arms.A)).toBe(true);
  });

  it("binds the report digest to the exact cohort, staged predictions, and sealed key", async () => {
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({
      nodes: [], edges: [], elapsedMs: 1, peakMemoryBytes: 1,
      ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}),
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    const report = gradeGraphifyBenchmark(staged, key);
    expect(report.cohortDigest).toBe(staged.cohortDigest);
    expect(report.stagedDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(report.keyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    const alternateCases = cases.map((item, index) => ({
      ...item,
      familyDigest: digest(`alternate-family-${index}`),
      inputDigest: digest(`alternate-input-${index}`),
    }));
    const alternateKey: GraphifyBenchmarkKey = {
      cohortDigest: graphifyBenchmarkCohortDigest(alternateCases),
      cases: key.cases.map((item, index) => ({
        ...item,
        familyDigest: alternateCases[index].familyDigest,
        inputDigest: alternateCases[index].inputDigest,
      })),
    };
    const alternateStaged = await stageGraphifyBenchmark({
      cases: alternateCases,
      cohortDigest: alternateKey.cohortDigest,
      predict,
    });
    const alternateReport = gradeGraphifyBenchmark(alternateStaged, alternateKey);
    expect(alternateReport.arms).toEqual(report.arms);
    expect(alternateReport.contentDigest).not.toBe(report.contentDigest);
    expect(alternateReport.stagedDigest).not.toBe(report.stagedDigest);
    expect(alternateReport.keyDigest).not.toBe(report.keyDigest);
  });
});
