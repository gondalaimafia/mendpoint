import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BRANCH = /^(?!\/)(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;
const CHECK = /^check:[1-9][0-9]{0,19}:[A-Za-z0-9][A-Za-z0-9 ._\/-]{0,199}$/;

export type WardenCiCycleStatus =
  | "observation_pending" | "checks_running" | "checks_failed" | "repair_pending"
  | "candidate_ready" | "update_pending" | "awaiting_review" | "succeeded" | "paused" | "exhausted";

export type WardenCiCycle = Readonly<{
  id: string; tenantId: string; deliveryId: string; observationJobId: string;
  status: WardenCiCycleStatus; repositoryId: string; remoteRepositoryId: number;
  installationId: number; pullRequestNumber: number; baseBranch: string; branchName: string;
  baseRevision: string; currentHeadSha: string; requiredChecks: readonly string[];
  allowedChangedPaths: readonly string[]; maxCycles: number; usedCycles: number;
  maxModelCalls: number; maximumCostUsd: number; currentObservationDigest: string | null;
  repairRunId: string | null; repairJobId: string | null; pausedBy: string | null;
  pauseReason: string | null; createdAt: string; updatedAt: string;
}>;

export type WardenCiObservation = Readonly<{
  id: string; tenantId: string; cycleId: string; headSha: string;
  verdict: "success" | "failure" | "running" | "missing";
  observationDigest: string; evidenceArtifactId: string; evidenceDigest: string; observedAt: string;
}>;

export type WardenCiUpdate = Readonly<{
  id: string; tenantId: string; cycleId: string; repairRunId: string; jobId: string;
  status: "pending" | "intent_bound" | "uncertain" | "delivered" | "failed"; expectedHeadSha: string;
  expectedFeedbackDigest: string | null;
  sealedPath: string; sealedSha256: string; reviewerPrincipalId: string; rationale: string;
  intentDigest: string | null; commitSha: string | null; requestedAt: string;
  deliveredAt: string | null; updatedAt: string;
}>;

type CycleRow = {
  id: string; tenant_id: string; delivery_id: string; observation_job_id: string; status: string;
  repository_id: string; remote_repository_id: number; installation_id: number; pull_request_number: number;
  base_branch: string; branch_name: string; base_revision: string; current_head_sha: string;
  required_checks_json: string; allowed_changed_paths_json: string; max_cycles: number; used_cycles: number;
  max_model_calls: number; maximum_cost_usd: number; current_observation_digest: string | null;
  repair_run_id: string | null; repair_job_id: string | null; paused_by: string | null;
  pause_reason: string | null; created_at: string; updated_at: string;
};

type ObservationRow = {
  id: string; tenant_id: string; cycle_id: string; head_sha: string; verdict: WardenCiObservation["verdict"];
  observation_digest: string; evidence_artifact_id: string; evidence_digest: string; observed_at: string;
};

type UpdateRow = {
  id: string; tenant_id: string; cycle_id: string; repair_run_id: string; job_id: string;
  status: WardenCiUpdate["status"]; expected_head_sha: string; sealed_path: string;
  expected_feedback_digest: string | null;
  sealed_sha256: string; reviewer_principal_id: string; rationale: string;
  intent_digest: string | null; commit_sha: string | null; requested_at: string;
  delivered_at: string | null; updated_at: string;
};

function codeUnits(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function text(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\0\r]/.test(value)) throw new Error(code);
  return value.trim();
}
function id(value: unknown, code: string): string { const valueText = text(value, code, 200); if (!ID.test(valueText)) throw new Error(code); return valueText; }
function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error("warden_ci_timestamp_invalid");
  }
  return value;
}
function integer(value: unknown, min: number, max: number, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(code);
  return Number(value);
}
function digest(value: unknown, code: string): string { if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(code); return value; }
function sha(value: unknown, code: string): string { if (typeof value !== "string" || !SHA.test(value)) throw new Error(code); return value; }
function list(value: unknown, pattern: RegExp, max: number, code: string): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) throw new Error(code);
  const result = value.map((item) => text(item, code, 1_000));
  if (result.some((item) => !pattern.test(item)) || new Set(result).size !== result.length) throw new Error(code);
  return Object.freeze(result.sort(codeUnits));
}
function pathList(value: unknown): readonly string[] {
  return list(value, /^(?!\/)(?!.*(?:\.\.\/|\/\.\.?\/|\\|\/\/))[A-Za-z0-9._-][A-Za-z0-9._\/-]{0,999}$/, 1_000, "warden_ci_paths_invalid");
}
function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, 32)}`;
}

function cycle(row: CycleRow): WardenCiCycle {
  const statuses = new Set<WardenCiCycleStatus>(["observation_pending", "checks_running", "checks_failed", "repair_pending", "candidate_ready", "update_pending", "awaiting_review", "succeeded", "paused", "exhausted"]);
  if (!statuses.has(row.status as WardenCiCycleStatus)) throw new Error("warden_ci_cycle_corrupt");
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, deliveryId: row.delivery_id, observationJobId: row.observation_job_id,
    status: row.status as WardenCiCycleStatus, repositoryId: row.repository_id,
    remoteRepositoryId: row.remote_repository_id, installationId: row.installation_id,
    pullRequestNumber: row.pull_request_number, baseBranch: row.base_branch, branchName: row.branch_name,
    baseRevision: row.base_revision, currentHeadSha: row.current_head_sha,
    requiredChecks: Object.freeze(JSON.parse(row.required_checks_json) as string[]),
    allowedChangedPaths: Object.freeze(JSON.parse(row.allowed_changed_paths_json) as string[]),
    maxCycles: row.max_cycles, usedCycles: row.used_cycles, maxModelCalls: row.max_model_calls,
    maximumCostUsd: row.maximum_cost_usd, currentObservationDigest: row.current_observation_digest,
    repairRunId: row.repair_run_id, repairJobId: row.repair_job_id, pausedBy: row.paused_by,
    pauseReason: row.pause_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

function observation(row: ObservationRow): WardenCiObservation {
  return Object.freeze({ id: row.id, tenantId: row.tenant_id, cycleId: row.cycle_id,
    headSha: row.head_sha, verdict: row.verdict, observationDigest: row.observation_digest,
    evidenceArtifactId: row.evidence_artifact_id, evidenceDigest: row.evidence_digest,
    observedAt: row.observed_at });
}

function update(row: UpdateRow): WardenCiUpdate {
  return Object.freeze({ id: row.id, tenantId: row.tenant_id, cycleId: row.cycle_id,
    repairRunId: row.repair_run_id, jobId: row.job_id, status: row.status,
    expectedHeadSha: row.expected_head_sha, sealedPath: row.sealed_path,
    expectedFeedbackDigest: row.expected_feedback_digest,
    sealedSha256: row.sealed_sha256, reviewerPrincipalId: row.reviewer_principal_id,
    rationale: row.rationale, intentDigest: row.intent_digest, commitSha: row.commit_sha,
    requestedAt: row.requested_at, deliveredAt: row.delivered_at, updatedAt: row.updated_at });
}

export function getWardenCiCycle(db: AppDb, tenantId: string, cycleId: string): WardenCiCycle | undefined {
  const row = db.raw.prepare("SELECT * FROM fettler_ci_cycles WHERE id = ? AND tenant_id = ?")
    .get(cycleId, tenantId) as CycleRow | undefined;
  return row ? cycle(row) : undefined;
}

export function listWardenCiObservations(db: AppDb, tenantId: string, cycleId: string): readonly WardenCiObservation[] {
  return Object.freeze((db.raw.prepare(
    "SELECT * FROM fettler_ci_observations WHERE tenant_id = ? AND cycle_id = ? ORDER BY observed_at, id",
  ).all(tenantId, cycleId) as ObservationRow[]).map(observation));
}

export type WardenCiReviewWakeResult = Readonly<{
  status: "woken" | "already_active" | "terminal" | "not_found";
  cycle: WardenCiCycle | null;
}>;

export function wakeWardenCiReviewObservation(db: AppDb, input: Readonly<{
  tenantId: string;
  remoteRepositoryId: number;
  installationId: number;
  pullRequestNumber: number;
  headSha: string;
  wakeId: string;
  observedAt: string;
}>): WardenCiReviewWakeResult {
  const tenantId = text(input.tenantId, "warden_ci_tenant_invalid", 200);
  const remoteRepositoryId = integer(input.remoteRepositoryId, 1, Number.MAX_SAFE_INTEGER,
    "warden_ci_remote_repository_invalid");
  const installationId = integer(input.installationId, 1, Number.MAX_SAFE_INTEGER,
    "warden_ci_installation_invalid");
  const pullRequestNumber = integer(input.pullRequestNumber, 1, Number.MAX_SAFE_INTEGER,
    "warden_ci_pull_request_invalid");
  const headSha = sha(input.headSha, "warden_ci_head_invalid");
  const wakeId = id(input.wakeId, "warden_ci_review_wake_invalid");
  const observedAt = timestamp(input.observedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.raw.prepare(`SELECT * FROM fettler_ci_cycles
      WHERE tenant_id = ? AND remote_repository_id = ? AND installation_id = ?
        AND pull_request_number = ? AND current_head_sha = ?
      ORDER BY id`).all(tenantId, remoteRepositoryId, installationId, pullRequestNumber, headSha) as CycleRow[];
    if (rows.length === 0) {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "not_found" as const, cycle: null });
    }
    if (rows.length !== 1) throw new Error("warden_ci_review_wake_ambiguous");
    const current = cycle(rows[0]!);
    if (current.status === "paused" || current.status === "exhausted") {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "terminal" as const, cycle: current });
    }
    if (current.status !== "awaiting_review" && current.status !== "succeeded") {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "already_active" as const, cycle: current });
    }
    const observationJobId = stableId("wardenciobservejob", current.tenantId, current.id, headSha, wakeId);
    const priorJob = db.raw.prepare("SELECT 1 AS found FROM jobs WHERE id = ? AND tenant_id = ?")
      .get(observationJobId, current.tenantId) as { found: number } | undefined;
    if (priorJob) {
      if (owns) db.raw.exec("COMMIT");
      return Object.freeze({ status: "already_active" as const, cycle: current });
    }
    db.raw.prepare(`INSERT INTO jobs
      (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
      VALUES (?, ?, 'warden.candidate.observe', ?, 'pending', 0, 100, ?, ?, 0)`)
      .run(observationJobId, current.tenantId,
        JSON.stringify({ cycleId: current.id, deliveryId: current.deliveryId }), observedAt, observedAt);
    const changed = db.raw.prepare(`UPDATE fettler_ci_cycles
      SET status = 'observation_pending', observation_job_id = ?, current_observation_digest = NULL,
          repair_run_id = NULL, repair_job_id = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('awaiting_review','succeeded') AND current_head_sha = ?`)
      .run(observationJobId, observedAt, current.id, current.tenantId, headSha);
    if (Number(changed.changes) !== 1) throw new Error("warden_ci_review_wake_not_authorized");
    const updated = getWardenCiCycle(db, current.tenantId, current.id)!;
    if (owns) db.raw.exec("COMMIT");
    return Object.freeze({ status: "woken" as const, cycle: updated });
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function enqueueWardenCiCycle(db: AppDb, input: Readonly<{
  tenantId: string; deliveryId: string; repositoryId: string; remoteRepositoryId: number;
  installationId: number; requiredChecks: readonly string[]; allowedChangedPaths: readonly string[];
  maxCycles: number; maxModelCalls: number; maximumCostUsd: number; observedAt: string;
}>): WardenCiCycle {
  const tenantId = text(input.tenantId, "warden_ci_tenant_invalid", 200);
  const deliveryId = id(input.deliveryId, "warden_ci_delivery_invalid");
  const repositoryId = id(input.repositoryId, "warden_ci_repository_invalid");
  const remoteRepositoryId = integer(input.remoteRepositoryId, 1, Number.MAX_SAFE_INTEGER, "warden_ci_remote_repository_invalid");
  const installationId = integer(input.installationId, 1, Number.MAX_SAFE_INTEGER, "warden_ci_installation_invalid");
  const requiredChecks = list(input.requiredChecks, CHECK, 50, "warden_ci_checks_invalid");
  const allowedPaths = pathList(input.allowedChangedPaths);
  const maxCycles = integer(input.maxCycles, 1, 20, "warden_ci_budget_invalid");
  const maxModelCalls = integer(input.maxModelCalls, 1, 100, "warden_ci_budget_invalid");
  if (maxModelCalls < maxCycles) throw new Error("warden_ci_budget_invalid");
  if (!Number.isFinite(input.maximumCostUsd) || input.maximumCostUsd <= 0 || input.maximumCostUsd > 1_000) throw new Error("warden_ci_budget_invalid");
  const observedAt = timestamp(input.observedAt);
  const delivery = db.raw.prepare("SELECT * FROM fettler_candidate_deliveries WHERE id = ? AND tenant_id = ?")
    .get(deliveryId, tenantId) as Record<string, unknown> | undefined;
  if (!delivery || delivery.status !== "delivered" || delivery.repository_id !== repositoryId ||
      typeof delivery.branch_name !== "string" || !BRANCH.test(delivery.branch_name) ||
      !SHA.test(String(delivery.base_revision)) || !SHA.test(String(delivery.commit_sha)) ||
      !Number.isSafeInteger(delivery.draft_pr_number)) throw new Error("warden_ci_delivery_not_authorized");
  const cycleId = stableId("wardencicycle", tenantId, deliveryId);
  const jobId = stableId("wardenciobservejob", tenantId, deliveryId);
  const existing = getWardenCiCycle(db, tenantId, cycleId);
  if (existing) {
    if (existing.deliveryId !== deliveryId || existing.repositoryId !== repositoryId ||
        existing.remoteRepositoryId !== remoteRepositoryId || existing.installationId !== installationId ||
        JSON.stringify(existing.requiredChecks) !== JSON.stringify(requiredChecks) ||
        JSON.stringify(existing.allowedChangedPaths) !== JSON.stringify(allowedPaths) ||
        existing.maxCycles !== maxCycles || existing.maxModelCalls !== maxModelCalls ||
        existing.maximumCostUsd !== input.maximumCostUsd) throw new Error("warden_ci_cycle_conflict");
    return existing;
  }
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.prepare(`INSERT INTO jobs
      (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
      VALUES (?, ?, 'warden.candidate.observe', ?, 'pending', 0, 100, ?, ?, 0)`)
      .run(jobId, tenantId, JSON.stringify({ cycleId, deliveryId }), observedAt, observedAt);
    db.raw.prepare(`INSERT INTO fettler_ci_cycles
      (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
       installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
       required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
       maximum_cost_usd, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'observation_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
      .run(cycleId, tenantId, deliveryId, jobId, repositoryId, remoteRepositoryId, installationId,
        Number(delivery.draft_pr_number), String(delivery.base_branch), String(delivery.branch_name),
        String(delivery.base_revision), String(delivery.commit_sha), JSON.stringify(requiredChecks),
        JSON.stringify(allowedPaths), maxCycles, maxModelCalls, input.maximumCostUsd, observedAt, observedAt);
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getWardenCiCycle(db, tenantId, cycleId)!;
}

export function recordWardenCiObservation(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; headSha: string; verdict: WardenCiObservation["verdict"];
  observationDigest: string; evidenceArtifactId: string; evidenceDigest: string; observedAt: string;
}>): WardenCiObservation {
  const cycleId = id(input.cycleId, "warden_ci_cycle_invalid");
  const current = getWardenCiCycle(db, input.tenantId, cycleId);
  if (!current) throw new Error("warden_ci_cycle_not_found");
  if (current.status === "paused" || current.status === "succeeded" || current.status === "exhausted") throw new Error("warden_ci_cycle_terminal");
  const headSha = sha(input.headSha, "warden_ci_head_invalid");
  if (headSha !== current.currentHeadSha) throw new Error("warden_ci_head_drift");
  if (!["success", "failure", "running", "missing"].includes(input.verdict)) throw new Error("warden_ci_verdict_invalid");
  const observationDigest = digest(input.observationDigest, "warden_ci_observation_digest_invalid");
  const evidenceArtifactId = id(input.evidenceArtifactId, "warden_ci_evidence_invalid");
  const evidenceDigest = digest(input.evidenceDigest, "warden_ci_evidence_invalid");
  const observedAt = timestamp(input.observedAt);
  const observationId = stableId("wardenciobservation", current.tenantId, cycleId, headSha, observationDigest);
  const prior = db.raw.prepare("SELECT * FROM fettler_ci_observations WHERE id = ? AND tenant_id = ?")
    .get(observationId, current.tenantId) as ObservationRow | undefined;
  if (prior) {
    const mapped = observation(prior);
    if (mapped.verdict !== input.verdict || mapped.evidenceArtifactId !== evidenceArtifactId ||
        mapped.evidenceDigest !== evidenceDigest || mapped.observedAt !== observedAt) throw new Error("warden_ci_observation_conflict");
    return mapped;
  }
  const nextStatus = input.verdict === "success" ? "awaiting_review" : input.verdict === "failure" ? "checks_failed" : "checks_running";
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.prepare(`INSERT INTO fettler_ci_observations
      (id, tenant_id, cycle_id, head_sha, verdict, observation_digest, evidence_artifact_id, evidence_digest, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(observationId, current.tenantId, cycleId, headSha, input.verdict, observationDigest,
        evidenceArtifactId, evidenceDigest, observedAt);
    if (input.verdict === "failure") {
      const repairDispatchJobId = stableId("wardencirepairdispatch", current.tenantId, cycleId, headSha, observationDigest);
      db.raw.prepare(`INSERT INTO jobs
        (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
        VALUES (?, ?, 'warden.candidate.repair', ?, 'pending', 0, 20, ?, ?, 0)
        ON CONFLICT(id) DO NOTHING`)
        .run(repairDispatchJobId, current.tenantId,
          JSON.stringify({ cycleId, observationId, observationDigest }), observedAt, observedAt);
    }
    db.raw.prepare(`UPDATE fettler_ci_cycles SET status = ?, current_observation_digest = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND current_head_sha = ?`)
      .run(nextStatus, observationDigest, observedAt, cycleId, current.tenantId, headSha);
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return observation(db.raw.prepare("SELECT * FROM fettler_ci_observations WHERE id = ?").get(observationId) as ObservationRow);
}

export function beginWardenCiRepair(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; observationDigest: string; repairRunId: string;
  repairJobId: string; observedAt: string;
}>): WardenCiCycle {
  const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
  if (!current) throw new Error("warden_ci_cycle_not_found");
  if (current.status === "paused") throw new Error("warden_ci_cycle_paused");
  if (current.status === "repair_pending") {
    if (current.repairRunId === input.repairRunId && current.repairJobId === input.repairJobId &&
        current.currentObservationDigest === input.observationDigest) return current;
    throw new Error("warden_ci_repair_conflict");
  }
  if (current.status !== "checks_failed" || current.currentObservationDigest !== digest(input.observationDigest, "warden_ci_observation_digest_invalid")) {
    throw new Error("warden_ci_repair_not_authorized");
  }
  if (current.usedCycles >= current.maxCycles) {
    throw new Error("warden_ci_budget_exhausted");
  }
  const repairRunId = id(input.repairRunId, "warden_ci_repair_run_invalid");
  const repairJobId = id(input.repairJobId, "warden_ci_repair_job_invalid");
  db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'repair_pending', used_cycles = used_cycles + 1,
    repair_run_id = ?, repair_job_id = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'checks_failed' AND used_cycles < max_cycles`)
    .run(repairRunId, repairJobId, timestamp(input.observedAt), current.id, current.tenantId);
  return getWardenCiCycle(db, current.tenantId, current.id)!;
}

export function exhaustWardenCiCycle(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; observationDigest: string; observedAt: string;
}>): WardenCiCycle {
  const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
  if (!current) throw new Error("warden_ci_cycle_not_found");
  if (current.status === "exhausted") return current;
  if (current.status !== "checks_failed" || current.usedCycles < current.maxCycles ||
      current.currentObservationDigest !== digest(input.observationDigest, "warden_ci_observation_digest_invalid")) {
    throw new Error("warden_ci_exhaustion_not_authorized");
  }
  const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'exhausted', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'checks_failed' AND used_cycles >= max_cycles
      AND current_observation_digest = ?`)
    .run(timestamp(input.observedAt), current.id, current.tenantId, current.currentObservationDigest);
  if (Number(changed.changes) !== 1) throw new Error("warden_ci_exhaustion_not_authorized");
  return getWardenCiCycle(db, current.tenantId, current.id)!;
}

export function pauseWardenCiCycle(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; actorPrincipalId: string; reason: string; observedAt: string;
}>): WardenCiCycle {
  const actor = text(input.actorPrincipalId, "warden_ci_pause_actor_invalid", 500);
  const reason = text(input.reason, "warden_ci_pause_reason_invalid", 2_000);
  const observedAt = timestamp(input.observedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
    if (!current) throw new Error("warden_ci_cycle_not_found");
    if (current.status === "exhausted") throw new Error("warden_ci_cycle_terminal");
    const mutation = db.raw.prepare(`SELECT 1 AS active FROM fettler_ci_updates update_row
      JOIN jobs job ON job.id = update_row.job_id AND job.tenant_id = update_row.tenant_id
      WHERE update_row.tenant_id = ? AND update_row.cycle_id = ? AND update_row.status = 'intent_bound'
        AND job.status = 'running' AND job.lease_expires_at > ? LIMIT 1`)
      .get(current.tenantId, current.id, observedAt) as { active: number } | undefined;
    if (mutation) throw new Error("warden_ci_mutation_in_flight");
    db.raw.prepare(`UPDATE fettler_ci_updates SET status = 'uncertain', updated_at = ?
      WHERE tenant_id = ? AND cycle_id = ? AND status = 'intent_bound'`)
      .run(observedAt, current.tenantId, current.id);
    const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'paused', paused_by = ?, pause_reason = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
        AND NOT EXISTS (SELECT 1 FROM fettler_ci_updates update_row
          JOIN jobs job ON job.id = update_row.job_id AND job.tenant_id = update_row.tenant_id
          WHERE update_row.tenant_id = ? AND update_row.cycle_id = ? AND update_row.status = 'intent_bound'
            AND job.status = 'running' AND job.lease_expires_at > ?)`)
      .run(actor, reason, observedAt, current.id, current.tenantId, current.tenantId, current.id, observedAt);
    if (Number(changed.changes) !== 1) throw new Error("warden_ci_mutation_in_flight");
    if (owns) db.raw.exec("COMMIT");
    return getWardenCiCycle(db, current.tenantId, current.id)!;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function rebindWardenCiRepair(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; currentRepairRunId: string; nextRepairRunId: string;
  nextRepairJobId: string; observedAt: string;
}>): WardenCiCycle {
  const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
  if (!current || current.status !== "repair_pending" ||
      current.repairRunId !== id(input.currentRepairRunId, "warden_ci_repair_run_invalid")) {
    throw new Error("warden_ci_repair_rebind_not_authorized");
  }
  if (current.usedCycles >= current.maxCycles) throw new Error("warden_ci_budget_exhausted");
  const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET repair_run_id = ?, repair_job_id = ?,
    used_cycles = used_cycles + 1, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'repair_pending' AND repair_run_id = ?
      AND used_cycles < max_cycles`)
    .run(id(input.nextRepairRunId, "warden_ci_repair_run_invalid"),
      id(input.nextRepairJobId, "warden_ci_repair_job_invalid"), timestamp(input.observedAt),
      current.id, current.tenantId, current.repairRunId);
  if (Number(changed.changes) !== 1) throw new Error("warden_ci_repair_rebind_not_authorized");
  return getWardenCiCycle(db, current.tenantId, current.id)!;
}

export function settleWardenCiRepairWithoutCandidate(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; repairRunId: string; reason: string; observedAt: string;
}>): WardenCiCycle {
  const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
  if (!current) throw new Error("warden_ci_cycle_not_found");
  const repairRunId = id(input.repairRunId, "warden_ci_repair_run_invalid");
  const reason = text(input.reason, "warden_ci_pause_reason_invalid", 2_000);
  if (current.status === "paused" && current.repairRunId === repairRunId &&
      current.pausedBy === "warden-ci-system" && current.pauseReason === reason) return current;
  if (current.status !== "repair_pending" || current.repairRunId !== repairRunId) {
    throw new Error("warden_ci_repair_settlement_not_authorized");
  }
  const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'paused', paused_by = 'warden-ci-system',
    pause_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status = 'repair_pending'
      AND repair_run_id = ?`)
    .run(reason, timestamp(input.observedAt), current.id, current.tenantId, repairRunId);
  if (Number(changed.changes) !== 1) throw new Error("warden_ci_repair_settlement_not_authorized");
  return getWardenCiCycle(db, current.tenantId, current.id)!;
}

