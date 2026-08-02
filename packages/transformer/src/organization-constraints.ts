import { createHash } from "node:crypto";

export const ORGANIZATION_CONSTRAINT_SCHEMA_VERSION = "2026-08-02.v1" as const;

export const ORGANIZATION_CONSTRAINT_PRECEDENCE = {
  service_map: 100,
  codeowners: 200,
  build_setting: 300,
  ci_setting: 400,
  protected_path: 500,
  architecture_decision: 600,
  explicit_policy: 700,
} as const;

export type OrganizationConstraintSourceKind = keyof typeof ORGANIZATION_CONSTRAINT_PRECEDENCE;
export type OrganizationConstraintAction = "read" | "change" | "delete";
export type OrganizationConstraintEffect = "allow" | "deny";

export type OrganizationConstraintSource = Readonly<{
  id: string;
  kind: OrganizationConstraintSourceKind;
  repositoryId: string;
  revision: string;
  digest: string;
  locator: string;
  evidenceRefs: readonly string[];
}>;

export type OrganizationConstraintRule = Readonly<{
  id: string;
  sourceId: string;
  repositoryId: string;
  pathPattern: string;
  actions: readonly OrganizationConstraintAction[];
  effect: OrganizationConstraintEffect;
  ownerIds: readonly string[];
  rationale: string;
}>;

export type OrganizationConstraintContract = Readonly<{
  schemaVersion: typeof ORGANIZATION_CONSTRAINT_SCHEMA_VERSION;
  tenantId: string;
  organizationId: string;
  version: number;
  effectiveAt: string;
  sources: readonly OrganizationConstraintSource[];
  rules: readonly OrganizationConstraintRule[];
  digest: string;
}>;

export type OrganizationConstraintDecision = Readonly<{
  allowed: boolean;
  tenantId: string;
  organizationId: string;
  contractVersion: number;
  contractDigest: string;
  repositoryId: string;
  path: string;
  action: OrganizationConstraintAction;
  reasons: readonly string[];
  evidenceRefs: readonly string[];
}>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const REVISION = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIONS = new Set<OrganizationConstraintAction>(["read", "change", "delete"]);

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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value: unknown, code: string, maximum = 1_000): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > maximum) {
    throw new Error(code);
  }
  return value;
}

function id(value: unknown, code: string): string {
  const result = text(value, code, 200);
  if (!ID.test(result)) throw new Error(code);
  return result;
}

function list(values: unknown, code: string): string[] {
  if (!Array.isArray(values) || values.length === 0) throw new Error(code);
  const normalized = values.map((value) => text(value, code));
  if (new Set(normalized).size !== normalized.length) throw new Error(code);
  return normalized.sort();
}

function pathPattern(value: unknown): string {
  const pattern = text(value, "organization_constraint_path_invalid");
  if (pattern === "**") return pattern;
  if (
    pattern.includes("\\") || pattern.includes("\0") || pattern.startsWith("/") ||
    pattern.includes("../") || pattern === ".." || pattern.includes("//") ||
    (pattern.includes("*") && !pattern.endsWith("/**")) || pattern.slice(0, -3).includes("*")
  ) throw new Error("organization_constraint_path_invalid");
  return pattern;
}

function normalizedPath(value: string): string {
  const path = text(value, "organization_constraint_path_invalid");
  if (path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.includes("../") || path === "..") {
    throw new Error("organization_constraint_path_invalid");
  }
  return path;
}

