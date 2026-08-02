import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  evaluatePolicy,
  mergePolicy,
  type PolicyConfig,
  type PolicyDecision,
} from "./index.js";
import type { ChangeRisk, ImpactFinding, MigrationDraft } from "@mendpoint/shared";

export const WARDEN_POLICY_SCOPE_KINDS = [
  "tenant",
  "repository",
  "branch",
  "environment",
  "risk",
] as const;

export type WardenPolicyScopeKind = (typeof WARDEN_POLICY_SCOPE_KINDS)[number];
export type WardenPolicyApprovalState = "draft" | "approved";

export type WardenPolicyScope = Readonly<{
  kind: WardenPolicyScopeKind;
  value: string;
}>;

export type WardenPolicyApproval = Readonly<{
  approvalId: string;
  approvedBy: string;
  approvedAt: string;
  evidenceArtifactId: string;
}>;

export type WardenPolicyVersion = Readonly<{
  id: string;
  tenantId: string;
  policyKey: string;
  version: number;
  scope: WardenPolicyScope;
  config: Readonly<Partial<PolicyConfig>>;
  createdBy: string;
  createdAt: string;
  evidenceArtifactId: string;
  contentSha256: string;
  approvalState: WardenPolicyApprovalState;
  approval: WardenPolicyApproval | null;
}>;

export type WardenPolicyContext = Readonly<{
  tenantId: string;
  repositoryId: string;
  branch: string;
  environment: string;
  risk: ChangeRisk;
}>;

export type WardenPolicyResolution = Readonly<{
  policy: PolicyConfig;
  appliedVersionIds: readonly string[];
  appliedDigests: readonly string[];
}>;

export type WardenPolicySimulationCase = Readonly<{
  id: string;
  context: WardenPolicyContext;
  draft: MigrationDraft;
  findings: readonly ImpactFinding[];
}>;

export type WardenPolicySimulationResult = Readonly<{
  candidateVersionId: string;
  candidateDigest: string;
  cases: readonly Readonly<{
    id: string;
    before: PolicyDecision;
    after: PolicyDecision;
    changed: boolean;
  }>[];
}>;

export type WardenPolicyWaiver = Readonly<{
  id: string;
  tenantId: string;
  policyVersionId: string;
  subjectType: string;
  subjectId: string;
  reason: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  evidenceArtifactId: string;
}>;

type StoredPolicyRow = {
  id: string;
  tenant_id: string;
  policy_key: string;
  version: number;
  scope_kind: WardenPolicyScopeKind;
  scope_value: string;
  config_json: string;
  created_by: string;
  created_at: string;
  evidence_artifact_id: string;
  content_sha256: string;
  approval_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_evidence_artifact_id: string | null;
};

type StoredWaiverRow = {
  id: string;
  tenant_id: string;
  policy_version_id: string;
  subject_type: string;
  subject_id: string;
  reason: string;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  evidence_artifact_id: string;
};

const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_WAIVER_TTL_MS = 24 * 60 * 60 * 1_000;

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new Error(`warden_policy_${field}_required`);
  }
  return value;
}

function humanPrincipal(value: string, field: string): string {
  requiredText(value, field);
  if (!value.startsWith("human:") || value.length === "human:".length) {
    throw new Error(`warden_policy_${field}_human_required`);
  }
  return value;
}

function timestamp(value: string, field: string): number {
  if (!CANONICAL_TIMESTAMP.test(value)) throw new Error(`warden_policy_${field}_invalid`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`warden_policy_${field}_invalid`);
  }
  return parsed;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("warden_policy_number_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("warden_policy_value_invalid");
}

function contentDigest(input: {
  tenantId: string;
  policyKey: string;
  version: number;
  scope: WardenPolicyScope;
  config: Partial<PolicyConfig>;
  createdBy: string;
  createdAt: string;
  evidenceArtifactId: string;
}): string {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex");
}

function validateScope(scope: WardenPolicyScope): void {
  if (!WARDEN_POLICY_SCOPE_KINDS.includes(scope.kind)) {
    throw new Error("warden_policy_scope_kind_invalid");
  }
  requiredText(scope.value, "scope_value");
}

