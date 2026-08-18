/**
 * Phase 10/11 — live-model lane comparison.
 *
 * The deterministic runners measure MendPoint's analysis core with the model
 * switched OFF. This module runs the SAME scenarios with the model path switched
 * ON and reports the two lanes side by side, so the delta is the measurement:
 * what does the live model ADD (or cost) on identical scenarios? That delta is
 * the Muse baseline Phase 11 needs.
 *
 * Honesty rules encoded here:
 *  - The live lane is opt-in and, unless fully configured, is recorded as
 *    "skipped (not measured)" with a stated reason — never silently downgraded
 *    to the deterministic path and reported as live (see resolveLiveLaneConfig).
 *  - Provenance is captured from what actually answered on the wire; a run whose
 *    echoed model does not match the approved model FAILS the provenance grade
 *    rather than being accepted.
 *  - The deterministic lane here uses the unchanged runner and grader, so its
 *    numbers match the canonical `eval:synthetic` run.
 */
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import {
  gradeLiveModelProvenance,
  type LiveModelApprovedConfig,
  type LiveModelGradeResult,
} from "@mendpoint/eval/live-model";
import type { GroundTruth } from "../ground-truth/schema.js";
import { countFettlerFindings, gradeFettler } from "../graders/fettler-graders.js";
import type { RunRecord } from "./types.js";

export const LIVE_LANE_REPORT_VERSION = "2026-08-17.v1" as const;

/** One lane's graded outcome for a single scenario. */
export interface LaneScore {
  passed: boolean;
  /** Precision as the grader computed it (0..1), or null when undefined. */
  precision: number | null;
  recall: number | null;
  /** Confusion-matrix counts (micro-average building blocks). */
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  findings: string[];
  latency_ms: number;
}

/** The live lane's per-scenario result: either measured or skipped honestly. */
export interface LiveScenarioResult {
  status: "measured" | "skipped";
  /** Present when skipped; states exactly why the lane was not measured. */
  reason?: string;
  score?: LaneScore;
  /** Successful model calls observed during this scenario's analysis. */
  modelCalls: number;
  totalTokens: number;
  costUsd: number;
  /** Per-scenario provenance grade, present only when at least one call fired. */
  provenanceGrade?: LiveModelGradeResult;
}

export interface LaneDelta {
  /** live precision - deterministic precision; null when live not measured. */
  precision: number | null;
  recall: number | null;
  /** Files the live lane flagged that the deterministic lane did not. */
  findingsAdded: string[];
  /** Files the deterministic lane flagged that the live lane did not. */
  findingsRemoved: string[];
  latency_ms: number | null;
}

export interface LaneComparison {
  scenario_id: string;
  product: string;
  difficulty: number;
  repo_family: string;
  correct_behavior: string;
  deterministic: LaneScore;
  live: LiveScenarioResult;
  delta: LaneDelta;
}

/** Grade one run with the SAME Fettler grader both lanes use. */
export function scoreRun(record: RunRecord, gt: GroundTruth): LaneScore {
  const grade = gradeFettler(record.findings, gt);
  const counts = countFettlerFindings(record.findings, gt);
  const hasExpected = gt.expected_findings.length > 0;
  return {
    passed: grade.passed,
    precision: record.findings.length > 0 ? grade.precision : hasExpected ? grade.precision : null,
    recall: hasExpected ? grade.recall : null,
    truePositives: counts.expectedHits.length,
    falsePositives: counts.trapHits.length + counts.extras.length,
    falseNegatives: counts.missed.length,
    findings: [...record.findings],
    latency_ms: record.latency_ms,
  };
}

/**
 * Assemble the live-lane result for one scenario from the live run record and
 * the provenance captured during it. When at least one model call fired, the
 * provenance is graded against the approved identity (a mismatched echoed model
 * fails the grade). Zero calls is an honest, non-failing outcome (nothing at
 * medium confidence needed the model for this scenario).
 */
export function buildLiveResult(
  record: RunRecord,
  gt: GroundTruth,
  provenance: readonly LiveModelProvenanceRecord[],
  approved: LiveModelApprovedConfig,
): LiveScenarioResult {
  const score = scoreRun(record, gt);
  const totalTokens = provenance.reduce((sum, p) => sum + p.totalTokens, 0);
  const costUsd = provenance.reduce((sum, p) => sum + (p.costUsd ?? 0), 0);
  const result: LiveScenarioResult = {
    status: "measured",
    score,
    modelCalls: provenance.length,
    totalTokens,
    costUsd,
  };
  if (provenance.length > 0) {
    result.provenanceGrade = gradeLiveModelProvenance({
      approved,
      provenance,
      // Every confirmed site in this lane is a live-model decision.
      plannerSources: provenance.map(() => "model"),
      scriptedPlannerInjected: false,
    });
  }
  return result;
}