function matches(pattern: string, path: string): boolean {
  if (pattern === "**") return true;
  if (!pattern.endsWith("/**")) return pattern === path;
  const prefix = pattern.slice(0, -3);
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function createOrganizationConstraintContract(input: Omit<OrganizationConstraintContract, "schemaVersion" | "digest">): OrganizationConstraintContract {
  const tenantId = id(input.tenantId, "organization_constraint_tenant_invalid");
  const organizationId = id(input.organizationId, "organization_constraint_organization_invalid");
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new Error("organization_constraint_version_invalid");
  if (new Date(input.effectiveAt).toISOString() !== input.effectiveAt) throw new Error("organization_constraint_effective_at_invalid");
  if (!Array.isArray(input.sources) || input.sources.length === 0) throw new Error("organization_constraint_sources_required");
  const sources = input.sources.map((candidate): OrganizationConstraintSource => {
    const source: OrganizationConstraintSource = {
      id: id(candidate.id, "organization_constraint_source_id_invalid"),
      kind: candidate.kind,
      repositoryId: id(candidate.repositoryId, "organization_constraint_repository_invalid"),
      revision: text(candidate.revision, "organization_constraint_source_revision_invalid"),
      digest: text(candidate.digest, "organization_constraint_source_digest_invalid"),
      locator: text(candidate.locator, "organization_constraint_source_locator_invalid"),
      evidenceRefs: list(candidate.evidenceRefs, "organization_constraint_source_evidence_required"),
    };
    if (!(source.kind in ORGANIZATION_CONSTRAINT_PRECEDENCE)) throw new Error("organization_constraint_source_kind_invalid");
    if (!REVISION.test(source.revision)) throw new Error("organization_constraint_source_revision_invalid");
    if (!DIGEST.test(source.digest)) throw new Error("organization_constraint_source_digest_invalid");
    return source;
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("organization_constraint_source_id_duplicate");
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  if (!Array.isArray(input.rules) || input.rules.length === 0) throw new Error("organization_constraint_rules_required");
  const rules = input.rules.map((candidate): OrganizationConstraintRule => {
    const sourceId = id(candidate.sourceId, "organization_constraint_rule_source_invalid");
    const source = sourceById.get(sourceId);
    if (!source) throw new Error("organization_constraint_rule_source_unknown");
    const repositoryId = id(candidate.repositoryId, "organization_constraint_rule_repository_invalid");
    if (repositoryId !== source.repositoryId) throw new Error("organization_constraint_rule_repository_mismatch");
    const candidateActions = candidate.actions as readonly OrganizationConstraintAction[];
    if (!Array.isArray(candidateActions) || candidateActions.length === 0 || candidateActions.some((action: OrganizationConstraintAction) => !ACTIONS.has(action))) {
      throw new Error("organization_constraint_rule_actions_invalid");
    }
    const actions = [...new Set(candidateActions)].sort() as OrganizationConstraintAction[];
    if (actions.length !== candidateActions.length) throw new Error("organization_constraint_rule_actions_duplicate");
    if (candidate.effect !== "allow" && candidate.effect !== "deny") throw new Error("organization_constraint_rule_effect_invalid");
    return {
      id: id(candidate.id, "organization_constraint_rule_id_invalid"),
      sourceId,
      repositoryId,
      pathPattern: pathPattern(candidate.pathPattern),
      actions,
      effect: candidate.effect,
      ownerIds: list(candidate.ownerIds, "organization_constraint_rule_owner_required"),
      rationale: text(candidate.rationale, "organization_constraint_rule_rationale_required", 2_000),
    };
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("organization_constraint_rule_id_duplicate");
  const exactDecisions = new Map<string, OrganizationConstraintEffect>();
  for (const rule of rules) {
    const source = sourceById.get(rule.sourceId)!;
    for (const action of rule.actions) {
      const key = `${rule.repositoryId}\0${rule.pathPattern}\0${action}\0${ORGANIZATION_CONSTRAINT_PRECEDENCE[source.kind]}`;
      const prior = exactDecisions.get(key);
      if (prior && prior !== rule.effect) throw new Error("organization_constraint_equal_precedence_conflict");
      exactDecisions.set(key, rule.effect);
    }
  }
  const body = {
    schemaVersion: ORGANIZATION_CONSTRAINT_SCHEMA_VERSION,
    tenantId,
    organizationId,
    version: input.version,
    effectiveAt: input.effectiveAt,
    sources: sources.sort((left, right) => left.id.localeCompare(right.id)),
    rules: rules.sort((left, right) => left.id.localeCompare(right.id)),
  };
  return deepFreeze({ ...body, digest: sha256(body) });
}

export function assessOrganizationConstraint(
  contract: OrganizationConstraintContract,
  input: { tenantId: string; organizationId: string; repositoryId: string; path: string; action: OrganizationConstraintAction },
): OrganizationConstraintDecision {
  const path = normalizedPath(input.path);
  const reasons: string[] = [];
  if (input.tenantId !== contract.tenantId) reasons.push("constraint_tenant_mismatch");
  if (input.organizationId !== contract.organizationId) reasons.push("constraint_organization_mismatch");
  if (!ACTIONS.has(input.action)) reasons.push("constraint_action_invalid");
  const sourceById = new Map(contract.sources.map((source) => [source.id, source]));
  const matchesForPath = contract.rules
    .filter((rule) => rule.repositoryId === input.repositoryId && rule.actions.includes(input.action) && matches(rule.pathPattern, path))
    .map((rule) => ({ rule, source: sourceById.get(rule.sourceId)! }));
  if (matchesForPath.length === 0) reasons.push("constraint_default_deny");
  const highest = Math.max(0, ...matchesForPath.map(({ source }) => ORGANIZATION_CONSTRAINT_PRECEDENCE[source.kind]));
  const decisive = matchesForPath.filter(({ source }) => ORGANIZATION_CONSTRAINT_PRECEDENCE[source.kind] === highest);
  if (new Set(decisive.map(({ rule }) => rule.effect)).size > 1) reasons.push("constraint_equal_precedence_conflict");
  const denied = decisive.some(({ rule }) => rule.effect === "deny");
  if (denied) reasons.push("constraint_denied");
  const evidenceRefs = [...new Set(decisive.flatMap(({ source }) => source.evidenceRefs))].sort();
  return deepFreeze({
    allowed: reasons.length === 0 && decisive.length > 0 && decisive.every(({ rule }) => rule.effect === "allow"),
    tenantId: input.tenantId,
    organizationId: input.organizationId,
    contractVersion: contract.version,
    contractDigest: contract.digest,
    repositoryId: input.repositoryId,
    path,
    action: input.action,
    reasons: [...new Set(reasons)].sort(),
    evidenceRefs,
  });
}
