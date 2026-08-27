import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";
import { assertMissionMutationAuthority, completeMissionMutationAuthorityTask, parseMissionMutationAuthority,
  refreshMissionMutationAuthority, type MissionMutationAuthorityV1 } from "./mission-mutation-authority.js";

const JOB_TYPE = "warden.candidate.deliver";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const DEFERRED_MISSION_OUTCOME_SETTLEMENT_ERRORS = new Set([
  "mission_mutation_authority_stale",
  "mission_mutation_authority_blocked",
  "mission_mutation_authority_task_missing",
  "mission_mutation_authority_task_not_accepted",
]);

export type WardenCandidateDeliveryStatus = "delivery_pending" | "delivered" | "delivery_failed";

/**
 * The delivered PR's real fate, recorded separately from the delivery-pipeline
 * `status`. A row with `outcome === null` has NOT been decided yet (pending) and
 * must never be read as a negative. `reverted` is modeled explicitly: a
 * merged-then-reverted migration is a different outcome from a plain `merged`.
 */
export type WardenCandidateDeliveryOutcome = "merged" | "closed_unmerged" | "reverted";

const OUTCOMES: readonly WardenCandidateDeliveryOutcome[] = ["merged", "closed_unmerged", "reverted"];

export type WardenCandidateDeliveryRecord = Readonly<{
  id: string;
  tenantId: string;
  runId: string;
  jobId: string;
  status: WardenCandidateDeliveryStatus;
  repositoryId: string;
  snapshotId: string;
  baseBranch: string;
  expectedBaseRevision: string;
  sealedPath: string;
  sealedSha256: string;
  requesterPrincipalId: string;
  rationale: string;
  missionAuthority: MissionMutationAuthorityV1 | null;
  intentDigest: string | null;
  branchName: string | null;
  baseRevision: string | null;
  commitSha: string | null;
  draftPr: true | null;
  draftPrNumber: number | null;
  draftPrUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestedAt: string;
  intentBoundAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  lastErrorAt: string | null;
  outcome: WardenCandidateDeliveryOutcome | null;
  outcomeAt: string | null;
  outcomeSource: string | null;
  updatedAt: string;
}>;

type Row = {
  id: string; tenant_id: string; run_id: string; job_id: string; status: string;
  repository_id: string; snapshot_id: string; base_branch: string;
  expected_base_revision: string; sealed_path: string; sealed_sha256: string;
  requester_principal_id: string; rationale: string; intent_digest: string | null;
  branch_name: string | null; base_revision: string | null; commit_sha: string | null;
  draft_pr: number | null; draft_pr_number: number | null; draft_pr_url: string | null;
  error_code: string | null; error_message: string | null; requested_at: string;
  intent_bound_at: string | null; delivered_at: string | null; failed_at: string | null;
  last_error_at: string | null; outcome: string | null; outcome_at: string | null;
  outcome_source: string | null; mission_authority_json: string | null; updated_at: string;
};

function text(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error(code);
  return value.trim();
}
function id(value: unknown, code: string): string {
  const out = text(value, code, 200);
  if (!IDENTIFIER.test(out)) throw new Error(code);
  return out;
}
function timestamp(value: unknown, code: string): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error(code);
  return value;
}
function branch(value: unknown): string {
  if (typeof value !== "string" || !BRANCH.test(value) || value.endsWith("/")) {
    throw new Error("warden_candidate_delivery_base_branch_invalid");
  }
  return value;
}
function map(row: Row): WardenCandidateDeliveryRecord {
  if (!["delivery_pending", "delivered", "delivery_failed"].includes(row.status)) {
    throw new Error("warden_candidate_delivery_corrupt");
  }
  if (row.outcome !== null && !OUTCOMES.includes(row.outcome as WardenCandidateDeliveryOutcome)) {
    throw new Error("warden_candidate_delivery_corrupt");
  }
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, runId: row.run_id, jobId: row.job_id,
    status: row.status as WardenCandidateDeliveryStatus, repositoryId: row.repository_id,
    snapshotId: row.snapshot_id, baseBranch: row.base_branch,
    expectedBaseRevision: row.expected_base_revision, sealedPath: row.sealed_path,
    sealedSha256: row.sealed_sha256, requesterPrincipalId: row.requester_principal_id,
    rationale: row.rationale,
    missionAuthority: row.mission_authority_json == null ? null
      : parseMissionMutationAuthority(JSON.parse(row.mission_authority_json)),
    intentDigest: row.intent_digest, branchName: row.branch_name,
    baseRevision: row.base_revision, commitSha: row.commit_sha,
    draftPr: row.draft_pr === 1 ? true : null, draftPrNumber: row.draft_pr_number,
    draftPrUrl: row.draft_pr_url, errorCode: row.error_code, errorMessage: row.error_message,
    requestedAt: row.requested_at, intentBoundAt: row.intent_bound_at,
    deliveredAt: row.delivered_at, failedAt: row.failed_at,
    lastErrorAt: row.last_error_at,
    outcome: row.outcome as WardenCandidateDeliveryOutcome | null,
    outcomeAt: row.outcome_at, outcomeSource: row.outcome_source,
    updatedAt: row.updated_at,
  });
}

