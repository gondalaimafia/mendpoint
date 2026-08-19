/**
 * Readiness gates (spec §33.5) — versioned acceptance criteria, evaluated.
 *
 * The owner's thresholds live in `evals/readiness-gates.json` (a versioned config
 * with a schema version), NOT as literals scattered across graders. This module
 * loads that config and evaluates a scored run against it, emitting a clear
 * PASS/FAIL per capability and per criterion.
 *
 * Every number here traces to a real run: precision/recall are micro-averaged
 * over the actual findings (so an easy scenario cannot mask a hard one), open-P0
 * counts the unsafe P0 failures the graders classified, and the holdout/dev gap
 * is computed from real per-split pass rates. A criterion whose inputs are not
 * present in the run (e.g. no holdout scenarios) is reported as "not measurable"
 * rather than silently passed.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countFettlerFindings } from "./graders/fettler-graders.js";
import type { GroundTruth } from "./ground-truth/schema.js";
import type { RunRecord } from "./runners/types.js";

/** A run record paired with its ground truth (same shape the report consumes). */
export interface ScoredRun {
  record: RunRecord;
  gt: GroundTruth;
}

/**
 * A gated scenario that was ABSENT from a run (e.g. the external corpus was not
 * present on the runner). Its ground truth is known even though it did not run,
 * so it can be attributed to the capability it would have fed and reported as an
 * explicit coverage hole — never silently dropped, which would let the pooled
 * metrics renormalise over a partial set and read as a pass.
 */
export interface AbsentScenario {
  scenario_id: string;
  product: string;
  gt: GroundTruth;
}

/**
 * Fettler impact-analysis capability thresholds. `kind` is optional so the
 * shipped config's untagged entry (and the hand-built test fixtures) still parse
 * as this shape.
 */
export interface FettlerImpactThresholds {
  kind?: "fettler-impact";
  description?: string;
  impact_precision_min: number;
  impact_recall_min: number;
  max_open_p0: number;
  holdout_dev_gap_max_pp: number;
}

/**
 * ReGauge migration-recipe family thresholds. A family aggregates every ReGauge
 * scenario whose `recipe_expectation.family` matches `family`, and is scored on
 * three behaviours plus open-P0. Each `*_min` is a pass RATE over that family's
 * scenarios of the relevant kind (small n by design — precision-first).
 */
export interface RegaugeFamilyThresholds {
  kind: "regauge-family";
  description?: string;
  notes?: string;
  /** The `recipe_expectation.family` string this capability aggregates. */
  family: string;
  /** Min pass rate over apply_recipe scenarios (correct application in scope). */
  apply_correctness_min: number;
  /** Min pass rate over refuse_partial scenarios (refusal on residual repos). */
  refusal_correctness_min: number;
  /** Min pass rate over abstain/coverage_gap/no_op scenarios (out-of-scope). */
  abstention_correctness_min: number;
  /** Max unsafe (non-coverage-gap, non-harness) P0 failures across the family. */
  max_open_p0: number;
}

/**
 * Fettler restraint (abstention / no-op) thresholds. A DISTINCT capability from
 * impact analysis: `fettler-impact-analysis` scores recall/precision on
 * `flag_files` scenarios; this scores whether the product correctly does NOTHING
 * on the scenarios where nothing is the right answer — an ambiguous rename with
 * two plausible successors (abstain) or an already-migrated repo (no_op). Acting
 * confidently on either is a P0. Pooled over the abstain/no_op Fettler scenarios,
 * which the impact-analysis gate deliberately excludes.
 */
export interface FettlerAbstentionThresholds {
  kind: "fettler-abstention";
  description?: string;
  notes?: string;
  /** Min pass rate over abstain + no_op Fettler scenarios. */
  abstention_correctness_min: number;
  /** Max unsafe (non-coverage-gap, non-harness) P0 failures across them. */
  max_open_p0: number;
}

export type CapabilityThresholds =
  | FettlerImpactThresholds
  | RegaugeFamilyThresholds
  | FettlerAbstentionThresholds;

function isRegaugeFamily(t: CapabilityThresholds): t is RegaugeFamilyThresholds {
  return (t as RegaugeFamilyThresholds).kind === "regauge-family";
}

