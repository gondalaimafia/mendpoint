/**
 * Failure -> eval: the converter.
 *
 * `regressionScenarios()` turns every governed `RegressionCase` into a runnable
 * `GeneratedScenario` on the `regression` dataset split (spec §18.9): a permanent
 * guard added AFTER a failure was diagnosed, so a later change that reintroduces
 * the defect is caught. Each case is passed through the governance gate FIRST, so
 * a case that is not certified safe to commit fails loudly here instead of
 * silently reaching a product path. The resulting scenarios flow through the
 * SAME runners and graders every other generated scenario uses (real graders,
 * machine-readable ground truth, answer-key isolation via `runners/stage.ts`).
 */
import type { GroundTruth } from "../ground-truth/schema.js";
import type { GeneratedScenario } from "../generators/types.js";
import { assertAdmissible } from "./governance.js";
import { REGRESSION_CASES } from "./cases.js";
import type { RegressionCase, RegressionReproduction } from "./schema.js";

/** Assemble a full, schema-valid GroundTruth from a case and its reproduction. */
function toGroundTruth(c: RegressionCase, repro: RegressionReproduction): GroundTruth {
  const g = repro.groundTruth;
  const statusTag = c.status === "fixed" ? "regression-guard" : "open-gap";
  return {
    scenario_id: c.id,
    dataset_split: "regression",
    // A regression scenario's difficulty_rationale defaults to its provenance so
    // the report reader sees WHY the case exists without opening the catalog.
    difficulty_rationale:
      g.difficulty_rationale ??
      `Regression guard (${c.status}${c.fixedBy ? `, ${c.fixedBy}` : ""}) from ${c.provenance.source}: ${c.provenance.note}`,
    tags: [
      "generated",
      "regression",
      c.product,
      c.capability,
      statusTag,
      ...(c.fixedBy ? [c.fixedBy.replace(/^#/, "pr-")] : []),
    ],
    ...g,
  };
}

/**
 * Every regression scenario, governance-checked and split-tagged. Consumed by the
 * generator alongside the family scenarios.
 */
export function regressionScenarios(): GeneratedScenario[] {
  const out: GeneratedScenario[] = [];
  for (const c of REGRESSION_CASES) {
    assertAdmissible(c);
    const repro = c.build();
    out.push({
      scenario_id: c.id,
      product: c.product,
      ...(repro.slug ? { slug: repro.slug } : {}),
      repo: repro.repo,
      gt: toGroundTruth(c, repro),
    });
  }
  return out;
}

export { REGRESSION_CASES } from "./cases.js";