/**
 * Legal outcome transitions. `null` (pending) is the start state. A closed PR
 * can still be reopened and merged, so closed_unmerged -> merged is allowed. A
 * revert is only meaningful after a merge, so it is reachable only from merged.
 */
function outcomeTransitionAllowed(
  from: WardenCandidateDeliveryOutcome | null,
  to: WardenCandidateDeliveryOutcome,
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

function missionOutcomeSettlementDeferred(error: unknown): boolean {
  return error instanceof Error && DEFERRED_MISSION_OUTCOME_SETTLEMENT_ERRORS.has(error.message);
}

function sameMissionOutcomeAuthorityLane(
  delivery: MissionMutationAuthorityV1,
  current: MissionMutationAuthorityV1,
): boolean {
  return delivery.missionId === current.missionId &&
    delivery.missionRevision === current.missionRevision &&
    delivery.missionState === current.missionState &&
    delivery.taskId === current.taskId &&
    delivery.repositoryId === current.repositoryId &&
    delivery.snapshotId === current.snapshotId &&
    delivery.resolvedSha === current.resolvedSha;
}

export type WardenMergedMissionOutcomeReplay = Readonly<{
  status: "settled" | "deferred" | "not_applicable";
  tenantId: string;
  deliveryId: string;
}>;

export function replayWardenCandidateDeliveryMergedOutcome(
  db: AppDb,
  tenantId: string,
  deliveryId: string,
  observedAt: string,
): WardenMergedMissionOutcomeReplay {
  const replayedAt = timestamp(observedAt, "warden_candidate_delivery_timestamp_invalid");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const delivery = getWardenCandidateDelivery(db, tenantId, deliveryId);
    if (!delivery || delivery.outcome !== "merged" || !delivery.missionAuthority) {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "not_applicable", tenantId, deliveryId });
    }
    const cycle = db.raw.prepare(`SELECT id, status, mission_authority_json FROM fettler_ci_cycles
      WHERE tenant_id = ? AND delivery_id = ?`).get(tenantId, deliveryId) as
        { id: string; status: string; mission_authority_json: string | null } | undefined;
    // A CI-backed delivery is accepted only from the exact green state. Other
    // states remain resumable and retain their lifecycle evidence unchanged.
    if (cycle?.status === "succeeded") {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "settled", tenantId, deliveryId });
    }
    if (cycle && cycle.status !== "awaiting_review") {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "deferred", tenantId, deliveryId });
    }
    const retainedAuthority = cycle
      ? cycle.mission_authority_json === null
        ? null
        : parseMissionMutationAuthority(JSON.parse(cycle.mission_authority_json))
      : delivery.missionAuthority;
    if (!retainedAuthority ||
        !sameMissionOutcomeAuthorityLane(delivery.missionAuthority, retainedAuthority)) {
      throw new Error("warden_candidate_delivery_outcome_authority_conflict");
    }
    const currentAuthority = refreshMissionMutationAuthority(db, tenantId, retainedAuthority, {
      allowClaimedTask: true,
      allowSettledTask: true,
      requireNoBlocking: true,
    });
    if (!sameMissionOutcomeAuthorityLane(delivery.missionAuthority, currentAuthority)) {
      throw new Error("warden_candidate_delivery_outcome_authority_conflict");
    }
    if (JSON.stringify(delivery.missionAuthority) !== JSON.stringify(currentAuthority)) {
      const rebound = db.raw.prepare(`UPDATE fettler_candidate_deliveries
        SET mission_authority_json = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND outcome = 'merged' AND mission_authority_json = ?`).run(
        JSON.stringify(currentAuthority), replayedAt, deliveryId, tenantId,
        JSON.stringify(delivery.missionAuthority),
      );
      if (Number(rebound.changes) !== 1) {
        throw new Error("warden_candidate_delivery_outcome_authority_conflict");
      }
    }
    completeMissionMutationAuthorityTask(db, tenantId, currentAuthority, {
      correlationId: `delivery-outcome:${deliveryId}`,
      createdAt: replayedAt,
    });
    if (cycle) {
      const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'succeeded', updated_at = ?
        WHERE id = ? AND tenant_id = ? AND delivery_id = ? AND status = 'awaiting_review'`).run(
        replayedAt, cycle.id, tenantId, deliveryId,
      );
      if (Number(changed.changes) !== 1) throw new Error("warden_ci_cycle_acceptance_conflict");
    }
    if (owns) db.raw.exec("COMMIT");
    return Object.freeze({ status: "settled", tenantId, deliveryId });
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    // A late blocker or stale task authority changes whether the Mission may
    // settle, never the already-observed fact that GitHub merged the PR.
    if (missionOutcomeSettlementDeferred(error)) {
      return Object.freeze({ status: "deferred", tenantId, deliveryId });
    }
    throw error;
  }
}

export function replayPendingWardenCandidateDeliveryMergedOutcomes(
  db: AppDb,
  input: Readonly<{ observedAt: string; tenantId?: string; limit?: number }>,
): Readonly<{ examined: number; settled: number; deferred: number; failed: number }> {
  const observedAt = timestamp(input.observedAt, "warden_candidate_delivery_timestamp_invalid");
  const tenantId = input.tenantId === undefined
    ? null
    : text(input.tenantId, "warden_candidate_delivery_tenant_invalid", 200);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("warden_candidate_delivery_outcome_replay_limit_invalid");
  }
  const rows = db.raw.prepare(`SELECT delivery.tenant_id, delivery.id
    FROM fettler_candidate_deliveries delivery
    LEFT JOIN fettler_ci_cycles cycle
      ON cycle.tenant_id = delivery.tenant_id AND cycle.delivery_id = delivery.id
    WHERE delivery.outcome = 'merged' AND delivery.mission_authority_json IS NOT NULL
      AND json_valid(delivery.mission_authority_json) = 1
      AND (? IS NULL OR delivery.tenant_id = ?)
      AND (cycle.status = 'awaiting_review' OR (
        cycle.id IS NULL
        AND json_extract(CASE WHEN json_valid(delivery.mission_authority_json) = 1
          THEN delivery.mission_authority_json ELSE '{}' END, '$.taskId') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM mission_task task
          WHERE task.tenant_id = delivery.tenant_id
            AND task.id = json_extract(CASE WHEN json_valid(delivery.mission_authority_json) = 1
              THEN delivery.mission_authority_json ELSE '{}' END, '$.taskId')
            AND task.status <> 'complete'
        )
      ))
    ORDER BY delivery.updated_at, delivery.outcome_at, delivery.id
    LIMIT ?`).all(tenantId, tenantId, limit) as Array<{ tenant_id: string; id: string }>;
  const remaining = limit - rows.length;
  const malformedRows = remaining === 0 ? [] : db.raw.prepare(`SELECT delivery.tenant_id, delivery.id
    FROM fettler_candidate_deliveries delivery
    LEFT JOIN fettler_ci_cycles cycle
      ON cycle.tenant_id = delivery.tenant_id AND cycle.delivery_id = delivery.id
    WHERE delivery.outcome = 'merged' AND delivery.mission_authority_json IS NOT NULL
      AND json_valid(delivery.mission_authority_json) = 0
      AND (? IS NULL OR delivery.tenant_id = ?)
      AND (cycle.id IS NULL OR cycle.status = 'awaiting_review')
    ORDER BY delivery.updated_at, delivery.outcome_at, delivery.id
    LIMIT ?`).all(tenantId, tenantId, remaining) as Array<{ tenant_id: string; id: string }>;
  let settled = 0;
  let deferred = 0;
  let failed = malformedRows.length;
  for (const row of malformedRows) {
    db.raw.prepare(`UPDATE fettler_candidate_deliveries SET updated_at = ?
      WHERE tenant_id = ? AND id = ? AND outcome = 'merged'`).run(
      observedAt, row.tenant_id, row.id,
    );
  }
  for (const row of rows) {
    try {
      const replay = replayWardenCandidateDeliveryMergedOutcome(
        db, row.tenant_id, row.id, observedAt,
      );
      if (replay.status === "settled") settled++;
      else if (replay.status === "deferred") {
        deferred++;
        db.raw.prepare(`UPDATE fettler_candidate_deliveries SET updated_at = ?
          WHERE tenant_id = ? AND id = ? AND outcome = 'merged'`).run(
          observedAt, row.tenant_id, row.id,
        );
      }
    } catch {
      // One corrupt authority lane must not starve unrelated durable outcomes.
      // The caller receives the failure count and can surface it operationally.
      failed++;
      db.raw.prepare(`UPDATE fettler_candidate_deliveries SET updated_at = ?
        WHERE tenant_id = ? AND id = ? AND outcome = 'merged'`).run(
        observedAt, row.tenant_id, row.id,
      );
    }
  }
  return Object.freeze({ examined: rows.length + malformedRows.length, settled, deferred, failed });
}

function ids(tenantId: string, runId: string) {
  const hash = createHash("sha256").update([tenantId, runId].join("\0"), "utf8").digest("hex").slice(0, 32);
  return { deliveryId: `wardendelivery_${hash}`, jobId: `wardendeliveryjob_${hash}` };
}

export type EnqueueWardenCandidateDeliveryInput = Readonly<{
  tenantId: string; runId: string; repositoryId: string; snapshotId: string;
  baseBranch: string; expectedBaseRevision: string; sealedPath: string; sealedSha256: string;
  requesterPrincipalId: string; rationale: string; maxAttempts?: number; now?: string;
  missionAuthority?: MissionMutationAuthorityV1;
}>;

export function getWardenCandidateDelivery(db: AppDb, tenantId: string, deliveryId: string) {
  const row = db.raw.prepare(
    "SELECT * FROM fettler_candidate_deliveries WHERE id = ? AND tenant_id = ?",
  ).get(deliveryId, tenantId) as Row | undefined;
  return row ? map(row) : undefined;
}

export function getWardenCandidateDeliveryByRun(db: AppDb, tenantId: string, runId: string) {
  const row = db.raw.prepare(
    "SELECT * FROM fettler_candidate_deliveries WHERE run_id = ? AND tenant_id = ?",
  ).get(runId, tenantId) as Row | undefined;
  return row ? map(row) : undefined;
}

export function enqueueWardenCandidateDelivery(
  db: AppDb,
  input: EnqueueWardenCandidateDeliveryInput,
): WardenCandidateDeliveryRecord {
  const tenantId = text(input.tenantId, "warden_candidate_delivery_tenant_invalid", 200);
  const runId = id(input.runId, "warden_candidate_delivery_run_invalid");
  const repositoryId = id(input.repositoryId, "warden_candidate_delivery_repository_invalid");
  const snapshotId = id(input.snapshotId, "warden_candidate_delivery_snapshot_invalid");
  const baseBranch = branch(input.baseBranch);
  if (!COMMIT.test(input.expectedBaseRevision)) throw new Error("warden_candidate_delivery_revision_invalid");
  if (!DIGEST.test(input.sealedSha256)) throw new Error("warden_candidate_delivery_seal_invalid");
  const sealedPath = text(input.sealedPath, "warden_candidate_delivery_seal_invalid", 4_000);
  const requester = text(input.requesterPrincipalId, "warden_candidate_delivery_requester_invalid", 500);
  const rationale = text(input.rationale, "warden_candidate_delivery_rationale_invalid", 2_000);
  const now = timestamp(input.now ?? new Date().toISOString(), "warden_candidate_delivery_timestamp_invalid");
  const deterministic = ids(tenantId, runId);
  const missionAuthority = input.missionAuthority
    ? parseMissionMutationAuthority(input.missionAuthority)
    : null;
  if (missionAuthority && (missionAuthority.repositoryId !== repositoryId ||
      missionAuthority.snapshotId !== snapshotId || missionAuthority.resolvedSha !== input.expectedBaseRevision)) {
    throw new Error("warden_candidate_delivery_binding_mismatch");
  }
  if (missionAuthority) assertMissionMutationAuthority(db, tenantId, missionAuthority, { requireNoBlocking: true });
  const payload = JSON.stringify({ deliveryId: deterministic.deliveryId, runId,
    ...(missionAuthority ? { missionId: missionAuthority.missionId, missionAuthority } : {}) });
  const existing = getWardenCandidateDeliveryByRun(db, tenantId, runId);
  if (existing) {
    const existingJob = db.raw.prepare("SELECT payload_json FROM jobs WHERE id = ? AND tenant_id = ?")
      .get(existing.jobId, tenantId) as { payload_json: string } | undefined;
    const same = existing.id === deterministic.deliveryId && existing.jobId === deterministic.jobId &&
      existing.repositoryId === repositoryId && existing.snapshotId === snapshotId &&
      existing.baseBranch === baseBranch && existing.expectedBaseRevision === input.expectedBaseRevision &&
      existing.sealedPath === sealedPath && existing.sealedSha256 === input.sealedSha256 &&
      existing.requesterPrincipalId === requester && existing.rationale === rationale &&
      JSON.stringify(existing.missionAuthority) === JSON.stringify(missionAuthority) &&
      existingJob?.payload_json === payload;
    if (!same) throw new Error("warden_candidate_delivery_conflict");
    return existing;
  }
  const run = db.raw.prepare(
    "SELECT status, result_json, job_id FROM agent_runs WHERE id = ? AND tenant_id = ?",
  ).get(runId, tenantId) as { status: string; result_json: string | null; job_id: string | null } | undefined;
  if (!run || run.status !== "candidate_approved") {
    throw new Error("warden_candidate_delivery_run_not_approved");
  }
  let result: Record<string, unknown>;
  try { result = JSON.parse(run.result_json ?? "null") as Record<string, unknown>; } catch { throw new Error("warden_candidate_delivery_run_invalid"); }
  const source = result?.source as Record<string, unknown> | undefined;
  const approval = (result?.artifacts as Record<string, unknown> | undefined)?.approval as Record<string, unknown> | undefined;
  const review = result?.review as Record<string, unknown> | undefined;
  if (source?.repositoryId !== repositoryId || source.snapshotId !== snapshotId ||
    source.revision !== input.expectedBaseRevision || approval?.path !== sealedPath ||
    approval.sha256 !== input.sealedSha256 || review?.decision !== "approve" ||
    review.reviewerPrincipalId !== requester || review.rationale !== rationale) {
    throw new Error("warden_candidate_delivery_binding_mismatch");
  }
  const sourceJob = run.job_id ? db.raw.prepare("SELECT payload_json FROM jobs WHERE id = ? AND tenant_id = ?")
    .get(run.job_id, tenantId) as { payload_json: string } | undefined : undefined;
  if (sourceJob) {
    let sourcePayload: unknown;
    try { sourcePayload = JSON.parse(sourceJob.payload_json); } catch { sourcePayload = null; }
    if (sourcePayload && typeof sourcePayload === "object" && !Array.isArray(sourcePayload) &&
        typeof (sourcePayload as Record<string, unknown>).missionId === "string") {
      const claimedMissionId = (sourcePayload as Record<string, unknown>).missionId;
      if (!missionAuthority || missionAuthority.missionId !== claimedMissionId) {
        throw new Error("warden_candidate_delivery_binding_mismatch");
      }
    }
  }
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.prepare(
      `INSERT INTO jobs
       (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0)`,
    ).run(deterministic.jobId, tenantId, JOB_TYPE, payload, input.maxAttempts ?? 5, now, now);
    db.raw.prepare(
      `INSERT INTO fettler_candidate_deliveries
       (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
        expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
        mission_authority_json, requested_at, updated_at)
       VALUES (?, ?, ?, ?, 'delivery_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(deterministic.deliveryId, tenantId, runId, deterministic.jobId, repositoryId, snapshotId,
      baseBranch, input.expectedBaseRevision, sealedPath, input.sealedSha256, requester, rationale,
      missionAuthority ? JSON.stringify(missionAuthority) : null, now, now);
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getWardenCandidateDelivery(db, tenantId, deterministic.deliveryId)!;
}