export function failWardenCiOperation(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; jobId: string; reason: string; observedAt: string;
}>): WardenCiCycle {
  const current = getWardenCiCycle(db, input.tenantId, input.cycleId);
  if (!current) throw new Error("warden_ci_cycle_not_found");
  const jobId = id(input.jobId, "warden_ci_operation_job_invalid");
  const updateRow = db.raw.prepare(`SELECT id FROM fettler_ci_updates
    WHERE tenant_id = ? AND cycle_id = ? AND job_id = ? LIMIT 1`)
    .get(current.tenantId, current.id, jobId) as { id: string } | undefined;
  const operationJob = db.raw.prepare(`SELECT 1 AS active FROM jobs WHERE id = ? AND tenant_id = ?
    AND type IN ('warden.candidate.observe','warden.candidate.repair','warden.candidate.update')
    AND json_valid(payload_json) = 1 AND json_extract(payload_json, '$.cycleId') = ? LIMIT 1`)
    .get(jobId, current.tenantId, current.id) as { active: number } | undefined;
  if (!operationJob || (current.observationJobId !== jobId && current.repairJobId !== jobId && !updateRow &&
      current.status !== "checks_failed")) {
    throw new Error("warden_ci_operation_failure_not_authorized");
  }
  const reason = text(input.reason, "warden_ci_pause_reason_invalid", 2_000);
  const observedAt = timestamp(input.observedAt);
  db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'paused', paused_by = 'warden-ci-system',
    pause_reason = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND status NOT IN ('succeeded','exhausted')`)
    .run(reason, observedAt, current.id, current.tenantId);
  if (updateRow) {
    db.raw.prepare(`UPDATE fettler_ci_updates SET status = 'failed', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending'`)
      .run(observedAt, updateRow.id, current.tenantId);
  }
  return getWardenCiCycle(db, current.tenantId, current.id)!;
}

