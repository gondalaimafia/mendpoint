import { describe, expect, it } from "vitest";
import { runHarness } from "./harness.js";

describe("phase-a harness", () => {
  it("meets ≥70% overall expected-site recall on TS samples", async () => {
    const report = await runHarness();
    expect(report.overallRecall).toBeGreaterThanOrEqual(0.7);
    expect(report.results.length).toBeGreaterThanOrEqual(3);
  }, 60_000);
});
