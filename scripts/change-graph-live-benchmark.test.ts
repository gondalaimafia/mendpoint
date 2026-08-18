import { describe, expect, it } from "vitest";
import { buildSyntheticChangeGraphCohort } from "./change-graph-live-benchmark.js";

describe("Change Graph live benchmark cohort", () => {
  it("builds direct and relationship-heavy development, validation, and holdout tasks without answer-key leakage", async () => {
    const cohort = await buildSyntheticChangeGraphCohort();
    expect(cohort).toHaveLength(6);
    for (const split of ["development", "validation", "holdout"] as const) {
      const members = cohort.filter((scenario) => scenario.split === split);
      expect(members).toHaveLength(2);
      expect(members.filter((scenario) => scenario.indirect)).toHaveLength(1);
    }
    expect(new Set(cohort.map((scenario) => scenario.splitGroupId)).size).toBe(6);
    for (const scenario of cohort) {
      expect(scenario.rawContext).not.toContain("expectedEntityIds");
      expect(scenario.graphContext).not.toContain("expectedEntityIds");
      expect(scenario.expectedEntityIds.length).toBeGreaterThan(0);
      expect(scenario.graphContext).toContain("mendpoint.fettler-impact-context.v1");
      expect(scenario.rawContext).toContain("src/unrelated.ts");
    }
  });
});
