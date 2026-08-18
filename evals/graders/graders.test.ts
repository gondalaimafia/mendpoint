import { describe, it, expect } from "vitest";
import { gradeFettler, countFettlerFindings } from "./fettler-graders.js";
import { gradeRegauge, type ObservedRecipe } from "./regauge-graders.js";
import { classifyOutcome, FAILURE_CATEGORIES } from "./taxonomy.js";
import { validateGroundTruth, type GroundTruth } from "../ground-truth/schema.js";
import { loadAllGroundTruth } from "../ground-truth/load.js";

const flagFilesGt = (over: Partial<GroundTruth> = {}): GroundTruth => ({
  scenario_id: "t",
  repo_family: "typescript-service",
  difficulty: 3,
  difficulty_rationale: "test",
  intended_product: ["fettler"],
  dataset_split: "development",
  correct_behavior: "flag_files",
  faults: [],
  expected_findings: ["a.ts", "b.ts"],
  acceptable_findings: ["c.test.ts"],
  false_positive_traps: ["trap.ts", "vendor/"],
  blast_radius_truth: { affectedFiles: 2 },
  tags: [],
  ...over,
});

describe("gradeFettler", () => {
  it("passes on full recall, no traps, no extras", () => {
    const g = gradeFettler(["a.ts", "b.ts", "c.test.ts"], flagFilesGt());
    expect(g.passed).toBe(true);
    expect(g.recall).toBe(1);
    expect(g.precision).toBe(1);
  });

  it("fails and classifies a trap hit as P0 false positive", () => {
    const g = gradeFettler(["a.ts", "b.ts", "trap.ts"], flagFilesGt());
    expect(g.passed).toBe(false);
    const trap = g.failures.find((f) => f.dimension === "false_positive_traps");
    expect(trap?.severity).toBe("P0");
    expect(trap?.category).toBe("FALSE_POSITIVE");
  });

  it("treats a directory-prefix trap as a trap", () => {
    const g = gradeFettler(["a.ts", "b.ts", "vendor/x.ts"], flagFilesGt());
    expect(g.trapHits).toContain("vendor/x.ts");
  });

  it("counts a non-expected, non-acceptable, non-trap file as an extra FP", () => {
    const g = gradeFettler(["a.ts", "b.ts", "extra.ts"], flagFilesGt());
    expect(g.extras).toEqual(["extra.ts"]);
    expect(g.passed).toBe(false);
  });

  it("does not penalize acceptable findings", () => {
    const g = gradeFettler(["a.ts", "b.ts", "c.test.ts"], flagFilesGt());
    expect(g.extras).toEqual([]);
    expect(g.trapHits).toEqual([]);
  });

  it("flags partial recall as a false negative", () => {
    const g = gradeFettler(["a.ts"], flagFilesGt());
    expect(g.recall).toBe(0.5);
    expect(g.failures.some((f) => f.category === "FALSE_NEGATIVE")).toBe(true);
  });

  it("countFettlerFindings exposes the raw confusion matrix used for micro-averaging", () => {
    const c = countFettlerFindings(["a.ts", "trap.ts", "extra.ts"], flagFilesGt());
    expect(c.expectedHits).toEqual(["a.ts"]);
    expect(c.missed).toEqual(["b.ts"]);
    expect(c.trapHits).toEqual(["trap.ts"]);
    expect(c.extras).toEqual(["extra.ts"]);
  });

  it("abstain: any confident finding is a P0 abstention failure", () => {
    const gt = flagFilesGt({ correct_behavior: "abstain", expected_findings: [], false_positive_traps: ["src/charge.js"] });
    const bad = gradeFettler(["src/charge.js"], gt);
    expect(bad.passed).toBe(false);
    expect(bad.failures[0]?.category).toBe("ABSTENTION_FAILURE");
    expect(bad.failures[0]?.severity).toBe("P0");
    const good = gradeFettler([], gt);
    expect(good.passed).toBe(true);
  });

  it("no_op: correct output is nothing", () => {
    const gt = flagFilesGt({ correct_behavior: "no_op", expected_findings: [], false_positive_traps: ["x.js"] });
    expect(gradeFettler([], gt).passed).toBe(true);
    expect(gradeFettler(["x.js"], gt).passed).toBe(false);
  });
});

