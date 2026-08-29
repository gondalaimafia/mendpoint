import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { contentDigest, exactUtc } from "./mission-record-content.js";
import {
  bindMissionPolicyEnvelopeVersion,
  getMission,
  type Mission,
} from "./mission.js";

// Persistence for the §6.7 / §8.18 Policy Envelope. The envelope body is opaque
// canonical JSON here — @mendpoint/policy owns the PolicyEnvelope type, its
// canonical serializer, and the deterministic evaluator. This module only makes
// an envelope RETAINED (immutable by tenant+version) and INHERITABLE (a mission
// pins a version and can read the exact envelope back). Keeping the type in the
// policy package avoids a db -> policy dependency and a duplicate policy platform
// (spec §31.7): there is one envelope shape, defined once, persisted here.

export type StoredPolicyEnvelope = Readonly<{
  tenantId: string;
  version: number;
  policyEnvelopeId: string;
  envelopeJson: string;
  contentSha256: string;
  createdAt: string;
}>;

type StoredPolicyEnvelopeRow = {
  tenant_id: string; version: number; policy_envelope_id: string;
  envelope_json: string; content_sha256: string; created_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function hydrate(row: StoredPolicyEnvelopeRow): StoredPolicyEnvelope {
  return Object.freeze({
    tenantId: row.tenant_id, version: row.version, policyEnvelopeId: row.policy_envelope_id,
    envelopeJson: row.envelope_json, contentSha256: row.content_sha256, createdAt: row.created_at,
  });
}

/**
 * Persist a Policy Envelope version. Immutable and idempotent by
 * (tenant_id, version): re-creating the same (tenant, version) with byte-identical
 * canonical JSON returns the existing row; re-creating it with different content
 * fails closed with `policy_envelope_version_conflict`, so a pinned envelope can
 * never be silently rewritten under a mission that inherited it.
 */
export function createPolicyEnvelope(db: AppDb, input: {
  tenantId: string; version: number; policyEnvelopeId: string; envelopeJson: string; createdAt: string;
}): StoredPolicyEnvelope {
  if (!Number.isInteger(input.version) || input.version < 1) throw new Error("policy_envelope_version_invalid");
  if (!input.tenantId.trim()) throw new Error("policy_envelope_tenant_invalid");
  if (!input.policyEnvelopeId.trim()) throw new Error("policy_envelope_id_invalid");
  if (!input.envelopeJson.trim()) throw new Error("policy_envelope_body_invalid");
  const contentSha256 = createHash("sha256").update(input.envelopeJson, "utf8").digest("hex");
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<StoredPolicyEnvelopeRow>(db,
      `SELECT * FROM policy_envelopes WHERE tenant_id = ? AND version = ?`, [input.tenantId, input.version]);
    if (existing) {
      if (existing.content_sha256 !== contentSha256) throw new Error("policy_envelope_version_conflict");
      if (owns) db.raw.exec("COMMIT");
      return hydrate(existing);
    }
    if (!one(db, `SELECT id FROM tenants WHERE id = ?`, [input.tenantId])) {
      throw new Error("policy_envelope_tenant_not_found");
    }
    db.raw.prepare(`INSERT INTO policy_envelopes
      (tenant_id, version, policy_envelope_id, envelope_json, content_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(input.tenantId, input.version, input.policyEnvelopeId,
        input.envelopeJson, contentSha256, input.createdAt);
    const value = hydrate(one<StoredPolicyEnvelopeRow>(db,
      `SELECT * FROM policy_envelopes WHERE tenant_id = ? AND version = ?`, [input.tenantId, input.version])!);
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

export function getPolicyEnvelope(db: AppDb, tenantId: string, version: number): StoredPolicyEnvelope | undefined {
  const row = one<StoredPolicyEnvelopeRow>(db,
    `SELECT * FROM policy_envelopes WHERE tenant_id = ? AND version = ?`, [tenantId, version]);
  return row ? hydrate(row) : undefined;
}

/**
 * Bind a mission to a RETAINED Policy Envelope version: the envelope must already
 * exist for the mission's tenant, so the mission never pins a dangling policy
 * version. Delegates the set-once, revision-fenced write to
 * `bindMissionPolicyEnvelopeVersion`, storing the numeric version as its string
 * identity (spec §6.7: a mission retains the policy version its decisions were
 * made under).
 */
export function bindMissionToPolicyEnvelope(db: AppDb, input: {
  tenantId: string; missionId: string; version: number; actorPrincipalId: string;
  eventId: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; createdAt: string;
}): Mission {
  if (!getPolicyEnvelope(db, input.tenantId, input.version)) {
    throw new Error("mission_policy_envelope_not_found");
  }
  return bindMissionPolicyEnvelopeVersion(db, {
    tenantId: input.tenantId, missionId: input.missionId,
    policyEnvelopeVersion: String(input.version), actorPrincipalId: input.actorPrincipalId,
    eventId: input.eventId, idempotencyKey: input.idempotencyKey, correlationId: input.correlationId,
    causationId: input.causationId, createdAt: input.createdAt,
  });
}

/**
 * Resolve the exact Policy Envelope a mission inherited, or null when the mission
 * has not pinned one. This is the read side of policy inheritance: a task
 * compiler loads this and hands it to `evaluatePolicyEnvelope` (in
 * @mendpoint/policy) for deterministic enforcement.
 */
export function getMissionPolicyEnvelope(db: AppDb, tenantId: string, missionId: string): StoredPolicyEnvelope | null {
  const mission = getMission(db, tenantId, missionId);
  if (!mission || mission.policyEnvelopeVersion === null) return null;
  const version = Number(mission.policyEnvelopeVersion);
  if (!Number.isInteger(version)) return null;
  return getPolicyEnvelope(db, tenantId, version) ?? null;
}

export type MissionPolicyEvaluationStatus = "enforced" | "no_envelope" | "envelope_invalid";

export type MissionPolicyEvaluation = Readonly<{
  id: string;
  tenantId: string;
  missionId: string;
  envelopeVersion: number | null;
  status: MissionPolicyEvaluationStatus;
  allowed: boolean | null;
  reviewRequired: boolean | null;
  violations: readonly Readonly<{ code: string; detail: string }>[];
  taskDigest: string;
  createdAt: string;
}>;

type MissionPolicyEvaluationRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  envelope_version: number | null;
  status: MissionPolicyEvaluationStatus;
  allowed: number | null;
  review_required: number | null;
  violations_json: string;
  task_digest: string;
  created_at: string;
};

// The `mission_policy_evaluations` table (and its append-only triggers) lives in
// the static schema DDL in `./index.ts`, alongside the other mission durable
// records, so it materialises on open for fresh AND pre-change databases and is
// listed in the canonical schema — not created lazily on first write.

function hydrateEvaluation(row: MissionPolicyEvaluationRow): MissionPolicyEvaluation {
  const violations = JSON.parse(row.violations_json) as Array<{ code: string; detail: string }>;
  if (!Array.isArray(violations) || violations.some((item) => typeof item?.code !== "string" || typeof item?.detail !== "string")) {
    throw new Error("mission_policy_evaluation_violations_invalid");
  }
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    missionId: row.mission_id,
    envelopeVersion: row.envelope_version,
    status: row.status,
    allowed: row.allowed === null ? null : row.allowed === 1,
    reviewRequired: row.review_required === null ? null : row.review_required === 1,
    violations: Object.freeze(violations.map((item) => Object.freeze({ code: item.code, detail: item.detail }))),
    taskDigest: row.task_digest,
    createdAt: row.created_at,
  });
}

/**
 * Append one Policy Envelope evaluation fact for a Mission task. Idempotent on
 * the content digest (tenant is inside the digest). A later evaluation with
 * different bytes is a new row. Direct UPDATE/DELETE fail closed.
 */
export function recordMissionPolicyEvaluation(db: AppDb, input: {
  tenantId: string;
  missionId: string;
  envelopeVersion: number | null;
  status: MissionPolicyEvaluationStatus;
  allowed: boolean | null;
  reviewRequired: boolean | null;
  violations: readonly Readonly<{ code: string; detail: string }>[];
  taskDigest: string;
  createdAt: string;
}): MissionPolicyEvaluation {
  if (!input.tenantId.trim()) throw new Error("mission_policy_evaluation_tenant_invalid");
  if (!input.missionId.trim()) throw new Error("mission_policy_evaluation_mission_invalid");
  if (!/^[a-f0-9]{64}$/.test(input.taskDigest)) throw new Error("mission_policy_evaluation_task_digest_invalid");
  const createdAt = exactUtc(input.createdAt, "mission_policy_evaluation_created_at_invalid");
  if (input.status === "enforced" && (input.allowed === null || input.reviewRequired === null || input.envelopeVersion === null)) {
    throw new Error("mission_policy_evaluation_enforced_fields_required");
  }
  if (input.status !== "enforced" && (input.allowed !== null || input.reviewRequired !== null)) {
    throw new Error("mission_policy_evaluation_unenforced_fields_invalid");
  }
  if (input.status === "no_envelope" && input.envelopeVersion !== null) {
    throw new Error("mission_policy_evaluation_no_envelope_version_invalid");
  }
  const violations = [...input.violations]
    .map((item) => ({ code: item.code, detail: item.detail }))
    .sort((left, right) => left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail));
  const id = contentDigest({
    tenantId: input.tenantId,
    missionId: input.missionId,
    envelopeVersion: input.envelopeVersion,
    status: input.status,
    allowed: input.allowed,
    reviewRequired: input.reviewRequired,
    violations,
    taskDigest: input.taskDigest,
    createdAt,
  });
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<MissionPolicyEvaluationRow>(db,
      `SELECT * FROM mission_policy_evaluations WHERE id = ? AND tenant_id = ?`, [id, input.tenantId]);
    if (existing) {
      if (owns) db.raw.exec("COMMIT");
      return hydrateEvaluation(existing);
    }
    if (!one(db, `SELECT id FROM mission WHERE tenant_id = ? AND id = ?`, [input.tenantId, input.missionId])) {
      throw new Error("mission_policy_evaluation_mission_not_found");
    }
    db.raw.prepare(`INSERT INTO mission_policy_evaluations
      (id, tenant_id, mission_id, envelope_version, status, allowed, review_required, violations_json, task_digest, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.tenantId, input.missionId, input.envelopeVersion, input.status,
      input.allowed === null ? null : input.allowed ? 1 : 0,
      input.reviewRequired === null ? null : input.reviewRequired ? 1 : 0,
      JSON.stringify(violations), input.taskDigest, createdAt,
    );
    const stored = one<MissionPolicyEvaluationRow>(db,
      `SELECT * FROM mission_policy_evaluations WHERE id = ? AND tenant_id = ?`, [id, input.tenantId])!;
    if (owns) db.raw.exec("COMMIT");
    return hydrateEvaluation(stored);
  } catch (error) { if (owns) db.raw.exec("ROLLBACK"); throw error; }
}

export function listMissionPolicyEvaluations(
  db: AppDb,
  tenantId: string,
  missionId: string,
): MissionPolicyEvaluation[] {
  if (!tenantId.trim() || !missionId.trim()) return [];
  const rows = db.raw.prepare(
    `SELECT * FROM mission_policy_evaluations WHERE tenant_id = ? AND mission_id = ? ORDER BY created_at ASC, id ASC`,
  ).all(tenantId, missionId) as MissionPolicyEvaluationRow[];
  return rows.map(hydrateEvaluation);
}

export function policyTaskDigest(task: unknown): string {
  return contentDigest(task);
}
