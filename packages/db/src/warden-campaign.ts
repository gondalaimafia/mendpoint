import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { appendDomainEvent } from "./trust.js";

export type WardenCampaignStatus =
  | "draft" | "running" | "paused" | "cancelling" | "cancelled"
  | "completed" | "failed" | "rolling_back" | "rolled_back";
export type WardenTargetStage =
  | "queued" | "analyzing" | "editing" | "verifying" | "review" | "delivering"
  | "completed" | "blocked" | "failed" | "cancelled" | "rolling_back" | "rolled_back";

export type WardenCampaign = Readonly<{
  id: string; tenantId: string; name: string; status: WardenCampaignStatus;
  ownerPrincipalId: string; concurrencyLimit: number;
  completionPolicy: "all" | "continue_on_failure"; revision: number;
  createdAt: string; updatedAt: string;
}>;

export type WardenCampaignTarget = Readonly<{
  id: string; tenantId: string; campaignId: string; repositoryId: string; snapshotId: string;
  packageArtifactId: string | null; ownerPrincipalId: string; stage: WardenTargetStage;
  dependsOn: string[]; attemptCount: number; maxAttempts: number; exceptionCode: string | null;
  revision: number; createdAt: string; updatedAt: string;
}>;

type CampaignRow = {
  id: string; tenant_id: string; name: string; status: WardenCampaignStatus;
  owner_principal_id: string; concurrency_limit: number;
  completion_policy: "all" | "continue_on_failure"; revision: number;
  created_at: string; updated_at: string;
};
type TargetRow = {
  id: string; tenant_id: string; campaign_id: string; repository_id: string; snapshot_id: string;
  package_artifact_id: string | null; owner_principal_id: string; stage: WardenTargetStage;
  depends_on_json: string; attempt_count: number; max_attempts: number; exception_code: string | null;
  revision: number; created_at: string; updated_at: string;
};

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}
function all<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}
function required(name: string, value: string) {
  const result = value.trim();
  if (!result || result.length > 256) throw new Error(`${name}_invalid`);
  return result;
}
function campaign(row: CampaignRow): WardenCampaign {
  return Object.freeze({ id: row.id, tenantId: row.tenant_id, name: row.name, status: row.status,
    ownerPrincipalId: row.owner_principal_id, concurrencyLimit: row.concurrency_limit,
    completionPolicy: row.completion_policy, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
function target(row: TargetRow): WardenCampaignTarget {
  const dependsOn = JSON.parse(row.depends_on_json) as unknown;
  if (!Array.isArray(dependsOn) || dependsOn.some((id) => typeof id !== "string")) {
    throw new Error("warden_target_dependencies_corrupt");
  }
  return Object.freeze({ id: row.id, tenantId: row.tenant_id, campaignId: row.campaign_id,
    repositoryId: row.repository_id, snapshotId: row.snapshot_id,
    packageArtifactId: row.package_artifact_id, ownerPrincipalId: row.owner_principal_id,
    stage: row.stage, dependsOn, attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    exceptionCode: row.exception_code, revision: row.revision,
    createdAt: row.created_at, updatedAt: row.updated_at });
}
function assertPrincipal(db: AppDb, tenantId: string, principalId: string) {
  if (!one(db, `SELECT id FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`, [principalId, tenantId])) {
    throw new Error("warden_principal_tenant_mismatch");
  }
}
function event(db: AppDb, input: { tenantId: string; campaignId: string; actorPrincipalId: string;
  eventId: string; eventType: string; idempotencyKey: string; correlationId: string;
  causationId?: string | null; payload: unknown; createdAt: string }) {
  appendDomainEvent(db, { id: input.eventId, tenantId: input.tenantId, schemaVersion: 1,
    eventType: input.eventType, aggregateType: "warden_campaign", aggregateId: input.campaignId,
    actorPrincipalId: input.actorPrincipalId, correlationId: input.correlationId,
    causationId: input.causationId ?? null, idempotencyKey: input.idempotencyKey,
    payload: input.payload, createdAt: input.createdAt });
}

export function createWardenCampaign(db: AppDb, input: {
  id: string; tenantId: string; name: string; ownerPrincipalId: string; concurrencyLimit: number;
  completionPolicy: "all" | "continue_on_failure"; eventId: string; idempotencyKey: string;
  correlationId: string; createdAt: string;
}): WardenCampaign {
  required("warden_campaign_id", input.id); required("tenant_id", input.tenantId);
  const name = required("warden_campaign_name", input.name);
  assertPrincipal(db, input.tenantId, input.ownerPrincipalId);
  if (!Number.isSafeInteger(input.concurrencyLimit) || input.concurrencyLimit < 1 || input.concurrencyLimit > 100) {
    throw new Error("warden_concurrency_invalid");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ?`, [input.id]);
    if (existing) {
      const value = campaign(existing);
      if (value.tenantId !== input.tenantId || value.name !== name || value.ownerPrincipalId !== input.ownerPrincipalId ||
        value.concurrencyLimit !== input.concurrencyLimit || value.completionPolicy !== input.completionPolicy) {
        throw new Error("warden_campaign_id_conflict");
      }
      db.raw.exec("COMMIT"); return value;
    }
    db.raw.prepare(`INSERT INTO warden_campaigns
      (id, tenant_id, name, status, owner_principal_id, concurrency_limit, completion_policy, revision, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?)`).run(input.id, input.tenantId, name,
        input.ownerPrincipalId, input.concurrencyLimit, input.completionPolicy, input.createdAt, input.createdAt);
    event(db, { ...input, campaignId: input.id, actorPrincipalId: input.ownerPrincipalId,
      eventType: "warden.campaign.created", payload: { revision: 1, status: "draft" } });
    const value = campaign(one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ?`, [input.id])!);
    db.raw.exec("COMMIT"); return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

export function addWardenCampaignTarget(db: AppDb, input: {
  id: string; tenantId: string; campaignId: string; repositoryId: string; snapshotId: string;
  ownerPrincipalId: string; dependsOn?: string[]; maxAttempts?: number; eventId: string;
  idempotencyKey: string; correlationId: string; createdAt: string;
}): WardenCampaignTarget {
  assertPrincipal(db, input.tenantId, input.ownerPrincipalId);
  const parent = one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ? AND tenant_id = ?`, [input.campaignId, input.tenantId]);
  if (!parent || parent.status !== "draft") throw new Error("warden_campaign_not_draft");
  const repo = one<{ snapshot_id: string }>(db, `SELECT rs.id AS snapshot_id FROM connected_repositories cr
    JOIN repository_snapshots rs ON rs.repository_id = cr.id AND rs.tenant_id = cr.tenant_id
    WHERE cr.id = ? AND cr.tenant_id = ? AND rs.id = ?`, [input.repositoryId, input.tenantId, input.snapshotId]);
  if (!repo) throw new Error("warden_snapshot_tenant_mismatch");
  const dependencies = [...new Set(input.dependsOn ?? [])].sort();
  if (dependencies.includes(input.id)) throw new Error("warden_dependency_cycle");
  for (const dependency of dependencies) {
    if (!one(db, `SELECT id FROM warden_campaign_targets WHERE id = ? AND campaign_id = ? AND tenant_id = ?`,
      [dependency, input.campaignId, input.tenantId])) throw new Error("warden_dependency_missing");
  }
  const maxAttempts = input.maxAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) throw new Error("warden_max_attempts_invalid");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.prepare(`INSERT INTO warden_campaign_targets
      (id, tenant_id, campaign_id, repository_id, snapshot_id, owner_principal_id, stage, depends_on_json,
       attempt_count, max_attempts, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, 0, ?, 1, ?, ?)`).run(input.id, input.tenantId,
        input.campaignId, input.repositoryId, input.snapshotId, input.ownerPrincipalId,
        JSON.stringify(dependencies), maxAttempts, input.createdAt, input.createdAt);
    event(db, { ...input, actorPrincipalId: input.ownerPrincipalId, eventType: "warden.target.added",
      payload: { targetId: input.id, dependencies, revision: 1 } });
    const value = target(one<TargetRow>(db, `SELECT * FROM warden_campaign_targets WHERE id = ?`, [input.id])!);
    db.raw.exec("COMMIT"); return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

const campaignTransitions: Record<WardenCampaignStatus, WardenCampaignStatus[]> = {
  draft: ["running", "cancelled"], running: ["paused", "cancelling", "completed", "failed", "rolling_back"],
  paused: ["running", "cancelling", "rolling_back"], cancelling: ["cancelled"], cancelled: [],
  completed: ["rolling_back"], failed: ["running", "rolling_back"], rolling_back: ["rolled_back", "failed"], rolled_back: [],
};
export function transitionWardenCampaign(db: AppDb, input: { tenantId: string; campaignId: string;
  expectedRevision: number; to: WardenCampaignStatus; actorPrincipalId: string; eventId: string;
  idempotencyKey: string; correlationId: string; causationId?: string | null; createdAt: string }): WardenCampaign {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ? AND tenant_id = ?`, [input.campaignId, input.tenantId]);
    if (!current) throw new Error("warden_campaign_not_found");
    if (current.revision !== input.expectedRevision) throw new Error("warden_revision_conflict");
    if (!campaignTransitions[current.status].includes(input.to)) throw new Error("warden_transition_invalid");
    const changed = db.raw.prepare(`UPDATE warden_campaigns SET status = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND revision = ?`).run(input.to, input.createdAt, input.campaignId, input.tenantId, input.expectedRevision);
    if (Number(changed.changes) !== 1) throw new Error("warden_revision_conflict");
    event(db, { ...input, eventType: "warden.campaign.transitioned",
      payload: { from: current.status, to: input.to, previousRevision: current.revision, revision: current.revision + 1 } });
    const value = campaign(one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ?`, [input.campaignId])!);
    db.raw.exec("COMMIT"); return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

export function claimReadyWardenTargets(db: AppDb, tenantId: string, campaignId: string): WardenCampaignTarget[] {
  const parent = one<CampaignRow>(db, `SELECT * FROM warden_campaigns WHERE id = ? AND tenant_id = ?`, [campaignId, tenantId]);
  if (!parent || parent.status !== "running") return [];
  const targets = all<TargetRow>(db, `SELECT * FROM warden_campaign_targets WHERE tenant_id = ? AND campaign_id = ? ORDER BY created_at, id`, [tenantId, campaignId]).map(target);
  const completed = new Set(targets.filter((item) => item.stage === "completed").map((item) => item.id));
  const active = targets.filter((item) => ["analyzing", "editing", "verifying", "review", "delivering"].includes(item.stage)).length;
  return targets.filter((item) => item.stage === "queued" && item.attemptCount < item.maxAttempts &&
    item.dependsOn.every((id) => completed.has(id))).slice(0, Math.max(0, parent.concurrency_limit - active));
}

export function transitionWardenTarget(db: AppDb, input: { tenantId: string; campaignId: string; targetId: string;
  expectedRevision: number; from: WardenTargetStage; to: WardenTargetStage; actorPrincipalId: string;
  packageArtifactId?: string | null; exceptionCode?: string | null; eventId: string; idempotencyKey: string;
  correlationId: string; causationId?: string | null; createdAt: string }): WardenCampaignTarget {
  assertPrincipal(db, input.tenantId, input.actorPrincipalId);
  const allowed: Record<WardenTargetStage, WardenTargetStage[]> = {
    queued: ["analyzing", "cancelled"], analyzing: ["editing", "blocked", "failed", "cancelled"],
    editing: ["verifying", "blocked", "failed", "cancelled"], verifying: ["review", "blocked", "failed", "cancelled"],
    review: ["delivering", "blocked", "failed", "cancelled"], delivering: ["completed", "blocked", "failed"],
    completed: ["rolling_back"], blocked: ["queued", "cancelled"], failed: ["queued", "rolling_back", "cancelled"],
    cancelled: [], rolling_back: ["rolled_back", "failed"], rolled_back: [],
  };
  if (!allowed[input.from].includes(input.to)) throw new Error("warden_target_transition_invalid");
  if (input.to === "review" && !input.packageArtifactId) throw new Error("warden_pr_package_required");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = one<TargetRow>(db, `SELECT * FROM warden_campaign_targets WHERE id = ? AND tenant_id = ? AND campaign_id = ?`,
      [input.targetId, input.tenantId, input.campaignId]);
    if (!current) throw new Error("warden_target_not_found");
    if (current.revision !== input.expectedRevision || current.stage !== input.from) throw new Error("warden_revision_conflict");
    const attempts = input.from === "queued" && input.to === "analyzing" ? current.attempt_count + 1 : current.attempt_count;
    if (attempts > current.max_attempts) throw new Error("warden_attempts_exhausted");
    const changed = db.raw.prepare(`UPDATE warden_campaign_targets SET stage = ?, package_artifact_id = COALESCE(?, package_artifact_id),
      exception_code = ?, attempt_count = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND campaign_id = ? AND revision = ? AND stage = ?`).run(input.to,
        input.packageArtifactId ?? null, input.exceptionCode ?? null, attempts, input.createdAt, input.targetId,
        input.tenantId, input.campaignId, input.expectedRevision, input.from);
    if (Number(changed.changes) !== 1) throw new Error("warden_revision_conflict");
    event(db, { ...input, eventType: "warden.target.transitioned", payload: { targetId: input.targetId,
      from: input.from, to: input.to, previousRevision: current.revision, revision: current.revision + 1,
      packageArtifactId: input.packageArtifactId ?? null, exceptionCode: input.exceptionCode ?? null } });
    const value = target(one<TargetRow>(db, `SELECT * FROM warden_campaign_targets WHERE id = ?`, [input.targetId])!);
    db.raw.exec("COMMIT"); return value;
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
}

export function listWardenCampaignTargets(db: AppDb, tenantId: string, campaignId: string) {
  return all<TargetRow>(db, `SELECT * FROM warden_campaign_targets WHERE tenant_id = ? AND campaign_id = ? ORDER BY created_at, id`, [tenantId, campaignId]).map(target);
}

export function planWardenRollback(db: AppDb, tenantId: string, campaignId: string): WardenCampaignTarget[] {
  const targets = listWardenCampaignTargets(db, tenantId, campaignId);
  const byId = new Map(targets.map((item) => [item.id, item]));
  const visited = new Set<string>(); const ordered: WardenCampaignTarget[] = [];
  const visit = (item: WardenCampaignTarget, stack: Set<string>) => {
    if (stack.has(item.id)) throw new Error("warden_dependency_cycle");
    if (visited.has(item.id)) return;
    stack.add(item.id);
    for (const dependency of item.dependsOn) { const value = byId.get(dependency); if (!value) throw new Error("warden_dependency_missing"); visit(value, stack); }
    stack.delete(item.id); visited.add(item.id); ordered.push(item);
  };
  for (const item of targets) visit(item, new Set());
  return ordered.filter((item) => ["completed", "failed"].includes(item.stage)).reverse();
}