/** A live lane that was not measured for a stated reason. */
export function skippedLiveResult(reason: string): LiveScenarioResult {
  return { status: "skipped", reason, modelCalls: 0, totalTokens: 0, costUsd: 0 };
}

export function compareLanes(
  gt: GroundTruth,
  scenario_id: string,
  product: string,
  deterministic: LaneScore,
  live: LiveScenarioResult,
): LaneComparison {
  const measured = live.status === "measured" && live.score !== undefined;
  const liveFindings = new Set(live.score?.findings ?? []);
  const detFindings = new Set(deterministic.findings);
  const delta: LaneDelta = measured
    ? {
        precision:
          live.score!.precision !== null && deterministic.precision !== null
            ? live.score!.precision - deterministic.precision
            : null,
        recall:
          live.score!.recall !== null && deterministic.recall !== null
            ? live.score!.recall - deterministic.recall
            : null,
        findingsAdded: [...liveFindings].filter((f) => !detFindings.has(f)).sort(),
        findingsRemoved: [...detFindings].filter((f) => !liveFindings.has(f)).sort(),
        latency_ms: live.score!.latency_ms - deterministic.latency_ms,
      }
    : { precision: null, recall: null, findingsAdded: [], findingsRemoved: [], latency_ms: null };
  return {
    scenario_id,
    product,
    difficulty: gt.difficulty,
    repo_family: gt.repo_family,
    correct_behavior: gt.correct_behavior,
    deterministic,
    live,
    delta,
  };
}

export interface MicroAverage {
  precision: number | null;
  recall: number | null;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}

/** Micro-averaged precision/recall over a set of lane scores. */
export function microAverage(scores: readonly LaneScore[]): MicroAverage {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of scores) {
    tp += s.truePositives;
    fp += s.falsePositives;
    fn += s.falseNegatives;
  }
  return {
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
  };
}

export interface LiveLanePayload {
  version: typeof LIVE_LANE_REPORT_VERSION;
  generated: string;
  git_commit: string;
  live_requested: boolean;
  lane_status: "ready" | "skipped";
  /** Present when the lane was not run; states exactly why. */
  skip_reason?: string;
  approved?: LiveModelApprovedConfig;
  /** Corpus scenarios excluded from the live lane (e.g. budgeted scale runs). */
  excluded: { scenario_id: string; reason: string }[];
  aggregate: {
    totalModelCalls: number;
    totalTokens: number;
    totalCostUsd: number;
    /** Union provenance grade over every live call; present when calls fired. */
    provenanceGrade?: LiveModelGradeResult;
  };
  summary: {
    deterministic: { scenarios: number; passed: number; precisionMicro: number | null; recallMicro: number | null };
    live:
      | { scenarios: number; measured: number; passed: number; precisionMicro: number | null; recallMicro: number | null }
      | null;
    delta: { precision: number | null; recall: number | null; findingsAddedTotal: number; findingsRemovedTotal: number; costUsd: number } | null;
  };
  scenarios: LaneComparison[];
}

/**
 * Assemble the machine-readable payload. `laneStatus` is "ready" only when the
 * live lane actually ran; otherwise it is "skipped" and every scenario's live
 * result carries the same not-measured reason.
 */