export function bindWardenCandidateDeliveryIntent(db: AppDb, input: {
  tenantId: string; deliveryId: string; intentDigest: string; branchName: string; observedAt: string;
  workerId: string; leaseGeneration: number;
}) {
  const current = getWardenCandidateDelivery(db, input.tenantId, input.deliveryId);
  if (!current) throw new Error("warden_candidate_delivery_not_found");
  if (current.status !== "delivery_pending") throw new Error("warden_candidate_delivery_not_pending");
  const active = db.raw.prepare(`SELECT 1 AS active FROM jobs WHERE id = ? AND tenant_id = ?
    AND status = 'running' AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?`).get(
    current.jobId, current.tenantId, input.workerId, input.leaseGeneration, input.observedAt,
  ) as { active: number } | undefined;
  if (!active) throw new Error("warden_candidate_delivery_lease_lost");
  if (current.intentDigest && (current.intentDigest !== input.intentDigest || current.branchName !== input.branchName)) {
    throw new Error("warden_candidate_delivery_intent_conflict");
  }
  // Idempotent: the same intent is already bound. Safe to return without re-writing.
  if (current.intentDigest === input.intentDigest && current.branchName === input.branchName) {
    return current;
  }
  // Fail closed: the intent fence must only bind against a delivery that is still pending. A row that
  // has already gone terminal (e.g. delivery_failed after an exhausted-and-retried job) must not have
  // its intent silently discarded while the caller believes the binding persisted.
  const changed = db.raw.prepare(
    `UPDATE fettler_candidate_deliveries SET intent_digest = ?, branch_name = ?, intent_bound_at = COALESCE(intent_bound_at, ?), updated_at = ?
     WHERE id = ? AND tenant_id = ? AND status = 'delivery_pending'`,
  ).run(input.intentDigest, input.branchName, input.observedAt, input.observedAt, input.deliveryId, input.tenantId);
  if (Number(changed.changes) !== 1) throw new Error("warden_candidate_delivery_not_pending");
  return getWardenCandidateDelivery(db, input.tenantId, input.deliveryId)!;
}

