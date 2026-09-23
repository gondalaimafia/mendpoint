import type { AppDb } from "./index.js";
import {
  assertMissionMutationAuthority,
  parseMissionMutationAuthority,
  type MissionMutationAuthorityV1,
} from "./mission-mutation-authority.js";

export type MissionMutationDispatchState = "authorized" | "dispatching" | "uncertain" | "settled" | "revoked";

type DispatchRow = {
  id: string;
  tenant_id: string;
  mission_id: string;
  job_id: string;
  mutation_kind: string;
  aggregate_id: string;
  authority_json: string;
  intent_digest: string;
  state: MissionMutationDispatchState;
  lease_owner: string;
  lease_generation: number;
  authorized_at: string;
  dispatching_at: string | null;
  uncertain_at: string | null;
  settled_at: string | null;
  revoked_at: string | null;
  updated_at: string;
};

const DIGEST = /^sha256:[a-f0-9]{64}$/;

function timestamp(value: string): string {
  if (new Date(value).toISOString() !== value) throw new Error("mission_mutation_dispatch_timestamp_invalid");
  return value;
}

function row(db: AppDb, tenantId: string, jobId: string): DispatchRow | undefined {
  return db.raw.prepare(`SELECT * FROM mission_mutation_dispatches
    WHERE tenant_id = ? AND job_id = ?`).get(tenantId, jobId) as DispatchRow | undefined;
}

function assertLease(db: AppDb, input: Readonly<{
  tenantId: string; jobId: string; workerId: string; leaseGeneration: number; observedAt: string;
}>): void {
  const active = db.raw.prepare(`SELECT 1 AS active FROM jobs
    WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_owner = ?
      AND lease_generation = ? AND lease_expires_at > ?`).get(
    input.jobId, input.tenantId, input.workerId, input.leaseGeneration, input.observedAt,
  ) as { active: number } | undefined;
  if (!active) throw new Error("mission_mutation_dispatch_lease_lost");
}

