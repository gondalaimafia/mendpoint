import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";

// Deterministic App-DB mission id for a ReGauge/Transformer control-plane
// campaign. Shared so that every writer that create-or-binds the mission for a
// campaign derives the SAME id — that identity is what makes createMission and
// linkRegaugeCampaignToMission idempotent across writers (e.g. the control-plane
// route and the production launch seam). Mirrors the Fettler id shape
// (`mission-fettler-…`) used at the enrollment writer.
export function regaugeMissionId(tenantId: string, campaignId: string): string {
  return `mission-regauge-${createHash("sha256").update(`${tenantId}\0${campaignId}`).digest("hex").slice(0, 32)}`;
}

// The Mission is the shared, tenant-scoped execution primitive (spec section 6.1
// and 8.6). It is the single join point between the two previously disjoint
// execution stacks: Fettler/Warden (`fettler_campaigns`, same database, real FK
// held in mission.fettler_campaign_id) and ReGauge/Transformer
// (`TransformerControlPlaneStore`, a separate SQLite database whose campaign
// identity is projected here by reference in mission.regauge_campaign_id, no
// cross-database FK). Both linkages live on this new table so neither stack is
// restructured. A Mission composes the section 6.1 fields by reference —
// repository/snapshot scope and the linked execution record, through which
// migration tasks, evidence, execution history, verification, and learning
// provenance are reachable. Payloads are never duplicated onto the mission row.

export type MissionProduct = "fettler" | "regauge";

export type MissionTriggerKind = "provider_change" | "migration_objective";

// Spec section 8.6 state model:
// created -> discovering -> scoped -> planning -> executing -> verifying ->
// awaiting_review -> accepted | rejected | partial | failed | cancelled
export type MissionState =
  | "created" | "discovering" | "scoped" | "planning" | "executing" | "verifying"
  | "awaiting_review" | "accepted" | "rejected" | "partial" | "failed" | "cancelled";

export type Mission = Readonly<{
  id: string;
  tenantId: string;
  product: MissionProduct;
  state: MissionState;
  triggerKind: MissionTriggerKind;
  objective: string;
  repositoryId: string | null;
  snapshotId: string | null;
  fettlerCampaignId: string | null;
  regaugeCampaignId: string | null;
  ownerPrincipalId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}>;

type MissionRow = {
  id: string; tenant_id: string; product: MissionProduct; state: MissionState;
  trigger_kind: MissionTriggerKind; objective: string; repository_id: string | null;
  snapshot_id: string | null; fettler_campaign_id: string | null; regauge_campaign_id: string | null;
  owner_principal_id: string; revision: number; created_at: string; updated_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}
function required(name: string, value: string): string {
  const result = value.trim();
  if (!result || result.length > 256) throw new Error(`${name}_invalid`);
  return result;
}
function assertPrincipal(db: AppDb, tenantId: string, principalId: string) {
  if (!one(db, `SELECT id FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`, [principalId, tenantId])) {
    throw new Error("mission_principal_tenant_mismatch");
  }
}
function mission(row: MissionRow): Mission {
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, product: row.product, state: row.state,
    triggerKind: row.trigger_kind, objective: row.objective, repositoryId: row.repository_id,
    snapshotId: row.snapshot_id, fettlerCampaignId: row.fettler_campaign_id,
    regaugeCampaignId: row.regauge_campaign_id,
    ownerPrincipalId: row.owner_principal_id, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}
function event(db: AppDb, input: { tenantId: string; missionId: string; actorPrincipalId: string;
  eventId: string; eventType: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; payload: unknown; createdAt: string }) {
  appendDomainEvent(db, { id: input.eventId, tenantId: input.tenantId, schemaVersion: 1,
    eventType: input.eventType, aggregateType: "mission", aggregateId: input.missionId,
    actorPrincipalId: input.actorPrincipalId, correlationId: input.correlationId,
    causationId: input.causationId ?? null, idempotencyKey: input.idempotencyKey,
    payload: input.payload, createdAt: input.createdAt });
}

// Legal transition table (spec section 8.6). CANCELLED and FAILED are reachable
// from any active state; ACCEPTED/REJECTED/PARTIAL only from AWAITING_REVIEW.
// SCOPED may go straight to EXECUTING because Fettler MAY skip explicit planning
// for small changes (section 8.6); ReGauge generally retains the PLANNING step.
const missionTransitions: Record<MissionState, MissionState[]> = {
  created: ["discovering", "cancelled"],
  discovering: ["scoped", "failed", "cancelled"],
  scoped: ["planning", "executing", "failed", "cancelled"],
  planning: ["executing", "failed", "cancelled"],
  executing: ["verifying", "failed", "cancelled"],
  verifying: ["awaiting_review", "failed", "cancelled"],
  awaiting_review: ["accepted", "rejected", "partial", "failed", "cancelled"],
  accepted: [],
  rejected: [],
  partial: [],
  failed: [],
  cancelled: [],
};