export function refreshWardenCandidateDeliveryMissionAuthority(db: AppDb, input: Readonly<{
  tenantId: string; deliveryId: string; authority: MissionMutationAuthorityV1; observedAt: string;
}>): WardenCandidateDeliveryRecord {
  const authority = parseMissionMutationAuthority(input.authority);
  const changed = db.raw.prepare(`UPDATE fettler_candidate_deliveries SET mission_authority_json = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'delivery_pending' AND repository_id = ? AND snapshot_id = ?`).run(
    JSON.stringify(authority), input.observedAt, input.deliveryId, input.tenantId,
    authority.repositoryId, authority.snapshotId,
  );
  if (Number(changed.changes) !== 1) throw new Error("warden_candidate_delivery_authority_conflict");
  return getWardenCandidateDelivery(db, input.tenantId, input.deliveryId)!;
}

export function recordWardenCandidateDeliverySuccess(db: AppDb, input: {
  tenantId: string; deliveryId: string; branchName: string; baseRevision: string; commitSha: string;
  draftPrNumber: number; draftPrUrl: string; observedAt: string;
}) {
  const changed = db.raw.prepare(
    `UPDATE fettler_candidate_deliveries SET status = 'delivered', branch_name = ?, base_revision = ?, commit_sha = ?,
       draft_pr = 1, draft_pr_number = ?, draft_pr_url = ?, delivered_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
     WHERE id = ? AND tenant_id = ? AND status = 'delivery_pending'`,
  ).run(input.branchName, input.baseRevision, input.commitSha, input.draftPrNumber, input.draftPrUrl,
    input.observedAt, input.observedAt, input.deliveryId, input.tenantId);
  if (Number(changed.changes) !== 1) {
    // Idempotent: the identical PR was already recorded as delivered. Anything else must fail closed —
    // a success write against a terminal (e.g. delivery_failed) row must not be silently discarded and
    // then reported as success. A retried job that produced a real PR surfaces the inconsistency here
    // instead of leaving the row denying the PR exists.
    const existing = getWardenCandidateDelivery(db, input.tenantId, input.deliveryId);
    if (existing && existing.status === "delivered" &&
      existing.draftPrNumber === input.draftPrNumber && existing.commitSha === input.commitSha) {
      return existing;
    }
    throw new Error("warden_candidate_delivery_not_pending");
  }
  return getWardenCandidateDelivery(db, input.tenantId, input.deliveryId)!;
}

