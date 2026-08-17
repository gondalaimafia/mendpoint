/**
 * Phase 10 — model-learning dataset record schema.
 *
 * One record per run, in the shape the spec sketches. This is a CLEAN, versioned
 * corpus for later eval / SFT / preference-optimization / routing work — we do
 * NOT fine-tune just because data exists.
 *
 * HARD RULE: never store private chain-of-thought or hidden model reasoning.
 * Every field here is an OBSERVABLE input reference, output, tool interaction,
 * grader score, or outcome. `input_reference` is a reference (scenario id +
 * provenance), not the raw repository, and `model_output` is the product's
 * observable findings — never its reasoning.
 */
import type { DatasetSplit } from "../ground-truth/schema.js";

export const DATASET_VERSION = "v1";

/** One observable step in the product's tool/analysis interaction. */
export interface ToolTraceStep {
  tool: string;
  observed: Record<string, number | string>;
}

/**
 * Training signal category:
 *   - positive     : the system did the right thing (found it, or correctly
 *                    ABSTAINED — abstention is a first-class positive here).
 *   - negative     : the system missed, invented, or acted unsafely.
 *   - coverage_gap : correct abstention-by-absence; not a defect, kept separate.
 */
export type TrainingCategory = "positive" | "negative" | "coverage_gap";

/** Coarse observable outcome for slicing the dataset. */
export type DatasetOutcome =
  | "correct_action"
  | "correct_abstention"
  | "false_negative"
  | "false_positive"
  | "abstention_failure"
  | "scale_failure"
  | "robustness_failure"
  | "coverage_gap";

export interface DatasetRecord {
  example_id: string;
  scenario_id: string;
  /** "impact_analysis" (Fettler) | "migration_recipe" (ReGauge). */
  task_type: string;
  /** A reference to the input, NOT the raw input (keeps answer keys out too). */
  input_reference: string;
  /** The model version, or null on the deterministic (no-model) path. */
  model_version: string | null;
  /** Observable analysis/tool interactions (no chain-of-thought). */
  tool_trace: ToolTraceStep[];
  /** The answer key used to score (labels, not reasoning). */
  ground_truth: {
    correct_behavior: string;
    expected_findings: string[];
    false_positive_traps: string[];
  };
  /** dimension -> score (0..1). */
  grader_scores: Record<string, number>;
  /** Primary failure category, or "none". */
  failure_type: string;
  outcome: DatasetOutcome;
  training_category: TrainingCategory;
  dataset_split: DatasetSplit;
  provenance: {
    run_id: string;
    timestamp: string;
    git_commit: string;
    product: string;
    product_version: string;
    origin: "corpus" | "generated";
    invocation_path: string;
    dataset_version: string;
  };
  /** Observable product output (findings). Populated for preference use. */
  model_output: string[];
  /**
   * The better output for a preference pair: the ground-truth answer. Present
   * only when this record is a negative example (so `(model_output, corrected_output)`
   * forms a same-input bad/better pair for later preference optimization).
   */
  corrected_output?: string[];
  /** Objective, non-CoT reason the corrected output is better. */
  preference_explanation?: string;
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "correct_action",
  "correct_abstention",
  "false_negative",
  "false_positive",
  "abstention_failure",
  "scale_failure",
  "robustness_failure",
  "coverage_gap",
]);

/** Validate a dataset record; empty array means well-formed. */
export function validateDatasetRecord(value: unknown): string[] {
  const problems: string[] = [];
  const r = value as Partial<DatasetRecord> | null;
  if (!r || typeof r !== "object") return ["not an object"];
  for (const k of ["example_id", "scenario_id", "task_type", "input_reference"] as const) {
    if (typeof r[k] !== "string" || !(r[k] as string).length) {
      problems.push(`${k} must be a non-empty string`);
    }
  }
  if (!Array.isArray(r.tool_trace)) problems.push("tool_trace must be an array");
  if (!Array.isArray(r.model_output)) problems.push("model_output must be an array");
  if (!r.ground_truth || typeof r.ground_truth !== "object") {
    problems.push("ground_truth must be an object");
  }
  if (typeof r.outcome !== "string" || !OUTCOMES.has(r.outcome)) {
    problems.push("outcome must be a known DatasetOutcome");
  }
  if (!["positive", "negative", "coverage_gap"].includes(r.training_category as string)) {
    problems.push("training_category must be positive|negative|coverage_gap");
  }
  if (!["development", "validation", "holdout"].includes(r.dataset_split as string)) {
    problems.push("dataset_split must be development|validation|holdout");
  }
  // CoT guard: forbid any field that could smuggle hidden reasoning.
  for (const banned of ["reasoning", "chain_of_thought", "thoughts", "scratchpad"]) {
    if (banned in (r as Record<string, unknown>)) {
      problems.push(`record must not contain '${banned}' (no chain-of-thought)`);
    }
  }
  return problems;
}
