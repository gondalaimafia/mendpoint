/**
 * Retrieval context-gap sink.
 *
 * The lesson pipeline can attribute a failed run to `retrieval` — spec 17.4.2:
 * objective verification `failed` AND the run's captured trajectory confirmed the
 * context the model needed was `recorded_absent` (see `deriveOutcomeAttribution`
 * in `apps/worker/src/outcome-attribution.ts`). Historically that lesson was
 * classified to the `retrieval` destination and then consumed by nothing: the
 * pipeline's dominant defect shape, where "we did not act on this" reads as
 * "there was nothing to act on."
 *
 * This module is the consumer that closes that drop. `recordRetrievalContextGap`
 * persists one row per admitted retrieval-attributed lesson (called inside the
 * admission transaction in `packages/pipeline` so the gap is captured atomically
 * with the learning record), and `computeRetrievalContextGaps` reads the rows back
 * into an operator-facing summary: how often required context was confirmed absent,
 * and for what (capability, migration family, product). The read path is wired to
 * the `/metrics/outcomes/retrieval-gaps` surface, so the destination genuinely
 * reaches a sink rather than moving the drop one storage layer down.
 *
 * Dormant in production today: both governed-learning producers pass
 * `not_verified` at their verification seam, so `deriveOutcomeAttribution` returns
 * `none` and no lesson is attributed `retrieval` yet (see
 * docs/learning/LESSON_DESTINATION_ROUTING.md Count 2). This is live code with a
 * real read path that receives nothing until producers can observe a genuine
 * verification failure and admit non-merged outcomes; the sink is ready for that
 * moment rather than being retrofitted after it.
 *
 * Honesty contract: every row means required context was CONFIRMED absent, never
 * merely "not observed" — the `retrieval` attribution is only derived from the
 * `recorded_absent` trajectory state, never from the undetermined `unrecorded`
 * one. So a count here is a count of proven gaps, not of unknowns.
 */
import type { AppDb } from "./index.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type RetrievalContextGapProduct = "fettler" | "regauge";

export type RetrievalContextGapInput = Readonly<{
  /** The admitted lesson's `learning_record_id`; the row is keyed 1:1 on it. */
  learningRecordId: string;
  tenantId: string;
  eventId: string;
  eventDigest: string;
  product: RetrievalContextGapProduct;
  capability: string;
  taskType: string;
  migrationFamily: string;
  repositoryId: string;
  observedAt: string;
  createdAt: string;
}>;

export type RetrievalContextGapRecord = Readonly<{
  id: string;
  tenantId: string;
  learningRecordId: string;
  eventId: string;
  eventDigest: string;
  product: RetrievalContextGapProduct;
  capability: string;
  taskType: string;
  migrationFamily: string;
  repositoryId: string;
  observedAt: string;
  createdAt: string;
}>;

/** One dimension bucket of the gap summary: a label and how many gaps carried it. */
export type RetrievalContextGapBucket = Readonly<{ key: string; gaps: number }>;

/**
 * Operator-facing summary of accumulated retrieval context gaps for one tenant.
 * `totalGaps` answers "how often did we confirm the model was missing the context
 * it needed?"; the `by*` breakdowns answer "for what?". Descending by count then
 * ascending by key so the surface is stable for a fixed database state. A summary
 * with `totalGaps === 0` is a real, honest zero (nothing confirmed absent yet),
 * not a "no data" placeholder.
 */
export type RetrievalContextGaps = Readonly<{
  tenantId: string;
  window: Readonly<{ since: string | null; until: string | null }>;
  totalGaps: number;
  byCapability: readonly RetrievalContextGapBucket[];
  byMigrationFamily: readonly RetrievalContextGapBucket[];
  byProduct: readonly RetrievalContextGapBucket[];
  /** Most recent gaps (bounded), newest first, for a concrete operator view. */
  recent: readonly RetrievalContextGapRecord[];
  computedAt: string;
}>;

const RECENT_LIMIT = 50;

function text(value: unknown, code: string, max = 512): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > max) {
    throw new Error(code);
  }
  return value;
}
function identifier(value: unknown, code: string): string {
  const out = text(value, code, 200);
  if (!IDENTIFIER.test(out)) throw new Error(code);
  return out;
}
function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(code);
  return value;
}
function isoOrNull(value: string | null | undefined, code: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(code);
  return value;
}

/**
 * Persist one retrieval context gap. Idempotent: keyed on the learning record, so
 * a replayed admission (which is itself idempotent) never double counts. Validates
 * every field before writing rather than trusting the caller — the admission path
 * is the only caller today, but a projection table earns its keep only if it fails
 * closed on malformed input.
 */