export function recordWardenCandidateDeliveryFailure(db: AppDb, input: {
  tenantId: string; deliveryId: string; errorCode: string; errorMessage: string; terminal: boolean; observedAt: string;
}) {
  db.raw.prepare(
    `UPDATE fettler_candidate_deliveries SET status = CASE WHEN ? THEN 'delivery_failed' ELSE status END,
       error_code = ?, error_message = ?, failed_at = CASE WHEN ? THEN ? ELSE failed_at END,
       last_error_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'delivery_pending'`,
  ).run(input.terminal ? 1 : 0, input.errorCode, input.errorMessage, input.terminal ? 1 : 0,
    input.observedAt, input.observedAt, input.observedAt, input.deliveryId, input.tenantId);
  return getWardenCandidateDelivery(db, input.tenantId, input.deliveryId)!;
}

/**
 * Resolve a delivered Fettler candidate delivery by the durable PR URL it
 * recorded at delivery time. This is a deliberate cross-tenant read: a GitHub
 * webhook carries no authenticated principal, so the tenant is derived from the
 * matched row and used to scope the subsequent outcome write. Returns undefined
 * when no delivered row (or more than one) owns the URL, so an ambiguous match
 * never writes an outcome to the wrong lane.
 */
export function findWardenCandidateDeliveryByPrUrl(
  db: AppDb,
  prUrl: string,
): WardenCandidateDeliveryRecord | undefined {
  if (typeof prUrl !== "string" || !prUrl.trim()) return undefined;
  const rows = db.raw.prepare(
    `SELECT * FROM fettler_candidate_deliveries
     WHERE draft_pr_url = ? AND status = 'delivered' AND draft_pr_number IS NOT NULL
     ORDER BY requested_at DESC LIMIT 2`,
  ).all(prUrl) as Row[];
  return rows.length === 1 ? map(rows[0]) : undefined;
}

