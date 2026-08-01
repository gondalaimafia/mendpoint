import { describe, expect, it } from "vitest";
import { runCapabilityEval } from "./capability-eval.js";

describe("Warden and Transformer capability corpus", () => {
  it("passes every deterministic capability and critical safety case", async () => {
    const report = await runCapabilityEval();
    expect(report.total).toBeGreaterThanOrEqual(100);
    expect(report.passed).toBe(report.total);
    expect(report.criticalFailures).toEqual([]);
    expect(report.byProduct.warden.total).toBeGreaterThanOrEqual(50);
    expect(report.byProduct.transformer.total).toBeGreaterThanOrEqual(45);
  }, 120_000);
});