export function getWardenCiUpdate(db: AppDb, tenantId: string, updateId: string): WardenCiUpdate | undefined {
  const row = db.raw.prepare("SELECT * FROM fettler_ci_updates WHERE id = ? AND tenant_id = ?")
    .get(updateId, tenantId) as UpdateRow | undefined;
  return row ? update(row) : undefined;
}

export function getWardenCiUpdateByRun(db: AppDb, tenantId: string, runId: string): WardenCiUpdate | undefined {
  const row = db.raw.prepare("SELECT * FROM fettler_ci_updates WHERE repair_run_id = ? AND tenant_id = ?")
    .get(runId, tenantId) as UpdateRow | undefined;
  return row ? update(row) : undefined;
}

export function enqueueWardenCiUpdate(db: AppDb, input: Readonly<{
  tenantId: string; cycleId: string; repairRunId: string; expectedHeadSha: string;
  expectedFeedbackDigest?: string | null;
  sealedPath: string; sealedSha256: string; reviewerPrincipalId: string; rationale: string;
  observedAt: string;
}>): WardenCiUpdate {
  const cycleId = id(input.cycleId, "warden_ci_cycle_invalid");
  const repairRunId = id(input.repairRunId, "warden_ci_repair_run_invalid");
  const expectedHeadSha = sha(input.expectedHeadSha, "warden_ci_head_invalid");
  const expectedFeedbackDigest = input.expectedFeedbackDigest === undefined || input.expectedFeedbackDigest === null
    ? null : digest(input.expectedFeedbackDigest, "warden_ci_feedback_digest_invalid");
  const sealedPath = text(input.sealedPath, "warden_ci_update_seal_invalid", 4_000);
  const sealedSha256 = digest(input.sealedSha256, "warden_ci_update_seal_invalid");
  const reviewerPrincipalId = text(input.reviewerPrincipalId, "warden_ci_update_reviewer_invalid", 500);
  const rationale = text(input.rationale, "warden_ci_update_rationale_invalid", 2_000);
  const observedAt = timestamp(input.observedAt);
  const cycle = getWardenCiCycle(db, input.tenantId, cycleId);
  if (!cycle) throw new Error("warden_ci_update_not_authorized");
  const updateId = stableId("wardenciupdate", cycle.tenantId, cycleId, repairRunId, expectedHeadSha,
    expectedFeedbackDigest ?? "no-review-feedback");
  const jobId = stableId("wardenciupdatejob", cycle.tenantId, updateId);
  const prior = getWardenCiUpdate(db, cycle.tenantId, updateId);
  if (prior) {
    if (prior.expectedHeadSha !== expectedHeadSha || prior.expectedFeedbackDigest !== expectedFeedbackDigest ||
        prior.sealedPath !== sealedPath ||
        prior.sealedSha256 !== sealedSha256 || prior.reviewerPrincipalId !== reviewerPrincipalId ||
        prior.rationale !== rationale) throw new Error("warden_ci_update_conflict");
    return prior;
  }
  if (cycle.status !== "repair_pending" || cycle.repairRunId !== repairRunId ||
      cycle.currentHeadSha !== expectedHeadSha) throw new Error("warden_ci_update_not_authorized");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.prepare(`INSERT INTO jobs
      (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
      VALUES (?, ?, 'warden.candidate.update', ?, 'pending', 0, 20, ?, ?, 0)`)
      .run(jobId, cycle.tenantId, JSON.stringify({ cycleId, updateId }), observedAt, observedAt);
    db.raw.prepare(`INSERT INTO fettler_ci_updates
      (id, tenant_id, cycle_id, repair_run_id, job_id, status, expected_head_sha, expected_feedback_digest, sealed_path,
       sealed_sha256, reviewer_principal_id, rationale, requested_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(updateId, cycle.tenantId, cycleId, repairRunId, jobId, expectedHeadSha, expectedFeedbackDigest, sealedPath,
        sealedSha256, reviewerPrincipalId, rationale, observedAt, observedAt);
    const changed = db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'update_pending', updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'repair_pending' AND repair_run_id = ? AND current_head_sha = ?`)
      .run(observedAt, cycleId, cycle.tenantId, repairRunId, expectedHeadSha);
    if (Number(changed.changes) !== 1) throw new Error("warden_ci_update_not_authorized");
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getWardenCiUpdate(db, cycle.tenantId, updateId)!;
}

