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

export interface CapabilityThresholds {
  description?: string;
  impact_precision_min: number;
  impact_recall_min: number;
  max_open_p0: number;
  holdout_dev_gap_max_pp: number;
}

export interface ReadinessGatesConfig {
  schema_version: number;
  policy: string;
  owner: string;
  decided_at: string;
  notes?: string;
  capabilities: Record<string, CapabilityThresholds>;
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
  for (const [name, t] of Object.entries(cfg.capabilities)) {
    for (const k of ["impact_precision_min", "impact_recall_min", "max_open_p0", "holdout_dev_gap_max_pp"] as const) {
      if (typeof t[k] !== "number") {
        throw new Error(`readiness-gates: capability ${name}.${k} must be a number`);
      }
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
  t: CapabilityThresholds,
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
      passed: gapPp !== null && gapPp <= t.holdout_dev_gap_max_pp,
      measured:
        gapPp !== null
          ? `${gapPp >= 0 ? "" : "+"}${(-gapPp).toFixed(1)}pp vs dev`
          : "not measured (no holdout or no development scenarios)",
      threshold: `holdout within ${t.holdout_dev_gap_max_pp}pp of development`,
      detail:
        dev !== null && holdout !== null
          ? `development pass ${asPct(dev)}, holdout pass ${asPct(holdout)}`
          : "requires both a development and a holdout split",
    },
  ];

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

/** Evaluate a scored run against the versioned gates config. */
export function evaluateReadiness(
  scored: ScoredRun[],
  gates: ReadinessGatesConfig,
  gatesPath: string = DEFAULT_GATES_PATH,
): ReadinessEvaluation {
  const capabilities: CapabilityReadiness[] = [];
  for (const [name, thresholds] of Object.entries(gates.capabilities)) {
    if (name === "fettler-impact-analysis") {
      capabilities.push(evaluateFettlerImpact(scored, thresholds));
    }
    // Additional capabilities gain their own evaluator here as thresholds are
    // authored for them; an unknown capability name is intentionally not scored
    // rather than scored with a placeholder that could read as a pass.
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