export function authorizeMissionMutationDispatch(db: AppDb, input: Readonly<{
  tenantId: string;
  jobId: string;
  mutationKind: "fettler_candidate_delivery" | "fettler_ci_update";
  aggregateId: string;
  authority: MissionMutationAuthorityV1;
  intentDigest: string;
  workerId: string;
  leaseGeneration: number;
  observedAt: string;
}>): MissionMutationDispatchState {
  const authority = parseMissionMutationAuthority(input.authority);
  if (!DIGEST.test(input.intentDigest)) throw new Error("mission_mutation_dispatch_intent_invalid");
  const observedAt = timestamp(input.observedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertMissionMutationAuthority(db, input.tenantId, authority,
      { allowClaimedTask: true, requireNoBlocking: true });
    assertLease(db, { ...input, observedAt });
    const authorityJson = JSON.stringify(authority);
    const prior = row(db, input.tenantId, input.jobId);
    if (prior) {
      if (prior.mission_id !== authority.missionId || prior.mutation_kind !== input.mutationKind ||
          prior.aggregate_id !== input.aggregateId || prior.authority_json !== authorityJson ||
          prior.intent_digest !== input.intentDigest) {
        throw new Error("mission_mutation_dispatch_conflict");
      }
      if (prior.state === "revoked" || prior.state === "settled") {
        throw new Error(`mission_mutation_dispatch_${prior.state}`);
      }
      if (prior.state === "dispatching" && (prior.lease_owner !== input.workerId ||
          prior.lease_generation !== input.leaseGeneration)) {
        db.raw.prepare(`UPDATE mission_mutation_dispatches SET state = 'uncertain',
          uncertain_at = COALESCE(uncertain_at, ?), lease_owner = ?, lease_generation = ?, updated_at = ?
          WHERE id = ? AND state = 'dispatching'`).run(
          observedAt, input.workerId, input.leaseGeneration, observedAt, prior.id,
        );
        if (owns) db.raw.exec("COMMIT");
        return "uncertain";
      }
      if (prior.state === "authorized" && (prior.lease_owner !== input.workerId ||
          prior.lease_generation !== input.leaseGeneration)) {
        db.raw.prepare(`UPDATE mission_mutation_dispatches
          SET lease_owner = ?, lease_generation = ?, authorized_at = ?, updated_at = ?
          WHERE id = ? AND state = 'authorized'`).run(
          input.workerId, input.leaseGeneration, observedAt, observedAt, prior.id,
        );
      }
      if (owns) db.raw.exec("COMMIT");
      return prior.state;
    }
    db.raw.prepare(`INSERT INTO mission_mutation_dispatches
      (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
       intent_digest, state, lease_owner, lease_generation, authorized_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'authorized', ?, ?, ?, ?)`).run(
      `mission-dispatch:${input.jobId}`, input.tenantId, authority.missionId, input.jobId,
      input.mutationKind, input.aggregateId, authorityJson, input.intentDigest, input.workerId,
      input.leaseGeneration, observedAt, observedAt,
    );
    if (owns) db.raw.exec("COMMIT");
    return "authorized";
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function reauthorizeSettledMissionMutationDispatch(db: AppDb, input: Readonly<{
  tenantId: string; jobId: string; authority: MissionMutationAuthorityV1;
  intentDigest: string; workerId: string; leaseGeneration: number; observedAt: string;
}>): void {
  const authority = parseMissionMutationAuthority(input.authority);
  if (!DIGEST.test(input.intentDigest)) throw new Error("mission_mutation_dispatch_intent_invalid");
  const observedAt = timestamp(input.observedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertMissionMutationAuthority(db, input.tenantId, authority,
      { allowClaimedTask: true, requireNoBlocking: true });
    assertLease(db, { ...input, observedAt });
    const changed = db.raw.prepare(`UPDATE mission_mutation_dispatches
      SET state = 'authorized', lease_owner = ?, lease_generation = ?, authorized_at = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND authority_json = ? AND intent_digest = ? AND state = 'settled'`).run(
      input.workerId, input.leaseGeneration, observedAt, observedAt, input.tenantId, input.jobId,
      JSON.stringify(authority), input.intentDigest,
    );
    if (Number(changed.changes) !== 1) throw new Error("mission_mutation_dispatch_settled_replay_conflict");
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function beginMissionMutationRemoteCall(db: AppDb, input: Readonly<{
  tenantId: string; jobId: string; authority: MissionMutationAuthorityV1;
  intentDigest: string; workerId: string; leaseGeneration: number; observedAt: string;
  permitUncertainReplay?: boolean;
}>): void {
  const authority = parseMissionMutationAuthority(input.authority);
  const observedAt = timestamp(input.observedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  // Only a control-plane write that invalidated this authority may revoke the
  // armed row. Every other failure here happens BEFORE the remote call, with
  // nothing at risk — above all an ordinary lease handover, which must roll back
  // and leave the row re-armable so the successor's authorize() can re-arm it.
  // Revoking there strands the delivery permanently: the successor gets
  // mission_mutation_dispatch_revoked, which matches no retryable pattern in the
  // worker's classifier and dead-letters.
  // See docs/adr/2026-08-26-durable-mission-remote-mutation-dispatch.md.
  let controlPlaneWins = false;
  try {
    try {
      assertMissionMutationAuthority(db, input.tenantId, authority,
        { allowClaimedTask: true, requireNoBlocking: true });
    } catch (error) {
      controlPlaneWins = true;
      throw error;
    }
    assertLease(db, { ...input, observedAt });
    const allowed = input.permitUncertainReplay ? "('authorized','uncertain')" : "('authorized')";
    const changed = db.raw.prepare(`UPDATE mission_mutation_dispatches
      SET state = 'dispatching', lease_owner = ?, lease_generation = ?, dispatching_at = ?, updated_at = ?
      WHERE tenant_id = ? AND job_id = ? AND mission_id = ? AND authority_json = ?
        AND intent_digest = ? AND state IN ${allowed}`).run(
      input.workerId, input.leaseGeneration, observedAt, observedAt, input.tenantId, input.jobId,
      authority.missionId, JSON.stringify(authority), input.intentDigest,
    );
    if (Number(changed.changes) !== 1) throw new Error("mission_mutation_dispatch_not_authorized");
    if (owns) db.raw.exec("COMMIT");
  } catch (error) {
    if (owns && db.raw.isTransaction) {
      if (controlPlaneWins) {
        db.raw.prepare(`UPDATE mission_mutation_dispatches SET state = 'revoked', revoked_at = ?, updated_at = ?
          WHERE tenant_id = ? AND job_id = ? AND state = 'authorized'`).run(
          observedAt, observedAt, input.tenantId, input.jobId,
        );
        db.raw.exec("COMMIT");
      } else {
        db.raw.exec("ROLLBACK");
      }
    }
    throw error;
  }
}

export function markMissionMutationDispatchUncertain(db: AppDb, input: Readonly<{
  tenantId: string; jobId: string; intentDigest: string; observedAt: string;
}>): void {
  const observedAt = timestamp(input.observedAt);
  const changed = db.raw.prepare(`UPDATE mission_mutation_dispatches
    SET state = 'uncertain', uncertain_at = COALESCE(uncertain_at, ?), updated_at = ?
    WHERE tenant_id = ? AND job_id = ? AND intent_digest = ? AND state = 'dispatching'`).run(
    observedAt, observedAt, input.tenantId, input.jobId, input.intentDigest,
  );
  if (Number(changed.changes) !== 1) throw new Error("mission_mutation_dispatch_uncertain_conflict");
}

export function settleMissionMutationDispatch(db: AppDb, input: Readonly<{
  tenantId: string; jobId: string; intentDigest: string; observedAt: string;
}>): void {
  const observedAt = timestamp(input.observedAt);
  const changed = db.raw.prepare(`UPDATE mission_mutation_dispatches
    SET state = 'settled', settled_at = COALESCE(settled_at, ?), updated_at = ?
    WHERE tenant_id = ? AND job_id = ? AND intent_digest = ? AND state IN ('dispatching','uncertain')`).run(
    observedAt, observedAt, input.tenantId, input.jobId, input.intentDigest,
  );
  if (Number(changed.changes) !== 1) throw new Error("mission_mutation_dispatch_settlement_conflict");
}
