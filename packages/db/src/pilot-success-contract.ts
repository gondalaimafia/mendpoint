import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppDb } from "./index.js";
import { insertArtifactManifest, insertReviewDecision } from "./trust.js";

export type PilotChangeClass = "breaking" | "behavioral" | "deprecation" | "security" | "other";
export type PilotThresholdOperator = "lte" | "gte" | "eq";
export type PilotOwnerResponsibility =
  | "customer_owner"
  | "mendpoint_owner"
  | "technical_reviewer"
  | "privacy_contact"
  | "rollback_owner";
export type PilotSupportSeverity = "critical" | "high" | "standard";
export type PilotReviewDay =
  | "Monday" | "Tuesday" | "Wednesday" | "Thursday" | "Friday" | "Saturday" | "Sunday";

export type PilotSuccessContractDefinition = Readonly<{
  providerChange: Readonly<{
    provider: string;
    changeClass: PilotChangeClass;
    description: string;
  }>;
  repositories: readonly Readonly<{
    owner: string;
    name: string;
    branch: string;
    scope: string;
  }>[];
  thresholds: readonly Readonly<{
    metric: string;
    operator: PilotThresholdOperator;
    target: number;
    unit: string;
  }>[];
  owners: readonly Readonly<{
    responsibility: PilotOwnerResponsibility;
    principalId: string;
  }>[];
  supportResponses: readonly Readonly<{
    severity: PilotSupportSeverity;
    responseMinutes: number;
    coverage: string;
  }>[];
  privacy: Readonly<{
    dataCategories: readonly string[];
    retentionDays: number;
    processingRegions: readonly string[];
    deletionProcedure: string;
  }>;
  rollback: Readonly<{
    trigger: string;
    procedure: string;
    ownerPrincipalId: string;
    recoveryMinutes: number;
  }>;
  weeklyReview: Readonly<{
    dayOfWeek: PilotReviewDay;
    timeUtc: string;
    ownerPrincipalId: string;
    agenda: readonly string[];
  }>;
  conversionDecision: Readonly<{
    decisionDueAt: string;
    ownerPrincipalId: string;
    criteria: readonly string[];
  }>;
}>;

export type PilotSuccessContractApproval = Readonly<{
  id: string;
  reviewerPrincipalId: string;
  rationale: string;
  evidenceSha256: string;
  createdAt: string;
}>;

export type PilotSuccessContract = Readonly<{
  id: string;
  tenantId: string;
  versionId: string;
  version: number;
  parentVersionId: string | null;
  title: string;
  definition: PilotSuccessContractDefinition;
  artifactId: string;
  contentSha256: string;
  createdByPrincipalId: string;
  createdAt: string;
  status: "draft" | "approved";
  approval: PilotSuccessContractApproval | null;
}>;

export type PilotSuccessContractWriteHook = (value: PilotSuccessContract) => void;

type VersionRow = {
  id: string;
  tenant_id: string;
  contract_id: string;
  version: number;
  parent_version_id: string | null;
  title: string;
  artifact_id: string;
  content_sha256: string;
  created_by_principal_id: string;
  created_at: string;
  content_text: string;
};

type ApprovalRow = {
  id: string;
  reviewer_principal_id: string;
  rationale: string;
  created_at: string;
};

const CHANGE_CLASSES = new Set<PilotChangeClass>(["breaking", "behavioral", "deprecation", "security", "other"]);
const THRESHOLD_OPERATORS = new Set<PilotThresholdOperator>(["lte", "gte", "eq"]);
const OWNER_RESPONSIBILITIES: readonly PilotOwnerResponsibility[] = [
  "customer_owner", "mendpoint_owner", "privacy_contact", "rollback_owner", "technical_reviewer",
];
const SUPPORT_SEVERITIES = new Set<PilotSupportSeverity>(["critical", "high", "standard"]);
const REVIEW_DAYS = new Set<PilotReviewDay>([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);

function one<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function many<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function text(name: string, value: string, max = 1_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\0]/.test(normalized)) {
    throw new Error(`pilot_contract_${name}_invalid`);
  }
  return normalized;
}

