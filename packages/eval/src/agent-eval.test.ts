import { describe, expect, it } from "vitest";
import { runWardenTransformerEval } from "./agent-eval.js";

describe("Warden and Transformer held out evals", () => {
  it("passes observable behavior, safety, recovery, and budget graders", async () => {
    const report = await runWardenTransformerEval(1);
    expect(report.behavior.scenarioCount).toBe(42);
    expect(report.behavior.byProduct.warden.total).toBe(16);
    expect(report.behavior.byProduct.transformer.total).toBe(26);
    expect(report.behavior.byEvidenceLane).toEqual({
      contract: { passed: 39, total: 39 },
      simulated_scripted: { passed: 3, total: 3 },
      live_model: { passed: 0, total: 0 },
    });
    expect(report.behavior.criticalFailures).toEqual([]);
    expect(report.behavior.deterministicFailures).toEqual([]);
    expect(report.behavior.passAtOne).toBe(1);
    expect(report.passed).toBe(true);
  }, 180_000);
});
