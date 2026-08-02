import { describe, expect, it } from "vitest";
import {
  agentEvalDigest,
  evalGrade,
  runAgentEvalScenarios,
  type AgentEvalScenario,
} from "./agent-eval-contract.js";

function scenario(input?: Readonly<{
  digestForTrial?: (trial: number) => string;
  gradePasses?: boolean;
  durationMs?: number;
}>): AgentEvalScenario {
  return {
    id: "eval.contract.sample",
    product: "warden",
    family: "contract",
    tier: "common",
    critical: true,
    sourceRefs: ["https://inspect.aisi.org.uk/scoring.html"],
    deterministic: true,
    budget: {
      maxDurationMs: 100,
      maxSteps: 2,
      maxChangedFiles: 0,
      maxChangedBytes: 0,
      maxEvidenceBytes: 100,
    },
    run: async (trial) => ({
      observation: {
        disposition: "passed",
        semanticDigest: input?.digestForTrial?.(trial) ?? agentEvalDigest("stable"),
        metrics: {
          durationMs: input?.durationMs ?? 1,
          steps: 1,
          changedFiles: 0,
          changedBytes: 0,
          evidenceBytes: 10,
        },
        details: {},
      },
      grades: [
        evalGrade({
          id: "observable.correctness",
          critical: true,
          passed: input?.gradePasses ?? true,
          expected: "passed",
          observed: input?.gradePasses === false ? "failed" : "passed",
        }),
      ],
    }),
  };
}

describe("agent eval contract", () => {
  it("requires every repeated critical trial to pass", async () => {
    const report = await runAgentEvalScenarios([scenario({ gradePasses: false })], 3);
    expect(report.passed).toBe(false);
    expect(report.passAtOne).toBe(0);
    expect(report.passAtK).toBe(0);
    expect(report.passToK).toBe(0);
    expect(report.criticalFailures).toEqual(["eval.contract.sample"]);
  });

  it("fails deterministic scenarios when repeated semantic outcomes drift", async () => {
    const report = await runAgentEvalScenarios([
      scenario({ digestForTrial: (trial) => agentEvalDigest({ trial }) }),
    ], 3);
    expect(report.scenarios[0]).toMatchObject({
      passAtOne: true,
      passAtK: true,
      passToK: true,
      deterministic: false,
      passed: false,
    });
    expect(report.deterministicFailures).toEqual(["eval.contract.sample"]);
    expect(report.passed).toBe(false);
  });

  it("makes an exceeded resource budget a release failure", async () => {
    const report = await runAgentEvalScenarios([scenario({ durationMs: 101 })], 1);
    const durationGrade = report.scenarios[0]!.trials[0]!.grades.find(
      (grade) => grade.id === "budget.duration",
    );
    expect(durationGrade).toMatchObject({ passed: false, observed: "101" });
    expect(report.passed).toBe(false);
  });
});
