import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CONTRACT_VERSION = 1 as const;
const SCHEMA_VERSION = 1;

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

type Identity = { tenantId: string; id: string; campaignId: string };
export type Versioned<T> = T & {
  contractVersion: typeof CONTRACT_VERSION;
  revision: number;
  createdAt: string;
};

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
  Identity & { state: BlueprintState; objective: string; content: Record<string, unknown> }
>;
export type BsgNodeContract = { id: string; kind: string; spec: string };
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

function assertTransition<T extends string>(
  transitions: Record<T, readonly T[]>,
  from: T,
  to: T,
  entity: string,
) {
  if (!transitions[from]?.includes(to)) {
    throw new Error(`invalid_${entity}_transition:${from}->${to}`);
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

export class TransformerControlPlaneStore {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => string;

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
    const current = this.schemaVersion();
    if (current > SCHEMA_VERSION) throw new Error(`unsupported_transformer_schema:${current}`);
    if (current < 1) {
      this.transaction(() => {
        this.db.exec(MIGRATION_1);
        this.db
          .prepare("INSERT INTO transformer_schema_migrations(version, applied_at) VALUES (?, ?)")
          .run(1, this.now());
      });
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
  ): Versioned<T> {
    required(body.tenantId, "tenant_id");
    required(body.id, `${kind}_id`);
    required(body.campaignId, "campaign_id");
    return this.transaction(() => {
      if (this.latest(kind, body.tenantId, body.id)) throw new Error(`${kind}_already_exists`);
      return this.insertVersion(kind, body, 1, `${kind}.created`);
    });
  }

  private revise<T extends Identity & { state?: string }>(
    kind: EntityKind,
    tenantId: string,
    id: string,
    update: (current: Versioned<T>) => T,
    eventType: string,
  ): Versioned<T> {
    return this.transaction(() => {
      const current = this.mustGet<T>(kind, tenantId, id);
      const next = update(current);
      if (next.tenantId !== tenantId || next.id !== id || next.campaignId !== current.campaignId) {
        throw new Error(`${kind}_identity_immutable`);
      }
      return this.insertVersion(kind, next, current.revision + 1, eventType);
    });
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
    return this.create("campaign", body) as CampaignContract;
  }

  getCampaign(tenantId: string, id: string): CampaignContract | undefined {
    return this.latest("campaign", tenantId, id) as CampaignContract | undefined;
  }

  transitionCampaign(tenantId: string, id: string, state: CampaignState): CampaignContract {
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
    ) as CampaignContract;
  }

  createBlueprint(input: Omit<BlueprintContract, keyof Versioned<unknown> | "state">): BlueprintContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("blueprint", {
      ...input,
      objective: required(input.objective, "blueprint_objective"),
      state: "draft" as const,
    }) as BlueprintContract;
  }

  getBlueprint(tenantId: string, id: string): BlueprintContract | undefined {
    return this.latest("blueprint", tenantId, id) as BlueprintContract | undefined;
  }

  reviseBlueprint(
    tenantId: string,
    id: string,
    content: Record<string, unknown>,
  ): BlueprintContract {
    return this.revise<BlueprintContract>(
      "blueprint",
      tenantId,
      id,
      (current) => {
        if (current.state !== "draft" && current.state !== "in_review") {
          throw new Error("reviewed_blueprint_immutable");
        }
        return { ...current, content };
      },
      "blueprint.revised",
    ) as BlueprintContract;
  }

  transitionBlueprint(tenantId: string, id: string, state: BlueprintState): BlueprintContract {
    return this.revise<BlueprintContract>(
      "blueprint",
      tenantId,
      id,
      (current) => {
        assertTransition(BLUEPRINT_TRANSITIONS, current.state, state, "blueprint");
        return { ...current, state };
      },
      "blueprint.transitioned",
    ) as BlueprintContract;
  }

  createBsg(input: Omit<BsgContract, keyof Versioned<unknown> | "state">): BsgContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("bsg", {
      ...input,
      nodes: this.validateBsgNodes(input.nodes),
      edges: this.validateBsgEdges(input.nodes, input.edges),
      state: "draft" as const,
    }) as BsgContract;
  }

  getBsg(tenantId: string, id: string): BsgContract | undefined {
    return this.latest("bsg", tenantId, id) as BsgContract | undefined;
  }

  reviseBsg(
    tenantId: string,
    id: string,
    nodes: BsgNodeContract[],
    edges: BsgEdgeContract[],
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
    ) as BsgContract;
  }

  lockBsg(tenantId: string, id: string): BsgContract {
    return this.revise<BsgContract>(
      "bsg",
      tenantId,
      id,
      (current) => {
        if (current.state !== "draft") throw new Error(`invalid_bsg_transition:${current.state}->locked`);
        if (!current.nodes.length) throw new Error("nonempty_bsg_required");
        return { ...current, state: "locked" };
      },
      "bsg.locked",
    ) as BsgContract;
  }

  private validateBsgNodes(nodes: BsgNodeContract[]): BsgNodeContract[] {
    if (nodes.length > 2_000) throw new Error("bsg_nodes_limit");
    const ids = unique(nodes.map((node) => node.id), "bsg_node_id");
    return nodes.map((node, index) => ({
      id: ids[index]!,
      kind: required(node.kind, `bsg_node_kind_${index}`),
      spec: required(node.spec, `bsg_node_spec_${index}`),
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

  createUnit(input: Omit<UnitContract, keyof Versioned<unknown> | "state">): UnitContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("unit", {
      ...input,
      title: required(input.title, "unit_title"),
      repoKey: required(input.repoKey, "unit_repo_key"),
      dependsOn: unique(input.dependsOn, "unit_dependency"),
      state: "pending" as const,
    }) as UnitContract;
  }

  getUnit(tenantId: string, id: string): UnitContract | undefined {
    return this.latest("unit", tenantId, id) as UnitContract | undefined;
  }

  transitionUnit(tenantId: string, id: string, state: UnitState): UnitContract {
    return this.revise<UnitContract>("unit", tenantId, id, (current) => {
      assertTransition(UNIT_TRANSITIONS, current.state, state, "unit");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "unit.transitioned") as UnitContract;
  }

  createWave(input: Omit<WaveContract, keyof Versioned<unknown> | "state">): WaveContract {
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
    }) as WaveContract;
  }

  getWave(tenantId: string, id: string): WaveContract | undefined {
    return this.latest("wave", tenantId, id) as WaveContract | undefined;
  }

  transitionWave(tenantId: string, id: string, state: WaveState): WaveContract {
    return this.revise<WaveContract>("wave", tenantId, id, (current) => {
      assertTransition(WAVE_TRANSITIONS, current.state, state, "wave");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "wave.transitioned") as WaveContract;
  }

  createAttempt(input: Omit<AttemptContract, keyof Versioned<unknown> | "state">): AttemptContract {
    const campaign = this.assertExecutionReady(input.tenantId, input.campaignId);
    if (campaign.state !== "running") throw new Error("campaign_running_required");
    const unit = this.getUnit(input.tenantId, input.unitId);
    if (!unit || unit.campaignId !== input.campaignId) throw new Error("attempt_unit_not_found");
    if (!Number.isSafeInteger(input.number) || input.number < 1) {
      throw new Error("attempt_number_invalid");
    }
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
    return this.create("attempt", { ...input, state: "queued" as const }) as AttemptContract;
  }

  getAttempt(tenantId: string, id: string): AttemptContract | undefined {
    return this.latest("attempt", tenantId, id) as AttemptContract | undefined;
  }

  transitionAttempt(tenantId: string, id: string, state: AttemptState): AttemptContract {
    return this.revise<AttemptContract>("attempt", tenantId, id, (current) => {
      assertTransition(ATTEMPT_TRANSITIONS, current.state, state, "attempt");
      if (state === "running") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "attempt.transitioned") as AttemptContract;
  }

  createApproval(input: Omit<ApprovalContract, keyof Versioned<unknown> | "state">): ApprovalContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("approval", {
      ...input,
      subjectType: required(input.subjectType, "approval_subject_type"),
      subjectId: required(input.subjectId, "approval_subject_id"),
      state: "pending" as const,
    }) as ApprovalContract;
  }

  getApproval(tenantId: string, id: string): ApprovalContract | undefined {
    return this.latest("approval", tenantId, id) as ApprovalContract | undefined;
  }

  transitionApproval(
    tenantId: string,
    id: string,
    state: ApprovalState,
    decision?: { reviewerId: string; note?: string },
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
    }, "approval.transitioned") as ApprovalContract;
  }

  createException(input: Omit<ExceptionContract, keyof Versioned<unknown> | "state">): ExceptionContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("exception", {
      ...input,
      code: required(input.code, "exception_code"),
      message: required(input.message, "exception_message"),
      state: "open" as const,
    }) as ExceptionContract;
  }

  getException(tenantId: string, id: string): ExceptionContract | undefined {
    return this.latest("exception", tenantId, id) as ExceptionContract | undefined;
  }

  transitionException(tenantId: string, id: string, state: ExceptionState): ExceptionContract {
    return this.revise<ExceptionContract>("exception", tenantId, id, (current) => {
      assertTransition(EXCEPTION_TRANSITIONS, current.state, state, "exception");
      return { ...current, state };
    }, "exception.transitioned") as ExceptionContract;
  }

  createArtifact(input: Omit<ArtifactContract, keyof Versioned<unknown>>): ArtifactContract {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.create("artifact", {
      ...input,
      kind: required(input.kind, "artifact_kind"),
      uri: required(input.uri, "artifact_uri"),
      digest: this.validateArtifactDigest(input.digest),
    }) as ArtifactContract;
  }

  getArtifact(tenantId: string, id: string): ArtifactContract | undefined {
    return this.latest("artifact", tenantId, id) as ArtifactContract | undefined;
  }

  reviseArtifact(
    tenantId: string,
    id: string,
    update: Pick<ArtifactContract, "uri" | "digest" | "metadata">,
  ): ArtifactContract {
    return this.revise<ArtifactContract>("artifact", tenantId, id, (current) => ({
      ...current,
      uri: required(update.uri, "artifact_uri"),
      digest: this.validateArtifactDigest(update.digest),
      metadata: update.metadata,
    }), "artifact.revised") as ArtifactContract;
  }

  private validateArtifactDigest(digest: string): string {
    const value = required(digest, "artifact_digest");
    if (!/^sha256:[a-f0-9]{64}$/.test(value)) throw new Error("artifact_digest_invalid");
    return value;
  }

  createPullRequest(input: Omit<PullRequestContract, keyof Versioned<unknown> | "state">): PullRequestContract {
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
    }) as PullRequestContract;
  }

  getPullRequest(tenantId: string, id: string): PullRequestContract | undefined {
    return this.latest("pr", tenantId, id) as PullRequestContract | undefined;
  }

  transitionPullRequest(tenantId: string, id: string, state: PullRequestState): PullRequestContract {
    return this.revise<PullRequestContract>("pr", tenantId, id, (current) => {
      assertTransition(PR_TRANSITIONS, current.state, state, "pr");
      if (state === "open") {
        const campaign = this.assertExecutionReady(tenantId, current.campaignId);
        if (campaign.state !== "running") throw new Error("campaign_running_required");
      }
      return { ...current, state };
    }, "pr.transitioned") as PullRequestContract;
  }

  appendEvent(input: {
    id?: string;
    tenantId: string;
    campaignId: string;
    type: string;
    entityType: EntityKind;
    entityId: string;
    entityRevision?: number;
    payload?: Record<string, unknown>;
  }): TransformerEvent {
    this.assertCampaign(input.tenantId, input.campaignId);
    return this.transaction(() =>
      this.insertEvent({
        ...input,
        id: input.id ?? randomUUID(),
        payload: input.payload ?? {},
        createdAt: this.now(),
      }),
    );
  }

  private insertEvent(input: {
    id?: string;
    tenantId: string;
    campaignId: string;
    type: string;
    entityType: EntityKind;
    entityId: string;
    entityRevision?: number;
    payload: Record<string, unknown>;
    createdAt: string;
  }): TransformerEvent {
    const id = input.id ?? randomUUID();
    const result = this.db
      .prepare(`INSERT INTO tf_events
        (id, tenant_id, campaign_id, contract_version, type, entity_type, entity_id,
         entity_revision, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        id,
        required(input.tenantId, "tenant_id"),
        required(input.campaignId, "campaign_id"),
        CONTRACT_VERSION,
        required(input.type, "event_type"),
        input.entityType,
        required(input.entityId, "event_entity_id"),
        input.entityRevision ?? null,
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
      payload: input.payload,
      createdAt: input.createdAt,
    };
  }

  listEvents(tenantId: string, campaignId: string): TransformerEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM tf_events WHERE tenant_id = ? AND campaign_id = ? ORDER BY sequence`,
      )
      .all(required(tenantId, "tenant_id"), required(campaignId, "campaign_id")) as Array<{
      sequence: number;
      id: string;
      tenant_id: string;
      campaign_id: string;
      contract_version: number;
      type: string;
      entity_type: EntityKind;
      entity_id: string;
      entity_revision?: number | null;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      sequence: row.sequence,
      id: row.id,
      tenantId: row.tenant_id,
      campaignId: row.campaign_id,
      contractVersion: CONTRACT_VERSION,
      type: row.type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityRevision: row.entity_revision ?? undefined,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }
}
