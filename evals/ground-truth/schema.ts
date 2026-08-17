/**
 * Machine-readable ground-truth schema for the MendPoint synthetic-repo
 * evaluation suite.
 *
 * IMPORTANT (answer-key isolation): ground truth lives here, under
 * `evals/ground-truth/`, and is NEVER copied into or referenced from the
 * repository under test. The evaluated products (Fettler / ReGauge) receive
 * only a repo path and an API spec pair; they cannot retrieve these files.
 * The runners load ground truth strictly for grading, after the product has
 * produced its output.
 *
 * The shape follows the schema sketched in the evaluation spec
 * (scenario_id, repo_family, difficulty, intended_product, faults,
 * expected_findings, false_positive_traps, blast_radius_truth, tags) and adds
 * the fields the deterministic graders in `evals/graders/` need to score a run
 * without any semantic judgment.
 */

/** Which product is expected to handle the scenario. */
export type Product = "fettler" | "regauge";

/** 1 (obvious) .. 5 (adversarial), per the spec's difficulty ladder. */
export type Difficulty = 1 | 2 | 3 | 4 | 5;

/**
 * Dataset split (spec §18.9 — three tiers). `development` may be inspected while
 * fixing. `regression` holds scenarios added AFTER a failure was diagnosed: every
 * fixed defect becomes a permanent regression case here, so a later change that
 * reintroduces the defect is caught. `holdout` is the honest quality measure and
 * is never inspected during a fix. (`validation` is the tuning split between
 * development and holdout; it is not one of the three canonical tiers but is
 * retained so procedurally-generated tuning scenarios have a home.)
 */
export type DatasetSplit =
  | "development"
  | "regression"
  | "validation"
  | "holdout";

/**
 * The kind of behaviour that counts as correct for the scenario. This drives
 * grader selection so we never grade an abstention scenario as if it were a
 * find-the-files scenario.
 *
 * - flag_files   Fettler must flag exactly the expected impacted files
 *                (precision/recall against expected_findings + traps).
 * - abstain      The correct output is an explicit "I will not act, here is why"
 *                (ambiguous / unsafe-to-automate). Any applied edit is a failure.
 * - no_op        The correct output is silence: nothing to do (already migrated).
 *                Distinct from abstain: there is no ambiguity, there is simply
 *                no work.
 * - apply_recipe ReGauge must apply a migration recipe to the expected sites
 *                (the one family that maps to a shipped recipe today).
 * - coverage_gap A correct engine WOULD apply the transforms in
 *                expected_findings, but no shipped recipe matches the family, so
 *                the correct *shipped* behaviour is abstention-by-absence. The
 *                grader records both: whether the shipped engine correctly
 *                abstained, and the distance to the human-authored oracle.
 */
export type CorrectBehavior =
  | "flag_files"
  | "abstain"
  | "no_op"
  | "apply_recipe"
  | "coverage_gap";

/** A single injected/known fault, kept human-readable for reports. */
export interface Fault {
  /** Short stable id, e.g. "provider-field-rename". */
  id: string;
  /** One-line description of the fault or migration under test. */
  description: string;
  /** Free-form family tag, e.g. "api-field-rename", "sdk-major-upgrade". */
  family: string;
}

/** What ReGauge's shipped recipe engine is expected to do with the repo. */
export interface RecipeExpectation {
  /** Migration family, e.g. "runtime-upgrade", "sdk-upgrade". */
  family: string;
  /**
   * The shipped recipe id that should match, or null when no shipped recipe
   * covers the family (the coverage-gap scenarios).
   */
  shippedRecipeId: string | null;
  /** Reason codes the engine should emit when abstaining. */
  abstainReasons?: string[];
}

/** Coarse blast-radius facts a correct analysis should reflect. */
export interface BlastRadiusTruth {
  /** Number of files a correct migration must change (0 for no_op/abstain). */
  affectedFiles: number;
  /** Packages/workspaces in scope, when the repo is a monorepo. */
  affectedPackages?: string[];
  /** Packages/subsystems that must be left entirely untouched. */
  untouchedSubsystems?: string[];
  /** Import/call chain a correct trace should follow (prose, for reports). */
  importChain?: string[];
}