export function buildLiveLanePayload(input: {
  gitCommit: string;
  liveRequested: boolean;
  laneStatus: "ready" | "skipped";
  skipReason?: string;
  approved?: LiveModelApprovedConfig;
  excluded: { scenario_id: string; reason: string }[];
  comparisons: LaneComparison[];
  provenance: readonly LiveModelProvenanceRecord[];
}): LiveLanePayload {
  const { comparisons } = input;
  const detScores = comparisons.map((c) => c.deterministic);
  const measuredLive = comparisons.filter((c) => c.live.status === "measured" && c.live.score);
  const liveScores = measuredLive.map((c) => c.live.score!);

  const detMicro = microAverage(detScores);
  const liveMicro = microAverage(liveScores);

  const totalModelCalls = comparisons.reduce((s, c) => s + c.live.modelCalls, 0);
  const totalTokens = comparisons.reduce((s, c) => s + c.live.totalTokens, 0);
  const totalCostUsd = comparisons.reduce((s, c) => s + c.live.costUsd, 0);

  const aggregate: LiveLanePayload["aggregate"] = { totalModelCalls, totalTokens, totalCostUsd };
  if (input.provenance.length > 0 && input.approved) {
    aggregate.provenanceGrade = gradeLiveModelProvenance({
      approved: input.approved,
      provenance: input.provenance,
      plannerSources: input.provenance.map(() => "model"),
      scriptedPlannerInjected: false,
    });
  }

  const liveSummary =
    input.laneStatus === "ready"
      ? {
          scenarios: comparisons.length,
          measured: measuredLive.length,
          passed: measuredLive.filter((c) => c.live.score!.passed).length,
          precisionMicro: liveMicro.precision,
          recallMicro: liveMicro.recall,
        }
      : null;

  const delta =
    input.laneStatus === "ready"
      ? {
          precision:
            liveMicro.precision !== null && detMicro.precision !== null
              ? liveMicro.precision - detMicro.precision
              : null,
          recall:
            liveMicro.recall !== null && detMicro.recall !== null
              ? liveMicro.recall - detMicro.recall
              : null,
          findingsAddedTotal: comparisons.reduce((s, c) => s + c.delta.findingsAdded.length, 0),
          findingsRemovedTotal: comparisons.reduce((s, c) => s + c.delta.findingsRemoved.length, 0),
          costUsd: totalCostUsd,
        }
      : null;

  const payload: LiveLanePayload = {
    version: LIVE_LANE_REPORT_VERSION,
    generated: new Date().toISOString(),
    git_commit: input.gitCommit,
    live_requested: input.liveRequested,
    lane_status: input.laneStatus,
    excluded: input.excluded,
    aggregate,
    summary: {
      deterministic: {
        scenarios: comparisons.length,
        passed: detScores.filter((s) => s.passed).length,
        precisionMicro: detMicro.precision,
        recallMicro: detMicro.recall,
      },
      live: liveSummary,
      delta,
    },
    scenarios: comparisons,
  };
  if (input.skipReason) payload.skip_reason = input.skipReason;
  if (input.approved) payload.approved = input.approved;
  return payload;
}

const pct = (n: number | null): string => (n === null ? "n/a" : `${(n * 100).toFixed(1)}%`);
const signedPct = (n: number | null): string =>
  n === null ? "n/a" : `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}pp`;

