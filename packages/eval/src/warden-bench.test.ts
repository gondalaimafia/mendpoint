import { describe, expect, it } from "vitest";
import { runWardenBench } from "./warden-bench.js";

describe("warden-bench v0", () => {
  it("requires every repair and safe handoff case to pass", async () => {
    const report = await runWardenBench();
    expect(report.total).toBeGreaterThanOrEqual(5);
    expect(report.passed).toBe(report.total);
    expect(report.cases.every((c) => typeof c.id === "string" && c.id.length > 0)).toBe(
      true,
    );
  }, 120_000);
});
