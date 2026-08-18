import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const COMMIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const JOB_TYPE = "transformer.adaptive.deliver";

export type AdaptiveDeliveryStatus =
  | "delivery_pending"
  | "delivered"
  | "delivery_failed";

/**
 * The delivered PR's real fate, recorded separately from the delivery-pipeline
 * `status`. A row with `outcome === null` has NOT been decided yet (pending) and
 * must never be read as a negative. `reverted` is modeled explicitly: a
 * merged-then-reverted migration is a different outcome from a plain `merged`.
 */
export type AdaptiveDeliveryOutcome = "merged" | "closed_unmerged" | "reverted";

const OUTCOMES: readonly AdaptiveDeliveryOutcome[] = ["merged", "closed_unmerged", "reverted"];

export type TransformerAdaptiveDeliveryRecord = Readonly<{
  id: string;
  tenantId: string;
  candidateId: string;
  jobId: string;
  status: AdaptiveDeliveryStatus;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  intentDigest: string | null;
  branchName: string | null;
  baseRevision: string | null;
  commitSha: string | null;
  draftPr: true | null;
  draftPrNumber: number | null;
  draftPrUrl: string | null;
  requesterPrincipalId: string;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  intentBoundAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  lastErrorAt: string | null;
  outcome: AdaptiveDeliveryOutcome | null;
  outcomeAt: string | null;
  outcomeSource: string | null;
  updatedAt: string;
}>;

type DeliveryRow = {
  id: string;
  tenant_id: string;
  candidate_id: string;
  job_id: string;
  status: string;
  repository_id: string;
  snapshot_id: string;
  base_branch: string;
  expected_base_revision: string;
  intent_digest: string | null;
  branch_name: string | null;
  base_revision: string | null;
  commit_sha: string | null;
  draft_pr: number | null;
  draft_pr_number: number | null;
  draft_pr_url: string | null;
  requester_principal_id: string;
  error_code: string | null;
  error_message: string | null;
  requested_at: string;
  intent_bound_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
  last_error_at: string | null;
  outcome: string | null;
  outcome_at: string | null;
  outcome_source: string | null;
  updated_at: string;
};

type CandidateRow = {
  status: string;
  kind: string;
  expires_at: string;
  repository_id: string;
  snapshot_id: string;
  base_branch: string;
  expected_base_revision: string;
};

type JobIdentityRow = {
  tenant_id: string;
  type: string;
  payload_json: string;
};

type ActiveJobRow = { id: string };

function requiredString(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(code);
  }
  return value.trim();
}

function identifier(value: unknown, code: string): string {
  const out = requiredString(value, code, 200);
  if (!IDENTIFIER.test(out)) throw new Error(code);
  return out;
}

function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) {
    throw new Error(code);
  }
  return value;
}

function digest(value: unknown, code: string): string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(code);
  return value;
}

function commitRevision(value: unknown, code: string): string {
  const out = requiredString(value, code, 64);
  if (!COMMIT_SHA.test(out)) throw new Error(code);
  return out;
}

function baseBranch(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !BRANCH.test(value) ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    throw new Error(code);
  }
  return value;
}

function httpsUrl(value: unknown, code: string): string {
  const out = requiredString(value, code, 2_000);
  try {
    const parsed = new URL(out);
    if (parsed.protocol !== "https:" || !parsed.hostname) throw new Error(code);
  } catch {
    throw new Error(code);
  }
  return out;
}