/** Render the side-by-side report. Never reports green for a lane that did not run. */
export function renderLiveLaneReport(payload: LiveLanePayload): string {
  const out: string[] = [];
  out.push(`# MendPoint live-model lane — deterministic vs deterministic+model`);
  out.push("");
  out.push(`- Generated: ${payload.generated}`);
  out.push(`- Git commit: \`${payload.git_commit}\``);
  out.push(`- Report version: ${payload.version}`);
  out.push(`- Live lane requested: ${payload.live_requested ? "yes" : "no"}`);
  out.push(`- Live lane status: **${payload.lane_status === "ready" ? "MEASURED" : "NOT MEASURED"}**`);
  if (payload.lane_status === "skipped") {
    out.push(`- Reason the live lane was not measured: ${payload.skip_reason ?? "unspecified"}`);
  }
  if (payload.approved) {
    out.push(`- Approved identity: model \`${payload.approved.model}\` @ host \`${payload.approved.host}\``);
  }
  out.push("");
  out.push(
    `The ONLY variable between lanes is whether the model path runs (\`useLlm\`). Same scenarios, same staging (answer keys stripped), same index, same grader. The delta is the model's contribution — and its cost — on identical inputs.`,
  );
  out.push("");

  out.push(`## Summary`);
  out.push("");
  out.push(`| lane | scenarios | passed | precision (micro) | recall (micro) | model calls | cost (USD) |`);
  out.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  const d = payload.summary.deterministic;
  out.push(`| deterministic | ${d.scenarios} | ${d.passed} | ${pct(d.precisionMicro)} | ${pct(d.recallMicro)} | 0 | 0 |`);
  if (payload.summary.live) {
    const l = payload.summary.live;
    out.push(
      `| deterministic + model | ${l.scenarios} | ${l.passed} | ${pct(l.precisionMicro)} | ${pct(l.recallMicro)} | ${payload.aggregate.totalModelCalls} | ${payload.aggregate.totalCostUsd.toFixed(6)} |`,
    );
  } else {
    out.push(`| deterministic + model | not measured | not measured | not measured | not measured | 0 | 0 |`);
  }
  out.push("");
  if (payload.summary.delta) {
    out.push(
      `**Model delta (the Muse baseline):** precision ${signedPct(payload.summary.delta.precision)}, recall ${signedPct(payload.summary.delta.recall)}; ${payload.summary.delta.findingsAddedTotal} finding(s) added, ${payload.summary.delta.findingsRemovedTotal} removed; total cost ${payload.summary.delta.costUsd.toFixed(6)} USD over ${payload.aggregate.totalModelCalls} call(s).`,
    );
  } else {
    out.push(
      `**Model delta (the Muse baseline): NOT MEASURED.** The live lane did not run, so there is no live number to compare. This is not a pass and not a fail — it is unmeasured. ${payload.skip_reason ?? ""}`,
    );
  }
  out.push("");

  out.push(`## Provenance (what actually answered)`);
  out.push("");
  if (payload.aggregate.provenanceGrade) {
    const g = payload.aggregate.provenanceGrade;
    out.push(`Union grade over ${payload.aggregate.totalModelCalls} live call(s): **${g.passed ? "PASS" : "FAIL"}** (version ${g.version}).`);
    out.push("");
    out.push(`| check | passed | expected | observed |`);
    out.push(`| --- | --- | --- | --- |`);
    for (const gr of g.grades) {
      out.push(`| ${gr.id} | ${gr.passed ? "yes" : "NO"} | ${gr.expected} | ${gr.observed} |`);
    }
  } else if (payload.lane_status === "ready") {
    out.push(`No live model calls fired (every scenario resolved at high confidence without the model). Provenance grade is not applicable; the model added nothing on these scenarios.`);
  } else {
    out.push(`No provenance: the live lane was not measured.`);
  }
  out.push("");

  out.push(`## Per-scenario (deterministic vs deterministic + model)`);
  out.push("");
  out.push(`| scenario | L | behavior | det recall | det prec | live recall | live prec | Δrecall | Δprec | calls | cost |`);
  out.push(`| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const c of payload.scenarios) {
    const det = c.deterministic;
    const live = c.live;
    const liveRecall = live.status === "measured" ? pct(live.score!.recall) : "not meas.";
    const livePrec = live.status === "measured" ? pct(live.score!.precision) : "not meas.";
    out.push(
      `| ${c.scenario_id} | ${c.difficulty} | ${c.correct_behavior} | ${pct(det.recall)} | ${pct(det.precision)} | ${liveRecall} | ${livePrec} | ${signedPct(c.delta.recall)} | ${signedPct(c.delta.precision)} | ${live.modelCalls} | ${live.costUsd.toFixed(6)} |`,
    );
  }
  out.push("");
  if (payload.excluded.length > 0) {
    out.push(`### Excluded from the live lane`);
    out.push("");
    for (const e of payload.excluded) {
      out.push(`- ${e.scenario_id} — ${e.reason}`);
    }
    out.push("");
  }

  out.push(`## What an operator must set to produce a real Muse baseline`);
  out.push("");
  out.push(`- \`MENDPOINT_EVAL_LIVE=1\` (or \`--live\`) to request the lane.`);
  out.push(`- \`LLM_CONFIRM_MODE=live\` (or \`LLM_CONFIRM=1\`) to arm the impact-confirm model path.`);
  out.push(`- \`OPENAI_API_KEY\` (or \`XAI_API_KEY\`) — the gateway key; refer to it by name only.`);
  out.push(`- \`OPENAI_API_BASE\` — the approved gateway base URL.`);
  out.push(`- \`LLM_CONFIRM_MODEL\` — the requested model, e.g. \`muse-spark-1.2-contributor\`.`);
  out.push(`- \`MENDPOINT_LIVE_APPROVED_HOST\` — the endpoint host the provenance must match.`);
  out.push(`- \`MENDPOINT_LIVE_APPROVED_MODEL\` — the approved echoed model (defaults to \`muse-spark-1.2-contributor\`).`);
  out.push("");
  out.push(`ReGauge has no live lane here: its analyze-only runner exercises no model path (the adaptive-repair loop requires apply + verification sandbox, which this harness does not run).`);
  out.push("");
  return out.join("\n") + "\n";
}
