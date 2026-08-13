/**
 * S3 — optional developer-satisfaction capture.
 *
 * There is no pre-existing satisfaction signal anywhere in the schema, so the
 * self-serve dashboard would otherwise have to omit the dimension. Rather than
 * fabricate a number, this module adds a minimal, OPTIONAL capture surface: a
 * developer can attach a 1-5 rating (and optional comment) to a reviewed run or
 * PR. The dashboard then summarizes ONLY real submitted rows; when none exist
 * the metric is honestly "unavailable" (never a zeroed or invented score).
 *
 * Tenant-scoped throughout. Ratings are constrained to 1-5 by both this module
 * and the table CHECK, so an out-of-range value can never reach the aggregate.
 */
import type { AppDb } from "./index.js";

export const SATISFACTION_SCALE = "1-5" as const;
/** Ratings at or above this are counted as positive (thumbs-up) sentiment. */
export const SATISFACTION_POSITIVE_MIN = 4;
/** Ratings at or below this are counted as negative (thumbs-down) sentiment. */
export const SATISFACTION_NEGATIVE_MAX = 2;

export type DeveloperSatisfactionSignal = Readonly<{
  id: string;
  tenantId: string;
  runId: string | null;
  prId: string | null;
  rating: number;
  comment: string | null;
  submittedBy: string | null;
  createdAt: string;
}>;

export type SatisfactionSummary = Readonly<{
  responses: number;
  averageRating: number | null;
  positive: number;
  negative: number;
  neutral: number;
  scale: typeof SATISFACTION_SCALE;
  basis: "measured" | "unavailable";
  reason?: string;
}>;

type SignalRow = {
  id: string;
  tenant_id: string;
  run_id: string | null;
  pr_id: string | null;
  rating: number;
  comment: string | null;
  submitted_by: string | null;
  created_at: string;
};

function signalFromRow(row: SignalRow): DeveloperSatisfactionSignal {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    prId: row.pr_id,
    rating: row.rating,
    comment: row.comment,
    submittedBy: row.submitted_by,
    createdAt: row.created_at,
  });
}

/**
 * Record one optional satisfaction signal for a tenant. Rating must be an
 * integer 1-5; anything else is rejected rather than clamped so a bad value
 * never silently distorts the aggregate.
 */
export function recordDeveloperSatisfaction(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    rating: number;
    runId?: string | null;
    prId?: string | null;
    comment?: string | null;
    submittedBy?: string | null;
    createdAt: string;
  },
): DeveloperSatisfactionSignal {
  const id = input.id.trim();
  const tenantId = input.tenantId.trim();
  if (!id) throw new Error("developer_satisfaction_id_invalid");
  if (!tenantId) throw new Error("developer_satisfaction_tenant_invalid");
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    throw new Error("developer_satisfaction_rating_invalid");
  }
  if (!Number.isFinite(Date.parse(input.createdAt))) {
    throw new Error("developer_satisfaction_created_at_invalid");
  }
  const comment = input.comment?.trim() ? input.comment.trim().slice(0, 2000) : null;

  db.raw
    .prepare(
      `INSERT INTO developer_satisfaction_signals
        (id, tenant_id, run_id, pr_id, rating, comment, submitted_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      tenantId,
      input.runId ?? null,
      input.prId ?? null,
      input.rating,
      comment,
      input.submittedBy ?? null,
      input.createdAt,
    );

  return signalFromRow(
    db.raw
      .prepare(`SELECT * FROM developer_satisfaction_signals WHERE id = ? AND tenant_id = ?`)
      .get(id, tenantId) as SignalRow,
  );
}

export function listDeveloperSatisfaction(
  db: AppDb,
  tenantId: string,
  limit = 100,
): DeveloperSatisfactionSignal[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 1_000));
  return (
    db.raw
      .prepare(
        `SELECT * FROM developer_satisfaction_signals
         WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(tenantId, bounded) as SignalRow[]
  ).map(signalFromRow);
}

/**
 * Summarize satisfaction over a tenant's real signals in an optional window.
 * Returns basis "unavailable" (never a zero score) when the tenant has captured
 * no signals, so the dashboard can show "not yet captured" honestly.
 */
export function summarizeDeveloperSatisfaction(
  db: AppDb,
  input: { tenantId: string; since?: string | null; until?: string | null },
): SatisfactionSummary {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("developer_satisfaction_tenant_invalid");
  // Bind order mirrors the placeholder order in the SQL below:
  // positive-threshold, negative-threshold, tenant, then optional window bounds.
  const params: (string | number)[] = [
    SATISFACTION_POSITIVE_MIN,
    SATISFACTION_NEGATIVE_MAX,
    tenantId,
  ];
  let windowClause = "";
  if (input.since !== null && input.since !== undefined) {
    windowClause += " AND created_at >= ?";
    params.push(input.since);
  }
  if (input.until !== null && input.until !== undefined) {
    windowClause += " AND created_at < ?";
    params.push(input.until);
  }
  const row = db.raw
    .prepare(
      `SELECT
         COUNT(*) AS responses,
         AVG(rating) AS average_rating,
         SUM(CASE WHEN rating >= ? THEN 1 ELSE 0 END) AS positive,
         SUM(CASE WHEN rating <= ? THEN 1 ELSE 0 END) AS negative
       FROM developer_satisfaction_signals
       WHERE tenant_id = ?${windowClause}`,
    )
    .get(...params) as {
    responses: number;
    average_rating: number | null;
    positive: number | null;
    negative: number | null;
  };

  const responses = row.responses ?? 0;
  if (responses === 0) {
    return Object.freeze({
      responses: 0,
      averageRating: null,
      positive: 0,
      negative: 0,
      neutral: 0,
      scale: SATISFACTION_SCALE,
      basis: "unavailable",
      reason:
        "No developer-satisfaction signals captured for this tenant in the window. " +
        "Satisfaction is measured only from explicitly submitted ratings, never inferred.",
    });
  }
  const positive = row.positive ?? 0;
  const negative = row.negative ?? 0;
  return Object.freeze({
    responses,
    averageRating: row.average_rating,
    positive,
    negative,
    neutral: responses - positive - negative,
    scale: SATISFACTION_SCALE,
    basis: "measured",
  });
}
