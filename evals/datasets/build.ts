/**
 * Phase 10 — build the model-learning dataset from run records.
 *
 *   tsx evals/datasets/build.ts            # project reports/latest-runs.json
 *   tsx evals/datasets/build.ts --in path  # project a specific runs file
 *
 * Projects each per-run record into the versioned {@link DatasetRecord} shape and
 * appends a NEW timestamped JSONL file under `evals/datasets/records/<version>/`.
 * The dataset is APPEND-ONLY: a build never rewrites a prior file, so the corpus
 * is an auditable log. Positive, negative, and coverage-gap records are all
 * captured; correct abstention is recorded as a POSITIVE example (several of the
 * product's most valuable behaviors are refusals, not actions).
 *
 * Never stores chain-of-thought — only observable inputs, outputs, tool
 * interactions, grader scores, and outcomes.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGroundTruth } from "../ground-truth/load.js";
import { generateScenarios } from "../generators/index.js";
import type { GroundTruth } from "../ground-truth/schema.js";
import type { RunRecord } from "../runners/types.js";
import {
  DATASET_VERSION,
  validateDatasetRecord,
  type DatasetOutcome,
  type DatasetRecord,
  type ToolTraceStep,
  type TrainingCategory,
} from "./schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const SAFE_NOTE_CATEGORIES = new Set(["COVERAGE_GAP", "HARNESS_LIMITATION"]);

/** Build the observable tool trace from a run's recorded activity (no CoT). */
function toolTrace(run: RunRecord): ToolTraceStep[] {
  const a = run.activity;
  const observed: Record<string, number | string> = { filesExamined: a.filesExamined };
  if (a.candidateCount !== undefined) observed.candidateCount = a.candidateCount;
  if (a.confirmedCount !== undefined) observed.confirmedCount = a.confirmedCount;
  if (a.lowConfidenceCount !== undefined) observed.lowConfidenceCount = a.lowConfidenceCount;
  if (a.recipesEvaluated !== undefined) observed.recipesEvaluated = a.recipesEvaluated;
  return [{ tool: run.invocation_path, observed }];
}

/** Classify the observable outcome + training category for one run. */
function classify(
  run: RunRecord,
  gt: GroundTruth,
): { outcome: DatasetOutcome; category: TrainingCategory; failureType: string } {
  const unsafe = run.failures.filter((f) => !SAFE_NOTE_CATEGORIES.has(f.category));
  const coverageGap = run.failures.some((f) => f.category === "COVERAGE_GAP");
  // A correct refusal on a partial-migration repo is a refusal, not an action:
  // group it with the abstention-shaped positives.
  const abstains =
    gt.correct_behavior === "abstain" ||
    gt.correct_behavior === "no_op" ||
    gt.correct_behavior === "refuse_partial";

  if (run.passed) {
    if (coverageGap) {
      return { outcome: "coverage_gap", category: "coverage_gap", failureType: "COVERAGE_GAP" };
    }
    if (abstains || gt.correct_behavior === "coverage_gap") {
      return { outcome: "correct_abstention", category: "positive", failureType: "none" };
    }
    return { outcome: "correct_action", category: "positive", failureType: "none" };
  }

  // Failed: pick the most severe unsafe failure as the primary signal.
  const primary =
    [...unsafe].sort((a, b) => a.severity.localeCompare(b.severity))[0] ?? run.failures[0];
  const cat = primary?.category ?? "FALSE_NEGATIVE";
  let outcome: DatasetOutcome = "false_negative";
  if (cat === "FALSE_POSITIVE") outcome = "false_positive";
  else if (cat === "ABSTENTION_FAILURE") outcome = "abstention_failure";
  else if (cat === "SCALE_FAILURE") outcome = "scale_failure";
  else if (cat === "ROBUSTNESS_FAILURE") outcome = "robustness_failure";
  else if (cat === "FALSE_NEGATIVE") outcome = "false_negative";
  return { outcome, category: "negative", failureType: cat };
}