function timestamp(name: string, value: string): string {
  const normalized = text(name, value, 64);
  if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    throw new Error(`pilot_contract_${name}_invalid`);
  }
  return normalized;
}

function positiveInteger(name: string, value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`pilot_contract_${name}_invalid`);
  }
  return value;
}

function strings(name: string, values: readonly string[], maxItems = 30): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems) {
    throw new Error(`pilot_contract_${name}_required`);
  }
  const normalized = values.map((value) => text(name, value, 300));
  if (new Set(normalized).size !== normalized.length) throw new Error(`pilot_contract_${name}_duplicate`);
  return normalized.sort((a, b) => a.localeCompare(b));
}

function assertPrincipal(db: AppDb, tenantId: string, principalId: string) {
  const principal = one<{ id: string; kind: string }>(db,
    `SELECT id, kind FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [principalId, tenantId]);
  if (!principal) throw new Error("pilot_contract_principal_tenant_mismatch");
  return principal;
}

function normalizeDefinition(
  db: AppDb,
  tenantId: string,
  value: PilotSuccessContractDefinition,
): PilotSuccessContractDefinition {
  if (!value || typeof value !== "object") throw new Error("pilot_contract_definition_invalid");
  if (!CHANGE_CLASSES.has(value.providerChange?.changeClass)) {
    throw new Error("pilot_contract_change_class_invalid");
  }
  if (!Array.isArray(value.repositories) || value.repositories.length === 0 || value.repositories.length > 100) {
    throw new Error("pilot_contract_repositories_required");
  }
  const repositories = value.repositories.map((repository) => ({
    owner: text("repository_owner", repository.owner, 200),
    name: text("repository_name", repository.name, 200),
    branch: text("repository_branch", repository.branch, 200),
    scope: text("repository_scope", repository.scope, 1_000),
  })).sort((a, b) => `${a.owner}/${a.name}/${a.branch}`.localeCompare(`${b.owner}/${b.name}/${b.branch}`));
  const repositoryKeys = repositories.map((repository) => `${repository.owner}/${repository.name}/${repository.branch}`);
  if (new Set(repositoryKeys).size !== repositoryKeys.length) throw new Error("pilot_contract_repository_duplicate");

  if (!Array.isArray(value.thresholds) || value.thresholds.length === 0 || value.thresholds.length > 50) {
    throw new Error("pilot_contract_thresholds_required");
  }
  const thresholds = value.thresholds.map((threshold) => {
    if (!THRESHOLD_OPERATORS.has(threshold.operator)) throw new Error("pilot_contract_threshold_operator_invalid");
    if (!Number.isFinite(threshold.target)) throw new Error("pilot_contract_threshold_target_invalid");
    return {
      metric: text("threshold_metric", threshold.metric, 300),
      operator: threshold.operator,
      target: threshold.target,
      unit: text("threshold_unit", threshold.unit, 100),
    };
  }).sort((a, b) => a.metric.localeCompare(b.metric));
  if (new Set(thresholds.map((threshold) => threshold.metric)).size !== thresholds.length) {
    throw new Error("pilot_contract_threshold_duplicate");
  }

  if (!Array.isArray(value.owners)) throw new Error("pilot_contract_owners_required");
  const owners = value.owners.map((owner) => {
    if (!OWNER_RESPONSIBILITIES.includes(owner.responsibility)) {
      throw new Error("pilot_contract_owner_responsibility_invalid");
    }
    const principalId = text("owner_principal", owner.principalId, 256);
    assertPrincipal(db, tenantId, principalId);
    return { responsibility: owner.responsibility, principalId };
  }).sort((a, b) => a.responsibility.localeCompare(b.responsibility));
  if (new Set(owners.map((owner) => owner.responsibility)).size !== owners.length) {
    throw new Error("pilot_contract_owner_duplicate");
  }
  for (const responsibility of OWNER_RESPONSIBILITIES) {
    if (!owners.some((owner) => owner.responsibility === responsibility)) {
      throw new Error(`pilot_contract_owner_${responsibility}_required`);
    }
  }

  if (!Array.isArray(value.supportResponses) || value.supportResponses.length === 0) {
    throw new Error("pilot_contract_support_responses_required");
  }
  const supportResponses = value.supportResponses.map((response) => {
    if (!SUPPORT_SEVERITIES.has(response.severity)) throw new Error("pilot_contract_support_severity_invalid");
    return {
      severity: response.severity,
      responseMinutes: positiveInteger("support_response_minutes", response.responseMinutes, 43_200),
      coverage: text("support_coverage", response.coverage, 500),
    };
  }).sort((a, b) => a.severity.localeCompare(b.severity));
  if (new Set(supportResponses.map((response) => response.severity)).size !== supportResponses.length) {
    throw new Error("pilot_contract_support_severity_duplicate");
  }

  const privacy = {
    dataCategories: strings("privacy_data_categories", value.privacy?.dataCategories ?? []),
    retentionDays: positiveInteger("privacy_retention_days", value.privacy?.retentionDays, 3_650),
    processingRegions: strings("privacy_processing_regions", value.privacy?.processingRegions ?? []),
    deletionProcedure: text("privacy_deletion_procedure", value.privacy?.deletionProcedure ?? "", 2_000),
  };
  const rollback = {
    trigger: text("rollback_trigger", value.rollback?.trigger ?? "", 1_000),
    procedure: text("rollback_procedure", value.rollback?.procedure ?? "", 2_000),
    ownerPrincipalId: text("rollback_owner", value.rollback?.ownerPrincipalId ?? "", 256),
    recoveryMinutes: positiveInteger("rollback_recovery_minutes", value.rollback?.recoveryMinutes, 43_200),
  };
  if (!owners.some((owner) => owner.responsibility === "rollback_owner" && owner.principalId === rollback.ownerPrincipalId)) {
    throw new Error("pilot_contract_rollback_owner_mismatch");
  }
  if (!REVIEW_DAYS.has(value.weeklyReview?.dayOfWeek)) throw new Error("pilot_contract_review_day_invalid");
  const reviewTime = text("review_time", value.weeklyReview?.timeUtc ?? "", 5);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(reviewTime)) throw new Error("pilot_contract_review_time_invalid");
  const weeklyReview = {
    dayOfWeek: value.weeklyReview.dayOfWeek,
    timeUtc: reviewTime,
    ownerPrincipalId: text("review_owner", value.weeklyReview.ownerPrincipalId, 256),
    agenda: strings("review_agenda", value.weeklyReview.agenda),
  };
  if (!owners.some((owner) => owner.principalId === weeklyReview.ownerPrincipalId)) {
    throw new Error("pilot_contract_review_owner_mismatch");
  }
  const conversionDecision = {
    decisionDueAt: timestamp("conversion_due_at", value.conversionDecision?.decisionDueAt ?? ""),
    ownerPrincipalId: text("conversion_owner", value.conversionDecision?.ownerPrincipalId ?? "", 256),
    criteria: strings("conversion_criteria", value.conversionDecision?.criteria ?? []),
  };
  if (!owners.some((owner) => owner.principalId === conversionDecision.ownerPrincipalId)) {
    throw new Error("pilot_contract_conversion_owner_mismatch");
  }

  return Object.freeze({
    providerChange: Object.freeze({
      provider: text("provider", value.providerChange.provider, 300),
      changeClass: value.providerChange.changeClass,
      description: text("change_description", value.providerChange.description, 2_000),
    }),
    repositories: Object.freeze(repositories.map((repository) => Object.freeze(repository))),
    thresholds: Object.freeze(thresholds.map((threshold) => Object.freeze(threshold))),
    owners: Object.freeze(owners.map((owner) => Object.freeze(owner))),
    supportResponses: Object.freeze(supportResponses.map((response) => Object.freeze(response))),
    privacy: Object.freeze({ ...privacy, dataCategories: Object.freeze(privacy.dataCategories), processingRegions: Object.freeze(privacy.processingRegions) }),
    rollback: Object.freeze(rollback),
    weeklyReview: Object.freeze({ ...weeklyReview, agenda: Object.freeze(weeklyReview.agenda) }),
    conversionDecision: Object.freeze({ ...conversionDecision, criteria: Object.freeze(conversionDecision.criteria) }),
  });
}

function digest(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function approvalFor(db: AppDb, row: VersionRow): PilotSuccessContractApproval | null {
  const approval = one<ApprovalRow>(db,
    `SELECT id, reviewer_principal_id, rationale, created_at FROM review_decisions
     WHERE tenant_id = ? AND subject_type = 'pilot_success_contract_version'
       AND subject_id = ? AND candidate_artifact_id = ? AND decision = 'approve'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    [row.tenant_id, row.id, row.artifact_id]);
  return approval ? Object.freeze({
    id: approval.id,
    reviewerPrincipalId: approval.reviewer_principal_id,
    rationale: approval.rationale,
    evidenceSha256: row.content_sha256,
    createdAt: approval.created_at,
  }) : null;
}