function isFettlerAbstention(t: CapabilityThresholds): t is FettlerAbstentionThresholds {
  return (t as FettlerAbstentionThresholds).kind === "fettler-abstention";
}

/**
 * A capability the product HAS but the eval substrate cannot score yet. Recorded
 * so gate coverage is honest: never gated on an invented threshold, always paired
 * with the experiment that would make it measurable.
 */
export interface NotMeasuredCapability {
  capability: string;
  reason: string;
  experiment: string;
  owner?: string;
}

export interface NotMeasuredBlock {
  notes?: string;
  capabilities: NotMeasuredCapability[];
}

export interface ReadinessGatesConfig {
  schema_version: number;
  policy: string;
  owner: string;
  decided_at: string;
  notes?: string;
  capabilities: Record<string, CapabilityThresholds>;
  /** Capabilities with no measurable signal today; documented, not gated. */
  not_measured?: NotMeasuredBlock;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_GATES_PATH = join(HERE, "readiness-gates.json");

/** The schema versions this evaluator understands. */
const SUPPORTED_SCHEMA_VERSIONS = new Set([1]);

/** Load and validate the versioned gates config. Throws on a malformed file. */
export function loadReadinessGates(path: string = DEFAULT_GATES_PATH): ReadinessGatesConfig {
  const cfg = JSON.parse(readFileSync(path, "utf8")) as ReadinessGatesConfig;
  if (typeof cfg.schema_version !== "number" || !SUPPORTED_SCHEMA_VERSIONS.has(cfg.schema_version)) {
    throw new Error(
      `readiness-gates schema_version ${cfg.schema_version} not supported (understood: ${[...SUPPORTED_SCHEMA_VERSIONS].join(", ")})`,
    );
  }
  if (!cfg.capabilities || typeof cfg.capabilities !== "object") {
    throw new Error("readiness-gates: capabilities must be an object");
  }
  const numeric = (name: string, t: CapabilityThresholds, keys: readonly string[]): void => {
    for (const k of keys) {
      if (typeof (t as unknown as Record<string, unknown>)[k] !== "number") {
        throw new Error(`readiness-gates: capability ${name}.${k} must be a number`);
      }
    }
  };
  for (const [name, t] of Object.entries(cfg.capabilities)) {
    if (isRegaugeFamily(t)) {
      if (typeof t.family !== "string" || t.family.length === 0) {
        throw new Error(`readiness-gates: capability ${name}.family must be a non-empty string`);
      }
      numeric(name, t, [
        "apply_correctness_min",
        "refusal_correctness_min",
        "abstention_correctness_min",
        "max_open_p0",
      ]);
    } else if (isFettlerAbstention(t)) {
      numeric(name, t, ["abstention_correctness_min", "max_open_p0"]);
    } else {
      numeric(name, t, [
        "impact_precision_min",
        "impact_recall_min",
        "max_open_p0",
        "holdout_dev_gap_max_pp",
      ]);
    }
  }
  return cfg;
}

const SAFE_NOTE_CATEGORIES = new Set(["COVERAGE_GAP", "HARNESS_LIMITATION"]);

/** One evaluated criterion. `measurable=false` means the run lacked the inputs. */
export interface CriterionResult {
  name: string;
  measurable: boolean;
  passed: boolean;
  /** Human-readable measured value, e.g. "64.1%" or "2" or "not measured". */
  measured: string;
  /** Human-readable threshold, e.g. ">= 90%". */
  threshold: string;
  detail: string;
}

/**
 * A not-measurable criterion for a capability whose gated scenarios were absent
 * from the run. Because verdicts require every criterion to be `measurable &&
 * passed`, appending this forces the capability to FAIL rather than silently
 * renormalise its pooled metrics over the scenarios that happened to run.
 */
function absentCoverageCriterion(absent: AbsentScenario[]): CriterionResult | null {
  if (absent.length === 0) return null;
  const ids = absent.map((a) => a.scenario_id).sort();
  return {
    name: "gated_scenario_coverage",
    measurable: false,
    passed: false,
    measured: `not measured (${absent.length} gated scenario(s) absent: ${ids.join(", ")})`,
    threshold: "every gated scenario present and scored",
    detail:
      "gated scenarios were absent from this run (e.g. the external corpus was not present); the pooled metrics would renormalise over a partial set, so readiness cannot be demonstrated until they run",
  };
}

/** Per-behaviour pass counts for a ReGauge family capability. */
export interface RegaugeFamilyMetrics {
  family: string;
  applyTotal: number;
  applyPassed: number;
  refuseTotal: number;
  refusePassed: number;
  abstainTotal: number;
  abstainPassed: number;
  openP0: number;
  scenarioCount: number;
}

export interface CapabilityReadiness {
  capability: string;
  verdict: "PASS" | "FAIL";
  criteria: CriterionResult[];
  /** Raw pooled numbers, for the scorecard and report. */
  metrics: {
    precision: number | null;
    recall: number | null;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    openP0: number;
    scenarioCount: number;
    developmentPassRate: number | null;
    holdoutPassRate: number | null;
  };
  /** Present only for regauge-family capabilities. */
  familyMetrics?: RegaugeFamilyMetrics;
}

export interface ReadinessEvaluation {
  policy: string;
  owner: string;
  decided_at: string;
  schema_version: number;
  gatesPath: string;
  overall: "PASS" | "FAIL";
  capabilities: CapabilityReadiness[];
}

/** Pool the confusion-matrix over the Fettler flag_files scenarios in a run. */
function fettlerMicroStats(scored: ScoredRun[]): {
  tp: number;
  fp: number;
  fn: number;
  scenarioCount: number;
} {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let scenarioCount = 0;
  for (const s of scored) {
    if (s.record.product !== "fettler") continue;
    if (s.gt.correct_behavior !== "flag_files") continue;
    scenarioCount++;
    const c = countFettlerFindings(s.record.findings, s.gt);
    tp += c.expectedHits.length;
    fp += c.trapHits.length + c.extras.length;
    fn += c.missed.length;
  }
  return { tp, fp, fn, scenarioCount };
}

/** Count unsafe (non-coverage-gap, non-harness) P0 failures on a product. */
function openP0Count(scored: ScoredRun[], product: string): number {
  let n = 0;
  for (const s of scored) {
    if (s.record.product !== product) continue;
    for (const f of s.record.failures) {
      if (f.severity === "P0" && !SAFE_NOTE_CATEGORIES.has(f.category)) n++;
    }
  }
  return n;
}

/** Pass rate on a given dataset split for a product; null when the split is empty. */
function splitPassRate(scored: ScoredRun[], product: string, split: string): number | null {
  const rows = scored.filter((s) => s.record.product === product && s.gt.dataset_split === split);
  if (rows.length === 0) return null;
  return rows.filter((s) => s.record.passed).length / rows.length;
}

const asPct = (n: number): string => `${(n * 100).toFixed(1)}%`;

/** Evaluate the Fettler impact-analysis capability against its thresholds. */
function evaluateFettlerImpact(
  scored: ScoredRun[],
  t: FettlerImpactThresholds,
  absent: AbsentScenario[] = [],
): CapabilityReadiness {
  const { tp, fp, fn, scenarioCount } = fettlerMicroStats(scored);
  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const openP0 = openP0Count(scored, "fettler");
  const dev = splitPassRate(scored, "fettler", "development");
  const holdout = splitPassRate(scored, "fettler", "holdout");
  const gapPp = dev !== null && holdout !== null ? (dev - holdout) * 100 : null;

  const criteria: CriterionResult[] = [
    {
      name: "impact_precision",
      measurable: precision !== null,
      passed: precision !== null && precision >= t.impact_precision_min,
      measured: precision !== null ? asPct(precision) : "not measured (no findings)",
      threshold: `>= ${asPct(t.impact_precision_min)}`,
      detail: `micro-averaged over ${scenarioCount} flag_files scenarios (TP=${tp}, FP=${fp})`,
    },
    {
      name: "impact_recall",
      measurable: recall !== null,
      passed: recall !== null && recall >= t.impact_recall_min,
      measured: recall !== null ? asPct(recall) : "not measured (no expected findings)",
      threshold: `>= ${asPct(t.impact_recall_min)}`,
      detail: `micro-averaged over ${scenarioCount} flag_files scenarios (TP=${tp}, FN=${fn})`,
    },
    {
      name: "open_p0",
      measurable: true,
      passed: openP0 <= t.max_open_p0,
      measured: String(openP0),
      threshold: `<= ${t.max_open_p0}`,
      detail: "unsafe P0 failures (false-positive traps / confidently-wrong abstention), coverage gaps excluded",
    },
    {
      name: "holdout_within_dev",
      measurable: gapPp !== null,
      // Divergence in EITHER direction is disqualifying. A holdout that
      // substantially OUTPERFORMS development is itself evidence the splits are
      // not comparable (e.g. the holdout is easier, or blind to a benchmark-fit
      // heuristic development exercises), so the magnitude of the gap is what the
      // gate bounds, not the signed dev-minus-holdout delta.
      passed: gapPp !== null && Math.abs(gapPp) <= t.holdout_dev_gap_max_pp,
      measured:
        gapPp !== null
          ? `${gapPp <= 0 ? "+" : "-"}${Math.abs(gapPp).toFixed(1)}pp vs dev`
          : "not measured (no holdout or no development scenarios)",
      threshold: `holdout within ${t.holdout_dev_gap_max_pp}pp of development`,
      detail:
        dev !== null && holdout !== null
          ? `development pass ${asPct(dev)}, holdout pass ${asPct(holdout)}`
          : "requires both a development and a holdout split",
    },
  ];

  // A gated flag_files scenario that was absent (corpus not present) leaves the
  // pooled precision/recall renormalised over a partial set — report it as an
  // explicit not-measured criterion so the capability cannot read as ready.
  const cov = absentCoverageCriterion(absent);
  if (cov) criteria.push(cov);

  // A not-measurable criterion cannot demonstrate readiness, so it does not pass.
  const verdict: "PASS" | "FAIL" = criteria.every((c) => c.measurable && c.passed) ? "PASS" : "FAIL";

  return {
    capability: "fettler-impact-analysis",
    verdict,
    criteria,
    metrics: {
      precision,
      recall,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
      openP0,
      scenarioCount,
      developmentPassRate: dev,
      holdoutPassRate: holdout,
    },
  };
}

const FETTLER_RESTRAINT = new Set(["abstain", "no_op"]);

/** Fettler abstain + no_op scenarios in a run. */
function fettlerRestraintScenarios(scored: ScoredRun[]): ScoredRun[] {
  return scored.filter(
    (s) => s.record.product === "fettler" && FETTLER_RESTRAINT.has(s.gt.correct_behavior),
  );
}

/** Evaluate the Fettler restraint (abstention / no-op) capability. */
function evaluateFettlerAbstention(
  capability: string,
  scored: ScoredRun[],
  t: FettlerAbstentionThresholds,
  absent: AbsentScenario[] = [],
): CapabilityReadiness {
  const rows = fettlerRestraintScenarios(scored);
  const passed = rows.filter((s) => s.record.passed).length;
  const rate = rows.length === 0 ? null : passed / rows.length;
  const openP0 = openP0Count(rows, "fettler");

  const criteria: CriterionResult[] = [
    {
      name: "abstention_correctness",
      measurable: rate !== null,
      passed: rate !== null && rate >= t.abstention_correctness_min,
      measured: rate !== null ? fracPct(passed, rows.length) : "not measured (no abstain/no_op scenarios)",
      threshold: `>= ${pctInt(t.abstention_correctness_min)} correct`,
      detail:
        "an ambiguous rename (>=2 plausible successors) or an already-migrated repo must produce NO confident finding",
    },
    {
      name: "open_p0",
      measurable: true,
      passed: openP0 <= t.max_open_p0,
      measured: String(openP0),
      threshold: `<= ${t.max_open_p0}`,
      detail: "unsafe P0 failures (acted confidently where abstention was required); coverage gaps excluded",
    },
  ];

  const cov = absentCoverageCriterion(absent);
  if (cov) criteria.push(cov);

  const verdict: "PASS" | "FAIL" = criteria.every((c) => c.measurable && c.passed) ? "PASS" : "FAIL";

  return {
    capability,
    verdict,
    criteria,
    metrics: {
      precision: null,
      recall: null,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      openP0,
      scenarioCount: rows.length,
      developmentPassRate: null,
      holdoutPassRate: null,
    },
  };
}

const REGAUGE_APPLY = new Set(["apply_recipe"]);
const REGAUGE_REFUSE = new Set(["refuse_partial"]);
const REGAUGE_ABSTAIN = new Set(["abstain", "coverage_gap", "no_op"]);

/** ReGauge scenarios in a run whose recipe family matches `family`. */
function familyScenarios(scored: ScoredRun[], family: string): ScoredRun[] {
  return scored.filter(
    (s) => s.record.product === "regauge" && (s.gt.recipe_expectation?.family ?? "") === family,
  );
}

const pctInt = (n: number): string => `${(n * 100).toFixed(0)}%`;
const fracPct = (passed: number, total: number): string =>
  `${total ? ((passed / total) * 100).toFixed(1) : "0.0"}% (${passed}/${total})`;

/** Evaluate one ReGauge migration-recipe family against its thresholds. */
function evaluateRegaugeFamily(
  capability: string,
  scored: ScoredRun[],
  t: RegaugeFamilyThresholds,
  absent: AbsentScenario[] = [],
): CapabilityReadiness {
  const rows = familyScenarios(scored, t.family);
  const apply = rows.filter((s) => REGAUGE_APPLY.has(s.gt.correct_behavior));
  const refuse = rows.filter((s) => REGAUGE_REFUSE.has(s.gt.correct_behavior));
  const abstain = rows.filter((s) => REGAUGE_ABSTAIN.has(s.gt.correct_behavior));
  const applyPassed = apply.filter((s) => s.record.passed).length;
  const refusePassed = refuse.filter((s) => s.record.passed).length;
  const abstainPassed = abstain.filter((s) => s.record.passed).length;
  const openP0 = openP0Count(rows, "regauge");

  const rate = (passed: number, total: number): number | null =>
    total === 0 ? null : passed / total;
  const applyRate = rate(applyPassed, apply.length);
  const refuseRate = rate(refusePassed, refuse.length);
  const abstainRate = rate(abstainPassed, abstain.length);

  const criteria: CriterionResult[] = [
    {
      name: "apply_correctness",
      measurable: applyRate !== null,
      passed: applyRate !== null && applyRate >= t.apply_correctness_min,
      measured: applyRate !== null ? fracPct(applyPassed, apply.length) : "not measured (no in-scope apply scenarios)",
      threshold: `>= ${pctInt(t.apply_correctness_min)} pass`,
      detail: "shipped recipe recognizes and (would) apply cleanly on in-scope repos",
    },
    {
      name: "residual_refusal",
      measurable: refuseRate !== null,
      passed: refuseRate !== null && refuseRate >= t.refusal_correctness_min,
      measured: refuseRate !== null ? fracPct(refusePassed, refuse.length) : "not measured (no residual scenarios)",
      threshold: `>= ${pctInt(t.refusal_correctness_min)} refuse`,
      detail: "a residual site outside allowedPaths must force status=incomplete (refuse to ship a partial migration)",
    },
    {
      name: "out_of_scope_abstention",
      measurable: abstainRate !== null,
      passed: abstainRate !== null && abstainRate >= t.abstention_correctness_min,
      measured: abstainRate !== null ? fracPct(abstainPassed, abstain.length) : "not measured (no abstention scenarios)",
      threshold: `>= ${pctInt(t.abstention_correctness_min)} abstain`,
      detail: "out-of-scope / no-shipped-recipe repos must not match (abstain by absence)",
    },
    {
      name: "open_p0",
      measurable: true,
      passed: openP0 <= t.max_open_p0,
      measured: String(openP0),
      threshold: `<= ${t.max_open_p0}`,
      detail: "unsafe P0 failures across the family (partial-migration application, distractor hit); coverage gaps excluded",
    },
  ];

  const cov = absentCoverageCriterion(absent);
  if (cov) criteria.push(cov);

  // A not-measurable criterion cannot demonstrate readiness, so it does not pass.
  const verdict: "PASS" | "FAIL" = criteria.every((c) => c.measurable && c.passed) ? "PASS" : "FAIL";

  return {
    capability,
    verdict,
    criteria,
    metrics: {
      precision: null,
      recall: null,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 0,
      openP0,
      scenarioCount: rows.length,
      developmentPassRate: null,
      holdoutPassRate: null,
    },
    familyMetrics: {
      family: t.family,
      applyTotal: apply.length,
      applyPassed,
      refuseTotal: refuse.length,
      refusePassed,
      abstainTotal: abstain.length,
      abstainPassed,
      openP0,
      scenarioCount: rows.length,
    },
  };
}

/** Evaluate a scored run against the versioned gates config. */
export function evaluateReadiness(
  scored: ScoredRun[],
  gates: ReadinessGatesConfig,
  gatesPath: string = DEFAULT_GATES_PATH,
  absent: AbsentScenario[] = [],
): ReadinessEvaluation {
  // Attribute each absent gated scenario to the capability it would have fed, so
  // that capability reports the coverage hole and fails rather than scoring over
  // a partial set.
  const absentFettlerFlag = absent.filter(
    (a) => a.product === "fettler" && a.gt.correct_behavior === "flag_files",
  );
  const absentFettlerRestraint = absent.filter(
    (a) => a.product === "fettler" && FETTLER_RESTRAINT.has(a.gt.correct_behavior),
  );
  const absentRegaugeFamily = (family: string): AbsentScenario[] =>
    absent.filter(
      (a) => a.product === "regauge" && (a.gt.recipe_expectation?.family ?? "") === family,
    );

  const capabilities: CapabilityReadiness[] = [];
  for (const [name, thresholds] of Object.entries(gates.capabilities)) {
    if (isRegaugeFamily(thresholds)) {
      capabilities.push(
        evaluateRegaugeFamily(name, scored, thresholds, absentRegaugeFamily(thresholds.family)),
      );
    } else if (isFettlerAbstention(thresholds)) {
      capabilities.push(
        evaluateFettlerAbstention(name, scored, thresholds, absentFettlerRestraint),
      );
    } else if (name === "fettler-impact-analysis") {
      capabilities.push(evaluateFettlerImpact(scored, thresholds, absentFettlerFlag));
    }
    // An unknown capability name/shape is intentionally not scored rather than
    // scored with a placeholder that could read as a pass.
  }
  const overall: "PASS" | "FAIL" = capabilities.length > 0 && capabilities.every((c) => c.verdict === "PASS") ? "PASS" : "FAIL";
  return {
    policy: gates.policy,
    owner: gates.owner,
    decided_at: gates.decided_at,
    schema_version: gates.schema_version,
    gatesPath,
    overall,
    capabilities,
  };
}

/** Markdown block for the readiness section of the latest report. */
export function renderReadinessSection(ev: ReadinessEvaluation): string {
  const out: string[] = [];
  out.push(`## Readiness gates (spec §33.5 — versioned acceptance criteria)`);
  out.push("");
  out.push(
    `Policy: **${ev.policy}**, owner ${ev.owner}, decided ${ev.decided_at} (schema v${ev.schema_version}). Thresholds are read from \`${relPath(ev.gatesPath)}\`, not hard-coded here. A capability is design-partner ready only when it clears every criterion.`,
  );
  out.push("");
  out.push(`**Overall readiness: ${ev.overall}**`);
  out.push("");
  for (const cap of ev.capabilities) {
    out.push(`### ${cap.capability} — ${cap.verdict}`);
    out.push("");
    out.push(`| criterion | measured | threshold | verdict |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const c of cap.criteria) {
      const verdict = !c.measurable ? "NOT MEASURED" : c.passed ? "PASS" : "FAIL";
      out.push(`| ${c.name} | ${c.measured} | ${c.threshold} | ${verdict} |`);
    }
    out.push("");
  }
  return out.join("\n");
}

function relPath(abs: string): string {
  const idx = abs.replace(/\\/g, "/").lastIndexOf("/evals/");
  return idx >= 0 ? abs.replace(/\\/g, "/").slice(idx + 1) : abs;
}
