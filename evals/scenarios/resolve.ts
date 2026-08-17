/**
 * Unify hand-authored corpus scenarios and procedurally-generated scenarios into
 * one runnable list for the driver.
 *
 * A corpus scenario points at a real repo under `MENDPOINT_CORPUS_ROOT` and loads
 * its answer key from `evals/ground-truth/*.json`. A generated scenario carries
 * its repo in memory and its answer key alongside; `prepare()` materializes it to
 * scratch just before the run and `cleanup()` removes it after. Both then flow
 * through the SAME product runners (which stage the repo, stripping any grading
 * key, before handing it to the product).
 */
import type { GroundTruth, Product } from "../ground-truth/schema.js";
import { loadGroundTruth } from "../ground-truth/load.js";
import { generateScenarios, materializeRepo } from "../generators/index.js";
import { SCENARIOS, type ScenarioConfig } from "./index.js";

export interface PreparedScenario {
  config: ScenarioConfig;
  cleanup: () => void;
}

export interface RunnableScenario {
  scenario_id: string;
  product: Product;
  gt: GroundTruth;
  origin: "corpus" | "generated";
  budgetMs?: number;
  /** Resolve the repo to a concrete path (materializing generated repos). */
  prepare: () => PreparedScenario;
}

/** Every runnable scenario: corpus first (stable order), then generated. */
export function resolveScenarios(): RunnableScenario[] {
  const corpus: RunnableScenario[] = SCENARIOS.map((cfg) => ({
    scenario_id: cfg.scenario_id,
    product: cfg.product,
    gt: loadGroundTruth(cfg.scenario_id),
    origin: "corpus",
    budgetMs: cfg.budgetMs,
    prepare: () => ({ config: cfg, cleanup: () => {} }),
  }));

  const generated: RunnableScenario[] = generateScenarios().map((g) => ({
    scenario_id: g.scenario_id,
    product: g.product,
    gt: g.gt,
    origin: "generated",
    prepare: () => {
      const mat = materializeRepo(g.repo);
      const config: ScenarioConfig = {
        scenario_id: g.scenario_id,
        product: g.product,
        repoPath: mat.repoPath,
        slug: g.slug,
      };
      return { config, cleanup: mat.cleanup };
    },
  }));

  return [...corpus, ...generated];
}