export interface GroundTruth {
  /** Stable scenario id, unique across the suite. */
  scenario_id: string;
  /** Repository family, e.g. "typescript-service", "python-service". */
  repo_family: string;
  /** 1..5 difficulty. */
  difficulty: Difficulty;
  /** Why this difficulty was assigned (required by the task brief). */
  difficulty_rationale: string;
  /** Which product(s) the scenario targets. */
  intended_product: Product[];
  /** Development split: dev scenarios may be inspected while fixing. */
  dataset_split: DatasetSplit;
  /** The behaviour that counts as correct. */
  correct_behavior: CorrectBehavior;
  /** Known faults / migration under test. */
  faults: Fault[];
  /**
   * Repo-relative file paths a correct product run MUST flag (Fettler) or
   * change (ReGauge). Empty for abstain / no_op scenarios.
   */
  expected_findings: string[];
  /**
   * Repo-relative paths that a correct run MAY flag/change without penalty but
   * is not required to (e.g. downstream test assertions that move with a
   * fixture). Flagging these counts neither as a hit nor a false positive.
   * A trailing "/" marks a directory prefix.
   */
  acceptable_findings: string[];
  /**
   * Repo-relative paths that look relevant but must NOT be flagged/changed.
   * These are the false-positive traps (distractors). A trailing "/" marks a
   * directory prefix (everything under it is a trap), used for generated,
   * vendored, and node_modules trees.
   */
  false_positive_traps: string[];
  /** Coarse blast-radius facts. */
  blast_radius_truth: BlastRadiusTruth;
  /** For ReGauge scenarios: what the recipe engine should do. */
  recipe_expectation?: RecipeExpectation;
  /** Free-form tags for slicing reports. */
  tags: string[];
  /** Human notes; never fed to the product. */
  notes?: string;
}

const PRODUCTS: ReadonlySet<string> = new Set(["fettler", "regauge"]);
const BEHAVIORS: ReadonlySet<string> = new Set([
  "flag_files",
  "abstain",
  "no_op",
  "apply_recipe",
  "coverage_gap",
]);
const SPLITS: ReadonlySet<string> = new Set([
  "development",
  "regression",
  "validation",
  "holdout",
]);

/**
 * Validate a parsed ground-truth object. Returns the list of problems; an empty
 * list means the object is well-formed. Deterministic, no external deps, so it
 * can run in a unit test and in the loader.
 */
export function validateGroundTruth(value: unknown): string[] {
  const problems: string[] = [];
  const g = value as Partial<GroundTruth> | null;
  if (!g || typeof g !== "object") return ["not an object"];

  const requireString = (k: keyof GroundTruth): void => {
    if (typeof g[k] !== "string" || (g[k] as string).length === 0) {
      problems.push(`${String(k)} must be a non-empty string`);
    }
  };
  requireString("scenario_id");
  requireString("repo_family");
  requireString("difficulty_rationale");

  if (
    typeof g.difficulty !== "number" ||
    g.difficulty < 1 ||
    g.difficulty > 5 ||
    !Number.isInteger(g.difficulty)
  ) {
    problems.push("difficulty must be an integer 1..5");
  }
  if (
    !Array.isArray(g.intended_product) ||
    g.intended_product.length === 0 ||
    !g.intended_product.every((p) => PRODUCTS.has(p))
  ) {
    problems.push("intended_product must be a non-empty array of fettler|regauge");
  }
  if (typeof g.dataset_split !== "string" || !SPLITS.has(g.dataset_split)) {
    problems.push("dataset_split must be development|regression|validation|holdout");
  }
  if (typeof g.correct_behavior !== "string" || !BEHAVIORS.has(g.correct_behavior)) {
    problems.push(
      "correct_behavior must be flag_files|abstain|no_op|apply_recipe|coverage_gap",
    );
  }
  if (!Array.isArray(g.faults)) problems.push("faults must be an array");
  if (!Array.isArray(g.expected_findings)) {
    problems.push("expected_findings must be an array");
  }
  if (!Array.isArray(g.false_positive_traps)) {
    problems.push("false_positive_traps must be an array");
  }
  if (!Array.isArray(g.tags)) problems.push("tags must be an array");
  if (!g.blast_radius_truth || typeof g.blast_radius_truth !== "object") {
    problems.push("blast_radius_truth must be an object");
  } else if (typeof g.blast_radius_truth.affectedFiles !== "number") {
    problems.push("blast_radius_truth.affectedFiles must be a number");
  }

  // Cross-field consistency: abstain / no_op must have no expected findings.
  if (
    (g.correct_behavior === "abstain" || g.correct_behavior === "no_op") &&
    Array.isArray(g.expected_findings) &&
    g.expected_findings.length > 0
  ) {
    problems.push(
      `${g.correct_behavior} scenarios must have empty expected_findings`,
    );
  }
  return problems;
}
