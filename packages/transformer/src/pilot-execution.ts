import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  authorizeTransformerDelivery,
  authorizeTransformerWorkerAction,
} from "@mendpoint/ops";
import {
  assessOrganizationConstraint,
  type OrganizationConstraintContract,
} from "./organization-constraints.js";
import type { RecipeReference } from "./recipe.js";

export const TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION = "2026-08-02.v1" as const;

const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MANIFEST_SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DEFAULT_LEASE_DURATION_MS = 60_000;
const MIN_LEASE_DURATION_MS = 1_000;
const MAX_LEASE_DURATION_MS = 3_600_000;

export type TransformerPilotUnitState =
  | "pending"
  | "running"
  | "executed"
  | "draft"
  | "accepted"
  | "merged"
  | "failed"
  | "cancelled"
  | "rolled_back";

export type TransformerPilotExceptionCode =
  | "worker_crash"
  | "source_drift"
  | "candidate_drift"
  | "verification_failed"
  | "execution_failed"
  | "head_drift"
  | "ci_failure"
  | "ci_incomplete"
  | "ci_evidence_stale"
  | "review_incomplete"
  | "review_evidence_stale"
  | "review_changes_requested"
  | "conversation_unresolved"
  | "partial_wave_merge"
  | "draft_closed";

export type TransformerAttemptFailureCode =
  | "source_drift"
  | "candidate_drift"
  | "verification_failed"
  | "execution_failed"
  | "worker_crash";

const TRANSFORMER_ATTEMPT_FAILURE_CODES = new Set<TransformerAttemptFailureCode>([
  "source_drift",
  "candidate_drift",
  "verification_failed",
  "execution_failed",
  "worker_crash",
]);