export function recordRetrievalContextGap(db: AppDb, input: RetrievalContextGapInput): void {
  const learningRecordId = identifier(input.learningRecordId, "retrieval_gap_learning_record_id_invalid");
  const tenantId = text(input.tenantId, "retrieval_gap_tenant_id_invalid");
  const eventId = text(input.eventId, "retrieval_gap_event_id_invalid");
  const eventDigest = text(input.eventDigest, "retrieval_gap_event_digest_invalid");
  if (input.product !== "fettler" && input.product !== "regauge") {
    throw new Error("retrieval_gap_product_invalid");
  }
  const capability = text(input.capability, "retrieval_gap_capability_invalid");
  const taskType = text(input.taskType, "retrieval_gap_task_type_invalid");
  const migrationFamily = text(input.migrationFamily, "retrieval_gap_migration_family_invalid");
  const repositoryId = text(input.repositoryId, "retrieval_gap_repository_id_invalid");
  const observedAt = timestamp(input.observedAt, "retrieval_gap_observed_at_invalid");
  const createdAt = timestamp(input.createdAt, "retrieval_gap_created_at_invalid");

  db.raw
    .prepare(
      `INSERT OR IGNORE INTO retrieval_context_gaps
         (id, tenant_id, learning_record_id, event_id, event_digest, product,
          capability, task_type, migration_family, repository_id, observed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      learningRecordId,
      tenantId,
      learningRecordId,
      eventId,
      eventDigest,
      input.product,
      capability,
      taskType,
      migrationFamily,
      repositoryId,
      observedAt,
      createdAt,
    );
}

type GapRow = {
  id: string;
  tenant_id: string;
  learning_record_id: string;
  event_id: string;
  event_digest: string;
  product: string;
  capability: string;
  task_type: string;
  migration_family: string;
  repository_id: string;
  observed_at: string;
  created_at: string;
};

function toRecord(row: GapRow): RetrievalContextGapRecord {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    learningRecordId: row.learning_record_id,
    eventId: row.event_id,
    eventDigest: row.event_digest,
    product: row.product as RetrievalContextGapProduct,
    capability: row.capability,
    taskType: row.task_type,
    migrationFamily: row.migration_family,
    repositoryId: row.repository_id,
    observedAt: row.observed_at,
    createdAt: row.created_at,
  });
}

function bucketize(rows: readonly GapRow[], key: (row: GapRow) => string): readonly RetrievalContextGapBucket[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const k = key(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Object.freeze(
    [...counts.entries()]
      .map(([k, gaps]) => Object.freeze({ key: k, gaps }))
      // Descending by count, ties broken by ascending key for a stable surface.
      .sort((a, b) => (b.gaps - a.gaps) || a.key.localeCompare(b.key)),
  );
}

/**
 * Read accumulated retrieval context gaps for one tenant, optionally windowed on
 * `observed_at`. Tenant-scoped (never reads another tenant's gaps) and computed
 * only from recorded rows. This is the sink's consumer: it is what makes the
 * `retrieval` destination `sink_consumes` rather than `unrouted`.
 */
export function computeRetrievalContextGaps(
  db: AppDb,
  input: { tenantId: string; since?: string | null; until?: string | null },
): RetrievalContextGaps {
  const tenantId = input.tenantId.trim();
  if (!tenantId) throw new Error("retrieval_gap_tenant_id_invalid");
  const since = isoOrNull(input.since, "retrieval_gap_since_invalid");
  const until = isoOrNull(input.until, "retrieval_gap_until_invalid");
  if (since !== null && until !== null && Date.parse(until) <= Date.parse(since)) {
    throw new Error("retrieval_gap_window_invalid");
  }

  const params: (string | number)[] = [tenantId];
  let windowClause = "";
  if (since !== null) {
    windowClause += " AND observed_at >= ?";
    params.push(since);
  }
  if (until !== null) {
    windowClause += " AND observed_at < ?";
    params.push(until);
  }

  const rows = db.raw
    .prepare(
      `SELECT id, tenant_id, learning_record_id, event_id, event_digest, product,
              capability, task_type, migration_family, repository_id, observed_at, created_at
       FROM retrieval_context_gaps
       WHERE tenant_id = ?${windowClause}
       ORDER BY observed_at DESC, id ASC`,
    )
    .all(...params) as GapRow[];

  return Object.freeze({
    tenantId,
    window: Object.freeze({ since, until }),
    totalGaps: rows.length,
    byCapability: bucketize(rows, (row) => row.capability),
    byMigrationFamily: bucketize(rows, (row) => row.migration_family),
    byProduct: bucketize(rows, (row) => row.product),
    recent: Object.freeze(rows.slice(0, RECENT_LIMIT).map(toRecord)),
    computedAt: new Date().toISOString(),
  });
}
