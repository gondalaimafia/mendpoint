import { describe, expect, it } from "vitest";
import { runPartnerEval } from "./run.js";

describe("design-partner eval", () => {
  it("meets ≥70% overall on partner corpus", async () => {
    const report = await runPartnerEval();
    expect(report.partnerCount).toBeGreaterThanOrEqual(4);
    expect(report.overall).toBeGreaterThanOrEqual(0.7);
    expect(report.passed).toBe(true);
  }, 120_000);
});