export type TransformerExactSnapshot = Readonly<{
  snapshotId: string;
  repositoryId: string;
  revision: string;
  manifestSha256: string;
  digest: string;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotUnitInput = Readonly<{
  id: string;
  title: string;
  ownerId: string;
  reviewerIds: readonly string[];
  dependsOn: readonly string[];
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  recipe: RecipeReference;
  changedPaths: readonly string[];
}>;

export type TransformerPilotCampaignInput = Readonly<{
  tenantId: string;
  organizationId: string;
  environment: string;
  campaignId: string;
  constraints: OrganizationConstraintContract;
  units: readonly TransformerPilotUnitInput[];
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
  gateConfig?: string;
}>;

export type TransformerPilotException = Readonly<{
  id: string;
  code: TransformerPilotExceptionCode;
  unitId?: string;
  ownerId: string;
  dueAction: string;
  state: "open" | "resolved" | "waived";
  openedAt: string;
  closedAt?: string;
  resolution?: string;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotUnit = Readonly<{
  id: string;
  title: string;
  ownerId: string;
  reviewerIds: readonly string[];
  dependsOn: readonly string[];
  wave: number;
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  recipe: RecipeReference;
  changedPaths: readonly string[];
  state: TransformerPilotUnitState;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest?: string;
  leaseExpiresAt?: string;
  retryAuthorized: boolean;
  executionEvidenceRefs: readonly string[];
  scmEvidenceRefs: readonly string[];
  startedAt?: string;
  executedAt?: string;
  acceptedAt?: string;
  mergedAt?: string;
  verificationPassed?: boolean;
  actualCostUsd?: number;
  reviewerEditLines?: number;
  legacyItemsRemoved?: number;
}>;

export type TransformerPilotCampaign = Readonly<{
  schemaVersion: typeof TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION;
  tenantId: string;
  organizationId: string;
  environment: string;
  campaignId: string;
  revision: number;
  state: "running" | "paused" | "cancelled" | "completed" | "rollback_required" | "rolled_back";
  constraintVersion: number;
  constraintDigest: string;
  gateEvidenceRefs: readonly string[];
  units: readonly TransformerPilotUnit[];
  exceptions: readonly TransformerPilotException[];
  rollbackPlan?: readonly TransformerRollbackAction[];
  createdAt: string;
  updatedAt: string;
}>;

export type TransformerAttemptLease = Readonly<{
  type: "execute_recipe";
  tenantId: string;
  campaignId: string;
  unitId: string;
  attemptNumber: number;
  leaseGeneration: number;
  leaseTokenDigest: string;
  leaseExpiresAt: string;
  snapshot: TransformerExactSnapshot;
  candidateRevision: string;
  candidateDigest: string;
  changedPaths: readonly string[];
  recipe: RecipeReference;
  constraintVersion: number;
  constraintDigest: string;
  gateEvidenceRefs: readonly string[];
}>;

export type TransformerRunnableCampaign = Readonly<{
  tenantId: string;
  campaignId: string;
  environment: string;
}>;

export type TransformerExpiredAttempt = Readonly<{
  tenantId: string;
  campaignId: string;
  unitId: string;
  leaseGeneration: number;
  environment: string;
}>;

export type TransformerDraftAction = Readonly<{
  type: "open_draft";
  unitId: string;
  repositoryId: string;
  expectedBaseRevision: string;
  expectedHeadRevision: string;
  evidenceRefs: readonly string[];
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type TransformerRollbackAction = Readonly<{
  type: "close_draft" | "open_revert_draft" | "restore_workspace";
  unitId: string;
  repositoryId: string;
  expectedRevision: string;
  evidenceRefs: readonly string[];
  draft: true;
  autoMerge: false;
  autoDeploy: false;
}>;

export type TransformerScmObservation = Readonly<{
  unitId: string;
  state: "draft" | "merged" | "closed";
  baseRevision: string;
  headRevision: string;
  checks: "success" | "failure" | "running" | "missing";
  checkRevision: string | null;
  approvals: number;
  approvalRevision: string | null;
  conversationsResolved: boolean;
  reviewerEditLines: number;
  legacyItemsRemoved: number;
  evidenceRefs: readonly string[];
}>;

export type TransformerPilotMetrics = Readonly<{
  campaignCompletionRate: number;
  waveCompletionRate: number;
  batchAcceptanceRate: number;
  timeToFirstAcceptedPullRequestMs: number | null;
  openExceptionCount: number;
  verificationPassRate: number | null;
  rollbackRate: number;
  legacyItemsRemoved: number;
  reviewerEditLines: number;
  actualCostUsd: number | null;
}>;

export type TransformerPilotEvent = Readonly<{
  sequence: number;
  tenantId: string;
  campaignId: string;
  campaignRevision: number;
  type: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  payload: Readonly<Record<string, unknown>>;
}>;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type StoredCampaign = Mutable<Omit<TransformerPilotCampaign, "units" | "exceptions">> & {
  units: TransformerPilotUnit[];
  exceptions: TransformerPilotException[];
};

type MutationInput = Readonly<{
  tenantId: string;
  campaignId: string;
  observedAt: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
}>;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]));
  }
  return value;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value)), "utf8").digest("hex")}`;
}

function leaseTokenDigest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function requireId(value: string, code: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(code);
  return value;
}

function requireTimestamp(value: string): string {
  if (new Date(value).toISOString() !== value) throw new Error("transformer_pilot_observed_at_invalid");
  return value;
}

function requireEvidence(values: readonly string[], code = "transformer_pilot_evidence_required"): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(code);
  }
  if (new Set(values).size !== values.length) throw new Error(`${code}_duplicate`);
  return [...values].sort();
}

function requireRevision(value: string, code: string): string {
  if (!REVISION.test(value)) throw new Error(code);
  return value;
}

function requireDigest(value: string, code: string): string {
  if (!DIGEST.test(value)) throw new Error(code);
  return value;
}

function requireNonnegative(value: number, code: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function waves(units: readonly TransformerPilotUnitInput[]): Map<string, number> {
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  if (byId.size !== units.length) throw new Error("transformer_pilot_unit_duplicate");
  for (const unit of units) {
    for (const dependency of unit.dependsOn) {
      if (!byId.has(dependency) || dependency === unit.id) throw new Error("transformer_pilot_dependency_invalid");
    }
  }
  const result = new Map<string, number>();
  const remaining = new Set(byId.keys());
  while (remaining.size) {
    const ready = [...remaining].filter((id) => byId.get(id)!.dependsOn.every((dependency) => result.has(dependency))).sort();
    if (!ready.length) throw new Error("transformer_pilot_dependency_cycle");
    for (const id of ready) {
      result.set(id, Math.max(1, ...byId.get(id)!.dependsOn.map((dependency) => result.get(dependency)! + 1)));
      remaining.delete(id);
    }
  }
  return result;
}

function unitById(state: { units: readonly TransformerPilotUnit[] }, unitId: string): TransformerPilotUnit {
  const unit = state.units.find((candidate) => candidate.id === unitId);
  if (!unit) throw new Error("transformer_pilot_unit_not_found");
  return unit;
}

function requireLeaseDuration(value: number | undefined): number {
  const duration = value ?? DEFAULT_LEASE_DURATION_MS;
  if (
    !Number.isSafeInteger(duration) ||
    duration < MIN_LEASE_DURATION_MS ||
    duration > MAX_LEASE_DURATION_MS
  ) {
    throw new Error("transformer_pilot_lease_duration_invalid");
  }
  return duration;
}

function attemptEligible(
  state: { units: readonly TransformerPilotUnit[] },
  unit: TransformerPilotUnit,
): boolean {
  return (
    (unit.state === "pending" || (unit.state === "failed" && unit.retryAuthorized)) &&
    unit.dependsOn.every((dependency) => unitById(state, dependency).state === "merged")
  );
}

function assertAttemptFence(
  state: StoredCampaign,
  input: Readonly<{
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    observedAt: string;
  }>,
): void {
  if (state.state !== "running") {
    throw new Error("transformer_pilot_campaign_not_running");
  }
  const unit = unitById(state, input.unitId);
  if (unit.state !== "running") {
    throw new Error("transformer_pilot_attempt_not_running");
  }
  if (
    !Number.isSafeInteger(input.leaseGeneration) ||
    input.leaseGeneration < 1 ||
    typeof input.leaseToken !== "string" ||
    input.leaseToken.length < 24 ||
    unit.leaseGeneration !== input.leaseGeneration ||
    unit.leaseTokenDigest !== leaseTokenDigest(input.leaseToken)
  ) {
    throw new Error("transformer_pilot_fence_stale");
  }
  const observedAt = Date.parse(requireTimestamp(input.observedAt));
  const leaseExpiresAt = Date.parse(unit.leaseExpiresAt ?? "");
  if (!Number.isFinite(leaseExpiresAt) || observedAt >= leaseExpiresAt) {
    throw new Error("transformer_pilot_fence_expired");
  }
}

function requireAttemptFailureCode(value: string): TransformerAttemptFailureCode {
  if (!TRANSFORMER_ATTEMPT_FAILURE_CODES.has(value as TransformerAttemptFailureCode)) {
    throw new Error("transformer_pilot_failure_code_invalid");
  }
  return value as TransformerAttemptFailureCode;
}

function replaceUnit(state: StoredCampaign, next: TransformerPilotUnit): void {
  state.units = state.units.map((unit) => unit.id === next.id ? next : unit);
}

function openedException(
  state: StoredCampaign,
  code: TransformerPilotExceptionCode,
  observedAt: string,
  evidenceRefs: readonly string[],
  unit?: TransformerPilotUnit,
): TransformerPilotException {
  const id = `exception-${String(state.exceptions.length + 1).padStart(4, "0")}`;
  return {
    id,
    code,
    unitId: unit?.id,
    ownerId: unit?.ownerId ?? "campaign-owner",
    dueAction: code === "worker_crash" ? "Authorize a fenced retry" : "Resolve the evidence conflict and resume",
    state: "open",
    openedAt: observedAt,
    evidenceRefs: requireEvidence(evidenceRefs),
  };
}

export class TransformerPilotExecutionStore {
  private readonly db: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS tf_pilot_campaigns (
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, campaign_id)
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_revision INTEGER NOT NULL,
        type TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        evidence_refs_json TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_idempotency (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        result_revision INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS tf_pilot_claim_results (
        tenant_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        lease_json TEXT NOT NULL,
        PRIMARY KEY (tenant_id, idempotency_key)
      );
      CREATE TRIGGER IF NOT EXISTS tf_pilot_events_no_update BEFORE UPDATE ON tf_pilot_events
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_events_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_events_no_delete BEFORE DELETE ON tf_pilot_events
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_events_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_idempotency_no_update BEFORE UPDATE ON tf_pilot_idempotency
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_idempotency_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_idempotency_no_delete BEFORE DELETE ON tf_pilot_idempotency
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_idempotency_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_claim_results_no_update BEFORE UPDATE ON tf_pilot_claim_results
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_claim_results_append_only'); END;
      CREATE TRIGGER IF NOT EXISTS tf_pilot_claim_results_no_delete BEFORE DELETE ON tf_pilot_claim_results
      BEGIN SELECT RAISE(ABORT, 'transformer_pilot_claim_results_append_only'); END;
    `);
  }

  close(): void {
    this.db.close();
  }

  getCampaign(tenantId: string, campaignId: string): TransformerPilotCampaign | undefined {
    const row = this.db.prepare(
      "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ? AND campaign_id = ?",
    ).get(requireId(tenantId, "transformer_pilot_tenant_invalid"), requireId(campaignId, "transformer_pilot_campaign_invalid")) as { body_json: string } | undefined;
    return row ? deepFreeze(JSON.parse(row.body_json) as TransformerPilotCampaign) : undefined;
  }

  listEvents(tenantId: string, campaignId: string): TransformerPilotEvent[] {
    const rows = this.db.prepare(
      "SELECT * FROM tf_pilot_events WHERE tenant_id = ? AND campaign_id = ? ORDER BY sequence",
    ).all(tenantId, campaignId) as Array<Record<string, unknown>>;
    return rows.map((row) => deepFreeze({
      sequence: row.sequence as number,
      tenantId: row.tenant_id as string,
      campaignId: row.campaign_id as string,
      campaignRevision: row.campaign_revision as number,
      type: row.type as string,
      observedAt: row.observed_at as string,
      evidenceRefs: JSON.parse(row.evidence_refs_json as string) as string[],
      payload: JSON.parse(row.payload_json as string) as Record<string, unknown>,
    }));
  }

  listRunnableCampaigns(
    tenantId?: string,
    limit = 25,
    gateConfig?: string,
  ): TransformerRunnableCampaign[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_campaign_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    const runnable = (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .filter((campaign) =>
        campaign.state === "running" &&
        !campaign.units.some((unit) => unit.state === "running") &&
        campaign.units.some((unit) => attemptEligible(campaign, unit)) &&
        (gateConfig === undefined || authorizeTransformerWorkerAction({
          tenantId: campaign.tenantId,
          environment: campaign.environment,
        }, gateConfig).allowed)
      )
      .sort((left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) ||
        left.tenantId.localeCompare(right.tenantId) ||
        left.campaignId.localeCompare(right.campaignId)
      )
      .slice(0, limit)
      .map(({ tenantId: campaignTenantId, campaignId, environment }) => ({
        tenantId: campaignTenantId,
        campaignId,
        environment,
      }));
    return deepFreeze(runnable);
  }

  listExpiredAttempts(
    observedAt: string,
    tenantId?: string,
    limit = 25,
    gateConfig?: string,
  ): TransformerExpiredAttempt[] {
    const observedAtMs = Date.parse(requireTimestamp(observedAt));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("transformer_pilot_attempt_limit_invalid");
    }
    const rows = tenantId === undefined
      ? this.db.prepare("SELECT body_json FROM tf_pilot_campaigns").all()
      : this.db.prepare(
        "SELECT body_json FROM tf_pilot_campaigns WHERE tenant_id = ?",
      ).all(requireId(tenantId, "transformer_pilot_tenant_invalid"));
    const expired = (rows as Array<{ body_json: string }>)
      .map((row) => JSON.parse(row.body_json) as TransformerPilotCampaign)
      .filter((campaign) =>
        campaign.state === "running" &&
        (gateConfig === undefined || authorizeTransformerWorkerAction({
          tenantId: campaign.tenantId,
          environment: campaign.environment,
        }, gateConfig).allowed)
      )
      .flatMap((campaign) => campaign.units
        .filter((unit) => {
          const expiresAt = Date.parse(unit.leaseExpiresAt ?? "");
          return unit.state === "running" &&
            (!Number.isFinite(expiresAt) || observedAtMs >= expiresAt);
        })
        .map((unit) => ({ campaign, unit })))
      .sort((left, right) =>
        String(left.unit.leaseExpiresAt ?? "").localeCompare(
          String(right.unit.leaseExpiresAt ?? ""),
        ) ||
        left.campaign.tenantId.localeCompare(right.campaign.tenantId) ||
        left.campaign.campaignId.localeCompare(right.campaign.campaignId) ||
        left.unit.id.localeCompare(right.unit.id)
      )
      .slice(0, limit)
      .map(({ campaign, unit }) => ({
        tenantId: campaign.tenantId,
        campaignId: campaign.campaignId,
        unitId: unit.id,
        leaseGeneration: unit.leaseGeneration,
        environment: campaign.environment,
      }));
    return deepFreeze(expired);
  }

  createCampaign(input: TransformerPilotCampaignInput): TransformerPilotCampaign {
    requireId(input.tenantId, "transformer_pilot_tenant_invalid");
    requireId(input.organizationId, "transformer_pilot_organization_invalid");
    requireId(input.environment, "transformer_pilot_environment_invalid");
    requireId(input.campaignId, "transformer_pilot_campaign_invalid");
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    if (!Array.isArray(input.units) || input.units.length === 0 || input.units.length > 500) {
      throw new Error("transformer_pilot_units_invalid");
    }
    if (input.constraints.tenantId !== input.tenantId || input.constraints.organizationId !== input.organizationId) {
      throw new Error("transformer_pilot_constraint_scope_mismatch");
    }
    const gate = authorizeTransformerWorkerAction({ tenantId: input.tenantId, environment: input.environment }, input.gateConfig);
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    const waveById = waves(input.units);
    const units = input.units.map((candidate): TransformerPilotUnit => {
      requireId(candidate.id, "transformer_pilot_unit_invalid");
      requireId(candidate.ownerId, "transformer_pilot_owner_invalid");
      requireEvidence(candidate.reviewerIds, "transformer_pilot_reviewers_required");
      requireId(candidate.snapshot.snapshotId, "transformer_pilot_snapshot_invalid");
      requireRevision(candidate.snapshot.revision, "transformer_pilot_source_revision_invalid");
      if (!MANIFEST_SHA256.test(candidate.snapshot.manifestSha256)) {
        throw new Error("transformer_pilot_snapshot_manifest_invalid");
      }
      requireRevision(candidate.candidateRevision, "transformer_pilot_candidate_revision_invalid");
      requireDigest(candidate.snapshot.digest, "transformer_pilot_source_digest_invalid");
      requireDigest(candidate.candidateDigest, "transformer_pilot_candidate_digest_invalid");
      requireEvidence(candidate.snapshot.evidenceRefs, "transformer_pilot_snapshot_evidence_required");
      if (!candidate.changedPaths.length) throw new Error("transformer_pilot_changed_paths_required");
      const decisions = candidate.changedPaths.map((path: string) => assessOrganizationConstraint(input.constraints, {
        tenantId: input.tenantId,
        organizationId: input.organizationId,
        repositoryId: candidate.snapshot.repositoryId,
        path,
        action: "change",
      }));
      const denied = decisions.filter((decision: ReturnType<typeof assessOrganizationConstraint>) => !decision.allowed);
      if (denied.length) throw new Error(`transformer_pilot_constraint_denied:${candidate.id}:${denied.flatMap((decision: ReturnType<typeof assessOrganizationConstraint>) => decision.reasons).join(",")}`);
      return {
        ...clone(candidate),
        wave: waveById.get(candidate.id)!,
        state: "pending",
        attemptNumber: 0,
        leaseGeneration: 0,
        retryAuthorized: false,
        executionEvidenceRefs: [],
        scmEvidenceRefs: [],
      };
    });
    const state: StoredCampaign = {
      schemaVersion: TRANSFORMER_PILOT_EXECUTION_SCHEMA_VERSION,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      environment: input.environment,
      campaignId: input.campaignId,
      revision: 1,
      state: "running",
      constraintVersion: input.constraints.version,
      constraintDigest: input.constraints.digest,
      gateEvidenceRefs: [...gate.acceptanceEvidenceRefs],
      units,
      exceptions: [],
      createdAt: input.observedAt,
      updatedAt: input.observedAt,
    };
    const requestDigest = sha256(input);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(input.tenantId, input.idempotencyKey, "campaign.created", requestDigest, input.campaignId);
      if (replay) {
        this.db.exec("COMMIT");
        return replay;
      }
      if (this.getCampaign(input.tenantId, input.campaignId)) throw new Error("transformer_pilot_campaign_exists");
      this.db.prepare("INSERT INTO tf_pilot_campaigns VALUES (?, ?, ?, ?)")
        .run(input.tenantId, input.campaignId, 1, JSON.stringify(state));
      this.insertEvent(state, "campaign.created", input.observedAt, evidenceRefs, {
        constraintDigest: state.constraintDigest,
        unitCount: units.length,
      });
      this.insertIdempotency(input.tenantId, input.idempotencyKey, "campaign.created", requestDigest, input.campaignId, 1);
      this.db.exec("COMMIT");
      return deepFreeze(clone(state));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  claimNextAttempt(input: MutationInput & {
    leaseToken: string;
    leaseDurationMs?: number;
    gateConfig?: string;
  }): TransformerAttemptLease | null {
    if (!input.leaseToken || input.leaseToken.length < 24) throw new Error("transformer_pilot_lease_token_invalid");
    const observedAt = requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    const leaseDurationMs = requireLeaseDuration(input.leaseDurationMs);
    const leaseExpiresAt = new Date(Date.parse(observedAt) + leaseDurationMs).toISOString();
    const tokenDigest = leaseTokenDigest(input.leaseToken);
    const request = {
      leaseTokenDigest: tokenDigest,
      leaseDurationMs,
      leaseExpiresAt,
    };
    const requestDigest = sha256(request);
    const leaseFrom = (
      state: StoredCampaign,
      unit: TransformerPilotUnit,
    ): TransformerAttemptLease => deepFreeze({
      type: "execute_recipe",
      tenantId: state.tenantId,
      campaignId: state.campaignId,
      unitId: unit.id,
      attemptNumber: unit.attemptNumber,
      leaseGeneration: unit.leaseGeneration,
      leaseTokenDigest: unit.leaseTokenDigest!,
      leaseExpiresAt: unit.leaseExpiresAt!,
      snapshot: unit.snapshot,
      candidateRevision: unit.candidateRevision,
      candidateDigest: unit.candidateDigest,
      changedPaths: unit.changedPaths,
      recipe: unit.recipe,
      constraintVersion: state.constraintVersion,
      constraintDigest: state.constraintDigest,
      gateEvidenceRefs: state.gateEvidenceRefs,
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(
        input.tenantId,
        input.idempotencyKey,
        "attempt.claimed",
        requestDigest,
        input.campaignId,
      );
      if (replay) {
        const row = this.db.prepare(
          "SELECT lease_json FROM tf_pilot_claim_results WHERE tenant_id = ? AND idempotency_key = ?",
        ).get(input.tenantId, input.idempotencyKey) as { lease_json: string } | undefined;
        if (!row) {
          const replayState = clone(replay) as StoredCampaign;
          const replayUnit = replayState.units.find(
            (unit) =>
              unit.state === "running" &&
              unit.leaseTokenDigest === tokenDigest &&
              unit.startedAt === observedAt,
          );
          if (!replayUnit) throw new Error("transformer_pilot_claim_replay_invalid");
          this.db.exec("COMMIT");
          return leaseFrom(replayState, replayUnit);
        }
        const claimedLease = JSON.parse(row.lease_json) as TransformerAttemptLease;
        if (
          claimedLease.tenantId !== input.tenantId ||
          claimedLease.campaignId !== input.campaignId ||
          claimedLease.leaseTokenDigest !== tokenDigest
        ) {
          throw new Error("transformer_pilot_claim_replay_invalid");
        }
        this.db.exec("COMMIT");
        return deepFreeze(claimedLease);
      }
      const state = this.mustGet(input.tenantId, input.campaignId);
      const gate = authorizeTransformerWorkerAction(
        { tenantId: input.tenantId, environment: state.environment },
        input.gateConfig,
      );
      if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
      if (state.state !== "running" || state.units.some((unit) => unit.state === "running")) {
        this.db.exec("COMMIT");
        return null;
      }
      const eligible = state.units
        .filter((unit) => attemptEligible(state, unit))
        .sort((left, right) => left.wave - right.wave || left.id.localeCompare(right.id))[0];
      if (!eligible) {
        this.db.exec("COMMIT");
        return null;
      }
      const updated: TransformerPilotUnit = {
        ...eligible,
        state: "running",
        attemptNumber: eligible.attemptNumber + 1,
        leaseGeneration: eligible.leaseGeneration + 1,
        leaseTokenDigest: tokenDigest,
        leaseExpiresAt,
        retryAuthorized: false,
        startedAt: observedAt,
      };
      replaceUnit(state, updated);
      state.revision += 1;
      state.updatedAt = observedAt;
      this.db.prepare("UPDATE tf_pilot_campaigns SET revision = ?, body_json = ? WHERE tenant_id = ? AND campaign_id = ?")
        .run(state.revision, JSON.stringify(state), state.tenantId, state.campaignId);
      this.insertEvent(state, "attempt.claimed", observedAt, evidenceRefs, {
        ...request,
        unitId: updated.id,
      });
      this.insertIdempotency(
        state.tenantId,
        input.idempotencyKey,
        "attempt.claimed",
        requestDigest,
        state.campaignId,
        state.revision,
      );
      const claimedLease = leaseFrom(state, updated);
      this.db.prepare("INSERT INTO tf_pilot_claim_results VALUES (?, ?, ?)")
        .run(state.tenantId, input.idempotencyKey, JSON.stringify(claimedLease));
      this.db.exec("COMMIT");
      return claimedLease;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  assertCurrentAttemptFence(input: Readonly<{
    tenantId: string;
    campaignId: string;
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    observedAt: string;
  }>): void {
    const state = this.mustGet(input.tenantId, input.campaignId);
    assertAttemptFence(state, input);
  }

  completeAttempt(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    sourceRevision: string;
    sourceDigest: string;
    candidateRevision: string;
    candidateDigest: string;
    verificationPassed: boolean;
    actualCostUsd: number;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    requireRevision(input.sourceRevision, "transformer_pilot_source_revision_invalid");
    requireDigest(input.sourceDigest, "transformer_pilot_source_digest_invalid");
    requireRevision(input.candidateRevision, "transformer_pilot_candidate_revision_invalid");
    requireDigest(input.candidateDigest, "transformer_pilot_candidate_digest_invalid");
    requireNonnegative(input.actualCostUsd, "transformer_pilot_cost_invalid");
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    return this.mutate(input, "attempt.completed", {
      ...input,
      leaseToken: leaseTokenDigest(input.leaseToken),
    }, (state) => {
      const unit = unitById(state, input.unitId);
      assertAttemptFence(state, input);
      if (unit.snapshot.revision !== input.sourceRevision || unit.snapshot.digest !== input.sourceDigest) {
        throw new Error("transformer_pilot_source_drift");
      }
      if (unit.candidateRevision !== input.candidateRevision || unit.candidateDigest !== input.candidateDigest) {
        throw new Error("transformer_pilot_candidate_drift");
      }
      if (!input.verificationPassed) throw new Error("transformer_pilot_verification_failed");
      replaceUnit(state, {
        ...unit,
        state: "executed",
        verificationPassed: true,
        actualCostUsd: input.actualCostUsd,
        executedAt: input.observedAt,
        executionEvidenceRefs: requireEvidence(input.evidenceRefs),
      });
    });
  }

  recordAttemptFailure(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    code: TransformerAttemptFailureCode;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const code = requireAttemptFailureCode(input.code);
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.failed",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        leaseTokenDigest: leaseTokenDigest(input.leaseToken),
        code,
      },
      (state) => {
        assertAttemptFence(state, input);
        const unit = unitById(state, input.unitId);
        replaceUnit(state, {
          ...unit,
          state: "failed",
          retryAuthorized: false,
        });
        state.state = "paused";
        state.exceptions.push(
          openedException(state, code, input.observedAt, input.evidenceRefs, unit),
        );
      },
    );
  }

  expireAttempt(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) {
      throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    }
    return this.mutate(
      input,
      "attempt.expired",
      {
        unitId: input.unitId,
        leaseGeneration: input.leaseGeneration,
        observedAt: input.observedAt,
        evidenceRefs: input.evidenceRefs,
      },
      (state) => {
        if (state.state !== "running") {
          throw new Error("transformer_pilot_campaign_not_running");
        }
        const unit = unitById(state, input.unitId);
        if (unit.state !== "running") {
          throw new Error("transformer_pilot_attempt_not_running");
        }
        if (
          !Number.isSafeInteger(input.leaseGeneration) ||
          input.leaseGeneration < 1 ||
          unit.leaseGeneration !== input.leaseGeneration
        ) {
          throw new Error("transformer_pilot_fence_stale");
        }
        const observedAt = Date.parse(requireTimestamp(input.observedAt));
        const leaseExpiresAt = Date.parse(unit.leaseExpiresAt ?? "");
        if (Number.isFinite(leaseExpiresAt) && observedAt < leaseExpiresAt) {
          throw new Error("transformer_pilot_fence_not_expired");
        }
        replaceUnit(state, {
          ...unit,
          state: "failed",
          retryAuthorized: false,
        });
        state.state = "paused";
        state.exceptions.push(
          openedException(
            state,
            "worker_crash",
            input.observedAt,
            input.evidenceRefs,
            unit,
          ),
        );
      },
    );
  }

  authorizeCurrentWaveDrafts(input: MutationInput & {
    gateConfig?: string;
    productionDeliveryApprovalRefs?: readonly string[];
  }): readonly TransformerDraftAction[] {
    const state = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerDelivery({
      tenantId: state.tenantId,
      environment: state.environment,
      productionDeliveryApprovalRefs: input.productionDeliveryApprovalRefs,
    }, input.gateConfig);
    if (!gate.allowed) throw new Error(`transformer_pilot_delivery_denied:${gate.reasons.join(",")}`);
    if (state.state !== "running") throw new Error("transformer_pilot_campaign_not_running");
    const wave = Math.min(...state.units.filter((unit) => unit.state !== "merged" && unit.state !== "cancelled" && unit.state !== "rolled_back").map((unit) => unit.wave));
    const current = state.units.filter((unit) => unit.wave === wave);
    if (!current.length || current.some((unit) => unit.state !== "executed")) {
      throw new Error("transformer_pilot_wave_execution_incomplete");
    }
    const actions = current.map((unit): TransformerDraftAction => ({
      type: "open_draft",
      unitId: unit.id,
      repositoryId: unit.snapshot.repositoryId,
      expectedBaseRevision: unit.snapshot.revision,
      expectedHeadRevision: unit.candidateRevision,
      evidenceRefs: [...new Set([...unit.executionEvidenceRefs, ...gate.acceptanceEvidenceRefs])].sort(),
      draft: true,
      autoMerge: false,
      autoDeploy: false,
    }));
    this.mutate(input, "delivery.drafts_authorized", { wave, actionUnitIds: actions.map((action) => action.unitId) }, (draft) => {
      draft.units = draft.units.map((unit) => unit.wave === wave ? { ...unit, state: "draft" as const } : unit);
    });
    return deepFreeze(actions);
  }

  reconcileWave(input: MutationInput & {
    wave: number;
    observations: readonly TransformerScmObservation[];
    gateConfig?: string;
  }): TransformerPilotCampaign {
    const campaign = this.mustGet(input.tenantId, input.campaignId);
    const gate = authorizeTransformerWorkerAction(
      { tenantId: input.tenantId, environment: campaign.environment },
      input.gateConfig,
    );
    if (!gate.allowed) throw new Error(`transformer_pilot_gate_denied:${gate.reasons.join(",")}`);
    return this.mutate(input, "delivery.wave_reconciled", { wave: input.wave, observations: input.observations }, (state) => {
      if (state.state !== "running") throw new Error("transformer_pilot_campaign_not_running");
      const units = state.units.filter((unit) => unit.wave === input.wave);
      if (!units.length || input.observations.length !== units.length) throw new Error("transformer_pilot_wave_observation_incomplete");
      const byId = new Map(input.observations.map((observation) => [observation.unitId, observation]));
      if (byId.size !== units.length || units.some((unit) => !byId.has(unit.id))) throw new Error("transformer_pilot_wave_observation_scope_invalid");
      const failures: Array<{ code: TransformerPilotExceptionCode; unit?: TransformerPilotUnit; evidenceRefs: readonly string[] }> = [];
      const merged = input.observations.filter((observation) => observation.state === "merged");
      if (merged.length > 0 && merged.length < units.length) {
        failures.push({ code: "partial_wave_merge", evidenceRefs: input.observations.flatMap((observation) => observation.evidenceRefs) });
      }
      for (const unit of units) {
        const observation = byId.get(unit.id)!;
        requireEvidence(observation.evidenceRefs, "transformer_pilot_scm_evidence_required");
        requireNonnegative(observation.approvals, "transformer_pilot_approvals_invalid");
        requireNonnegative(observation.reviewerEditLines, "transformer_pilot_reviewer_delta_invalid");
        requireNonnegative(observation.legacyItemsRemoved, "transformer_pilot_legacy_delta_invalid");
        if (observation.baseRevision !== unit.snapshot.revision) failures.push({ code: "source_drift", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.headRevision !== unit.candidateRevision) failures.push({ code: "head_drift", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.state === "closed") failures.push({ code: "draft_closed", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.checks === "failure") failures.push({ code: "ci_failure", unit, evidenceRefs: observation.evidenceRefs });
        if (!observation.conversationsResolved) failures.push({ code: "conversation_unresolved", unit, evidenceRefs: observation.evidenceRefs });
        if (observation.state === "merged") {
          if (observation.checks === "running" || observation.checks === "missing") {
            failures.push({ code: "ci_incomplete", unit, evidenceRefs: observation.evidenceRefs });
          } else if (observation.checkRevision !== unit.candidateRevision) {
            failures.push({ code: "ci_evidence_stale", unit, evidenceRefs: observation.evidenceRefs });
          }
          if (observation.approvals < 1) {
            failures.push({ code: "review_incomplete", unit, evidenceRefs: observation.evidenceRefs });
          } else if (observation.approvalRevision !== unit.candidateRevision) {
            failures.push({ code: "review_evidence_stale", unit, evidenceRefs: observation.evidenceRefs });
          }
        }
      }
      state.units = state.units.map((unit) => {
        if (unit.wave !== input.wave) return unit;
        const observation = byId.get(unit.id)!;
        const accepted =
          observation.baseRevision === unit.snapshot.revision &&
          observation.headRevision === unit.candidateRevision &&
          observation.checks === "success" &&
          observation.checkRevision === unit.candidateRevision &&
          observation.approvals >= 1 &&
          observation.approvalRevision === unit.candidateRevision &&
          observation.conversationsResolved;
        const merged = observation.state === "merged" && accepted;
        return {
          ...unit,
          state: merged
            ? "merged" as const
            : observation.state === "merged" && unit.state === "accepted"
              ? "accepted" as const
              : accepted
                ? "accepted" as const
                : "draft" as const,
          acceptedAt: accepted ? unit.acceptedAt ?? input.observedAt : unit.acceptedAt,
          mergedAt: merged ? input.observedAt : unit.mergedAt,
          scmEvidenceRefs: requireEvidence(observation.evidenceRefs),
          reviewerEditLines: observation.reviewerEditLines,
          legacyItemsRemoved: observation.legacyItemsRemoved,
        };
      });
      if (failures.length) {
        state.state = "paused";
        for (const failure of failures) {
          if (!state.exceptions.some((exception) => exception.state === "open" && exception.code === failure.code && exception.unitId === failure.unit?.id)) {
            state.exceptions.push(openedException(state, failure.code, input.observedAt, failure.evidenceRefs, failure.unit));
          }
        }
        return;
      }
      if (state.units.every((unit) => unit.state === "merged")) state.state = "completed";
    });
  }

  recordWorkerCrash(input: MutationInput & {
    unitId: string;
    leaseGeneration: number;
    leaseToken: string;
    gateConfig?: string;
  }): TransformerPilotCampaign {
    return this.recordAttemptFailure({ ...input, code: "worker_crash" });
  }

  control(input: MutationInput & {
    action: "pause" | "resume" | "cancel" | "authorize_retry" | "resolve_exception" | "waive_exception";
    unitId?: string;
    exceptionId?: string;
    resolution?: string;
  }): TransformerPilotCampaign {
    return this.mutate(input, `campaign.${input.action}`, input, (state) => {
      if (input.action === "pause") {
        if (state.state !== "running") throw new Error("transformer_pilot_pause_invalid");
        state.state = "paused";
      } else if (input.action === "cancel") {
        if (state.state === "completed" || state.state === "rolled_back") throw new Error("transformer_pilot_cancel_invalid");
        state.state = "cancelled";
        state.units = state.units.map((unit) => ["merged", "rolled_back"].includes(unit.state) ? unit : { ...unit, state: "cancelled" as const });
      } else if (input.action === "authorize_retry") {
        const unit = unitById(state, requireId(input.unitId!, "transformer_pilot_unit_invalid"));
        if (unit.state !== "failed") throw new Error("transformer_pilot_retry_invalid");
        replaceUnit(state, { ...unit, retryAuthorized: true });
      } else if (input.action === "resolve_exception" || input.action === "waive_exception") {
        const exceptionId = requireId(input.exceptionId!, "transformer_pilot_exception_invalid");
        if (!input.resolution?.trim()) throw new Error("transformer_pilot_resolution_required");
        const current = state.exceptions.find((exception) => exception.id === exceptionId);
        if (!current || current.state !== "open") throw new Error("transformer_pilot_exception_not_open");
        state.exceptions = state.exceptions.map((exception) => exception.id === exceptionId ? {
          ...exception,
          state: input.action === "resolve_exception" ? "resolved" as const : "waived" as const,
          closedAt: input.observedAt,
          resolution: input.resolution!.trim(),
          evidenceRefs: [...new Set([...exception.evidenceRefs, ...input.evidenceRefs])].sort(),
        } : exception);
      } else {
        if (state.state !== "paused" || state.exceptions.some((exception) => exception.state === "open")) {
          throw new Error("transformer_pilot_resume_blocked");
        }
        state.state = "running";
      }
    });
  }

  planRollback(input: MutationInput): readonly TransformerRollbackAction[] {
    const state = this.mustGet(input.tenantId, input.campaignId);
    const actions = [...state.units]
      .sort((left, right) => right.wave - left.wave || right.id.localeCompare(left.id))
      .flatMap((unit): TransformerRollbackAction[] => {
        const evidenceRefs = [...new Set([...unit.executionEvidenceRefs, ...unit.scmEvidenceRefs, ...input.evidenceRefs])].sort();
        if (unit.state === "merged") return [{
          type: "open_revert_draft", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.candidateRevision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        if (unit.state === "draft" || unit.state === "accepted") return [{
          type: "close_draft", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.candidateRevision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        if (unit.state === "executed" || unit.state === "failed" || unit.state === "running") return [{
          type: "restore_workspace", unitId: unit.id, repositoryId: unit.snapshot.repositoryId,
          expectedRevision: unit.snapshot.revision, evidenceRefs, draft: true, autoMerge: false, autoDeploy: false,
        }];
        return [];
      });
    if (!actions.length) throw new Error("transformer_pilot_rollback_plan_empty");
    const planned = this.mutate(input, "rollback.planned", { actions }, (draft) => {
      if (draft.state === "rolled_back") throw new Error("transformer_pilot_already_rolled_back");
      draft.state = "rollback_required";
      draft.rollbackPlan = actions;
    });
    return deepFreeze(clone(planned.rollbackPlan!));
  }

  getRollbackPlan(tenantId: string, campaignId: string): readonly TransformerRollbackAction[] {
    const state = this.mustGet(tenantId, campaignId);
    if (state.state !== "rollback_required" || !state.rollbackPlan?.length) {
      throw new Error("transformer_pilot_rollback_plan_not_found");
    }
    return deepFreeze(clone(state.rollbackPlan));
  }

  metrics(tenantId: string, campaignId: string): TransformerPilotMetrics {
    const state = this.mustGet(tenantId, campaignId);
    const waves = new Set(state.units.map((unit) => unit.wave));
    const completedWaves = [...waves].filter((wave) => state.units.filter((unit) => unit.wave === wave).every((unit) => unit.state === "merged"));
    const accepted = state.units.filter((unit) => unit.acceptedAt || unit.mergedAt);
    const verified = state.units.filter((unit) => unit.verificationPassed !== undefined);
    const firstAcceptedAt = accepted.map((unit) => unit.acceptedAt ?? unit.mergedAt!).sort()[0];
    return deepFreeze({
      campaignCompletionRate: state.state === "completed" ? 1 : state.units.filter((unit) => unit.state === "merged").length / state.units.length,
      waveCompletionRate: completedWaves.length / waves.size,
      batchAcceptanceRate: accepted.length / state.units.length,
      timeToFirstAcceptedPullRequestMs: firstAcceptedAt ? Date.parse(firstAcceptedAt) - Date.parse(state.createdAt) : null,
      openExceptionCount: state.exceptions.filter((exception) => exception.state === "open").length,
      verificationPassRate: verified.length ? verified.filter((unit) => unit.verificationPassed).length / verified.length : null,
      rollbackRate: state.units.filter((unit) => unit.state === "rolled_back").length / state.units.length,
      legacyItemsRemoved: state.units.reduce((sum, unit) => sum + (unit.legacyItemsRemoved ?? 0), 0),
      reviewerEditLines: state.units.reduce((sum, unit) => sum + (unit.reviewerEditLines ?? 0), 0),
      actualCostUsd: state.units.every((unit) => unit.actualCostUsd !== undefined)
        ? state.units.reduce((sum, unit) => sum + unit.actualCostUsd!, 0)
        : null,
    });
  }

  private mustGet(tenantId: string, campaignId: string): StoredCampaign {
    const state = this.getCampaign(tenantId, campaignId);
    if (!state) throw new Error("transformer_pilot_campaign_not_found");
    return clone(state) as StoredCampaign;
  }

  private mutate(
    input: MutationInput,
    scope: string,
    request: unknown,
    update: (state: StoredCampaign) => void,
  ): TransformerPilotCampaign {
    requireTimestamp(input.observedAt);
    const evidenceRefs = requireEvidence(input.evidenceRefs);
    requireId(input.idempotencyKey, "transformer_pilot_idempotency_invalid");
    const requestDigest = sha256(request);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const replay = this.idempotentReplay(input.tenantId, input.idempotencyKey, scope, requestDigest, input.campaignId);
      if (replay) {
        this.db.exec("COMMIT");
        return replay;
      }
      const state = this.mustGet(input.tenantId, input.campaignId);
      update(state);
      state.revision += 1;
      state.updatedAt = input.observedAt;
      this.db.prepare("UPDATE tf_pilot_campaigns SET revision = ?, body_json = ? WHERE tenant_id = ? AND campaign_id = ?")
        .run(state.revision, JSON.stringify(state), state.tenantId, state.campaignId);
      this.insertEvent(state, scope, input.observedAt, evidenceRefs, request as Record<string, unknown>);
      this.insertIdempotency(state.tenantId, input.idempotencyKey, scope, requestDigest, state.campaignId, state.revision);
      this.db.exec("COMMIT");
      return deepFreeze(clone(state));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private idempotentReplay(
    tenantId: string,
    idempotencyKey: string,
    scope: string,
    requestDigest: string,
    campaignId: string,
  ): TransformerPilotCampaign | undefined {
    const row = this.db.prepare(
      "SELECT scope, request_digest, campaign_id FROM tf_pilot_idempotency WHERE tenant_id = ? AND idempotency_key = ?",
    ).get(tenantId, idempotencyKey) as { scope: string; request_digest: string; campaign_id: string } | undefined;
    if (!row) return undefined;
    if (row.scope !== scope || row.request_digest !== requestDigest || row.campaign_id !== campaignId) {
      throw new Error("transformer_pilot_idempotency_conflict");
    }
    return this.getCampaign(tenantId, campaignId);
  }

  private insertEvent(
    state: StoredCampaign,
    type: string,
    observedAt: string,
    evidenceRefs: readonly string[],
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare("INSERT INTO tf_pilot_events (tenant_id, campaign_id, campaign_revision, type, observed_at, evidence_refs_json, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(state.tenantId, state.campaignId, state.revision, type, observedAt, JSON.stringify(evidenceRefs), JSON.stringify(payload));
  }

  private insertIdempotency(
    tenantId: string,
    key: string,
    scope: string,
    requestDigest: string,
    campaignId: string,
    resultRevision: number,
  ): void {
    this.db.prepare("INSERT INTO tf_pilot_idempotency VALUES (?, ?, ?, ?, ?, ?)")
      .run(tenantId, key, scope, requestDigest, campaignId, resultRevision);
  }
}
