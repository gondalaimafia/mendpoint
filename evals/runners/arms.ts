/**
 * Representation experiment — N named arms with an explicit representation
 * dimension (spec §11.21, §18.6.1, §36.1).
 *
 * WHAT THIS GENERALIZES. `evals/runners/live-lane.ts` is already a paired
 * comparison on the SAME scenario, runner and grader — but its two arms are the
 * wrong independent variable: `deterministic` (model off) vs `live` (model on).
 * §11.21 asks for a different variable, held on the SAME task/model/harness:
 *
 *   A. raw retrieval           + Muse
 *   B. Change Graph projection + Muse
 *   C. Change Graph projection + Muse + independent verifier
 *
 * This module carries N NAMED arms instead of a hard-coded pair, and describes
 * each arm by two dimensions — its CONTEXT SOURCE (raw retrieval vs Change Graph
 * projection) and its MODEL/VERIFIER configuration — so A/B/C are three points in
 * that space and the existing deterministic/live pair is another. It reuses the
 * live-lane primitives unchanged (`LaneScore`, `microAverage`, the measured/
 * skipped honesty), so the model-off/model-on comparison keeps producing the
 * same numbers; `liveLaneAsArmSuite` expresses that pair as a two-arm suite and
 * `arms.test.ts` proves the numbers match.
 *
 * HONESTY (the reason this file exists). An arm that cannot run yet — arm B
 * (the projection is not wired into `packages/code-impact`) and arm C (the
 * independent verifier is not on main) — is a FIRST-CLASS DECLARED arm that
 * reports "not measured" with a stated reason. It never silently vanishes from
 * the report, and its absence is never averaged in as a zero or as a tie. A
 * measured arm's confusion counts are real; a not-measured arm contributes
 * nothing to any average. Efficiency (model calls / tokens / cost) is likewise
 * measured only when a model path actually ran: on the model-off arm those are
 * genuinely null and render "not measured", never zero.
 *
 * This module makes the experiment POSSIBLE. It does not run it: on main arms A,
 * B and C are all reported not-measured (arm A needs the live-model config; B and
 * C need code that is not here yet). Nothing in this file claims the thesis has
 * been tested.
 */
import type { LiveModelGradeResult } from "@mendpoint/eval/live-model";
import type { LaneScore, LiveScenarioResult, MicroAverage } from "./live-lane.js";
import { microAverage } from "./live-lane.js";
import {
  classifyTaskFamily,
  REPORTED_TASK_FAMILIES,
  type TaskFamily,
  type TaskFamilyClassification,
} from "./task-family.js";
import type { GroundTruth } from "../ground-truth/schema.js";

export const ARM_SUITE_REPORT_VERSION = "2026-08-18.v1" as const;

/** The context a reasoning pass is given: raw retrieval vs a graph projection. */
export type ContextSource = "raw-retrieval" | "change-graph-projection";

/** The reasoning/verification configuration layered on the context. */
export type ModelConfiguration =
  | "analysis-core" // model off — the deterministic analysis core alone
  | "muse" // Muse on, single pass
  | "muse-plus-verifier"; // Muse on + an independent verifier

/** One fully-described arm: a point in (context source × model configuration). */
export interface ArmDescriptor {
  /** Stable id, unique within a suite (e.g. "A", "B", "C", "det"). */
  id: string;
  /** Human-readable label for reports. */
  label: string;
  contextSource: ContextSource;
  modelConfiguration: ModelConfiguration;
}

/** The efficiency facet (spec §11.14). Measured only when a model path ran. */
export interface ArmEfficiency {
  /** false → the numbers below are null and render "not measured". */
  measured: boolean;
  modelCalls: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}

const NOT_MEASURED_EFFICIENCY: ArmEfficiency = Object.freeze({
  measured: false,
  modelCalls: null,
  totalTokens: null,
  costUsd: null,
});

