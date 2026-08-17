import { describe, it, expect } from "vitest";
import { validateGroundTruth, type GroundTruth } from "./schema.js";

function base(over: Partial<GroundTruth>): GroundTruth {
  return {
    scenario_id: "s",
    repo_family: "typescript-service",
    difficulty: 3,
    difficulty_rationale: "x",
    intended_product: ["fettler"],
    dataset_split: "development",
    correct_behavior: "flag_files",
    faults: [],
    expected_findings: [],
    acceptable_findings: [],
    false_positive_traps: [],
    blast_radius_truth: { affectedFiles: 0 },
    tags: [],
    ...over,
  };
}

describe("validateGroundTruth dataset_split (spec §18.9 three tiers)", () => {
  for (const split of ["development", "regression", "validation", "holdout"] as const) {
    it(`accepts the ${split} tier`, () => {
      expect(validateGroundTruth(base({ dataset_split: split }))).toEqual([]);
    });
  }

  it("rejects an unknown split", () => {
    const problems = validateGroundTruth(base({ dataset_split: "prod" as never }));
    expect(problems).toContain("dataset_split must be development|regression|validation|holdout");
  });
});