export function createMission(db: AppDb, input: {
  id: string; tenantId: string; product: MissionProduct; triggerKind: MissionTriggerKind;
  objective: string; ownerPrincipalId: string; repositoryId?: string | null;
  snapshotId?: string | null; eventId: string; idempotencyKey: string;
  correlationId: string; createdAt: string;
}): Mission {
  required("mission_id", input.id);
  required("tenant_id", input.tenantId);
  const objective = required("mission_objective", input.objective);
  if (input.product !== "fettler" && input.product !== "regauge") throw new Error("mission_product_invalid");
  if (input.triggerKind !== "provider_change" && input.triggerKind !== "migration_objective") {
    throw new Error("mission_trigger_kind_invalid");
  }
  assertPrincipal(db, input.tenantId, input.ownerPrincipalId);
  const repositoryId = input.repositoryId ?? null;
  const snapshotId = input.snapshotId ?? null;
  if (repositoryId && !one(db, `SELECT id FROM connected_repositories WHERE id = ? AND tenant_id = ?`, [repositoryId, input.tenantId])) {
    throw new Error("mission_repository_tenant_mismatch");
  }
  if (snapshotId && !one(db, `SELECT id FROM repository_snapshots WHERE id = ? AND tenant_id = ?`, [snapshotId, input.tenantId])) {
    throw new Error("mission_snapshot_tenant_mismatch");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    // Deliberately tenant-LESS: `id` is a global PRIMARY KEY, so this is the
    // idempotency/uniqueness guard that lets a mission id reused across tenants
    // surface as a clean `mission_id_conflict` below rather than a raw INSERT
    // constraint error. Do NOT add `AND tenant_id = ?` here — that would let a
    // cross-tenant id collision slip past this check into the INSERT. (The
    // post-write value re-reads below ARE tenant-scoped; those are pure reads of
    // a row this transaction just wrote, and the predicate is defense-in-depth
    // against a future tenant-scoped-key refactor.)
    const existing = one<MissionRow>(db, `SELECT * FROM mission WHERE id = ?`, [input.id]);
    if (existing) {
      const value = mission(existing);
      if (value.tenantId !== input.tenantId || value.product !== input.product ||
        value.triggerKind !== input.triggerKind || value.objective !== objective ||
        value.ownerPrincipalId !== input.ownerPrincipalId || value.repositoryId !== repositoryId ||
        value.snapshotId !== snapshotId) {
        throw new Error("mission_id_conflict");
      }
      db.raw.exec("COMMIT");
      return value;
    }
    db.raw.prepare(`INSERT INTO mission
      (id, tenant_id, product, state, trigger_kind, objective, repository_id, snapshot_id,
       fettler_campaign_id, regauge_campaign_id, owner_principal_id, revision, created_at, updated_at)
      VALUES (?, ?, ?, 'created', ?, ?, ?, ?, NULL, NULL, ?, 1, ?, ?)`).run(input.id, input.tenantId,
        input.product, input.triggerKind, objective, repositoryId, snapshotId,
        input.ownerPrincipalId, input.createdAt, input.createdAt);
    event(db, { ...input, missionId: input.id, actorPrincipalId: input.ownerPrincipalId,
      eventType: "mission.created", payload: { product: input.product, triggerKind: input.triggerKind,
        state: "created", revision: 1 } });
    const value = mission(one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.id, input.tenantId])!);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

export function transitionMission(db: AppDb, input: {
  tenantId: string; missionId: string; expectedRevision: number; to: MissionState;
  actorPrincipalId: string; eventId: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; createdAt: string;
}): Mission {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId]);
    if (!current) throw new Error("mission_not_found");
    if (current.revision !== input.expectedRevision) throw new Error("mission_revision_conflict");
    if (!missionTransitions[current.state].includes(input.to)) throw new Error("mission_transition_invalid");
    const changed = db.raw.prepare(`UPDATE mission SET state = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND revision = ?`).run(input.to, input.createdAt, input.missionId,
        input.tenantId, input.expectedRevision);
    if (Number(changed.changes) !== 1) throw new Error("mission_revision_conflict");
    event(db, { ...input, eventType: "mission.transitioned",
      payload: { from: current.state, to: input.to, previousRevision: current.revision, revision: current.revision + 1 } });
    const value = mission(one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId])!);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

