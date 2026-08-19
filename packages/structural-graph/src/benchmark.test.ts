import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gradeGraphifyBenchmark, stageGraphifyBenchmark, type GraphifyBenchmarkCase, type GraphifyBenchmarkKey } from "./benchmark.js";

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const cases: GraphifyBenchmarkCase[] = Array.from({ length: 18 }, (_, index) => ({
  caseId: `case-${String(index + 1).padStart(2, "0")}`,
  familyDigest: digest(String.fromCharCode(97 + index)),
  split: index < 6 ? "development" : index < 12 ? "validation" : "holdout",
  indirect: index % 2 === 1,
  language: "typescript",
  inputDigest: digest(String.fromCharCode(97 + index)),
}));
const key: GraphifyBenchmarkKey = {
  cohortDigest: digest("f"),
  cases: cases.map((item) => ({
    caseId: item.caseId,
    expectedNodes: ["endpoint", "sdk", "wrapper", ...(item.indirect ? ["service", "test"] : [])],
    expectedEdges: ["sdk->endpoint", "wrapper->sdk", ...(item.indirect ? ["service->wrapper", "test->service"] : [])],
  })),
};

describe("Graphify adoption benchmark contract", () => {
  it("keeps labels out of predictors, requires three arms and a sealed holdout, and measures indirect value", async () => {
    const predict = vi.fn(async (input: { arm: "A" | "B" | "C"; caseId: string; indirect: boolean }) => {
      expect(input).not.toHaveProperty("expectedNodes");
      expect(input).not.toHaveProperty("expectedEdges");
      const truth = key.cases.find((item) => item.caseId === input.caseId)!;
      if (input.arm === "A" && input.indirect) return { nodes: truth.expectedNodes.slice(0, 3), edges: truth.expectedEdges.slice(0, 2), elapsedMs: 8, peakMemoryBytes: 1_000 };
      if (input.arm === "B") return { nodes: truth.expectedNodes, edges: truth.expectedEdges, elapsedMs: 6, peakMemoryBytes: 1_100, semantic: "not_measured" as const };
      return { nodes: truth.expectedNodes, edges: truth.expectedEdges, elapsedMs: 7, peakMemoryBytes: 1_200 };
    });
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    const report = gradeGraphifyBenchmark(staged, key);
    expect(predict).toHaveBeenCalledTimes(54);
    expect(report.cohort).toEqual({ total: 18, development: 6, validation: 6, holdout: 6, indirect: 9 });
    expect(report.arms.B.semanticStatus).toBe("not_measured");
    expect(report.arms.C.indirectRecall).toBe(1);
    expect(report.arms.C.indirectRecall - report.arms.A.indirectRecall).toBeGreaterThanOrEqual(0.1);
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

  it("fails closed on family leakage, missing arms, and a mismatched sealed key", async () => {
    const leaky = cases.map((item, index) => index === 6 ? { ...item, familyDigest: cases[0].familyDigest } : item);
    const predict = async (input: { arm: "A" | "B" | "C" }) => ({ nodes: [], edges: [], elapsedMs: 1, peakMemoryBytes: 1, ...(input.arm === "B" ? { semantic: "not_measured" as const } : {}) });
    await expect(stageGraphifyBenchmark({ cases: leaky, cohortDigest: key.cohortDigest, predict })).rejects.toThrow("GRAPHIFY_BENCHMARK_LEAKAGE");
    const staged = await stageGraphifyBenchmark({ cases, cohortDigest: key.cohortDigest, predict });
    expect(() => gradeGraphifyBenchmark(staged, { ...key, cohortDigest: digest("e") })).toThrow("GRAPHIFY_BENCHMARK_KEY_MISMATCH");
  });
});