function contract(db: AppDb, row: VersionRow): PilotSuccessContract {
  if (digest(row.content_text) !== row.content_sha256) throw new Error("pilot_contract_evidence_corrupt");
  const envelope = JSON.parse(row.content_text) as {
    schemaVersion: number;
    contractId: string;
    version: number;
    title: string;
    definition: PilotSuccessContractDefinition;
  };
  if (envelope.schemaVersion !== 1 || envelope.contractId !== row.contract_id ||
    envelope.version !== row.version || envelope.title !== row.title) {
    throw new Error("pilot_contract_evidence_corrupt");
  }
  const approval = approvalFor(db, row);
  return Object.freeze({
    id: row.contract_id,
    tenantId: row.tenant_id,
    versionId: row.id,
    version: row.version,
    parentVersionId: row.parent_version_id,
    title: row.title,
    definition: envelope.definition,
    artifactId: row.artifact_id,
    contentSha256: row.content_sha256,
    createdByPrincipalId: row.created_by_principal_id,
    createdAt: row.created_at,
    status: approval ? "approved" : "draft",
    approval,
  });
}

function versionRows(db: AppDb, where: string, params: SQLInputValue[]): VersionRow[] {
  return many<VersionRow>(db,
    `SELECT v.*, a.content_text FROM pilot_success_contract_versions v
     JOIN artifact_manifests a ON a.id = v.artifact_id AND a.tenant_id = v.tenant_id
     WHERE ${where} ORDER BY v.version DESC`, params);
}