export function getMission(db: AppDb, tenantId: string, missionId: string): Mission | undefined {
  const row = one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [missionId, tenantId]);
  return row ? mission(row) : undefined;
}

// Fettler/Warden linkage: the mission projects the campaign identity through the
// `mission.fettler_campaign_id` foreign key (same database). Set-once, unique per
// tenant, and the referenced campaign must be tenant-owned.
export function linkFettlerCampaignToMission(db: AppDb, input: {
  tenantId: string; campaignId: string; missionId: string; actorPrincipalId: string;
  eventId: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; createdAt: string;
}): Mission {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const missionRow = one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId]);
    if (!missionRow) throw new Error("mission_not_found");
    if (missionRow.product !== "fettler") throw new Error("mission_product_mismatch");
    if (!one(db, `SELECT id FROM fettler_campaigns WHERE id = ? AND tenant_id = ?`, [input.campaignId, input.tenantId])) {
      throw new Error("mission_fettler_campaign_not_found");
    }
    if (missionRow.fettler_campaign_id === input.campaignId) { db.raw.exec("COMMIT"); return mission(missionRow); }
    if (missionRow.fettler_campaign_id) throw new Error("mission_link_conflict");
    const claimed = one<{ id: string }>(db,
      `SELECT id FROM mission WHERE tenant_id = ? AND fettler_campaign_id = ?`, [input.tenantId, input.campaignId]);
    if (claimed) throw new Error("mission_link_conflict");
    const changed = db.raw.prepare(`UPDATE mission SET fettler_campaign_id = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND fettler_campaign_id IS NULL`).run(input.campaignId,
        input.createdAt, input.missionId, input.tenantId);
    if (Number(changed.changes) !== 1) throw new Error("mission_link_conflict");
    event(db, { ...input, eventType: "mission.fettler_campaign_linked",
      payload: { campaignId: input.campaignId } });
    const value = mission(one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId])!);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

// ReGauge/Transformer linkage: the transformer campaign lives in a separate
// SQLite database (TransformerControlPlaneStore), so there is no cross-database
// foreign key to enforce. The mission projects the transformer campaign identity
// by reference in `mission.regauge_campaign_id`. Set-once, and unique per tenant.
export function linkRegaugeCampaignToMission(db: AppDb, input: {
  tenantId: string; missionId: string; regaugeCampaignId: string; actorPrincipalId: string;
  eventId: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; createdAt: string;
}): Mission {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  const regaugeCampaignId = required("mission_regauge_campaign_id", input.regaugeCampaignId);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const missionRow = one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId]);
    if (!missionRow) throw new Error("mission_not_found");
    if (missionRow.product !== "regauge") throw new Error("mission_product_mismatch");
    if (missionRow.regauge_campaign_id === regaugeCampaignId) { db.raw.exec("COMMIT"); return mission(missionRow); }
    if (missionRow.regauge_campaign_id) throw new Error("mission_link_conflict");
    const claimed = one<{ id: string }>(db,
      `SELECT id FROM mission WHERE tenant_id = ? AND regauge_campaign_id = ?`, [input.tenantId, regaugeCampaignId]);
    if (claimed) throw new Error("mission_link_conflict");
    const changed = db.raw.prepare(`UPDATE mission SET regauge_campaign_id = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND regauge_campaign_id IS NULL`).run(regaugeCampaignId,
        input.createdAt, input.missionId, input.tenantId);
    if (Number(changed.changes) !== 1) throw new Error("mission_link_conflict");
    event(db, { ...input, eventType: "mission.regauge_campaign_linked",
      payload: { regaugeCampaignId } });
    const value = mission(one<MissionRow>(db, `SELECT * FROM mission WHERE id = ? AND tenant_id = ?`, [input.missionId, input.tenantId])!);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

// Resolve a Fettler/Warden campaign to its Mission through the same-database FK.
export function resolveMissionForFettlerCampaign(db: AppDb, tenantId: string, campaignId: string): Mission | undefined {
  const row = one<MissionRow>(db,
    `SELECT * FROM mission WHERE tenant_id = ? AND fettler_campaign_id = ?`, [tenantId, campaignId]);
  return row ? mission(row) : undefined;
}

// Resolve a ReGauge/Transformer campaign id to its Mission through the projected
// reference (the transformer campaign lives in a separate database).
export function resolveMissionForRegaugeCampaign(db: AppDb, tenantId: string, regaugeCampaignId: string): Mission | undefined {
  const row = one<MissionRow>(db,
    `SELECT * FROM mission WHERE tenant_id = ? AND regauge_campaign_id = ?`, [tenantId, regaugeCampaignId]);
  return row ? mission(row) : undefined;
}