export function bindWardenCiUpdateIntent(db: AppDb, input: Readonly<{
  tenantId: string; updateId: string; intentDigest: string; workerId: string;
  leaseGeneration: number; observedAt: string;
}>): WardenCiUpdate {
  const intentDigest = digest(input.intentDigest, "warden_ci_update_intent_invalid");
  const observedAt = timestamp(input.observedAt);
  const workerId = text(input.workerId, "warden_ci_update_lease_invalid", 500);
  const leaseGeneration = integer(input.leaseGeneration, 1, Number.MAX_SAFE_INTEGER, "warden_ci_update_lease_invalid");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = getWardenCiUpdate(db, input.tenantId, input.updateId);
    if (!current) throw new Error("warden_ci_update_not_found");
    if (current.intentDigest && current.intentDigest !== intentDigest) throw new Error("warden_ci_update_intent_conflict");
    if (current.status === "intent_bound") {
      if (owns) db.raw.exec("COMMIT");
      return current;
    }
    const changed = db.raw.prepare(`UPDATE fettler_ci_updates SET status = 'intent_bound', intent_digest = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('pending','uncertain')
        AND (intent_digest IS NULL OR intent_digest = ?)
        AND EXISTS (SELECT 1 FROM fettler_ci_cycles cycle WHERE cycle.id = cycle_id
          AND cycle.tenant_id = tenant_id AND cycle.status = 'update_pending'
          AND cycle.current_head_sha = expected_head_sha)
        AND EXISTS (SELECT 1 FROM jobs job WHERE job.id = job_id AND job.tenant_id = tenant_id
          AND job.status = 'running' AND job.lease_owner = ? AND job.lease_generation = ?
          AND job.lease_expires_at > ?)`)
      .run(intentDigest, observedAt, current.id, current.tenantId, intentDigest,
        workerId, leaseGeneration, observedAt);
    if (Number(changed.changes) !== 1) throw new Error("warden_ci_update_not_authorized");
    if (owns) db.raw.exec("COMMIT");
    return getWardenCiUpdate(db, current.tenantId, current.id)!;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function markWardenCiUpdateUncertain(db: AppDb, input: Readonly<{
  tenantId: string; updateId: string; intentDigest: string; observedAt: string;
}>): WardenCiUpdate {
  const intentDigest = digest(input.intentDigest, "warden_ci_update_intent_invalid");
  const changed = db.raw.prepare(`UPDATE fettler_ci_updates SET status = 'uncertain', updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'intent_bound' AND intent_digest = ?`)
    .run(timestamp(input.observedAt), input.updateId, input.tenantId, intentDigest);
  if (Number(changed.changes) !== 1) throw new Error("warden_ci_update_uncertain_not_authorized");
  return getWardenCiUpdate(db, input.tenantId, input.updateId)!;
}

export function completeWardenCiUpdate(db: AppDb, input: Readonly<{
  tenantId: string; updateId: string; expectedHeadSha: string; commitSha: string; observedAt: string;
}>): WardenCiUpdate {
  const current = getWardenCiUpdate(db, input.tenantId, input.updateId);
  if (!current) throw new Error("warden_ci_update_not_found");
  const expectedHeadSha = sha(input.expectedHeadSha, "warden_ci_head_invalid");
  const commitSha = sha(input.commitSha, "warden_ci_commit_invalid");
  const observedAt = timestamp(input.observedAt);
  if (commitSha === expectedHeadSha || expectedHeadSha !== current.expectedHeadSha || !current.intentDigest) {
    throw new Error("warden_ci_update_result_invalid");
  }
  if (current.status === "delivered") {
    if (current.commitSha !== commitSha) throw new Error("warden_ci_update_conflict");
    return current;
  }
  const cycle = getWardenCiCycle(db, current.tenantId, current.cycleId);
  if (!cycle || !["update_pending", "paused"].includes(cycle.status) || cycle.currentHeadSha !== expectedHeadSha) {
    throw new Error("warden_ci_update_not_authorized");
  }
  const nextObservationJobId = stableId("wardenciobservejob", cycle.tenantId, cycle.id, commitSha);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (cycle.status === "update_pending") db.raw.prepare(`INSERT INTO jobs
      (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at, available_at, lease_generation)
      VALUES (?, ?, 'warden.candidate.observe', ?, 'pending', 0, 100, ?, ?, 0)`)
      .run(nextObservationJobId, cycle.tenantId, JSON.stringify({ cycleId: cycle.id, deliveryId: cycle.deliveryId }),
        observedAt, observedAt);
    const completed = db.raw.prepare(`UPDATE fettler_ci_updates SET status = 'delivered', commit_sha = ?, delivered_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status IN ('intent_bound','uncertain')`)
      .run(commitSha, observedAt, observedAt, current.id, current.tenantId);
    if (Number(completed.changes) !== 1) throw new Error("warden_ci_update_not_authorized");
    const advanced = cycle.status === "paused" ? { changes: 1 } : db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'observation_pending',
      observation_job_id = ?, current_head_sha = ?, current_observation_digest = NULL,
      repair_run_id = NULL, repair_job_id = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'update_pending' AND current_head_sha = ?`)
      .run(nextObservationJobId, commitSha, observedAt, cycle.id, cycle.tenantId, expectedHeadSha);
    if (cycle.status === "paused") {
      const reconciled = db.raw.prepare(`UPDATE fettler_ci_cycles SET current_head_sha = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'paused' AND current_head_sha = ?`)
        .run(commitSha, observedAt, cycle.id, cycle.tenantId, expectedHeadSha);
      if (Number(reconciled.changes) !== 1) throw new Error("warden_ci_update_not_authorized");
    } else if (Number(advanced.changes) !== 1) throw new Error("warden_ci_update_not_authorized");
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getWardenCiUpdate(db, current.tenantId, current.id)!;
}
