import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveRecipe, type RecipeReference } from "./recipe.js";
import {
  TransformerDomainError,
  type TransformerDomainErrorCode,
} from "./types.js";

const CONTRACT_VERSION = 1 as const;
const SCHEMA_VERSION = 2;

export type CampaignState =
  | "draft"
  | "ready"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";
export type BlueprintState = "draft" | "in_review" | "reviewed" | "superseded";
export type BsgState = "draft" | "locked";
export type UnitState =
  | "pending"
  | "ready"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
export type WaveState = "planned" | "ready" | "running" | "completed" | "failed" | "cancelled";
export type AttemptState = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type ApprovalState = "pending" | "approved" | "rejected" | "revoked";
export type ExceptionState = "open" | "acknowledged" | "resolved" | "waived";
export type PullRequestState = "draft" | "open" | "merged" | "closed";
type TransformerTransitionEntity =
  | "campaign"
  | "blueprint"
  | "bsg"
  | "exception"
  | "unit"
  | "wave"
  | "attempt"
  | "approval"
  | "pr";

type Identity = { tenantId: string; id: string; campaignId: string };
export type Versioned<T> = T & {
  contractVersion: typeof CONTRACT_VERSION;
  revision: number;
  createdAt: string;
};

export type MutationContext = Readonly<{
  actorId: string;
  correlationId: string;
  causationId: string;
  evidenceRefs: readonly string[];
  idempotencyKey: string;
}>;

export type BlueprintRisk = Readonly<{
  id: string;
  statement: string;
  severity: "low" | "medium" | "high" | "critical";
  ownerId: string;
  evidenceRefs: readonly string[];
}>;

export type BlueprintUnknown = Readonly<{
  id: string;
  question: string;
  ownerId: string;
  evidenceRefs: readonly string[];
}>;

export type BlueprintPolicy = Readonly<{
  ownerIds: readonly string[];
  risks: readonly BlueprintRisk[];
  unknowns: readonly BlueprintUnknown[];
  verification: Readonly<{ commands: readonly string[] }>;
  rollback: Readonly<{
    strategy: "inverse_operations";
    verificationCommands: readonly string[];
  }>;
  approval: Readonly<{
    required: true;
    reviewerIds: readonly string[];
  }>;
  recipe: RecipeReference;
}>;

export type CampaignContract = Versioned<
  Identity & {
    name: string;
    sourceSystem: string;
    targetSystem: string;
    blueprintId: string;
    bsgId: string;
    state: CampaignState;
  }
>;
export type BlueprintContract = Versioned<
  Identity & {
    state: BlueprintState;
    objective: string;
    content: Record<string, unknown>;
    policy: BlueprintPolicy;
  }
>;
export type BsgNodeContract = {
  id: string;
  kind: string;
  spec: string;
  sourceRefs: readonly string[];
};
export type BsgEdgeContract = { id: string; from: string; to: string; kind: string };
export type BsgContract = Versioned<
  Identity & { state: BsgState; nodes: BsgNodeContract[]; edges: BsgEdgeContract[] }
>;
export type UnitContract = Versioned<
  Identity & { state: UnitState; title: string; repoKey: string; waveId?: string; dependsOn: string[] }
>;
export type WaveContract = Versioned<
  Identity & { state: WaveState; name: string; unitIds: string[] }
>;
export type AttemptContract = Versioned<
  Identity & { state: AttemptState; unitId: string; number: number; input: Record<string, unknown> }
>;
export type ApprovalContract = Versioned<
  Identity & {
    state: ApprovalState;
    subjectType: string;
    subjectId: string;
    reviewerId?: string;
    note?: string;
  }
>;
export type ExceptionContract = Versioned<
  Identity & { state: ExceptionState; code: string; message: string; unitId?: string }
>;
export type ArtifactContract = Versioned<
  Identity & { kind: string; uri: string; digest: string; metadata: Record<string, unknown> }
>;
export type PullRequestContract = Versioned<
  Identity & { state: PullRequestState; unitId: string; url: string; number?: number }
>;

