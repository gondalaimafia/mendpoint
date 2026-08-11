/**
 * Wave 3b — per-outcome customer metrics.
 *
 * Computes tenant-scoped, time-windowed customer-facing outcome metrics from
 * data we already record: `agent_runs` (status + lifecycle timestamps +
 * review result) and `routing_ledger` (measured cost/tokens per run, linked by
 * routing_ledger.run_id = agent_runs.id).
 *
 * Honesty contract:
 *  - Only real recorded data is used.
 *  - Where a metric cannot be computed truthfully it returns `value: null` with
 *    a `basis` label and a `reason`, never a fabricated number.
 *  - `basis` is one of "measured" (computed directly from recorded outcomes),
 *    "proxy" (a defensible stand-in, explicitly labeled), or "unavailable"
 *    (no faithful signal exists yet).
 */
import type { AppDb } from "./index.js";
import { getExternalBaselineReference, type ExternalBaselineReference } from "./external-baseline.js";

export type MetricBasis = "measured" | "proxy" | "unavailable";

export type RateMetric = Readonly<{
  value: number | null;
  numerator: number;
  denominator: number;
  basis: MetricBasis;
  reason?: string;
}>;

export type EscapedRegressionMetric = Readonly<{
  value: null;
  basis: "unavailable";
  reason: string;
  /** Closest recorded quality signal, explicitly labeled as NOT an escape measure. */
  nearestProxy: RateMetric & Readonly<{ name: string; note: string }>;
}>;

export type CostPerAcceptedMetric = Readonly<{
  value: number | null;
  currency: "USD";
  acceptedCount: number;
  measuredAcceptedCount: number;
  totalMeasuredCostUsd: number | null;
  basis: "measured";
  reason?: string;
  note?: string;
}>;

export type TimeToCandidateMetric = Readonly<{
  p50Ms: number | null;
  p95Ms: number | null;
  sampleSize: number;
  excludedReviewedRuns: number;
  basis: "measured";
  reason?: string;
  note: string;
}>;

export type OutcomeMetrics = Readonly<{
  tenantId: string;
  window: Readonly<{ since: string | null; until: string | null }>;
  totalRuns: number;
  candidateProducingRuns: number;
  acceptedCandidates: number;
  acceptedCandidateRate: RateMetric;
  escapedRegressionRate: EscapedRegressionMetric;
  humanInterventionRate: RateMetric;
  costPerAcceptedPr: CostPerAcceptedMetric;
  timeToCandidate: TimeToCandidateMetric;
  externalBaseline: ExternalBaselineReference;
  computedAt: string;
}>;

/**
 * Statuses that mean a reviewable candidate was produced. Every one of these
 * required (or awaits) a human review decision.
 */
const CANDIDATE_PRODUCING = new Set([
  "candidate_ready",
  "candidate_approved",
  "candidate_rejected",
  "candidate_superseded",
]);
const ACCEPTED_STATUS = "candidate_approved";
const REJECTED_STATUS = "candidate_rejected";
/** Statuses that required a human action (review of a candidate or escalation). */
const HUMAN_REVIEW = new Set([
  "candidate_ready",
  "candidate_approved",
  "candidate_rejected",
  "candidate_superseded",
  "needs_human",
]);

type RunRow = {
  id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
  measured_cost_usd: number | null;
  measured_rows: number | null;
};