const regaugeGt = (over: Partial<GroundTruth> = {}): GroundTruth => ({
  scenario_id: "r",
  repo_family: "node-service",
  difficulty: 3,
  difficulty_rationale: "test",
  intended_product: ["regauge"],
  dataset_split: "development",
  correct_behavior: "coverage_gap",
  faults: [],
  expected_findings: ["src/a.ts"],
  acceptable_findings: [],
  false_positive_traps: ["vendor/"],
  blast_radius_truth: { affectedFiles: 1 },
  recipe_expectation: { family: "sdk-upgrade", shippedRecipeId: null },
  tags: [],
  ...over,
});

const rec = (over: Partial<ObservedRecipe>): ObservedRecipe => ({
  recipeId: "x",
  version: 1,
  status: "unsupported",
  matchedPaths: [],
  residualPaths: [],
  ...over,
});

describe("gradeRegauge", () => {
  it("apply_recipe: passes when the shipped recipe matches all root files", () => {
    const gt = regaugeGt({
      correct_behavior: "apply_recipe",
      expected_findings: ["package.json", ".nvmrc"],
      recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-18-to-20" },
    });
    const g = gradeRegauge(
      [rec({ recipeId: "node-runtime-18-to-20", status: "applicable", matchedPaths: ["package.json", ".nvmrc"] })],
      gt,
    );
    expect(g.passed).toBe(true);
  });

  it("apply_recipe: records residual as a coverage gap without flipping pass", () => {
    const gt = regaugeGt({
      correct_behavior: "apply_recipe",
      expected_findings: ["package.json"],
      recipe_expectation: { family: "runtime-upgrade", shippedRecipeId: "node-runtime-18-to-20" },
    });
    const g = gradeRegauge(
      [rec({ recipeId: "node-runtime-18-to-20", status: "incomplete", matchedPaths: ["package.json"], residualPaths: ["docker/Dockerfile.ci"] })],
      gt,
    );
    expect(g.passed).toBe(true);
    expect(g.failures.some((f) => f.category === "COVERAGE_GAP")).toBe(true);
  });

  it("coverage_gap: no recipe matches -> abstention by absence passes, gap recorded", () => {
    const g = gradeRegauge([rec({ status: "unsupported" })], regaugeGt());
    expect(g.passed).toBe(true);
    expect(g.failures.some((f) => f.category === "COVERAGE_GAP")).toBe(true);
  });

  it("abstain: a matching recipe is a P0 abstention failure", () => {
    const gt = regaugeGt({ correct_behavior: "abstain", expected_findings: [] });
    const g = gradeRegauge([rec({ recipeId: "y", status: "applicable", matchedPaths: ["src/x.ts"] })], gt);
    expect(g.passed).toBe(false);
    expect(g.failures[0]?.severity).toBe("P0");
  });

  it("coverage_gap: a recipe that gains coverage but touches a trap fails", () => {
    const g = gradeRegauge(
      [rec({ recipeId: "z", status: "applicable", matchedPaths: ["vendor/lib.ts"] })],
      regaugeGt(),
    );
    expect(g.passed).toBe(false);
    expect(g.failures.some((f) => f.category === "FALSE_POSITIVE")).toBe(true);
  });
});

describe("taxonomy", () => {
  it("maps every outcome to a known category", () => {
    const outcomes = [
      "missed_all_findings",
      "missed_some_findings",
      "flagged_trap",
      "flagged_extra",
      "acted_when_should_abstain",
      "abstained_when_should_act",
      "scan_aborted",
      "scan_crashed",
      "no_shipped_capability",
      "dimension_unobservable",
    ] as const;
    for (const o of outcomes) {
      const c = classifyOutcome(o);
      expect(FAILURE_CATEGORIES).toContain(c.category);
      expect(["P0", "P1", "P2", "P3", "P4"]).toContain(c.severity);
    }
  });
});

describe("ground truth corpus", () => {
  it("all 21 answer keys are valid", () => {
    const all = loadAllGroundTruth();
    expect(all.length).toBe(21);
    for (const gt of all) {
      expect(validateGroundTruth(gt)).toEqual([]);
    }
  });

  it("abstain/no_op scenarios have empty expected_findings", () => {
    for (const gt of loadAllGroundTruth()) {
      if (gt.correct_behavior === "abstain" || gt.correct_behavior === "no_op") {
        expect(gt.expected_findings).toEqual([]);
      }
    }
  });
});
