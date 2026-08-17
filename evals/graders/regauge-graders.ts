/**
 * Phase 5 — ReGauge (migration-recipe) graders.
 *
 * Deterministic. The runner evaluates every shipped recipe against the repo via
 * `analyzeRecipe` and passes the observed results here. We grade the ENGINE's
 * decision against ground truth:
 *   - apply_recipe : a shipped recipe must match the repo and cover the expected
 *                    root files (residual -> recorded, still counts as matched).
 *   - abstain      : NO recipe may match; producing an edit is P0.
 *   - coverage_gap : abstention-by-absence is the correct shipped behaviour;
 *                    if a recipe DID gain coverage, it must stay within the
 *                    oracle and touch no trap. The gap itself is recorded as a
 *                    COVERAGE_GAP note (does not flip pass/fail).
 *   - no_op        : nothing to do.
 *
 * `passed` = the engine did the SAFE, expected thing for the CURRENT shipped
 * engine. COVERAGE_GAP and HARNESS_LIMITATION notes never flip it.
 */
import type { GroundTruth } from "../ground-truth/schema.js";
import type { GraderResult, RunFailure } from "../runners/types.js";
import { classifyOutcome } from "./taxonomy.js";

/** One recipe's observed analysis outcome against the repo. */
export interface ObservedRecipe {
  recipeId: string;
  version: number;
  status: "applicable" | "already_applied" | "unsupported" | "incomplete";
  matchedPaths: string[];
  residualPaths: string[];
}

export interface RegaugeGrade {
  grader_results: GraderResult[];
  failures: RunFailure[];
  passed: boolean;
  matchedRecipes: string[];
}

function matches(path: string, entry: string): boolean {
  if (entry.endsWith("/")) return path === entry.slice(0, -1) || path.startsWith(entry);
  return path === entry;
}