function deterministicIds(tenantId: string, candidateId: string) {
  const value = createHash("sha256")
    .update([tenantId, candidateId].join("\0"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return Object.freeze({
    deliveryId: `tfdelivery_${value}`,
    jobId: `tfdeliveryjob_${value}`,
  });
}

function mapRow(row: DeliveryRow): TransformerAdaptiveDeliveryRecord {
  if (!["delivery_pending", "delivered", "delivery_failed"].includes(row.status)) {
    throw new Error("transformer_adaptive_delivery_corrupt");
  }
  if (row.draft_pr !== null && row.draft_pr !== 1) {
    throw new Error("transformer_adaptive_delivery_corrupt");
  }
  if (row.outcome !== null && !OUTCOMES.includes(row.outcome as AdaptiveDeliveryOutcome)) {
    throw new Error("transformer_adaptive_delivery_corrupt");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    candidateId: row.candidate_id,
    jobId: row.job_id,
    status: row.status as AdaptiveDeliveryStatus,
    repositoryId: row.repository_id,
    snapshotId: row.snapshot_id,
    baseBranch: baseBranch(row.base_branch, "transformer_adaptive_delivery_base_branch_invalid"),
    expectedBaseRevision: row.expected_base_revision,
    intentDigest: row.intent_digest,
    branchName: row.branch_name,
    baseRevision: row.base_revision,
    commitSha: row.commit_sha,
    draftPr: row.draft_pr === 1 ? true : null,
    draftPrNumber: row.draft_pr_number,
    draftPrUrl: row.draft_pr_url,
    requesterPrincipalId: row.requester_principal_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestedAt: row.requested_at,
    intentBoundAt: row.intent_bound_at,
    deliveredAt: row.delivered_at,
    failedAt: row.failed_at,
    lastErrorAt: row.last_error_at,
    outcome: row.outcome as AdaptiveDeliveryOutcome | null,
    outcomeAt: row.outcome_at,
    outcomeSource: row.outcome_source,
    updatedAt: row.updated_at,
  });
}

/**
 * Legal outcome transitions. `null` (pending) is the start state. A closed PR
 * can still be reopened and merged, so closed_unmerged -> merged is allowed. A
 * revert is only meaningful after a merge, so it is reachable only from merged.
 */
function outcomeTransitionAllowed(
  from: AdaptiveDeliveryOutcome | null,
  to: AdaptiveDeliveryOutcome,
): boolean {
  if (from === to) return true;
  switch (to) {
    case "merged":
      return from === null || from === "closed_unmerged";
    case "closed_unmerged":
      return from === null;
    case "reverted":
      return from === "merged";
    default:
      return false;
  }
}

function loadRow(
  db: AppDb,
  tenantId: string,
  deliveryId: string,
): TransformerAdaptiveDeliveryRecord | undefined {
  const row = db.raw
    .prepare("SELECT * FROM regauge_adaptive_deliveries WHERE id = ? AND tenant_id = ?")
    .get(deliveryId, tenantId) as DeliveryRow | undefined;
  return row ? mapRow(row) : undefined;
}

function inTransaction<T>(db: AppDb, operation: () => T): T {
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (ownsTransaction) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function assertDeliveryJob(
  delivery: TransformerAdaptiveDeliveryRecord,
  jobId: string,
): void {
  if (delivery.jobId !== jobId) throw new Error("transformer_adaptive_delivery_job_mismatch");
}

function assertActiveLease(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    jobId: string;
    workerId: string;
    leaseGeneration: number;
    observedAt: string;
  }>,
): void {
  const active = db.raw
    .prepare(
      `SELECT id FROM jobs
       WHERE id = ? AND tenant_id = ? AND type = ? AND status = 'running'
         AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`,
    )
    .get(
      input.jobId,
      input.tenantId,
      JOB_TYPE,
      input.workerId,
      input.leaseGeneration,
      input.observedAt,
    ) as ActiveJobRow | undefined;
  if (!active) throw new Error("transformer_adaptive_delivery_lease_lost");
}

export type EnqueueAdaptiveDeliveryInput = Readonly<{
  tenantId: string;
  candidateId: string;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  requesterPrincipalId: string;
  maxAttempts?: number;
  now?: string;
}>;

/** Atomically create the durable outbox row and its deterministic queue job. */
export function enqueueAdaptiveDelivery(
  db: AppDb,
  input: EnqueueAdaptiveDeliveryInput,
): TransformerAdaptiveDeliveryRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_delivery_tenant_invalid", 200);
  const candidateId = identifier(input.candidateId, "transformer_adaptive_delivery_candidate_invalid");
  const repositoryId = identifier(input.repositoryId, "transformer_adaptive_delivery_repository_invalid");
  const snapshotId = identifier(input.snapshotId, "transformer_adaptive_delivery_snapshot_invalid");
  const expectedBaseBranch = baseBranch(
    input.baseBranch,
    "transformer_adaptive_delivery_base_branch_invalid",
  );
  const expectedBaseRevision = commitRevision(
    input.expectedBaseRevision,
    "transformer_adaptive_delivery_expected_base_invalid",
  );
  const requesterPrincipalId = requiredString(
    input.requesterPrincipalId,
    "transformer_adaptive_delivery_requester_invalid",
    200,
  );
  const now = input.now
    ? timestamp(input.now, "transformer_adaptive_delivery_timestamp_invalid")
    : new Date().toISOString();
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new Error("transformer_adaptive_delivery_max_attempts_invalid");
  }
  const ids = deterministicIds(tenantId, candidateId);

  return inTransaction(db, () => {
    const existing = loadRow(db, tenantId, ids.deliveryId);
    const job = db.raw
      .prepare("SELECT tenant_id, type, payload_json FROM jobs WHERE id = ?")
      .get(ids.jobId) as JobIdentityRow | undefined;
    let payload: unknown;
    try {
      payload = job ? JSON.parse(job.payload_json) : null;
    } catch {
      payload = null;
    }
    if (existing) {
      if (
        existing.candidateId !== candidateId ||
        existing.jobId !== ids.jobId ||
        existing.repositoryId !== repositoryId ||
        existing.snapshotId !== snapshotId ||
        existing.baseBranch !== expectedBaseBranch ||
        existing.expectedBaseRevision !== expectedBaseRevision ||
        existing.requesterPrincipalId !== requesterPrincipalId ||
        !job ||
        job.tenant_id !== tenantId ||
        job.type !== JOB_TYPE ||
        JSON.stringify(payload) !== JSON.stringify({ candidateId })
      ) {
        throw new Error("transformer_adaptive_delivery_conflict");
      }
      return existing;
    }
    if (job) throw new Error("transformer_adaptive_delivery_conflict");

    const candidate = db.raw
      .prepare(
        `SELECT status, kind, expires_at, repository_id, snapshot_id, base_branch,
                expected_base_revision
         FROM regauge_adaptive_candidates
         WHERE id = ? AND tenant_id = ?`,
      )
      .get(candidateId, tenantId) as CandidateRow | undefined;
    if (!candidate || candidate.kind !== "adaptive") {
      throw new Error("transformer_adaptive_delivery_candidate_not_found");
    }
    if (candidate.status !== "approved") {
      throw new Error("transformer_adaptive_delivery_candidate_not_approved");
    }
    if (candidate.expires_at <= now) {
      throw new Error("transformer_adaptive_delivery_candidate_expired");
    }
    if (
      candidate.repository_id !== repositoryId ||
      candidate.snapshot_id !== snapshotId ||
      candidate.base_branch !== expectedBaseBranch ||
      candidate.expected_base_revision !== expectedBaseRevision
    ) {
      throw new Error("transformer_adaptive_delivery_candidate_binding_mismatch");
    }

    db.raw
      .prepare(
        `INSERT INTO regauge_adaptive_deliveries
          (id, tenant_id, candidate_id, job_id, status, repository_id,
           snapshot_id, base_branch, expected_base_revision, intent_digest, branch_name,
           base_revision, commit_sha, draft_pr, draft_pr_number, draft_pr_url,
           requester_principal_id, error_code, error_message, requested_at,
           intent_bound_at, delivered_at, failed_at, last_error_at, updated_at)
         VALUES (?, ?, ?, ?, 'delivery_pending', ?, ?, ?, ?, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, ?, NULL, NULL, ?, NULL, NULL, NULL, NULL, ?)` ,
      )
      .run(
        ids.deliveryId,
        tenantId,
        candidateId,
        ids.jobId,
        repositoryId,
        snapshotId,
        expectedBaseBranch,
        expectedBaseRevision,
        requesterPrincipalId,
        now,
        now,
      );
    db.raw
      .prepare(
        `INSERT INTO jobs
          (id, tenant_id, type, payload_json, status, attempts, max_attempts,
           created_at, available_at, lease_generation)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0)`,
      )
      .run(
        ids.jobId,
        tenantId,
        JOB_TYPE,
        JSON.stringify({ candidateId }),
        maxAttempts,
        now,
        now,
      );
    return loadRow(db, tenantId, ids.deliveryId)!;
  });
}