export type TransformerEvent = {
  sequence: number;
  id: string;
  tenantId: string;
  campaignId: string;
  contractVersion: typeof CONTRACT_VERSION;
  type: string;
  entityType: EntityKind;
  entityId: string;
  entityRevision?: number;
  actorId: string;
  correlationId: string;
  causationId: string;
  evidenceRefs: readonly string[];
  previousRevision: number;
  newRevision: number;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type TransformerEntityKind =
  | "campaign"
  | "blueprint"
  | "bsg"
  | "unit"
  | "wave"
  | "attempt"
  | "approval"
  | "exception"
  | "artifact"
  | "pr";
type EntityKind = TransformerEntityKind;
type EntityTable =
  | "tf_campaign_versions"
  | "tf_blueprint_versions"
  | "tf_bsg_versions"
  | "tf_unit_versions"
  | "tf_wave_versions"
  | "tf_attempt_versions"
  | "tf_approval_versions"
  | "tf_exception_versions"
  | "tf_artifact_versions"
  | "tf_pr_versions";

const TABLES: Record<EntityKind, EntityTable> = {
  campaign: "tf_campaign_versions",
  blueprint: "tf_blueprint_versions",
  bsg: "tf_bsg_versions",
  unit: "tf_unit_versions",
  wave: "tf_wave_versions",
  attempt: "tf_attempt_versions",
  approval: "tf_approval_versions",
  exception: "tf_exception_versions",
  artifact: "tf_artifact_versions",
  pr: "tf_pr_versions",
};

const CAMPAIGN_TRANSITIONS: Record<CampaignState, readonly CampaignState[]> = {
  draft: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["paused", "completed", "failed", "cancelled"],
  paused: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};
const BLUEPRINT_TRANSITIONS: Record<BlueprintState, readonly BlueprintState[]> = {
  draft: ["in_review", "superseded"],
  in_review: ["draft", "reviewed", "superseded"],
  reviewed: ["superseded"],
  superseded: [],
};
const UNIT_TRANSITIONS: Record<UnitState, readonly UnitState[]> = {
  pending: ["ready", "blocked", "cancelled"],
  ready: ["running", "blocked", "cancelled"],
  running: ["blocked", "completed", "failed", "cancelled"],
  blocked: ["ready", "cancelled"],
  completed: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};
const WAVE_TRANSITIONS: Record<WaveState, readonly WaveState[]> = {
  planned: ["ready", "cancelled"],
  ready: ["running", "cancelled"],
  running: ["completed", "failed", "cancelled"],
  completed: [],
  failed: ["ready", "cancelled"],
  cancelled: [],
};
const ATTEMPT_TRANSITIONS: Record<AttemptState, readonly AttemptState[]> = {
  queued: ["running", "cancelled"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};
const APPROVAL_TRANSITIONS: Record<ApprovalState, readonly ApprovalState[]> = {
  pending: ["approved", "rejected"],
  approved: ["revoked"],
  rejected: [],
  revoked: [],
};
const EXCEPTION_TRANSITIONS: Record<ExceptionState, readonly ExceptionState[]> = {
  open: ["acknowledged", "resolved", "waived"],
  acknowledged: ["resolved", "waived"],
  resolved: [],
  waived: [],
};
const PR_TRANSITIONS: Record<PullRequestState, readonly PullRequestState[]> = {
  draft: ["open", "closed"],
  open: ["merged", "closed"],
  merged: [],
  closed: [],
};

type VersionRow = {
  tenant_id: string;
  id: string;
  campaign_id: string;
  revision: number;
  contract_version: number;
  state: string;
  body_json: string;
  created_at: string;
};

type IdempotencyRow = {
  scope: string;
  request_digest: string;
  entity_type: EntityKind;
  entity_id: string;
  entity_revision: number | null;
  event_id: string | null;
};

type EventRow = {
  sequence: number;
  id: string;
  tenant_id: string;
  campaign_id: string;
  contract_version: number;
  type: string;
  entity_type: EntityKind;
  entity_id: string;
  entity_revision?: number | null;
  actor_id: string;
  correlation_id: string;
  causation_id: string;
  evidence_refs_json: string;
  previous_revision: number;
  new_revision: number;
  payload_json: string;
  created_at: string;
};

function required(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${field}_required`);
  if (normalized.length > 1_000) throw new Error(`${field}_too_long`);
  return normalized;
}

function unique(values: readonly string[], field: string): string[] {
  const normalized = values.map((value, index) => required(value, `${field}_${index}`));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${field}_duplicate`);
  return normalized;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function requestDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)), "utf8")
    .digest("hex");
}

function normalizeContext(context: MutationContext): MutationContext {
  return Object.freeze({
    actorId: required(context.actorId, "actor_id"),
    correlationId: required(context.correlationId, "correlation_id"),
    causationId: required(context.causationId, "causation_id"),
    evidenceRefs: nonempty(context.evidenceRefs, "evidence_ref"),
    idempotencyKey: required(context.idempotencyKey, "idempotency_key"),
  });
}

function nonempty(values: readonly string[], field: string): readonly string[] {
  const normalized = unique(values, field);
  if (!normalized.length) throw new Error(`${field}_required`);
  return Object.freeze(normalized);
}

function normalizeBlueprintPolicy(policy: BlueprintPolicy): BlueprintPolicy {
  if (!policy || typeof policy !== "object") throw new Error("blueprint_policy_required");
  if (!Array.isArray(policy.ownerIds) || !policy.ownerIds.length) {
    throw new Error("blueprint_owner_required");
  }
  if (!Array.isArray(policy.risks)) throw new Error("blueprint_risks_required");
  if (!Array.isArray(policy.unknowns)) throw new Error("blueprint_unknowns_required");
  const ownerIds = nonempty(policy.ownerIds, "blueprint_owner");
  const risks = Object.freeze(
    policy.risks.map((risk, index) => {
      if (!(["low", "medium", "high", "critical"] as unknown[]).includes(risk.severity)) {
        throw new Error(`blueprint_risk_severity_${index}_invalid`);
      }
      return Object.freeze({
        id: required(risk.id, `blueprint_risk_id_${index}`),
        statement: required(risk.statement, `blueprint_risk_statement_${index}`),
        severity: risk.severity,
        ownerId: required(risk.ownerId, `blueprint_risk_owner_${index}`),
        evidenceRefs: nonempty(risk.evidenceRefs, `blueprint_risk_evidence_${index}`),
      });
    }),
  );
  const unknowns = Object.freeze(
    policy.unknowns.map((unknown, index) =>
      Object.freeze({
        id: required(unknown.id, `blueprint_unknown_id_${index}`),
        question: required(unknown.question, `blueprint_unknown_question_${index}`),
        ownerId: required(unknown.ownerId, `blueprint_unknown_owner_${index}`),
        evidenceRefs: nonempty(unknown.evidenceRefs, `blueprint_unknown_evidence_${index}`),
      }),
    ),
  );
  const verificationCommands = nonempty(
    policy.verification?.commands ?? [],
    "blueprint_verification_command",
  );
  if (policy.rollback?.strategy !== "inverse_operations") {
    throw new Error("blueprint_rollback_strategy_invalid");
  }
  const rollbackCommands = nonempty(
    policy.rollback.verificationCommands,
    "blueprint_rollback_verification_command",
  );
  if (policy.approval?.required !== true) throw new Error("blueprint_approval_required");
  const reviewerIds = nonempty(policy.approval.reviewerIds, "blueprint_reviewer");
  const recipe = resolveRecipe(policy.recipe);
  const recipeRef = Object.freeze({
    id: recipe.id,
    version: recipe.version,
    digest: recipe.digest,
  });
  return Object.freeze({
    ownerIds,
    risks,
    unknowns,
    verification: Object.freeze({ commands: verificationCommands }),
    rollback: Object.freeze({
      strategy: "inverse_operations" as const,
      verificationCommands: rollbackCommands,
    }),
    approval: Object.freeze({ required: true as const, reviewerIds }),
    recipe: recipeRef,
  });
}

