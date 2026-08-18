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
 *   - refuse_partial: the recipe recognizes the repo but a residual site sits
 *                    outside its `allowedPaths`; the ONLY safe outcome is
 *                    `status="incomplete"` (refuse). Applying anyway is a P0
 *                    partial migration that would ship a repo which no longer
 *                    installs. Graded on the analyze status.
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
        if (!coverOk) {
          // A shipped recipe that matched but did NOT surface an expected root
          // file is under-applying: the migration would skip a site the answer
          // key requires. Unlike a residual (outside allowedPaths, recorded as a
          // coverage gap), this is an in-scope miss and must flip pass/fail — a
          // graded dimension that can never fail is worse than no dimension.
          const missing = gt.expected_findings.filter((f) => !hit!.matchedPaths.includes(f));
          const c = classifyOutcome("missed_some_findings");
          failures.push({
            category: c.category,
            severity: c.severity,
            dimension: "recipe_path_coverage",
            observed: `matchedPaths=${hit!.matchedPaths.join(", ") || "none"}`,
            expected: `all expected root files matched; missing: ${missing.join(", ")}`,
          });
        }
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
    case "refuse_partial": {
      // The recipe must recognize its own source repo but REFUSE to ship a
      // partial migration: `status="incomplete"` (residual site outside
      // allowedPaths). Grading keys on the analyze status, not on findings.
      const want = gt.recipe_expectation?.shippedRecipeId;
      const hit = matched.find((r) => r.recipeId === want);
      if (!hit) {
        // The recipe did not even recognize the repo as its own source. That is
        // a miss (a capability exists), not the confidently-wrong application the
        // scenario targets — abstained where it should have engaged and refused.
        grader_results.push({
          dimension: "residual_refusal",
          passed: false,
          score: 0,
          detail: `expected recipe ${want} to recognize the repo and refuse on the residual site; matched: ${matchedRecipes.join(", ") || "none"}`,
        });
        const c = classifyOutcome("abstained_when_should_act");
        failures.push({
          category: c.category,
          severity: c.severity,
          dimension: "residual_refusal",
          observed: `matched: ${matchedRecipes.join(", ") || "none"}`,
          expected: `recipe ${want} matches with status=incomplete (refuses on residual)`,
        });
      } else {
        const refused = hit.status === "incomplete";
        grader_results.push({
          dimension: "residual_refusal",
          passed: refused,
          score: refused ? 1 : 0,
          detail: refused
            ? `recipe ${want} refused: status=incomplete, residual=${hit.residualPaths.join(", ") || "(none reported)"}`
            : `recipe ${want} would APPLY (status=${hit.status}) despite a residual consumer outside allowedPaths — a partial migration would ship`,
        });
        if (!refused) {
          // status=applicable with a residual present == the confidently-wrong
          // application: strip/bump the dependency while a residual site still
          // uses the old surface. P0 (acted_when_should_abstain).
          const c = classifyOutcome("acted_when_should_abstain");
          failures.push({
            category: c.category,
            severity: c.severity,
            dimension: "residual_refusal",
            observed: `status=${hit.status}; residualPaths=${hit.residualPaths.join(", ") || "none"}`,
            expected: "status=incomplete (refuse; do not ship a partial migration)",
          });
        }
        // Even while refusing, the recipe must not have matched a distractor.
        if (trapHits.length) {
          const c = classifyOutcome("flagged_trap");
          failures.push({
            category: c.category,
            severity: c.severity,
            dimension: "coverage_safety",
            observed: `matched recipe touched traps: ${trapHits.join(", ")}`,
            expected: "touch no distractor",
          });
        }
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