function isoOrNull(name: string, value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

/** Linear-interpolation percentile over an ascending-sorted numeric array. */
function percentile(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  if (n === 1) return sortedAsc[0]!;
  const rank = p * (n - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAsc[low]!;
  const weight = rank - low;
  return Math.round(sortedAsc[low]! * (1 - weight) + sortedAsc[high]! * weight);
}

function rate(numerator: number, denominator: number, emptyReason: string): RateMetric {
  if (denominator === 0) {
    return Object.freeze({ value: null, numerator, denominator, basis: "measured", reason: emptyReason });
  }
  return Object.freeze({ value: numerator / denominator, numerator, denominator, basis: "measured" });
}

export function computeOutcomeMetrics(
  db: AppDb,
  input: { tenantId: string; since?: string | null; until?: string | null },
): OutcomeMetrics {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("tenant_id_invalid");
  const since = isoOrNull("outcome_since", input.since);
  const until = isoOrNull("outcome_until", input.until);
  if (since !== null && until !== null && Date.parse(until) <= Date.parse(since)) {
    throw new Error("outcome_window_invalid");
  }

  const params: (string | number)[] = [tenantId, tenantId];
  let windowClause = "";
  if (since !== null) {
    windowClause += " AND r.created_at >= ?";
    params.push(since);
  }
  if (until !== null) {
    windowClause += " AND r.created_at < ?";
    params.push(until);
  }

  const runs = db.raw
    .prepare(
      `SELECT r.id, r.status, r.created_at, r.finished_at,
              ledger.measured_cost_usd AS measured_cost_usd,
              ledger.measured_rows AS measured_rows
       FROM agent_runs r
       LEFT JOIN (
         SELECT run_id,
                SUM(cost_usd) AS measured_cost_usd,
                SUM(CASE WHEN cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS measured_rows
         FROM routing_ledger
         WHERE tenant_id = ? AND run_id IS NOT NULL
         GROUP BY run_id
       ) ledger ON ledger.run_id = r.id
       WHERE r.tenant_id = ?${windowClause}
       ORDER BY r.created_at`,
    )
    .all(...params) as RunRow[];

  let candidateProducing = 0;
  let accepted = 0;
  let rejected = 0;
  let humanReview = 0;
  let measuredAccepted = 0;
  let measuredCostSum = 0;
  const timeToCandidateMs: number[] = [];
  let excludedReviewedRuns = 0;

  for (const run of runs) {
    const producing = CANDIDATE_PRODUCING.has(run.status);
    if (producing) candidateProducing += 1;
    if (run.status === ACCEPTED_STATUS) {
      accepted += 1;
      if ((run.measured_rows ?? 0) > 0 && run.measured_cost_usd !== null) {
        measuredAccepted += 1;
        measuredCostSum += run.measured_cost_usd;
      }
    }
    if (run.status === REJECTED_STATUS) rejected += 1;
    if (HUMAN_REVIEW.has(run.status)) humanReview += 1;

    // Time-to-candidate is truthful only for runs still awaiting review:
    // finished_at is genuinely the candidate-ready moment there. Once a
    // candidate is reviewed, the review action overwrites finished_at with the
    // review timestamp, so those runs are excluded rather than inflate latency.
    if (run.status === "candidate_ready") {
      if (run.finished_at) {
        const ms = Date.parse(run.finished_at) - Date.parse(run.created_at);
        if (Number.isFinite(ms) && ms >= 0) timeToCandidateMs.push(ms);
      }
    } else if (producing) {
      excludedReviewedRuns += 1;
    }
  }

  const acceptedCandidateRate = rate(
    accepted,
    candidateProducing,
    "no candidate-producing runs in window",
  );

  const escapedRegressionRate: EscapedRegressionMetric = Object.freeze({
    value: null,
    basis: "unavailable",
    reason:
      "No post-delivery regression or revert signal is recorded yet. Every " +
      "current judge (repair + regression) gates a candidate BEFORE delivery, " +
      "so recorded data cannot show a regression that escaped to the customer. " +
      "This requires a delivered-candidate follow-up verification/revert signal " +
      "that does not exist in agent_runs or routing_ledger today.",
    nearestProxy: Object.freeze({
      name: "reviewRejectionRate",
      value: candidateProducing === 0 ? null : rejected / candidateProducing,
      numerator: rejected,
      denominator: candidateProducing,
      basis: "proxy",
      ...(candidateProducing === 0 ? { reason: "no candidate-producing runs in window" } : {}),
      note:
        "Share of candidate-producing runs a reviewer rejected. These were " +
        "caught pre-delivery, NOT escaped regressions; shown only as the " +
        "nearest recorded quality signal.",
    }),
  });

  const humanInterventionRate = rate(humanReview, runs.length, "no runs in window");

  const costPerAcceptedPr = buildCostMetric(accepted, measuredAccepted, measuredCostSum);

  const timeToCandidate = buildTimeToCandidate(timeToCandidateMs, excludedReviewedRuns);

  return Object.freeze({
    tenantId,
    window: Object.freeze({ since, until }),
    totalRuns: runs.length,
    candidateProducingRuns: candidateProducing,
    acceptedCandidates: accepted,
    acceptedCandidateRate,
    escapedRegressionRate,
    humanInterventionRate,
    costPerAcceptedPr,
    timeToCandidate,
    externalBaseline: getExternalBaselineReference(),
    computedAt: new Date().toISOString(),
  });
}

function buildCostMetric(
  acceptedCount: number,
  measuredAcceptedCount: number,
  measuredCostSum: number,
): CostPerAcceptedMetric {
  if (acceptedCount === 0) {
    return Object.freeze({
      value: null,
      currency: "USD",
      acceptedCount,
      measuredAcceptedCount: 0,
      totalMeasuredCostUsd: null,
      basis: "measured",
      reason: "no accepted candidates in window",
    });
  }
  if (measuredAcceptedCount === 0) {
    return Object.freeze({
      value: null,
      currency: "USD",
      acceptedCount,
      measuredAcceptedCount: 0,
      totalMeasuredCostUsd: null,
      basis: "measured",
      reason: "cost was not measured for any accepted candidate in window",
    });
  }
  const base = {
    value: measuredCostSum / measuredAcceptedCount,
    currency: "USD" as const,
    acceptedCount,
    measuredAcceptedCount,
    totalMeasuredCostUsd: measuredCostSum,
    basis: "measured" as const,
  };
  if (measuredAcceptedCount < acceptedCount) {
    return Object.freeze({
      ...base,
      note:
        `Averaged over the ${measuredAcceptedCount} of ${acceptedCount} accepted ` +
        "candidates with measured cost; runs with unmeasured cost are excluded " +
        "rather than counted as zero.",
    });
  }
  return Object.freeze(base);
}

function buildTimeToCandidate(samplesMs: number[], excludedReviewedRuns: number): TimeToCandidateMetric {
  const note =
    "created_at to candidate-ready, over runs still awaiting review " +
    "(status candidate_ready), where finished_at is genuinely the " +
    "candidate-ready timestamp. Reviewed candidates are excluded because the " +
    "review action overwrites finished_at with the review time.";
  if (samplesMs.length === 0) {
    return Object.freeze({
      p50Ms: null,
      p95Ms: null,
      sampleSize: 0,
      excludedReviewedRuns,
      basis: "measured",
      reason: "no runs awaiting review in window",
      note,
    });
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return Object.freeze({
    p50Ms: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    sampleSize: sorted.length,
    excludedReviewedRuns,
    basis: "measured",
    note,
  });
}