function validateConfig(config: Partial<PolicyConfig>): void {
  const allowed = new Set<keyof PolicyConfig>([
    "autoMergeLowRisk",
    "neverTouchPaths",
    "requireTwoReviewersForAuth",
    "minConfidenceForEdit",
    "notificationsOnly",
  ]);
  for (const key of Object.keys(config) as (keyof PolicyConfig)[]) {
    if (!allowed.has(key) || config[key] === undefined) {
      throw new Error(`warden_policy_config_${key}_invalid`);
    }
  }
  for (const key of ["autoMergeLowRisk", "requireTwoReviewersForAuth", "notificationsOnly"] as const) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") {
      throw new Error(`warden_policy_config_${key}_invalid`);
    }
  }
  if (
    config.minConfidenceForEdit !== undefined &&
    !new Set(["low", "medium", "high"]).has(config.minConfidenceForEdit)
  ) {
    throw new Error("warden_policy_config_minConfidenceForEdit_invalid");
  }
  if (
    config.neverTouchPaths !== undefined &&
    (!Array.isArray(config.neverTouchPaths) ||
      config.neverTouchPaths.some((path) => typeof path !== "string" || !path.trim()))
  ) {
    throw new Error("warden_policy_config_neverTouchPaths_invalid");
  }
  mergePolicy(config);
}

function hydratePolicy(row: StoredPolicyRow): WardenPolicyVersion {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    policyKey: row.policy_key,
    version: row.version,
    scope: Object.freeze({ kind: row.scope_kind, value: row.scope_value }),
    config: Object.freeze(JSON.parse(row.config_json) as Partial<PolicyConfig>),
    createdBy: row.created_by,
    createdAt: row.created_at,
    evidenceArtifactId: row.evidence_artifact_id,
    contentSha256: row.content_sha256,
    approvalState: row.approval_id ? "approved" : "draft",
    approval: row.approval_id
      ? Object.freeze({
          approvalId: row.approval_id,
          approvedBy: row.approved_by!,
          approvedAt: row.approved_at!,
          evidenceArtifactId: row.approval_evidence_artifact_id!,
        })
      : null,
  });
}

function hydrateWaiver(row: StoredWaiverRow): WardenPolicyWaiver {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    policyVersionId: row.policy_version_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reason: row.reason,
    issuedBy: row.issued_by,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    evidenceArtifactId: row.evidence_artifact_id,
  });
}