/** One arm's outcome on one scenario: measured (with a score) or not. */
export interface ArmScenarioResult {
  status: "measured" | "not-measured";
  /** Present when not measured; states exactly why this arm did not run. */
  reason?: string;
  /** Retrieval facet (precision/recall/confusion), present only when measured. */
  score?: LaneScore;
  efficiency: ArmEfficiency;
  /** Present only when at least one model call fired on this arm/scenario. */
  provenanceGrade?: LiveModelGradeResult;
}

/**
 * The model-off arm's result: the retrieval facet IS measured (the analysis core
 * localized without a model), but the efficiency facet is not — no model ran, so
 * calls/tokens/cost are null, not zero.
 */
export function analysisCoreArmResult(score: LaneScore): ArmScenarioResult {
  return { status: "measured", score, efficiency: NOT_MEASURED_EFFICIENCY };
}

/** Adapt a live-lane per-scenario result (measured|skipped) to an arm result. */
export function liveResultAsArmResult(live: LiveScenarioResult): ArmScenarioResult {
  if (live.status === "skipped") {
    return { status: "not-measured", reason: live.reason ?? "not measured", efficiency: NOT_MEASURED_EFFICIENCY };
  }
  const result: ArmScenarioResult = {
    status: "measured",
    score: live.score,
    efficiency: {
      measured: true,
      modelCalls: live.modelCalls,
      totalTokens: live.totalTokens,
      costUsd: live.costUsd,
    },
  };
  if (live.provenanceGrade) result.provenanceGrade = live.provenanceGrade;
  return result;
}

/** A declared arm that did not run, for a stated reason. Never averaged in. */
export function notMeasuredArmResult(reason: string): ArmScenarioResult {
  return { status: "not-measured", reason, efficiency: NOT_MEASURED_EFFICIENCY };
}

/** One scenario evaluated across every declared arm, with its task family. */
export interface ScenarioArms {
  scenario_id: string;
  product: string;
  difficulty: number;
  correct_behavior: string;
  taskFamily: TaskFamilyClassification;
  /** Result per arm id. Every declared arm MUST have an entry (measured or not). */
  results: Record<string, ArmScenarioResult>;
}

/**
 * Build a `ScenarioArms` from ground truth plus a per-arm result map. The task
 * family is derived from the (answer-key-isolated) ground truth, never from the
 * repo under test.
 */
export function buildScenarioArms(
  gt: GroundTruth,
  scenario_id: string,
  product: string,
  results: Record<string, ArmScenarioResult>,
): ScenarioArms {
  return {
    scenario_id,
    product,
    difficulty: gt.difficulty,
    correct_behavior: gt.correct_behavior,
    taskFamily: classifyTaskFamily(gt),
    results,
  };
}

/** Per-(arm, family) aggregate. `not-measured` when the arm ran nowhere here. */
export interface ArmFamilyAggregate {
  arm: string;
  family: TaskFamily;
  status: "measured" | "not-measured";
  /** When not measured, the reason the arm gave (first stated reason wins). */
  reason?: string;
  /** Scenarios in this family (the denominator we could have measured over). */
  scenarios: number;
  /** How many of them this arm actually measured. */
  measured: number;
  /** Micro-averaged retrieval over the measured scenarios; null when none. */
  micro: MicroAverage | null;
  /** Efficiency totals over measured scenarios; null when no model ran. */
  totalModelCalls: number | null;
  totalTokens: number | null;
  totalCostUsd: number | null;
}