export function getAdaptiveDelivery(
  db: AppDb,
  tenantId: string,
  deliveryId: string,
): TransformerAdaptiveDeliveryRecord | undefined {
  return loadRow(
    db,
    requiredString(tenantId, "transformer_adaptive_delivery_tenant_invalid", 200),
    identifier(deliveryId, "transformer_adaptive_delivery_id_invalid"),
  );
}

export function getAdaptiveDeliveryByCandidate(
  db: AppDb,
  tenantId: string,
  candidateId: string,
): TransformerAdaptiveDeliveryRecord | undefined {
  const safeTenant = requiredString(tenantId, "transformer_adaptive_delivery_tenant_invalid", 200);
  const safeCandidate = identifier(
    candidateId,
    "transformer_adaptive_delivery_candidate_invalid",
  );
  const row = db.raw
    .prepare(
      `SELECT * FROM regauge_adaptive_deliveries
       WHERE tenant_id = ? AND candidate_id = ?`,
    )
    .get(safeTenant, safeCandidate) as DeliveryRow | undefined;
  return row ? mapRow(row) : undefined;
}

export function listAdaptiveDeliveries(
  db: AppDb,
  tenantId: string,
  status?: AdaptiveDeliveryStatus,
  limit = 50,
): TransformerAdaptiveDeliveryRecord[] {
  const safeTenant = requiredString(tenantId, "transformer_adaptive_delivery_tenant_invalid", 200);
  if (status !== undefined && !["delivery_pending", "delivered", "delivery_failed"].includes(status)) {
    throw new Error("transformer_adaptive_delivery_status_invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("transformer_adaptive_delivery_limit_invalid");
  }
  const rows = status === undefined
    ? db.raw
        .prepare(
          `SELECT * FROM regauge_adaptive_deliveries
           WHERE tenant_id = ? ORDER BY requested_at DESC, id DESC LIMIT ?`,
        )
        .all(safeTenant, limit) as DeliveryRow[]
    : db.raw
        .prepare(
          `SELECT * FROM regauge_adaptive_deliveries
           WHERE tenant_id = ? AND status = ?
           ORDER BY requested_at DESC, id DESC LIMIT ?`,
        )
        .all(safeTenant, status, limit) as DeliveryRow[];
  return rows.map(mapRow);
}

type FencedDeliveryInput = Readonly<{
  tenantId: string;
  deliveryId: string;
  jobId: string;
  workerId: string;
  leaseGeneration: number;
  observedAt: string;
}>;

function validatedFence(input: FencedDeliveryInput) {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_delivery_tenant_invalid", 200);
  const deliveryId = identifier(input.deliveryId, "transformer_adaptive_delivery_id_invalid");
  const jobId = identifier(input.jobId, "transformer_adaptive_delivery_job_invalid");
  const workerId = requiredString(input.workerId, "transformer_adaptive_delivery_worker_invalid", 200);
  if (!Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1) {
    throw new Error("transformer_adaptive_delivery_lease_generation_invalid");
  }
  const observedAt = timestamp(input.observedAt, "transformer_adaptive_delivery_timestamp_invalid");
  return Object.freeze({
    tenantId,
    deliveryId,
    jobId,
    workerId,
    leaseGeneration: input.leaseGeneration,
    observedAt,
  });
}

export type BindAdaptiveDeliveryIntentInput = FencedDeliveryInput & Readonly<{
  intentDigest: string;
  branchName: string;
  baseBranch: string;
  baseRevision: string;
}>;

export function bindAdaptiveDeliveryIntent(
  db: AppDb,
  input: BindAdaptiveDeliveryIntentInput,
): TransformerAdaptiveDeliveryRecord {
  const fence = validatedFence(input);
  const intentDigest = digest(input.intentDigest, "transformer_adaptive_delivery_intent_invalid");
  const branchName = requiredString(input.branchName, "transformer_adaptive_delivery_branch_invalid", 512);
  const expectedBaseBranch = baseBranch(
    input.baseBranch,
    "transformer_adaptive_delivery_base_branch_invalid",
  );
  const baseRevision = commitRevision(
    input.baseRevision,
    "transformer_adaptive_delivery_base_invalid",
  );

  return inTransaction(db, () => {
    const current = loadRow(db, fence.tenantId, fence.deliveryId);
    if (!current) throw new Error("transformer_adaptive_delivery_not_found");
    assertDeliveryJob(current, fence.jobId);
    assertActiveLease(db, fence);
    if (current.status !== "delivery_pending") {
      throw new Error("transformer_adaptive_delivery_terminal");
    }
    if (
      expectedBaseBranch !== current.baseBranch ||
      baseRevision !== current.expectedBaseRevision
    ) {
      throw new Error("transformer_adaptive_delivery_base_mismatch");
    }
    if (current.intentDigest !== null) {
      if (
        current.intentDigest !== intentDigest ||
        current.branchName !== branchName ||
        current.baseRevision !== baseRevision
      ) {
        throw new Error("transformer_adaptive_delivery_intent_conflict");
      }
      return current;
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_deliveries
         SET intent_digest = ?, branch_name = ?, base_revision = ?,
             intent_bound_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND job_id = ?
           AND status = 'delivery_pending' AND intent_digest IS NULL`,
      )
      .run(
        intentDigest,
        branchName,
        baseRevision,
        fence.observedAt,
        fence.observedAt,
        fence.deliveryId,
        fence.tenantId,
        fence.jobId,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_delivery_intent_conflict");
    }
    return loadRow(db, fence.tenantId, fence.deliveryId)!;
  });
}

export type RecordAdaptiveDeliverySuccessInput = FencedDeliveryInput & Readonly<{
  commitSha: string;
  branchName: string;
  baseBranch: string;
  baseRevision: string;
  draftPr: true;
  draftPrNumber: number;
  draftPrUrl: string;
}>;

export function recordAdaptiveDeliverySuccess(
  db: AppDb,
  input: RecordAdaptiveDeliverySuccessInput,
): TransformerAdaptiveDeliveryRecord {
  if (!db.raw.isTransaction) {
    throw new Error("transformer_adaptive_delivery_outer_transaction_required");
  }
  const fence = validatedFence(input);
  const commitSha = requiredString(input.commitSha, "transformer_adaptive_delivery_commit_invalid", 64);
  if (!COMMIT_SHA.test(commitSha)) throw new Error("transformer_adaptive_delivery_commit_invalid");
  const branchName = requiredString(
    input.branchName,
    "transformer_adaptive_delivery_branch_invalid",
    512,
  );
  const expectedBaseBranch = baseBranch(
    input.baseBranch,
    "transformer_adaptive_delivery_base_branch_invalid",
  );
  const baseRevision = commitRevision(
    input.baseRevision,
    "transformer_adaptive_delivery_base_invalid",
  );
  if (input.draftPr !== true) throw new Error("transformer_adaptive_delivery_draft_required");
  if (!Number.isSafeInteger(input.draftPrNumber) || input.draftPrNumber < 1) {
    throw new Error("transformer_adaptive_delivery_pr_number_invalid");
  }
  const draftPrUrl = httpsUrl(input.draftPrUrl, "transformer_adaptive_delivery_pr_url_invalid");

  return inTransaction(db, () => {
    const current = loadRow(db, fence.tenantId, fence.deliveryId);
    if (!current) throw new Error("transformer_adaptive_delivery_not_found");
    assertDeliveryJob(current, fence.jobId);
    assertActiveLease(db, fence);
    if (current.status !== "delivery_pending") {
      throw new Error("transformer_adaptive_delivery_terminal");
    }
    if (!current.intentDigest || !current.branchName || !current.baseRevision) {
      throw new Error("transformer_adaptive_delivery_intent_required");
    }
    if (
      branchName !== current.branchName ||
      expectedBaseBranch !== current.baseBranch ||
      baseRevision !== current.baseRevision ||
      baseRevision !== current.expectedBaseRevision
    ) {
      throw new Error("transformer_adaptive_delivery_evidence_mismatch");
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_deliveries
         SET status = 'delivered', commit_sha = ?, draft_pr = 1,
             draft_pr_number = ?, draft_pr_url = ?, delivered_at = ?,
             error_code = NULL, error_message = NULL, last_error_at = NULL,
             failed_at = NULL, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND job_id = ?
           AND status = 'delivery_pending'`,
      )
      .run(
        commitSha,
        input.draftPrNumber,
        draftPrUrl,
        fence.observedAt,
        fence.observedAt,
        fence.deliveryId,
        fence.tenantId,
        fence.jobId,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_delivery_success_conflict");
    }
    return loadRow(db, fence.tenantId, fence.deliveryId)!;
  });
}

export type RecordAdaptiveDeliveryFailureInput = FencedDeliveryInput & Readonly<{
  terminal: boolean;
  errorCode: string;
  errorMessage: string;
}>;

export function recordAdaptiveDeliveryFailure(
  db: AppDb,
  input: RecordAdaptiveDeliveryFailureInput,
): TransformerAdaptiveDeliveryRecord {
  if (input.terminal && !db.raw.isTransaction) {
    throw new Error("transformer_adaptive_delivery_outer_transaction_required");
  }
  const fence = validatedFence(input);
  const errorCode = requiredString(input.errorCode, "transformer_adaptive_delivery_error_code_invalid", 200);
  if (!ERROR_CODE.test(errorCode)) {
    throw new Error("transformer_adaptive_delivery_error_code_invalid");
  }
  const errorMessage = requiredString(
    input.errorMessage,
    "transformer_adaptive_delivery_error_message_invalid",
    2_000,
  );

  return inTransaction(db, () => {
    const current = loadRow(db, fence.tenantId, fence.deliveryId);
    if (!current) throw new Error("transformer_adaptive_delivery_not_found");
    assertDeliveryJob(current, fence.jobId);
    assertActiveLease(db, fence);
    if (current.status !== "delivery_pending") {
      throw new Error("transformer_adaptive_delivery_terminal");
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_deliveries
         SET status = ?, error_code = ?, error_message = ?, last_error_at = ?,
             failed_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND job_id = ?
           AND status = 'delivery_pending'`,
      )
      .run(
        input.terminal ? "delivery_failed" : "delivery_pending",
        errorCode,
        errorMessage,
        fence.observedAt,
        input.terminal ? fence.observedAt : null,
        fence.observedAt,
        fence.deliveryId,
        fence.tenantId,
        fence.jobId,
      );
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_delivery_failure_conflict");
    }
    return loadRow(db, fence.tenantId, fence.deliveryId)!;
  });
}

/**
 * Resolve a delivered Regauge adaptive delivery by the durable PR URL it recorded
 * at delivery time. This is a deliberate cross-tenant read: a GitHub webhook
 * carries no authenticated principal, so the tenant is derived from the matched
 * row and used to scope the subsequent outcome write. Returns undefined when no
 * delivered row (or more than one) owns the URL, so an ambiguous match never
 * writes an outcome to the wrong lane.
 */
export function findAdaptiveDeliveryByPrUrl(
  db: AppDb,
  prUrl: string,
): TransformerAdaptiveDeliveryRecord | undefined {
  if (typeof prUrl !== "string" || !prUrl.trim()) return undefined;
  const rows = db.raw
    .prepare(
      `SELECT * FROM regauge_adaptive_deliveries
       WHERE draft_pr_url = ? AND status = 'delivered' AND draft_pr_number IS NOT NULL
       ORDER BY requested_at DESC LIMIT 2`,
    )
    .all(prUrl) as DeliveryRow[];
  return rows.length === 1 ? mapRow(rows[0]) : undefined;
}

export type RecordAdaptiveDeliveryOutcomeInput = Readonly<{
  tenantId: string;
  deliveryId: string;
  outcome: AdaptiveDeliveryOutcome;
  source: string;
  observedAt: string;
}>;

/**
 * Record the delivered PR's real fate against the delivery that produced it.
 * Tenant-scoped from the caller's derived principal (never a request body), so a
 * cross-tenant write matches no row and fails closed. Enforces the legal outcome
 * transitions and is idempotent when the same outcome is re-delivered.
 */
export function recordAdaptiveDeliveryOutcome(
  db: AppDb,
  input: RecordAdaptiveDeliveryOutcomeInput,
): TransformerAdaptiveDeliveryRecord {
  const tenantId = requiredString(input.tenantId, "transformer_adaptive_delivery_tenant_invalid", 200);
  const deliveryId = identifier(input.deliveryId, "transformer_adaptive_delivery_id_invalid");
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error("transformer_adaptive_delivery_outcome_invalid");
  }
  const source = requiredString(
    input.source,
    "transformer_adaptive_delivery_outcome_source_invalid",
    500,
  );
  const observedAt = timestamp(input.observedAt, "transformer_adaptive_delivery_timestamp_invalid");

  return inTransaction(db, () => {
    const current = loadRow(db, tenantId, deliveryId);
    if (!current) throw new Error("transformer_adaptive_delivery_outcome_not_found");
    if (current.status !== "delivered" || current.draftPrNumber === null) {
      throw new Error("transformer_adaptive_delivery_outcome_not_delivered");
    }
    if (current.outcome === input.outcome) return current;
    if (!outcomeTransitionAllowed(current.outcome, input.outcome)) {
      throw new Error("transformer_adaptive_delivery_outcome_transition_invalid");
    }
    const changed = db.raw
      .prepare(
        `UPDATE regauge_adaptive_deliveries
         SET outcome = ?, outcome_at = ?, outcome_source = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'delivered' AND outcome IS ?`,
      )
      .run(input.outcome, observedAt, source, observedAt, deliveryId, tenantId, current.outcome);
    if (Number(changed.changes) !== 1) {
      throw new Error("transformer_adaptive_delivery_outcome_conflict");
    }
    return loadRow(db, tenantId, deliveryId)!;
  });
}