function normalizeBlueprintContract(blueprint: BlueprintContract): BlueprintContract {
  return { ...blueprint, policy: normalizeBlueprintPolicy(blueprint.policy) };
}

function assertTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
  entity: TransformerTransitionEntity,
) {
  if (!transitions[from]?.includes(to)) {
    const code: TransformerDomainErrorCode = `invalid_${entity}_transition`;
    throw new TransformerDomainError(code, `${from}->${to}`);
  }
}

const VERSION_TABLE_DDL = Object.values(TABLES)
  .map(
    (table) => `
CREATE TABLE IF NOT EXISTS ${table} (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, id, revision)
);
CREATE INDEX IF NOT EXISTS ${table}_campaign_idx
  ON ${table}(tenant_id, campaign_id, created_at);
CREATE TRIGGER IF NOT EXISTS ${table}_no_update
BEFORE UPDATE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'transformer_versions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS ${table}_no_delete
BEFORE DELETE ON ${table} BEGIN
  SELECT RAISE(ABORT, 'transformer_versions_append_only');
END;`,
  )
  .join("\n");

const MIGRATION_1 = `
${VERSION_TABLE_DDL}
CREATE TABLE IF NOT EXISTS tf_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tf_events_tenant_campaign_idx
  ON tf_events(tenant_id, campaign_id, sequence);
CREATE TRIGGER IF NOT EXISTS tf_events_no_update
BEFORE UPDATE ON tf_events BEGIN
  SELECT RAISE(ABORT, 'transformer_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS tf_events_no_delete
BEFORE DELETE ON tf_events BEGIN
  SELECT RAISE(ABORT, 'transformer_events_append_only');
END;
`;

const MIGRATION_2 = `
ALTER TABLE tf_events ADD COLUMN actor_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tf_events ADD COLUMN correlation_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tf_events ADD COLUMN causation_id TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE tf_events ADD COLUMN evidence_refs_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tf_events ADD COLUMN previous_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tf_events ADD COLUMN new_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS tf_idempotency_keys (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_revision INTEGER,
  event_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
CREATE TRIGGER IF NOT EXISTS tf_idempotency_keys_no_update
BEFORE UPDATE ON tf_idempotency_keys BEGIN
  SELECT RAISE(ABORT, 'transformer_idempotency_append_only');
END;
CREATE TRIGGER IF NOT EXISTS tf_idempotency_keys_no_delete
BEFORE DELETE ON tf_idempotency_keys BEGIN
  SELECT RAISE(ABORT, 'transformer_idempotency_append_only');
END;
`;