function globMatches(pattern: string, value: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

function scopeMatches(scope: WardenPolicyScope, context: WardenPolicyContext): boolean {
  if (scope.kind === "tenant") return scope.value === context.tenantId;
  if (scope.kind === "repository") return scope.value === context.repositoryId;
  if (scope.kind === "branch") return globMatches(scope.value, context.branch);
  if (scope.kind === "environment") return scope.value === context.environment;
  return scope.value === context.risk;
}

const PRECEDENCE: Readonly<Record<WardenPolicyScopeKind, number>> = {
  tenant: 0,
  repository: 1,
  branch: 2,
  environment: 3,
  risk: 4,
};

export function resolveWardenPolicy(
  versions: readonly WardenPolicyVersion[],
  context: WardenPolicyContext,
): WardenPolicyResolution {
  const latestByLayer = new Map<string, WardenPolicyVersion>();
  for (const version of versions) {
    if (
      version.tenantId !== context.tenantId ||
      version.approvalState !== "approved" ||
      !scopeMatches(version.scope, context)
    ) continue;
    const key = `${version.policyKey}\n${version.scope.kind}\n${version.scope.value}`;
    const previous = latestByLayer.get(key);
    if (!previous || version.version > previous.version) latestByLayer.set(key, version);
  }
  const applied = [...latestByLayer.values()].sort((left, right) =>
    PRECEDENCE[left.scope.kind] - PRECEDENCE[right.scope.kind] ||
    left.policyKey.localeCompare(right.policyKey) ||
    left.version - right.version,
  );
  let policy = mergePolicy();
  for (const version of applied) policy = mergePolicy({ ...policy, ...version.config });
  return Object.freeze({
    policy,
    appliedVersionIds: Object.freeze(applied.map((version) => version.id)),
    appliedDigests: Object.freeze(applied.map((version) => version.contentSha256)),
  });
}

export function simulateWardenPolicyChange(input: {
  activeVersions: readonly WardenPolicyVersion[];
  candidate: WardenPolicyVersion;
  cases: readonly WardenPolicySimulationCase[];
}): WardenPolicySimulationResult {
  const candidate = Object.freeze({
    ...input.candidate,
    approvalState: "approved" as const,
    approval: input.candidate.approval ?? Object.freeze({
      approvalId: "simulation",
      approvedBy: "human:simulation",
      approvedAt: input.candidate.createdAt,
      evidenceArtifactId: input.candidate.evidenceArtifactId,
    }),
  });
  return Object.freeze({
    candidateVersionId: candidate.id,
    candidateDigest: candidate.contentSha256,
    cases: Object.freeze(input.cases.map((testCase) => {
      const beforePolicy = resolveWardenPolicy(input.activeVersions, testCase.context).policy;
      const afterPolicy = resolveWardenPolicy(
        [...input.activeVersions, candidate],
        testCase.context,
      ).policy;
      const before = evaluatePolicy(testCase.draft, [...testCase.findings], { policy: beforePolicy });
      const after = evaluatePolicy(testCase.draft, [...testCase.findings], { policy: afterPolicy });
      return Object.freeze({
        id: testCase.id,
        before,
        after,
        changed: canonicalJson(before) !== canonicalJson(after),
      });
    })),
  });
}

const POLICY_DDL = `
CREATE TABLE IF NOT EXISTS warden_policy_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_key TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('tenant','repository','branch','environment','risk')),
  scope_value TEXT NOT NULL,
  config_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  UNIQUE (tenant_id, policy_key, version)
);
CREATE INDEX IF NOT EXISTS warden_policy_versions_scope_idx
  ON warden_policy_versions(tenant_id, scope_kind, scope_value, policy_key, version);
CREATE TABLE IF NOT EXISTS warden_policy_approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL UNIQUE REFERENCES warden_policy_versions(id),
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS warden_policy_waivers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL REFERENCES warden_policy_versions(id),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS warden_policy_waivers_subject_idx
  ON warden_policy_waivers(tenant_id, subject_type, subject_id, expires_at);
CREATE TRIGGER IF NOT EXISTS warden_policy_versions_append_only_update BEFORE UPDATE ON warden_policy_versions
BEGIN SELECT RAISE(ABORT, 'warden_policy_versions_append_only'); END;
CREATE TRIGGER IF NOT EXISTS warden_policy_versions_append_only_delete BEFORE DELETE ON warden_policy_versions
BEGIN SELECT RAISE(ABORT, 'warden_policy_versions_append_only'); END;
CREATE TRIGGER IF NOT EXISTS warden_policy_approvals_append_only_update BEFORE UPDATE ON warden_policy_approvals
BEGIN SELECT RAISE(ABORT, 'warden_policy_approvals_append_only'); END;
CREATE TRIGGER IF NOT EXISTS warden_policy_approvals_append_only_delete BEFORE DELETE ON warden_policy_approvals
BEGIN SELECT RAISE(ABORT, 'warden_policy_approvals_append_only'); END;
CREATE TRIGGER IF NOT EXISTS warden_policy_waivers_append_only_update BEFORE UPDATE ON warden_policy_waivers
BEGIN SELECT RAISE(ABORT, 'warden_policy_waivers_append_only'); END;
CREATE TRIGGER IF NOT EXISTS warden_policy_waivers_append_only_delete BEFORE DELETE ON warden_policy_waivers
BEGIN SELECT RAISE(ABORT, 'warden_policy_waivers_append_only'); END;
`;

const POLICY_SELECT = `SELECT v.*,
  a.id AS approval_id, a.approved_by, a.approved_at,
  a.evidence_artifact_id AS approval_evidence_artifact_id
  FROM warden_policy_versions v
  LEFT JOIN warden_policy_approvals a
    ON a.tenant_id = v.tenant_id AND a.policy_version_id = v.id`;

export class WardenPolicyStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(POLICY_DDL);
  }

  createVersion(input: Omit<WardenPolicyVersion, "contentSha256" | "approvalState" | "approval">): WardenPolicyVersion {
    requiredText(input.id, "id");
    requiredText(input.tenantId, "tenant_id");
    requiredText(input.policyKey, "key");
    if (!Number.isSafeInteger(input.version) || input.version < 1) {
      throw new Error("warden_policy_version_invalid");
    }
    validateScope(input.scope);
    validateConfig(input.config);
    humanPrincipal(input.createdBy, "creator");
    timestamp(input.createdAt, "created_at");
    requiredText(input.evidenceArtifactId, "evidence_artifact");
    const latest = this.db.prepare(
      `SELECT MAX(version) AS version FROM warden_policy_versions
       WHERE tenant_id = ? AND policy_key = ?`,
    ).get(input.tenantId, input.policyKey) as { version: number | null };
    if (input.version !== (latest.version ?? 0) + 1) {
      throw new Error("warden_policy_version_sequence_invalid");
    }
    const digest = contentDigest(input);
    this.db.prepare(
      `INSERT INTO warden_policy_versions
       (id, tenant_id, policy_key, version, scope_kind, scope_value, config_json,
        created_by, created_at, evidence_artifact_id, content_sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.tenantId, input.policyKey, input.version, input.scope.kind,
      input.scope.value, canonicalJson(input.config), input.createdBy, input.createdAt,
      input.evidenceArtifactId, digest,
    );
    return this.getVersion(input.tenantId, input.id)!;
  }

  approveVersion(input: {
    id: string;
    tenantId: string;
    policyVersionId: string;
    approvedBy: string;
    approvedAt: string;
    evidenceArtifactId: string;
  }): WardenPolicyVersion {
    requiredText(input.id, "approval_id");
    humanPrincipal(input.approvedBy, "approver");
    timestamp(input.approvedAt, "approved_at");
    requiredText(input.evidenceArtifactId, "approval_evidence_artifact");
    const version = this.getVersion(input.tenantId, input.policyVersionId);
    if (!version) throw new Error("warden_policy_version_not_found");
    if (version.approval) throw new Error("warden_policy_already_approved");
    if (Date.parse(input.approvedAt) < Date.parse(version.createdAt)) {
      throw new Error("warden_policy_approval_before_creation");
    }
    this.db.prepare(
      `INSERT INTO warden_policy_approvals
       (id, tenant_id, policy_version_id, approved_by, approved_at, evidence_artifact_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.tenantId, input.policyVersionId, input.approvedBy,
      input.approvedAt, input.evidenceArtifactId,
    );
    return this.getVersion(input.tenantId, input.policyVersionId)!;
  }

  getVersion(tenantId: string, id: string): WardenPolicyVersion | undefined {
    const row = this.db.prepare(`${POLICY_SELECT} WHERE v.tenant_id = ? AND v.id = ?`)
      .get(tenantId, id) as StoredPolicyRow | undefined;
    return row ? hydratePolicy(row) : undefined;
  }

  listVersions(tenantId: string): WardenPolicyVersion[] {
    const rows = this.db.prepare(
      `${POLICY_SELECT} WHERE v.tenant_id = ? ORDER BY v.policy_key, v.version, v.id`,
    ).all(tenantId) as unknown as StoredPolicyRow[];
    return rows.map(hydratePolicy);
  }

  resolve(context: WardenPolicyContext): WardenPolicyResolution {
    return resolveWardenPolicy(this.listVersions(context.tenantId), context);
  }

  simulate(input: {
    tenantId: string;
    candidateVersionId: string;
    cases: readonly WardenPolicySimulationCase[];
  }): WardenPolicySimulationResult {
    const versions = this.listVersions(input.tenantId);
    const candidate = versions.find((version) => version.id === input.candidateVersionId);
    if (!candidate) throw new Error("warden_policy_version_not_found");
    return simulateWardenPolicyChange({
      activeVersions: versions.filter((version) => version.id !== candidate.id),
      candidate,
      cases: input.cases,
    });
  }

  issueWaiver(input: WardenPolicyWaiver, maxTtlMs = DEFAULT_WAIVER_TTL_MS): WardenPolicyWaiver {
    requiredText(input.id, "waiver_id");
    requiredText(input.tenantId, "tenant_id");
    requiredText(input.subjectType, "waiver_subject_type");
    requiredText(input.subjectId, "waiver_subject_id");
    requiredText(input.reason, "waiver_reason");
    humanPrincipal(input.issuedBy, "waiver_issuer");
    const issuedAt = timestamp(input.issuedAt, "waiver_issued_at");
    const expiresAt = timestamp(input.expiresAt, "waiver_expires_at");
    if (expiresAt <= issuedAt || expiresAt - issuedAt > maxTtlMs) {
      throw new Error("warden_policy_waiver_expiry_invalid");
    }
    requiredText(input.evidenceArtifactId, "waiver_evidence_artifact");
    const policy = this.getVersion(input.tenantId, input.policyVersionId);
    if (!policy || policy.approvalState !== "approved") {
      throw new Error("warden_policy_waiver_approved_policy_required");
    }
    this.db.prepare(
      `INSERT INTO warden_policy_waivers
       (id, tenant_id, policy_version_id, subject_type, subject_id, reason,
        issued_by, issued_at, expires_at, evidence_artifact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id, input.tenantId, input.policyVersionId, input.subjectType,
      input.subjectId, input.reason, input.issuedBy, input.issuedAt,
      input.expiresAt, input.evidenceArtifactId,
    );
    return Object.freeze({ ...input });
  }

  listWaivers(tenantId: string, subjectType: string, subjectId: string): WardenPolicyWaiver[] {
    const rows = this.db.prepare(
      `SELECT * FROM warden_policy_waivers
       WHERE tenant_id = ? AND subject_type = ? AND subject_id = ?
       ORDER BY issued_at, id`,
    ).all(tenantId, subjectType, subjectId) as unknown as StoredWaiverRow[];
    return rows.map(hydrateWaiver);
  }

  activeWaiver(input: {
    tenantId: string;
    policyVersionId: string;
    subjectType: string;
    subjectId: string;
    now: string;
  }): WardenPolicyWaiver | null {
    timestamp(input.now, "waiver_evaluation_at");
    const waiver = this.listWaivers(input.tenantId, input.subjectType, input.subjectId)
      .filter((candidate) =>
        candidate.policyVersionId === input.policyVersionId &&
        Date.parse(candidate.issuedAt) <= Date.parse(input.now) &&
        Date.parse(candidate.expiresAt) > Date.parse(input.now))
      .at(-1);
    return waiver ?? null;
  }
}
