import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
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
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<StoredPolicyEnvelopeRow>(db,
      `SELECT * FROM policy_envelopes WHERE tenant_id = ? AND version = ?`, [input.tenantId, input.version]);
    if (existing) {
      if (existing.content_sha256 !== contentSha256) throw new Error("policy_envelope_version_conflict");
      db.raw.exec("COMMIT");
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
    db.raw.exec("COMMIT");
    return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
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