export class TransformerControlPlaneStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private transactionDepth = 0;
  private savepointSequence = 0;

  constructor(path = ":memory:", now: () => string = () => new Date().toISOString()) {
    this.path = path;
    this.now = now;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  schemaVersion(): number {
    return Number(
      (this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM transformer_schema_migrations")
        .get() as { version: number }).version,
    );
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS transformer_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    let current = this.schemaVersion();
    if (current > SCHEMA_VERSION) throw new Error(`unsupported_transformer_schema:${current}`);
    if (current < 1) {
      this.transaction(() => {
        this.db.exec(MIGRATION_1);
        this.db
          .prepare("INSERT INTO transformer_schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(1, this.now());
      });
      current = 1;
    }
    if (current < 2) {
      this.transaction(() => {
        this.db.exec(MIGRATION_2);
        this.db
          .prepare("INSERT INTO transformer_schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(2, this.now());
      });
    }
  }

  atomic<T>(work: () => T): T {
    if (this.transactionDepth > 0) {
      const savepoint = `transformer_atomic_${++this.savepointSequence}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const result = work();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }

  private transaction<T>(work: () => T): T {
    return this.atomic(work);
  }

  private latest<T>(kind: EntityKind, tenantId: string, id: string): Versioned<T> | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${TABLES[kind]} WHERE tenant_id = ? AND id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(required(tenantId, "tenant_id"), required(id, `${kind}_id`)) as
      | VersionRow
      | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.body_json) as T),
      contractVersion: CONTRACT_VERSION,
      revision: row.revision,
      createdAt: row.created_at,
    };
  }

  private atRevision<T>(
    kind: EntityKind,
    tenantId: string,
    id: string,
    revision: number,
  ): Versioned<T> | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM ${TABLES[kind]}
         WHERE tenant_id = ? AND id = ? AND revision = ?`,
      )
      .get(tenantId, id, revision) as VersionRow | undefined;
    if (!row) return undefined;
    return {
      ...(JSON.parse(row.body_json) as T),
      contractVersion: CONTRACT_VERSION,
      revision: row.revision,
      createdAt: row.created_at,
    };
  }

  private mustGet<T>(kind: EntityKind, tenantId: string, id: string): Versioned<T> {
    const record = this.latest<T>(kind, tenantId, id);
    if (!record) throw new Error(`${kind}_not_found`);
    return record;
  }

  private insertVersion<T extends Identity & { state?: string }>(
    kind: EntityKind,
    body: T,
    revision: number,
    eventType: string,
    previousRevision: number,
    context: MutationContext,
  ): Versioned<T> {
    const createdAt = this.now();
    const {
      contractVersion: _contractVersion,
      revision: _revision,
      createdAt: _createdAt,
      ...persistedBody
    } = body as T & Partial<Versioned<unknown>>;
    this.db
      .prepare(
        `INSERT INTO ${TABLES[kind]}
          (tenant_id, id, campaign_id, revision, contract_version, state, body_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        body.tenantId,
        body.id,
        body.campaignId,
        revision,
        CONTRACT_VERSION,
        body.state ?? "recorded",
        JSON.stringify(persistedBody),
        createdAt,
      );
    this.insertEvent({
      tenantId: body.tenantId,
      campaignId: body.campaignId,
      type: eventType,
      entityType: kind,
      entityId: body.id,
      entityRevision: revision,
      context,
      previousRevision,
      newRevision: revision,
      payload: { state: body.state ?? "recorded" },
      createdAt,
    });
    return {
      ...(persistedBody as T),
      contractVersion: CONTRACT_VERSION,
      revision,
      createdAt,
    };
  }

  private create<T extends Identity & { state?: string }>(
    kind: EntityKind,
    body: T,
    contextInput: MutationContext,
  ): Versioned<T> {
    required(body.tenantId, "tenant_id");
    required(body.id, `${kind}_id`);
    required(body.campaignId, "campaign_id");
    const context = normalizeContext(contextInput);
    const scope = `${kind}.created`;
    const digest = requestDigest({ scope, body });
    return this.transaction(() => {
      const replay = this.idempotencyReplay<T>(
        body.tenantId,
        context.idempotencyKey,
        scope,
        digest,
        kind,
        body.id,
      );
      if (replay) return replay;
      if (this.latest(kind, body.tenantId, body.id)) throw new Error(`${kind}_already_exists`);
      const created = this.insertVersion(kind, body, 1, scope, 0, context);
      this.recordIdempotency(body.tenantId, context, scope, digest, kind, body.id, 1);
      return created;
    });
  }

  private revise<T extends Identity & { state?: string }>(
    kind: EntityKind,
    tenantId: string,
    id: string,
    update: (current: Versioned<T>) => T,
    eventType: string,
    expectedRevision: number,
    contextInput: MutationContext,
    request: unknown,
  ): Versioned<T> {
    const safeTenantId = required(tenantId, "tenant_id");
    const safeId = required(id, `${kind}_id`);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      throw new Error(`${kind}_expected_revision_invalid`);
    }
    const context = normalizeContext(contextInput);
    const digest = requestDigest({ eventType, expectedRevision, request });
    return this.transaction(() => {
      const replay = this.idempotencyReplay<T>(
        safeTenantId,
        context.idempotencyKey,
        eventType,
        digest,
        kind,
        safeId,
      );
      if (replay) return replay;
      const current = this.mustGet<T>(kind, safeTenantId, safeId);
      if (current.revision !== expectedRevision) throw new Error(`${kind}_revision_conflict`);
      const next = update(current);
      if (next.tenantId !== safeTenantId || next.id !== safeId || next.campaignId !== current.campaignId) {
        throw new Error(`${kind}_identity_immutable`);
      }
      const revision = current.revision + 1;
      const revised = this.insertVersion(
        kind,
        next,
        revision,
        eventType,
        current.revision,
        context,
      );
      this.recordIdempotency(
        safeTenantId,
        context,
        eventType,
        digest,
        kind,
        safeId,
        revision,
      );
      return revised;
    });
  }

  private idempotencyReplay<T>(
    tenantId: string,
    idempotencyKey: string,
    scope: string,
    digest: string,
    kind: EntityKind,
    entityId: string,
  ): Versioned<T> | undefined {
    const row = this.db
      .prepare(
        `SELECT scope, request_digest, entity_type, entity_id, entity_revision, event_id
         FROM tf_idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?`,
      )
      .get(tenantId, idempotencyKey) as IdempotencyRow | undefined;
    if (!row) return undefined;
    if (
      row.scope !== scope ||
      row.request_digest !== digest ||
      row.entity_type !== kind ||
      row.entity_id !== entityId
    ) {
      throw new Error("idempotency_conflict");
    }
    if (row.entity_revision === null) throw new Error("idempotency_result_missing");
    const replay = this.atRevision<T>(kind, tenantId, entityId, row.entity_revision);
    if (!replay) throw new Error("idempotency_result_missing");
    return replay;
  }

  private recordIdempotency(
    tenantId: string,
    context: MutationContext,
    scope: string,
    digest: string,
    kind: EntityKind,
    entityId: string,
    entityRevision: number | null,
    eventId?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO tf_idempotency_keys
          (tenant_id, idempotency_key, scope, request_digest, entity_type,
           entity_id, entity_revision, event_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        tenantId,
        context.idempotencyKey,
        scope,
        digest,
        kind,
        entityId,
        entityRevision,
        eventId ?? null,
        this.now(),
      );
  }

  private assertCampaign(tenantId: string, campaignId: string): CampaignContract {
    return this.mustGet<CampaignContract>("campaign", tenantId, campaignId) as CampaignContract;
  }

  private assertExecutionReady(tenantId: string, campaignId: string): CampaignContract {
    const campaign = this.assertCampaign(tenantId, campaignId);
    const blueprint = this.getBlueprint(tenantId, campaign.blueprintId);
    const bsg = this.getBsg(tenantId, campaign.bsgId);
    if (!blueprint || blueprint.campaignId !== campaignId || blueprint.state !== "reviewed") {
      throw new Error("reviewed_blueprint_required");
    }
    if (!bsg || bsg.campaignId !== campaignId || bsg.state !== "locked" || !bsg.nodes.length) {
      throw new Error("nonempty_locked_bsg_required");
    }
    return campaign;
  }

  createCampaign(
    input: Omit<CampaignContract, keyof Versioned<unknown> | "state" | "campaignId">,
    context: MutationContext,
  ): CampaignContract {
    const body = {
      ...input,
      tenantId: required(input.tenantId, "tenant_id"),
      id: required(input.id, "campaign_id"),
      campaignId: required(input.id, "campaign_id"),
      name: required(input.name, "campaign_name"),
      sourceSystem: required(input.sourceSystem, "source_system"),
      targetSystem: required(input.targetSystem, "target_system"),
      blueprintId: required(input.blueprintId, "blueprint_id"),
      bsgId: required(input.bsgId, "bsg_id"),
      state: "draft" as const,
    };
    return this.create("campaign", body, context) as CampaignContract;
  }

  getCampaign(tenantId: string, id: string): CampaignContract | undefined {
    return this.latest("campaign", tenantId, id) as CampaignContract | undefined;
  }

  transitionCampaign(
    tenantId: string,
    id: string,
    state: CampaignState,
    expectedRevision: number,
    context: MutationContext,
  ): CampaignContract {
    return this.revise<CampaignContract>(
      "campaign",
      tenantId,
      id,
      (current) => {
        assertTransition(CAMPAIGN_TRANSITIONS, current.state, state, "campaign");
        if (state === "ready" || state === "running") this.assertExecutionReady(tenantId, id);
        return { ...current, state };
      },
      "campaign.transitioned",
      expectedRevision,
      context,
      { state },
    ) as CampaignContract;
  }

  createBlueprint(
    input: Omit<BlueprintContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): BlueprintContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    const blueprint = this.create("blueprint", {
      ...input,
      objective: required(input.objective, "blueprint_objective"),
      policy: normalizeBlueprintPolicy(input.policy),
      state: "draft" as const,
    }, context) as BlueprintContract;
    return normalizeBlueprintContract(blueprint);
  }

  getBlueprint(tenantId: string, id: string): BlueprintContract | undefined {
    const blueprint = this.latest("blueprint", tenantId, id) as BlueprintContract | undefined;
    return blueprint ? normalizeBlueprintContract(blueprint) : undefined;
  }

  reviseBlueprint(
    tenantId: string,
    id: string,
    update: Pick<BlueprintContract, "content" | "policy">,
    expectedRevision: number,
    context: MutationContext,
  ): BlueprintContract {
    const blueprint = this.revise<BlueprintContract>(
      "blueprint",
      tenantId,
      id,
      (current) => {
        if (current.state !== "draft" && current.state !== "in_review") {
          throw new Error("reviewed_blueprint_immutable");
        }
        return {
          ...current,
          content: update.content,
          policy: normalizeBlueprintPolicy(update.policy),
        };
      },
      "blueprint.revised",
      expectedRevision,
      context,
      update,
    ) as BlueprintContract;
    return normalizeBlueprintContract(blueprint);
  }

  transitionBlueprint(
    tenantId: string,
    id: string,
    state: BlueprintState,
    expectedRevision: number,
    context: MutationContext,
  ): BlueprintContract {
    const blueprint = this.revise<BlueprintContract>(
      "blueprint",
      tenantId,
      id,
      (current) => {
        assertTransition(BLUEPRINT_TRANSITIONS, current.state, state, "blueprint");
        return { ...current, state };
      },
      "blueprint.transitioned",
      expectedRevision,
      context,
      { state },
    ) as BlueprintContract;
    return normalizeBlueprintContract(blueprint);
  }

  createBsg(
    input: Omit<BsgContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): BsgContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("bsg", {
      ...input,
      nodes: this.validateBsgNodes(input.nodes),
      edges: this.validateBsgEdges(input.nodes, input.edges),
      state: "draft" as const,
    }, context) as BsgContract;
  }

  getBsg(tenantId: string, id: string): BsgContract | undefined {
    return this.latest("bsg", tenantId, id) as BsgContract | undefined;
  }

  reviseBsg(
    tenantId: string,
    id: string,
    nodes: BsgNodeContract[],
    edges: BsgEdgeContract[],
    expectedRevision: number,
    context: MutationContext,
  ): BsgContract {
    return this.revise<BsgContract>(
      "bsg",
      tenantId,
      id,
      (current) => {
        if (current.state !== "draft") throw new Error("locked_bsg_immutable");
        return {
          ...current,
          nodes: this.validateBsgNodes(nodes),
          edges: this.validateBsgEdges(nodes, edges),
        };
      },
      "bsg.revised",
      expectedRevision,
      context,
      { nodes, edges },
    ) as BsgContract;
  }

  lockBsg(
    tenantId: string,
    id: string,
    expectedRevision: number,
    context: MutationContext,
  ): BsgContract {
    return this.revise<BsgContract>(
      "bsg",
      tenantId,
      id,
      (current) => {
        if (current.state !== "draft") {
          throw new TransformerDomainError("invalid_bsg_transition", `${current.state}->locked`);
        }
        if (!current.nodes.length) throw new Error("nonempty_bsg_required");
        return { ...current, state: "locked" };
      },
      "bsg.locked",
      expectedRevision,
      context,
      { state: "locked" },
    ) as BsgContract;
  }

  private validateBsgNodes(nodes: BsgNodeContract[]): BsgNodeContract[] {
    if (nodes.length > 2_000) throw new Error("bsg_nodes_limit");
    const ids = unique(nodes.map((node) => node.id), "bsg_node_id");
    return nodes.map((node, index) => ({
      id: ids[index]!,
      kind: required(node.kind, `bsg_node_kind_${index}`),
      spec: required(node.spec, `bsg_node_spec_${index}`),
      sourceRefs: nonempty(node.sourceRefs, `bsg_node_source_ref_${index}`),
    }));
  }

  private validateBsgEdges(nodes: BsgNodeContract[], edges: BsgEdgeContract[]): BsgEdgeContract[] {
    if (edges.length > 4_000) throw new Error("bsg_edges_limit");
    unique(edges.map((edge) => edge.id), "bsg_edge_id");
    const nodeIds = new Set(nodes.map((node) => node.id));
    return edges.map((edge, index) => {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        throw new Error(`bsg_edge_${index}_unknown_node`);
      }
      return {
        id: required(edge.id, `bsg_edge_id_${index}`),
        from: edge.from,
        to: edge.to,
        kind: required(edge.kind, `bsg_edge_kind_${index}`),
      };
    });
  }

  createUnit(
    input: Omit<UnitContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): UnitContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("unit", {
      ...input,
      title: required(input.title, "unit_title"),
      repoKey: required(input.repoKey, "unit_repo_key"),
      dependsOn: unique(input.dependsOn, "unit_dependency"),
      state: "pending" as const,
    }, context) as UnitContract;
  }

  getUnit(tenantId: string, id: string): UnitContract | undefined {
    return this.latest("unit", tenantId, id) as UnitContract | undefined;
  }

  transitionUnit(
    tenantId: string,
    id: string,
    state: UnitState,
    expectedRevision: number,
    context: MutationContext,
  ): UnitContract {
    return this.revise<UnitContract>("unit", tenantId, id, (current) => {
      assertTransition(UNIT_TRANSITIONS, current.state, state, "unit");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "unit.transitioned", expectedRevision, context, { state }) as UnitContract;
  }

  createWave(
    input: Omit<WaveContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): WaveContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    for (const unitId of input.unitIds) {
      const unit = this.getUnit(input.tenantId, unitId);
      if (!unit || unit.campaignId !== input.campaignId) {
        throw new Error("wave_unit_not_found");
      }
    }
    return this.create("wave", {
      ...input,
      name: required(input.name, "wave_name"),
      unitIds: unique(input.unitIds, "wave_unit"),
      state: "planned" as const,
    }, context) as WaveContract;
  }

  getWave(tenantId: string, id: string): WaveContract | undefined {
    return this.latest("wave", tenantId, id) as WaveContract | undefined;
  }

  transitionWave(
    tenantId: string,
    id: string,
    state: WaveState,
    expectedRevision: number,
    context: MutationContext,
  ): WaveContract {
    return this.revise<WaveContract>("wave", tenantId, id, (current) => {
      assertTransition(WAVE_TRANSITIONS, current.state, state, "wave");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "wave.transitioned", expectedRevision, context, { state }) as WaveContract;
  }

  createAttempt(
    input: Omit<AttemptContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): AttemptContract {
    const campaign = this.assertExecutionReady(input.tenantId, input.campaignId);
    if (campaign.state !== "running") throw new Error("campaign_running_required");
    const unit = this.getUnit(input.tenantId, input.unitId);
    if (!unit || unit.campaignId !== input.campaignId) throw new Error("attempt_unit_not_found");
    if (!Number.isSafeInteger(input.number) || input.number < 1) {
      throw new Error("attempt_number_invalid");
    }
    if (!this.getAttempt(input.tenantId, input.id)) {
      const duplicate = this.db
        .prepare(
          `SELECT 1 FROM tf_attempt_versions
           WHERE tenant_id = ? AND campaign_id = ?
             AND json_extract(body_json, '$.unitId') = ?
             AND json_extract(body_json, '$.number') = ?
           LIMIT 1`,
        )
        .get(input.tenantId, input.campaignId, input.unitId, input.number);
      if (duplicate) throw new Error("attempt_number_duplicate");
    }
    return this.create(
      "attempt",
      { ...input, state: "queued" as const },
      context,
    ) as AttemptContract;
  }

  getAttempt(tenantId: string, id: string): AttemptContract | undefined {
    return this.latest("attempt", tenantId, id) as AttemptContract | undefined;
  }

  transitionAttempt(
    tenantId: string,
    id: string,
    state: AttemptState,
    expectedRevision: number,
    context: MutationContext,
  ): AttemptContract {
    return this.revise<AttemptContract>("attempt", tenantId, id, (current) => {
      assertTransition(ATTEMPT_TRANSITIONS, current.state, state, "attempt");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "attempt.transitioned", expectedRevision, context, { state }) as AttemptContract;
  }

  createApproval(
    input: Omit<ApprovalContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): ApprovalContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("approval", {
      ...input,
      subjectType: required(input.subjectType, "approval_subject_type"),
      subjectId: required(input.subjectId, "approval_subject_id"),
      state: "pending" as const,
    }, context) as ApprovalContract;
  }

  getApproval(tenantId: string, id: string): ApprovalContract | undefined {
    return this.latest("approval", tenantId, id) as ApprovalContract | undefined;
  }

  transitionApproval(
    tenantId: string,
    id: string,
    state: ApprovalState,
    decision: { reviewerId: string; note?: string } | undefined,
    expectedRevision: number,
    context: MutationContext,
  ): ApprovalContract {
    return this.revise<ApprovalContract>("approval", tenantId, id, (current) => {
      assertTransition(APPROVAL_TRANSITIONS, current.state, state, "approval");
      if (state !== "pending") {
        if (!decision) throw new Error("approval_reviewer_required");
        const reviewerId = required(decision.reviewerId, "approval_reviewer_id");
        if ((state === "rejected" || state === "revoked") && !decision.note?.trim()) {
          throw new Error("approval_note_required");
        }
        return {
          ...current,
          state,
          reviewerId,
          note: decision.note?.trim() || undefined,
        };
      }
      return { ...current, state };
    }, "approval.transitioned", expectedRevision, context, { state, decision }) as ApprovalContract;
  }

  createException(
    input: Omit<ExceptionContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): ExceptionContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("exception", {
      ...input,
      code: required(input.code, "exception_code"),
      message: required(input.message, "exception_message"),
      state: "open" as const,
    }, context) as ExceptionContract;
  }

  getException(tenantId: string, id: string): ExceptionContract | undefined {
    return this.latest("exception", tenantId, id) as ExceptionContract | undefined;
  }

  transitionException(
    tenantId: string,
    id: string,
    state: ExceptionState,
    expectedRevision: number,
    context: MutationContext,
  ): ExceptionContract {
    return this.revise<ExceptionContract>("exception", tenantId, id, (current) => {
      assertTransition(EXCEPTION_TRANSITIONS, current.state, state, "exception");
      return { ...current, state };
    }, "exception.transitioned", expectedRevision, context, { state }) as ExceptionContract;
  }

  createArtifact(
    input: Omit<ArtifactContract, keyof Versioned<unknown>>,
    context: MutationContext,
  ): ArtifactContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("artifact", {
      ...input,
      kind: required(input.kind, "artifact_kind"),
      uri: required(input.uri, "artifact_uri"),
      digest: this.validateArtifactDigest(input.digest),
    }, context) as ArtifactContract;
  }

  getArtifact(tenantId: string, id: string): ArtifactContract | undefined {
    return this.latest("artifact", tenantId, id) as ArtifactContract | undefined;
  }

  reviseArtifact(
    tenantId: string,
    id: string,
    update: Pick<ArtifactContract, "uri" | "digest" | "metadata">,
    expectedRevision: number,
    context: MutationContext,
  ): ArtifactContract {
    return this.revise<ArtifactContract>("artifact", tenantId, id, (current) => ({
      ...current,
      uri: required(update.uri, "artifact_uri"),
      digest: this.validateArtifactDigest(update.digest),
      metadata: update.metadata,
    }), "artifact.revised", expectedRevision, context, update) as ArtifactContract;
  }

  private validateArtifactDigest(digest: string): string {
    const value = required(digest, "artifact_digest");
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("artifact_digest_invalid");
    return value;
  }

  createPullRequest(
    input: Omit<PullRequestContract, keyof Versioned<unknown> | "state">,
    context: MutationContext,
  ): PullRequestContract {
    const campaign = this.assertExecutionReady(input.tenantId, input.campaignId);
    if (campaign.state !== "running") throw new Error("campaign_running_required");
    const unit = this.getUnit(input.tenantId, input.unitId);
    if (!unit || unit.campaignId !== input.campaignId) throw new Error("pr_unit_not_found");
    if (input.number !== undefined && (!Number.isSafeInteger(input.number) || input.number < 1)) {
      throw new Error("pr_number_invalid");
    }
    return this.create("pr", {
      ...input,
      unitId: required(input.unitId, "pr_unit_id"),
      url: required(input.url, "pr_url"),
      state: "draft" as const,
    }, context) as PullRequestContract;
  }

  getPullRequest(tenantId: string, id: string): PullRequestContract | undefined {
    return this.latest("pr", tenantId, id) as PullRequestContract | undefined;
  }

  transitionPullRequest(
    tenantId: string,
    id: string,
    state: PullRequestState,
    expectedRevision: number,
    context: MutationContext,
  ): PullRequestContract {
    return this.revise<PullRequestContract>("pr", tenantId, id, (current) => {
      assertTransition(PR_TRANSITIONS, current.state, state, "pr");
      if (state === "open") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "pr.transitioned", expectedRevision, context, { state }) as PullRequestContract;
  }

  appendEvent(input: {
    id: string;
    tenantId: string;
    campaignId: string;
    type: string;
    entityType: EntityKind;
    entityId: string;
    entityRevision?: number;
    previousRevision: number;
    newRevision: number;
    payload?: Record<string, unknown>;
  }, contextInput: MutationContext): TransformerEvent {
    this.assertCampaign(input.tenantId, input.campaignId);
    const context = normalizeContext(contextInput);
    const scope = required(input.type, "event_type");
    const digest = requestDigest(input);
    return this.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT scope, request_digest, entity_type, entity_id, entity_revision, event_id
           FROM tf_idempotency_keys WHERE tenant_id = ? AND idempotency_key = ?`,
        )
        .get(input.tenantId, context.idempotencyKey) as IdempotencyRow | undefined;
      if (existing) {
        if (
          existing.scope !== scope ||
          existing.request_digest !== digest ||
          existing.entity_type !== input.entityType ||
          existing.entity_id !== input.entityId ||
          existing.event_id !== input.id
        ) {
          throw new Error("idempotency_conflict");
        }
        const replay = this.eventById(input.tenantId, input.id);
        if (!replay) throw new Error("idempotency_result_missing");
        return replay;
      }
      const event = this.insertEvent({
        ...input,
        payload: input.payload ?? {},
        context,
        createdAt: this.now(),
      });
      this.recordIdempotency(
        input.tenantId,
        context,
        scope,
        digest,
        input.entityType,
        input.entityId,
        input.entityRevision ?? null,
        event.id,
      );
      return event;
    });
  }

  private insertEvent(input: {
    id?: string;
    tenantId: string;
    campaignId: string;
    type: string;
    entityType: EntityKind;
    entityId: string;
    entityRevision?: number;
    context: MutationContext;
    previousRevision: number;
    newRevision: number;
    payload: Record<string, unknown>;
    createdAt: string;
  }): TransformerEvent {
    const id = input.id ?? randomUUID();
    const result = this.db
      .prepare(`INSERT INTO tf_events
        (id, tenant_id, campaign_id, contract_version, type, entity_type, entity_id,
         entity_revision, actor_id, correlation_id, causation_id, evidence_refs_json,
         previous_revision, new_revision, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        required(input.tenantId, "tenant_id"),
        required(input.campaignId, "campaign_id"),
        CONTRACT_VERSION,
        required(input.type, "event_type"),
        input.entityType,
        required(input.entityId, "event_entity_id"),
        input.entityRevision ?? null,
        input.context.actorId,
        input.context.correlationId,
        input.context.causationId,
        JSON.stringify(input.context.evidenceRefs),
        input.previousRevision,
        input.newRevision,
        JSON.stringify(input.payload),
        input.createdAt,
      );
    return {
      sequence: Number(result.lastInsertRowid),
      id,
      tenantId: input.tenantId,
      campaignId: input.campaignId,
      contractVersion: CONTRACT_VERSION,
      type: input.type,
      entityType: input.entityType,
      entityId: input.entityId,
      entityRevision: input.entityRevision,
      actorId: input.context.actorId,
      correlationId: input.context.correlationId,
      causationId: input.context.causationId,
      evidenceRefs: input.context.evidenceRefs,
      previousRevision: input.previousRevision,
      newRevision: input.newRevision,
      payload: input.payload,
      createdAt: input.createdAt,
    };
  }

  private eventById(tenantId: string, id: string): TransformerEvent | undefined {
    const row = this.db
      .prepare("SELECT * FROM tf_events WHERE tenant_id = ? AND id = ?")
      .get(tenantId, id) as EventRow | undefined;
    return row ? this.mapEvent(row) : undefined;
  }

  private mapEvent(row: EventRow): TransformerEvent {
    return {
      sequence: row.sequence,
      id: row.id,
      tenantId: row.tenant_id,
      campaignId: row.campaign_id,
      contractVersion: CONTRACT_VERSION,
      type: row.type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityRevision: row.entity_revision ?? undefined,
      actorId: row.actor_id,
      correlationId: row.correlation_id,
      causationId: row.causation_id,
      evidenceRefs: Object.freeze(JSON.parse(row.evidence_refs_json) as string[]),
      previousRevision: row.previous_revision,
      newRevision: row.new_revision,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    };
  }

  listEvents(tenantId: string, campaignId: string): TransformerEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tf_events WHERE tenant_id = ? AND campaign_id = ? ORDER BY sequence`,
      )
      .all(required(tenantId, "tenant_id"), required(campaignId, "campaign_id")) as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }
}
