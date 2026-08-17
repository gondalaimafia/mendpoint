import { describe, it, expect } from "vitest";
import { buildDatasetRecords } from "./build.js";
import { validateDatasetRecord } from "./schema.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord } from "../runners/types.js";

const gt = (over: Partial<GroundTruth>): GroundTruth => ({
  scenario_id: "s",
  repo_family: "typescript-service",
  difficulty: 3,
  difficulty_rationale: "test",
  intended_product: ["fettler"],
  dataset_split: "development",
  correct_behavior: "flag_files",
  faults: [],
  expected_findings: ["a.ts"],
  acceptable_findings: [],
  false_positive_traps: ["trap.ts"],
  blast_radius_truth: { affectedFiles: 1 },
  tags: [],
  ...over,
});

const run = (over: Partial<RunRecord>): RunRecord => ({
  run_id: "r1",
  timestamp: "2026-08-15T00:00:00.000Z",
  git_commit: "abc1234",
  product: "fettler",
  product_version: "mendpoint@1.0.0+abc1234",
  scenario_id: "s",
  scenario_version: "1",
  invocation_path: "change-intel -> code-impact",
  model: null,
  model_provider: null,
  routing_decisions: [],
  tokens: null,
  latency_ms: 10,
  estimated_cost_usd: null,
  activity: { filesExamined: 5, candidateCount: 5, confirmedCount: 3 },
  findings: ["a.ts"],
  confidence: "high",
  produced_edit: false,
  grader_results: [{ dimension: "expected_findings_recall", passed: true, score: 1, detail: "" }],
  failures: [],
  passed: true,
  unmeasured_dimensions: [],
  ...over,
});

const lookup = (map: Record<string, GroundTruth>) => (id: string) => map[id]!;

describe("buildDatasetRecords", () => {
  it("emits one valid record per run with no chain-of-thought", () => {
    const recs = buildDatasetRecords([run({})], lookup({ s: gt({}) }));
    expect(recs.length).toBe(1);
    expect(validateDatasetRecord(recs[0])).toEqual([]);
    // No CoT fields.
    expect(recs[0]).not.toHaveProperty("reasoning");
    expect(recs[0]).not.toHaveProperty("chain_of_thought");
    // Only observable output stored.
    expect(recs[0]!.model_output).toEqual(["a.ts"]);
    expect(recs[0]!.model_version).toBeNull();
  });

  it("records correct action as a positive example", () => {
    const recs = buildDatasetRecords([run({ passed: true })], lookup({ s: gt({}) }));
    expect(recs[0]!.training_category).toBe("positive");
    expect(recs[0]!.outcome).toBe("correct_action");
  });

  it("records correct ABSTENTION as a positive example", () => {
    const abstainRun = run({
      passed: true,
      findings: [],
      grader_results: [{ dimension: "abstention_correctness", passed: true, score: 1, detail: "" }],
    });
    const recs = buildDatasetRecords(
      [abstainRun],
      lookup({ s: gt({ correct_behavior: "abstain", expected_findings: [] }) }),
    );
    expect(recs[0]!.training_category).toBe("positive");
    expect(recs[0]!.outcome).toBe("correct_abstention");
  });

  it("records a failure as a negative example with a preference pair", () => {
    const badRun = run({
      passed: false,
      findings: ["trap.ts"],
      failures: [
        {
          category: "FALSE_POSITIVE",
          severity: "P0",
          dimension: "false_positive_traps",
          observed: "flagged trap.ts",
          expected: "no distractor",
        },
      ],
    });
    const recs = buildDatasetRecords([badRun], lookup({ s: gt({}) }));
    expect(recs[0]!.training_category).toBe("negative");
    expect(recs[0]!.outcome).toBe("false_positive");
    // Preference pair: bad observable output vs the ground-truth better answer.
    expect(recs[0]!.model_output).toEqual(["trap.ts"]);
    expect(recs[0]!.corrected_output).toEqual(["a.ts"]);
    expect(recs[0]!.preference_explanation).toBeTruthy();
  });

  it("keeps coverage gaps as their own category", () => {
    const gapRun = run({
      product: "regauge",
      passed: true,
      failures: [
        {
          category: "COVERAGE_GAP",
          severity: "P1",
          dimension: "family_coverage",
          observed: "no recipe",
          expected: "a recipe",
        },
      ],
    });
    const recs = buildDatasetRecords(
      [gapRun],
      lookup({ s: gt({ intended_product: ["regauge"], correct_behavior: "coverage_gap" }) }),
    );
    expect(recs[0]!.training_category).toBe("coverage_gap");
    expect(recs[0]!.outcome).toBe("coverage_gap");
  });
});