function aggregateArmFamily(
  arm: ArmDescriptor,
  family: TaskFamily,
  scenarios: readonly ScenarioArms[],
): ArmFamilyAggregate {
  const inFamily = scenarios.filter((s) => s.taskFamily.family === family);
  const results = inFamily.map((s) => s.results[arm.id]);
  const measuredScores: LaneScore[] = [];
  let firstReason: string | undefined;
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  let anyEfficiency = false;
  for (const r of results) {
    if (!r || r.status !== "measured") {
      if (r?.reason && firstReason === undefined) firstReason = r.reason;
      continue;
    }
    if (r.score) measuredScores.push(r.score);
    if (r.efficiency.measured) {
      anyEfficiency = true;
      calls += r.efficiency.modelCalls ?? 0;
      tokens += r.efficiency.totalTokens ?? 0;
      cost += r.efficiency.costUsd ?? 0;
    }
  }
  const measuredCount = results.filter((r) => r && r.status === "measured").length;
  const status: "measured" | "not-measured" = measuredCount > 0 ? "measured" : "not-measured";
  return {
    arm: arm.id,
    family,
    status,
    reason: status === "not-measured" ? firstReason : undefined,
    scenarios: inFamily.length,
    measured: measuredCount,
    micro: measuredScores.length > 0 ? microAverage(measuredScores) : null,
    totalModelCalls: anyEfficiency ? calls : null,
    totalTokens: anyEfficiency ? tokens : null,
    totalCostUsd: anyEfficiency ? cost : null,
  };
}

/** Paired micro-delta between two arms on one family (contrast minus base). */
export interface ArmPairedDelta {
  base: string;
  contrast: string;
  family: TaskFamily;
  /** true only when BOTH arms measured at least one shared scenario. */
  measurable: boolean;
  /** Scenarios in the family measured by BOTH arms (the paired denominator). */
  sharedScenarios: number;
  precision: number | null;
  recall: number | null;
  /** Findings the contrast arm added / removed vs the base, over shared scenarios. */
  findingsAddedTotal: number;
  findingsRemovedTotal: number;
  /** Contrast arm's total cost over shared scenarios; null when no model ran. */
  costUsd: number | null;
}

/**
 * Compare two arms on one family with the SAME paired-delta semantics the live
 * lane uses: delta is defined only over scenarios BOTH arms measured, and is null
 * when either side did not run. A not-measured arm yields a null, honest delta —
 * never a zero and never a tie.
 */
export function compareArms(
  scenarios: readonly ScenarioArms[],
  baseId: string,
  contrastId: string,
  family: TaskFamily,
): ArmPairedDelta {
  const shared = scenarios.filter(
    (s) =>
      s.taskFamily.family === family &&
      s.results[baseId]?.status === "measured" &&
      s.results[contrastId]?.status === "measured",
  );
  if (shared.length === 0) {
    return {
      base: baseId,
      contrast: contrastId,
      family,
      measurable: false,
      sharedScenarios: 0,
      precision: null,
      recall: null,
      findingsAddedTotal: 0,
      findingsRemovedTotal: 0,
      costUsd: null,
    };
  }
  const baseScores: LaneScore[] = [];
  const contrastScores: LaneScore[] = [];
  let added = 0;
  let removed = 0;
  let anyEfficiency = false;
  let cost = 0;
  for (const s of shared) {
    const base = s.results[baseId]!;
    const contrast = s.results[contrastId]!;
    if (base.score) baseScores.push(base.score);
    if (contrast.score) contrastScores.push(contrast.score);
    const baseFindings = new Set(base.score?.findings ?? []);
    const contrastFindings = new Set(contrast.score?.findings ?? []);
    added += [...contrastFindings].filter((f) => !baseFindings.has(f)).length;
    removed += [...baseFindings].filter((f) => !contrastFindings.has(f)).length;
    if (contrast.efficiency.measured) {
      anyEfficiency = true;
      cost += contrast.efficiency.costUsd ?? 0;
    }
  }
  const baseMicro = microAverage(baseScores);
  const contrastMicro = microAverage(contrastScores);
  return {
    base: baseId,
    contrast: contrastId,
    family,
    measurable: true,
    sharedScenarios: shared.length,
    precision:
      contrastMicro.precision !== null && baseMicro.precision !== null
        ? contrastMicro.precision - baseMicro.precision
        : null,
    recall:
      contrastMicro.recall !== null && baseMicro.recall !== null
        ? contrastMicro.recall - baseMicro.recall
        : null,
    findingsAddedTotal: added,
    findingsRemovedTotal: removed,
    costUsd: anyEfficiency ? cost : null,
  };
}