export function gradeRegauge(observed: readonly ObservedRecipe[], gt: GroundTruth): RegaugeGrade {
  // A recipe "matches" when it recognizes the repo as its source: applicable
  // (would apply) or incomplete (matches but refuses due to residual sites).
  const matched = observed.filter((r) => r.status === "applicable" || r.status === "incomplete");
  const matchedRecipes = matched.map((r) => `${r.recipeId}@${r.version}(${r.status})`);
  const traps = gt.false_positive_traps;
  const grader_results: GraderResult[] = [];
  const failures: RunFailure[] = [];

  const trapHits = matched.flatMap((r) => r.matchedPaths.filter((p) => traps.some((t) => matches(p, t))));

  switch (gt.correct_behavior) {
    case "apply_recipe": {
      const want = gt.recipe_expectation?.shippedRecipeId;
      const hit = matched.find((r) => r.recipeId === want);
      const ok = Boolean(hit);
      grader_results.push({
        dimension: "recipe_match",
        passed: ok,
        score: ok ? 1 : 0,
        detail: ok
          ? `shipped recipe ${want} matched (status=${hit!.status})`
          : `expected shipped recipe ${want} to match; matched: ${matchedRecipes.join(", ") || "none"}`,
      });
      if (!ok) {
        const c = classifyOutcome("abstained_when_should_act");
        failures.push({
          category: c.category,
          severity: c.severity,
          dimension: "recipe_match",
          observed: `matched: ${matchedRecipes.join(", ") || "none"}`,
          expected: `shipped recipe ${want} applicable`,
        });
      } else {
        // Coverage of the expected root files.
        const covered = gt.expected_findings.filter((f) => hit!.matchedPaths.includes(f));
        const coverOk = covered.length === gt.expected_findings.length;
        grader_results.push({
          dimension: "recipe_path_coverage",
          passed: coverOk,
          score: gt.expected_findings.length ? covered.length / gt.expected_findings.length : 1,
          detail: `${covered.length}/${gt.expected_findings.length} expected root files in matchedPaths`,
        });
        if (hit!.residualPaths.length) {
          // Recorded as a coverage finding, not an unsafe failure.
          const c = classifyOutcome("no_shipped_capability");
          failures.push({
            category: "COVERAGE_GAP",
            severity: c.severity,
            dimension: "recipe_residual",
            observed: `residual sites left un-migrated: ${hit!.residualPaths.join(", ")}`,
            expected: "no residual (full migration)",
          });
        }
      }
      break;
    }
    case "abstain": {
      const ok = matched.length === 0;
      grader_results.push({
        dimension: "required_abstention",
        passed: ok,
        score: ok ? 1 : 0,
        detail: ok
          ? "no recipe matched — engine correctly does not act"
          : `recipe(s) matched where a required abstention was expected: ${matchedRecipes.join(", ")}`,
      });
      if (!ok) {
        const c = classifyOutcome("acted_when_should_abstain");
        failures.push({
          category: c.category,
          severity: c.severity,
          dimension: "required_abstention",
          observed: `matched: ${matchedRecipes.join(", ")}${trapHits.length ? `; touched traps: ${trapHits.join(", ")}` : ""}`,
          expected: "global abstention (no edit)",
        });
      }
      break;
    }
    case "coverage_gap": {
      if (matched.length === 0) {
        // Correct shipped behaviour: abstention-by-absence. Record the gap.
        grader_results.push({
          dimension: "abstention_by_absence",
          passed: true,
          score: 1,
          detail: "no shipped recipe matches the family — correct abstention-by-absence",
        });
        const c = classifyOutcome("no_shipped_capability");
        failures.push({
          category: c.category,
          severity: c.severity,
          dimension: "family_coverage",
          observed: "no shipped recipe covers this migration family",
          expected: `a recipe for family '${gt.recipe_expectation?.family ?? "?"}'`,
        });
      } else {
        // Engine gained coverage. Must stay within the oracle and hit no trap.
        const trapOk = trapHits.length === 0;
        grader_results.push({
          dimension: "coverage_safety",
          passed: trapOk,
          score: trapOk ? 1 : 0,
          detail: trapOk
            ? `recipe(s) matched (${matchedRecipes.join(", ")}) and touched no distractor`
            : `recipe(s) matched and touched distractor(s): ${trapHits.join(", ")}`,
        });
        if (!trapOk) {
          const c = classifyOutcome("flagged_trap");
          failures.push({
            category: c.category,
            severity: c.severity,
            dimension: "coverage_safety",
            observed: `matched recipe touched traps: ${trapHits.join(", ")}`,
            expected: "stay within the oracle; touch no distractor",
          });
        }
        // Oracle-coverage measurement (informational).
        const oraclePaths = matched.flatMap((r) => r.matchedPaths);
        const covered = gt.expected_findings.filter((f) => oraclePaths.some((p) => matches(p, f)));
        grader_results.push({
          dimension: "oracle_coverage",
          passed: true,
          score: gt.expected_findings.length ? covered.length / gt.expected_findings.length : 1,
          detail: `${covered.length}/${gt.expected_findings.length} oracle files reached by a matched recipe`,
        });
      }
      break;
    }
    case "no_op": {
      const ok = matched.length === 0;
      grader_results.push({
        dimension: "no_op_correctness",
        passed: ok,
        score: ok ? 1 : 0,
        detail: ok ? "no recipe matched — nothing to do" : `matched: ${matchedRecipes.join(", ")}`,
      });
      if (!ok) {
        const c = classifyOutcome("acted_when_should_abstain");
        failures.push({
          category: c.category,
          severity: c.severity,
          dimension: "no_op_correctness",
          observed: `matched: ${matchedRecipes.join(", ")}`,
          expected: "no-op",
        });
      }
      break;
    }
    default: {
      // flag_files is a Fettler behaviour; a ReGauge scenario should not use it.
      grader_results.push({
        dimension: "behaviour",
        passed: false,
        score: 0,
        detail: `unexpected correct_behavior '${gt.correct_behavior}' for a ReGauge scenario`,
      });
      failures.push({
        category: "HARNESS_LIMITATION",
        severity: "P3",
        dimension: "behaviour",
        observed: `correct_behavior=${gt.correct_behavior}`,
        expected: "apply_recipe|abstain|coverage_gap|no_op",
      });
    }
  }

  const passed = failures.every(
    (f) => f.category === "COVERAGE_GAP" || f.category === "HARNESS_LIMITATION",
  );
  return { grader_results, failures, passed, matchedRecipes };
}