export function getPilotSuccessContract(
  db: AppDb,
  tenantId: string,
  contractId: string,
  version?: number,
): PilotSuccessContract | undefined {
  const rows = versionRows(db,
    `v.tenant_id = ? AND v.contract_id = ? ${version === undefined ? "" : "AND v.version = ?"}`,
    version === undefined ? [tenantId, contractId] : [tenantId, contractId, version]);
  return rows[0] ? contract(db, rows[0]) : undefined;
}

export function listPilotSuccessContracts(db: AppDb, tenantId: string): PilotSuccessContract[] {
  const rows = versionRows(db,
    `v.tenant_id = ? AND v.version = (SELECT MAX(v2.version) FROM pilot_success_contract_versions v2
      WHERE v2.tenant_id = v.tenant_id AND v2.contract_id = v.contract_id)`, [tenantId]);
  return rows.map((row) => contract(db, row));
}

function insertVersion(db: AppDb, input: {
  contractId: string;
  tenantId: string;
  version: number;
  parentVersionId: string | null;
  title: string;
  definition: PilotSuccessContractDefinition;
  createdByPrincipalId: string;
  createdAt: string;
}, onWrite?: PilotSuccessContractWriteHook): PilotSuccessContract {
  const contractId = text("id", input.contractId, 256);
  const tenantId = text("tenant_id", input.tenantId, 256);
  const title = text("title", input.title, 300);
  const createdAt = timestamp("created_at", input.createdAt);
  assertPrincipal(db, tenantId, input.createdByPrincipalId);
  const definition = normalizeDefinition(db, tenantId, input.definition);
  const versionId = `${contractId}:v${input.version}`;
  const artifactId = `pilot-contract-artifact:${contractId}:v${input.version}`;
  const content = JSON.stringify({ schemaVersion: 1, contractId, version: input.version, title, definition });
  const contentSha256 = digest(content);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    insertArtifactManifest(db, {
      id: artifactId,
      tenantId,
      kind: "pilot-success-contract",
      schemaVersion: 1,
      sha256: contentSha256,
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `db:pilot-success-contract:${contractId}:v${input.version}`,
      content,
      producerPrincipalId: input.createdByPrincipalId,
      createdAt,
    });
    db.raw.prepare(`INSERT INTO pilot_success_contract_versions
      (id, tenant_id, contract_id, version, parent_version_id, title, artifact_id, content_sha256,
       created_by_principal_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(versionId, tenantId, contractId, input.version, input.parentVersionId, title, artifactId,
        contentSha256, input.createdByPrincipalId, createdAt);
    const value = getPilotSuccessContract(db, tenantId, contractId, input.version)!;
    onWrite?.(value);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new Error("pilot_contract_id_conflict");
    }
    throw error;
  }
}

export function createPilotSuccessContract(db: AppDb, input: {
  id: string;
  tenantId: string;
  title: string;
  definition: PilotSuccessContractDefinition;
  createdByPrincipalId: string;
  createdAt: string;
}, onWrite?: PilotSuccessContractWriteHook): PilotSuccessContract {
  return insertVersion(db, {
    contractId: input.id,
    tenantId: input.tenantId,
    version: 1,
    parentVersionId: null,
    title: input.title,
    definition: input.definition,
    createdByPrincipalId: input.createdByPrincipalId,
    createdAt: input.createdAt,
  }, onWrite);
}

export function revisePilotSuccessContract(db: AppDb, input: {
  tenantId: string;
  contractId: string;
  expectedVersion: number;
  title: string;
  definition: PilotSuccessContractDefinition;
  createdByPrincipalId: string;
  createdAt: string;
}, onWrite?: PilotSuccessContractWriteHook): PilotSuccessContract {
  const latest = getPilotSuccessContract(db, input.tenantId, input.contractId);
  if (!latest) throw new Error("pilot_contract_not_found");
  if (!Number.isSafeInteger(input.expectedVersion) || latest.version !== input.expectedVersion) {
    throw new Error("pilot_contract_version_conflict");
  }
  return insertVersion(db, {
    ...input,
    version: latest.version + 1,
    parentVersionId: latest.versionId,
  }, onWrite);
}

export function approvePilotSuccessContract(db: AppDb, input: {
  id: string;
  tenantId: string;
  contractId: string;
  version: number;
  reviewerPrincipalId: string;
  rationale: string;
  createdAt: string;
}, onWrite?: PilotSuccessContractWriteHook): PilotSuccessContract {
  const current = getPilotSuccessContract(db, input.tenantId, input.contractId, input.version);
  if (!current) throw new Error("pilot_contract_not_found");
  if (current.approval) throw new Error("pilot_contract_already_approved");
  const reviewer = one<{ kind: string }>(db,
    `SELECT kind FROM principals WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL`,
    [input.reviewerPrincipalId, input.tenantId]);
  if (reviewer?.kind !== "human") throw new Error("pilot_contract_human_reviewer_required");
  if (current.createdByPrincipalId === input.reviewerPrincipalId) {
    throw new Error("pilot_contract_independent_reviewer_required");
  }
  if (!current.definition.owners.some((owner) =>
    owner.responsibility === "technical_reviewer" && owner.principalId === input.reviewerPrincipalId)) {
    throw new Error("pilot_contract_reviewer_not_assigned");
  }
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    insertReviewDecision(db, {
      id: text("approval_id", input.id, 256),
      tenantId: input.tenantId,
      subjectType: "pilot_success_contract_version",
      subjectId: current.versionId,
      candidateArtifactId: current.artifactId,
      reviewerPrincipalId: input.reviewerPrincipalId,
      decision: "approve",
      rationale: text("approval_rationale", input.rationale, 2_000),
      createdAt: timestamp("approval_created_at", input.createdAt),
    });
    const value = getPilotSuccessContract(db, input.tenantId, input.contractId, input.version)!;
    onWrite?.(value);
    db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}