/** Project run records + their ground truth into dataset records. */
export function buildDatasetRecords(
  runs: RunRecord[],
  gtFor: (scenarioId: string) => GroundTruth,
): DatasetRecord[] {
  const records: DatasetRecord[] = [];
  for (const run of runs) {
    const gt = gtFor(run.scenario_id);
    const { outcome, category, failureType } = classify(run, gt);
    const grader_scores: Record<string, number> = {};
    for (const g of run.grader_results) grader_scores[g.dimension] = g.score;
    const origin: "corpus" | "generated" = run.scenario_id.startsWith("gen-")
      ? "generated"
      : "corpus";

    const record: DatasetRecord = {
      example_id: `${run.scenario_id}:${run.run_id}`,
      scenario_id: run.scenario_id,
      task_type: run.product === "fettler" ? "impact_analysis" : "migration_recipe",
      input_reference: `${run.scenario_id}@${run.product_version} (${origin}; ${run.invocation_path})`,
      model_version: run.model,
      tool_trace: toolTrace(run),
      ground_truth: {
        correct_behavior: gt.correct_behavior,
        expected_findings: gt.expected_findings,
        false_positive_traps: gt.false_positive_traps,
      },
      grader_scores,
      failure_type: failureType,
      outcome,
      training_category: category,
      dataset_split: gt.dataset_split,
      provenance: {
        run_id: run.run_id,
        timestamp: run.timestamp,
        git_commit: run.git_commit,
        product: run.product,
        product_version: run.product_version,
        origin,
        invocation_path: run.invocation_path,
        dataset_version: DATASET_VERSION,
      },
      model_output: run.findings,
    };

    // Negative example -> attach the ground-truth better answer, forming a
    // same-input preference pair (bad product output vs. correct label).
    if (category === "negative") {
      record.corrected_output =
        gt.correct_behavior === "abstain" ||
        gt.correct_behavior === "no_op" ||
        gt.correct_behavior === "refuse_partial"
          ? []
          : gt.expected_findings;
      record.preference_explanation =
        outcome === "false_positive"
          ? `The correct output flags none of the distractor/trap files; the product flagged ${run.findings.length} file(s) including traps.`
          : outcome === "abstention_failure"
            ? `The correct behavior is '${gt.correct_behavior}' (act on nothing); the product produced confident findings.`
            : outcome === "false_negative"
              ? `The correct output flags exactly ${gt.expected_findings.length} impacted file(s); the product missed some or all of them.`
              : `The correct output for this scenario is defined by its ground truth (behavior=${gt.correct_behavior}).`;
    }

    const problems = validateDatasetRecord(record);
    if (problems.length) {
      throw new Error(`dataset record ${record.example_id} invalid: ${problems.join("; ")}`);
    }
    records.push(record);
  }
  return records;
}

/** Ground-truth lookup spanning both corpus and generated scenarios. */
export function combinedGroundTruthLookup(): (scenarioId: string) => GroundTruth {
  const generated = new Map(generateScenarios().map((g) => [g.scenario_id, g.gt]));
  return (scenarioId) => generated.get(scenarioId) ?? loadGroundTruth(scenarioId);
}

function parseArgs(argv: string[]): { in?: string } {
  const out: { in?: string } = {};
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--in") out.in = argv[++i];
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runsPath = args.in
    ? resolve(args.in)
    : join(HERE, "..", "reports", "latest-runs.json");
  const runs = JSON.parse(readFileSync(runsPath, "utf8")) as RunRecord[];
  const records = buildDatasetRecords(runs, combinedGroundTruthLookup());

  const outDir = join(HERE, "records", DATASET_VERSION);
  mkdirSync(outDir, { recursive: true });
  const commit = runs[0]?.git_commit ?? "unknown";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = join(outDir, `run-${stamp}-${commit}.jsonl`);
  writeFileSync(outFile, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

  const byCat = records.reduce<Record<string, number>>((acc, r) => {
    acc[r.training_category] = (acc[r.training_category] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`wrote ${records.length} dataset records -> ${outFile}`);
  console.log(
    `positive=${byCat.positive ?? 0} negative=${byCat.negative ?? 0} coverage_gap=${byCat.coverage_gap ?? 0}`,
  );
}

// Run as a script (not when imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