/**
 * Record the delivered PR's real fate against the delivery that produced it.
 * Tenant-scoped from the caller's derived principal (never a request body), so a
 * cross-tenant write matches no row and fails closed. Enforces the legal outcome
 * transitions and is idempotent when the same outcome is re-delivered.
 */
export function recordWardenCandidateDeliveryOutcome(db: AppDb, input: {
  tenantId: string; deliveryId: string; outcome: WardenCandidateDeliveryOutcome;
  source: string; observedAt: string;
}): WardenCandidateDeliveryRecord {
  const tenantId = text(input.tenantId, "warden_candidate_delivery_tenant_invalid", 200);
  const deliveryId = id(input.deliveryId, "warden_candidate_delivery_id_invalid");
  if (!OUTCOMES.includes(input.outcome)) {
    throw new Error("warden_candidate_delivery_outcome_invalid");
  }
  const source = text(input.source, "warden_candidate_delivery_outcome_source_invalid", 500);
  const observedAt = timestamp(input.observedAt, "warden_candidate_delivery_timestamp_invalid");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = getWardenCandidateDelivery(db, tenantId, deliveryId);
    if (!current) throw new Error("warden_candidate_delivery_outcome_not_found");
    if (current.status !== "delivered" || current.draftPrNumber === null) {
      throw new Error("warden_candidate_delivery_outcome_not_delivered");
    }
    if (current.outcome !== input.outcome && !outcomeTransitionAllowed(current.outcome, input.outcome)) {
      throw new Error("warden_candidate_delivery_outcome_transition_invalid");
    }
    if (current.outcome !== input.outcome) {
      const changed = db.raw.prepare(
        `UPDATE fettler_candidate_deliveries
         SET outcome = ?, outcome_at = ?, outcome_source = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND status = 'delivered' AND outcome IS ?`,
      ).run(input.outcome, observedAt, source, observedAt, deliveryId, tenantId, current.outcome);
      if (Number(changed.changes) !== 1) {
        throw new Error("warden_candidate_delivery_outcome_conflict");
      }
    }
    const updated = getWardenCandidateDelivery(db, tenantId, deliveryId)!;
    if (owns) db.raw.exec("COMMIT");
    if (input.outcome === "merged" && updated.missionAuthority) {
      replayWardenCandidateDeliveryMergedOutcome(db, tenantId, deliveryId, observedAt);
    }
    return getWardenCandidateDelivery(db, tenantId, deliveryId)!;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}