export interface ArmSuitePayload {
  version: typeof ARM_SUITE_REPORT_VERSION;
  generated: string;
  git_commit: string;
  arms: ArmDescriptor[];
  /** Every reported family × every declared arm — nothing omitted. */
  aggregates: ArmFamilyAggregate[];
  /** The scenarios that could not be placed on the axis, recorded honestly. */
  unclassified: { scenario_id: string; product: string; reason: string }[];
  scenarios: ScenarioArms[];
}

/**
 * Assemble the machine-readable payload. Every declared arm is crossed with
 * every REPORTED task family, so a declared-but-unavailable arm (B, C) appears
 * as an explicit not-measured aggregate per family rather than being dropped.
 */
export function buildArmSuitePayload(input: {
  gitCommit: string;
  arms: readonly ArmDescriptor[];
  scenarios: readonly ScenarioArms[];
}): ArmSuitePayload {
  const aggregates: ArmFamilyAggregate[] = [];
  for (const family of REPORTED_TASK_FAMILIES) {
    for (const arm of input.arms) {
      aggregates.push(aggregateArmFamily(arm, family, input.scenarios));
    }
  }
  const unclassified = input.scenarios
    .filter((s) => s.taskFamily.family === "unclassified")
    .map((s) => ({ scenario_id: s.scenario_id, product: s.product, reason: s.taskFamily.reason }));
  return {
    version: ARM_SUITE_REPORT_VERSION,
    generated: new Date().toISOString(),
    git_commit: input.gitCommit,
    arms: [...input.arms],
    aggregates,
    unclassified,
    scenarios: [...input.scenarios],
  };
}

/**
 * Canonical arms for the representation experiment. The model-off arm is the
 * existing deterministic lane's baseline; arm A is the existing live lane's arm
 * (raw retrieval + Muse). B and C add the Change Graph projection, and C adds the
 * independent verifier — the two arms that cannot run yet.
 */
export const ANALYSIS_CORE_ARM: ArmDescriptor = Object.freeze({
  id: "det",
  label: "raw retrieval + analysis core (Muse off)",
  contextSource: "raw-retrieval",
  modelConfiguration: "analysis-core",
});
export const ARM_A_RAW_MUSE: ArmDescriptor = Object.freeze({
  id: "A",
  label: "raw retrieval + Muse",
  contextSource: "raw-retrieval",
  modelConfiguration: "muse",
});
export const ARM_B_GRAPH_MUSE: ArmDescriptor = Object.freeze({
  id: "B",
  label: "Change Graph projection + Muse",
  contextSource: "change-graph-projection",
  modelConfiguration: "muse",
});
export const ARM_C_GRAPH_MUSE_VERIFIER: ArmDescriptor = Object.freeze({
  id: "C",
  label: "Change Graph projection + Muse + independent verifier",
  contextSource: "change-graph-projection",
  modelConfiguration: "muse-plus-verifier",
});

/** The full declared arm set for the §11.21 experiment, in report order. */
export const REPRESENTATION_ARMS: readonly ArmDescriptor[] = Object.freeze([
  ANALYSIS_CORE_ARM,
  ARM_A_RAW_MUSE,
  ARM_B_GRAPH_MUSE,
  ARM_C_GRAPH_MUSE_VERIFIER,
]);

/**
 * Express the existing deterministic/live pair as this space's two arms: the
 * model-off analysis core (`det`) and raw retrieval + Muse (`A`). This is the
 * non-lossy bridge proving the existing comparison is a special case of the
 * generalized arm set — `arms.test.ts` asserts the numbers match exactly.
 */
export function liveLaneArmOutcomes(
  det: LaneScore,
  live: LiveScenarioResult,
): Record<string, ArmScenarioResult> {
  return {
    [ANALYSIS_CORE_ARM.id]: analysisCoreArmResult(det),
    [ARM_A_RAW_MUSE.id]: liveResultAsArmResult(live),
  };
}

const pct = (n: number | null): string => (n === null ? "not measured" : `${(n * 100).toFixed(1)}%`);
const signedPct = (n: number | null): string =>
  n === null ? "not measured" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;
