import { describe, expect, it } from "vitest";
import { runWardenTransformerEval } from "./agent-eval.js";

describe("Warden and Transformer held out evals", () => {
  it("passes observable behavior, safety, recovery, and budget graders", async () => {
    const report = await runWardenTransformerEval(1);
    expect(report.behavior.scenarioCount).toBeGreaterThanOrEqual(25);
    expect(report.behavior.byProduct.warden.total).toBeGreaterThanOrEqual(14);
    expect(report.behavior.byProduct.transformer.total).toBeGreaterThanOrEqual(11);
    expect(report.behavior.criticalFailures).toEqual([]);
    expect(report.behavior.deterministicFailures).toEqual([]);
    expect(report.behavior.passAtOne).toBe(1);
    expect(report.passed).toBe(true);
  }, 180_000);
});
