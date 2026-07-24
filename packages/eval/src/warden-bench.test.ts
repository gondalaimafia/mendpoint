import { describe, expect, it } from "vitest";
import { runWardenBench } from "./warden-bench.js";

describe("warden-bench v0", () => {
  it("runs ≥5 cases and at least one passes end-to-end", async () => {
    const report = await runWardenBench();
    expect(report.total).toBeGreaterThanOrEqual(5);
    expect(report.passed).toBeGreaterThanOrEqual(1);
    expect(report.cases.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(
      true,
    );
  }, 120_000);
});