const num = (n: number | null): string => (n === null ? "not measured" : String(n));
const usd = (n: number | null): string => (n === null ? "not measured" : n.toFixed(6));

/**
 * Render the representation experiment report. Every declared arm is shown —
 * including the not-measured ones and the reason they did not run — and the two
 * task families are reported in SEPARATE tables, never pooled into one number.
 */
export function renderArmSuiteReport(payload: ArmSuitePayload): string {
  const out: string[] = [];
  out.push(`# Mendpoint representation experiment — N named arms (spec §11.21)`);
  out.push("");
  out.push(`- Generated: ${payload.generated}`);
  out.push(`- Git commit: \`${payload.git_commit}\``);
  out.push(`- Report version: ${payload.version}`);
  out.push("");
  out.push(
    `This report makes the controlled representation experiment POSSIBLE; it does not yet run it. On the same task, model and harness it holds one variable — the CONTEXT SOURCE (raw retrieval vs Change Graph projection) and the reasoning/verifier configuration — and reads graph-induced false positives and negatives straight out of each arm's confusion counts. A not-measured arm is shown, with its reason; it is never averaged in as a zero or a tie.`,
  );
  out.push("");

  out.push(`## Declared arms`);
  out.push("");
  out.push(`| arm | label | context source | model configuration |`);
  out.push(`| --- | --- | --- | --- |`);
  for (const a of payload.arms) {
    out.push(`| ${a.id} | ${a.label} | ${a.contextSource} | ${a.modelConfiguration} |`);
  }
  out.push("");

  for (const family of REPORTED_TASK_FAMILIES) {
    out.push(`## Task family: ${family}`);
    out.push("");
    const rows = payload.aggregates.filter((a) => a.family === family);
    const denom = rows[0]?.scenarios ?? 0;
    out.push(`Scenarios in this family: ${denom}. Reported separately from every other family — never pooled.`);
    out.push("");
    out.push(`| arm | status | measured | precision (micro) | recall (micro) | model calls | tokens | cost (USD) | reason |`);
    out.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
    for (const r of rows) {
      const status = r.status === "measured" ? "MEASURED" : "NOT MEASURED";
      out.push(
        `| ${r.arm} | ${status} | ${r.measured}/${r.scenarios} | ${pct(r.micro?.precision ?? null)} | ${pct(r.micro?.recall ?? null)} | ${num(r.totalModelCalls)} | ${num(r.totalTokens)} | ${usd(r.totalCostUsd)} | ${r.reason ?? ""} |`,
      );
    }
    out.push("");
  }

  out.push(`## Unclassified scenarios (not placed on the reference-vs-relationship axis)`);
  out.push("");
  if (payload.unclassified.length === 0) {
    out.push(`None — every scenario carried enough ground truth to place it in a family.`);
  } else {
    out.push(
      `These carry no importChain answer key or grade restraint/coverage rather than retrieval depth. They are recorded here and NEVER folded into either family's number.`,
    );
    out.push("");
    out.push(`| scenario | product | reason |`);
    out.push(`| --- | --- | --- |`);
    for (const u of payload.unclassified) {
      out.push(`| ${u.scenario_id} | ${u.product} | ${u.reason} |`);
    }
  }
  out.push("");

  out.push(`## What still blocks the unavailable arms`);
  out.push("");
  out.push(
    `- Arm A (raw retrieval + Muse) needs the live-model config (\`MENDPOINT_EVAL_LIVE=1\` plus the approved model/endpoint/key); on main it is not measured for the same reason the live lane is not.`,
  );
  out.push(
    `- Arm B (Change Graph projection + Muse) needs the projection wired into \`packages/code-impact\` (\`@mendpoint/graph-learn\` is not yet on the evaluated path); built concurrently.`,
  );
  out.push(
    `- Arm C (Change Graph projection + Muse + independent verifier) additionally needs \`packages/verifier\`, which is not on main yet.`,
  );
  out.push("");
  return out.join("\n") + "\n";
}
