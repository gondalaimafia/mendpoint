import { createHash } from "node:crypto";
import type { GraphLearnDb } from "./store.js";

export type SoftwareEntityKind = "endpoint" | "provider_sdk_method" | "internal_sdk_method" | "function" | "test";
export type SoftwareRelationshipKind = "uses_endpoint" | "uses_sdk_method" | "wraps" | "calls" | "tests";
// A "conflicted" status — competing extractor evidence disagreeing about the same
// entity or relationship — is a future state with no producer today: the
// materializer only emits "active". Re-add it here together with the conflict
// detection that would produce it (the conflictRefs field below already carries
// the disagreeing evidence), so the reader below cannot branch on a state the
// graph can never reach.
export type SoftwareGraphStatus = "active" | "stale" | "superseded";
export type SoftwareGraphDerivation = "provider_spec" | "provider_sdk_binding" | "repository_usage" | "call_graph";
// A "calibrated_probability" basis (a numeric confidence from a calibration model)
// has no producer today: every entity and relationship is derived deterministically
// or from tiered static analysis, so no numeric confidence is ever emitted. Re-add
// the basis together with the `confidence` field and the calibration producer that
// would populate it.
export type SoftwareGraphConfidenceBasis =
  | "deterministic_exact"
  | "static_analysis_high"
  | "static_analysis_medium"
  | "static_analysis_low";

export type SoftwareGraphEntityV1 = {
  id: string;
  kind: SoftwareEntityKind;
  canonicalKey: string;
  aliases: string[];
  label: string;
  scope: "provider" | "repository";
  evidenceRefs: string[];
  extractor: SoftwareGraphExtractorV1;
  derivation: SoftwareGraphDerivation;
  confidenceBasis: SoftwareGraphConfidenceBasis;
  status: SoftwareGraphStatus;
  validFrom: string;
  validTo?: string;
  conflictRefs?: string[];
};
export type SoftwareGraphExtractorV1 = { id: string; version: string; digest: string };
export type SoftwareGraphRelationshipV1 = {
  id: string;
  kind: SoftwareRelationshipKind;
  sourceId: string;
  targetId: string;
  evidenceRefs: string[];
  extractor: SoftwareGraphExtractorV1;
  derivation: SoftwareGraphDerivation;
  confidenceBasis: SoftwareGraphConfidenceBasis;
  status: SoftwareGraphStatus;
  validFrom: string;
  validTo?: string;
  conflictRefs?: string[];
};
export type SoftwareGraphCoverageStageV1 = {
  stage: "repository_discovery" | "language_parsing" | "provider_specification" | "sdk_resolution" | "call_resolution" | "test_resolution";
  // The materializer emits only these three bases today. "failed" (a stage ran
  // but produced no authoritative result) and "conflicted" (authoritative sources
  // disagree) are future states with no producer; re-add them here together with
  // the stage logic that would emit them. See docs/graph/COVERAGE_MODEL.md.
  basis: "complete" | "partial" | "not_analyzed";
  analyzed: number;
  omitted: number;
  reasons?: string[];
  evidenceRefs: string[];
  extractor: SoftwareGraphExtractorV1;
};
export type SoftwareGraphPublicationV1 = {
  schemaVersion: "mendpoint.software-graph.v1";
  tenantId: string;
  repositoryId: string;
  repositorySnapshotId: string;
  repositoryRevision: string;
  providerId: string;
  providerSnapshotId: string;
  providerRevision: string;
  observedAt: string;
  parentVersionId?: string;
  entities: SoftwareGraphEntityV1[];
  relationships: SoftwareGraphRelationshipV1[];
  coverage: SoftwareGraphCoverageStageV1[];
};
export type PublishedSoftwareGraphVersionV1 = SoftwareGraphPublicationV1 & { versionId: string; contentDigest: string };
export type SoftwareEntityResolution =
  | { status: "exact" | "alias"; entity: SoftwareGraphEntityV1 }
  | { status: "ambiguous" | "collision"; candidates: SoftwareGraphEntityV1[] }
  | { status: "unresolved"; candidates: [] };

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/ -]{0,511}$/;
const REVISION_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ENTITY_KINDS = new Set<SoftwareEntityKind>([
  "endpoint",
  "provider_sdk_method",
  "internal_sdk_method",
  "function",
  "test",
]);
const RELATIONSHIP_KINDS = new Set<SoftwareRelationshipKind>([
  "uses_endpoint",
  "uses_sdk_method",
  "wraps",
  "calls",
  "tests",
]);
const GRAPH_STATUSES = new Set<SoftwareGraphStatus>([
  "active",
  "stale",
  "superseded",
]);
const DERIVATIONS = new Set<SoftwareGraphDerivation>([
  "provider_spec", "provider_sdk_binding", "repository_usage", "call_graph",
]);
const CONFIDENCE_BASES = new Set<SoftwareGraphConfidenceBasis>([
  "deterministic_exact", "static_analysis_high", "static_analysis_medium",
  "static_analysis_low",
]);
const COVERAGE_STAGES = new Set<SoftwareGraphCoverageStageV1["stage"]>([
  "repository_discovery",
  "language_parsing",
  "provider_specification",
  "sdk_resolution",
  "call_resolution",
  "test_resolution",
]);
const COVERAGE_BASES = new Set<SoftwareGraphCoverageStageV1["basis"]>([
  "complete",
  "partial",
  "not_analyzed",
]);
const compareCodeUnits = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function onlyKeys(value: unknown, allowed: readonly string[], code: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) throw new Error(code);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
      out[key] = canonicalValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
const canonicalJson = (value: unknown) => JSON.stringify(canonicalValue(value));
const sha256 = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function exactUtc(value: string, code: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error(code);
}
function boundedString(value: string, code: string, max = 512): void {
  if (typeof value !== "string" || value.length < 1 || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error(code);
}
function validateEvidence(refs: string[], code: string): void {
  if (!Array.isArray(refs) || refs.length < 1 || refs.length > 32) throw new Error(code);
  const seen = new Set<string>();
  for (const ref of refs) {
    boundedString(ref, code, 1_024);
    if (seen.has(ref)) throw new Error(code);
    seen.add(ref);
  }
}

function normalizedPublication(input: SoftwareGraphPublicationV1): SoftwareGraphPublicationV1 {
  onlyKeys(input, [
    "schemaVersion", "tenantId", "repositoryId", "repositorySnapshotId",
    "repositoryRevision", "providerId", "providerSnapshotId", "providerRevision",
    "observedAt", "parentVersionId", "entities", "relationships", "coverage",
  ], "software_graph_publication_shape_invalid");
  if (input.schemaVersion !== "mendpoint.software-graph.v1") throw new Error("software_graph_schema_version_invalid");
  for (const [value, code] of [
    [input.tenantId, "software_graph_tenant_invalid"], [input.repositoryId, "software_graph_repository_invalid"],
    [input.repositorySnapshotId, "software_graph_repository_snapshot_invalid"], [input.providerId, "software_graph_provider_invalid"],
    [input.providerSnapshotId, "software_graph_provider_snapshot_invalid"], [input.providerRevision, "software_graph_provider_revision_invalid"],
  ] as const) boundedString(value, code);
  if (!REVISION_RE.test(input.repositoryRevision)) throw new Error("software_graph_repository_revision_invalid");
  exactUtc(input.observedAt, "software_graph_observed_at_invalid");
  if (input.parentVersionId !== undefined) boundedString(input.parentVersionId, "software_graph_parent_invalid");
  if (!Array.isArray(input.entities) || input.entities.length < 1 || input.entities.length > 10_000) throw new Error("software_graph_entities_invalid");
  if (!Array.isArray(input.relationships) || input.relationships.length > 50_000) throw new Error("software_graph_relationships_invalid");
  if (!Array.isArray(input.coverage) || input.coverage.length < 1 || input.coverage.length > 16) throw new Error("software_graph_coverage_invalid");

  const entityIds = new Set<string>();
  const canonicalKeys = new Set<string>();
  const entities = input.entities.map((entity) => {
    onlyKeys(entity, [
      "id", "kind", "canonicalKey", "aliases", "label", "scope", "evidenceRefs",
      "extractor", "derivation", "confidenceBasis", "status", "validFrom", "validTo", "conflictRefs",
    ], "software_graph_entity_shape_invalid");
    if (!ID_RE.test(entity.id)) throw new Error("software_graph_entity_id_invalid");
    if (entityIds.has(entity.id)) throw new Error("software_graph_entity_id_duplicate");
    entityIds.add(entity.id);
    boundedString(entity.canonicalKey, "software_graph_entity_key_invalid", 1_024);
    if (canonicalKeys.has(entity.canonicalKey)) throw new Error("software_graph_entity_key_collision");
    canonicalKeys.add(entity.canonicalKey);
    boundedString(entity.label, "software_graph_entity_label_invalid", 1_024);
    if (!ENTITY_KINDS.has(entity.kind)) throw new Error("software_graph_entity_kind_invalid");
    if (entity.scope !== "provider" && entity.scope !== "repository") throw new Error("software_graph_entity_scope_invalid");
    const expectedScope = entity.kind === "endpoint" || entity.kind === "provider_sdk_method"
      ? "provider"
      : "repository";
    if (entity.scope !== expectedScope) throw new Error("software_graph_entity_scope_invalid");
    if (!GRAPH_STATUSES.has(entity.status)) throw new Error("software_graph_entity_status_invalid");
    if (!Array.isArray(entity.aliases) || entity.aliases.length > 32) throw new Error("software_graph_entity_aliases_invalid");
    const aliases = [...new Set(entity.aliases.map((alias) => {
      boundedString(alias, "software_graph_entity_alias_invalid", 1_024);
      return alias;
    }))].sort(compareCodeUnits);
    validateEvidence(entity.evidenceRefs, "software_graph_entity_evidence_invalid");
    if (!entity.extractor || typeof entity.extractor !== "object") {
      throw new Error("software_graph_entity_extractor_invalid");
    }
    onlyKeys(entity.extractor, ["id", "version", "digest"], "software_graph_entity_extractor_invalid");
    boundedString(entity.extractor.id, "software_graph_entity_extractor_invalid");
    boundedString(entity.extractor.version, "software_graph_entity_extractor_invalid");
    if (!DIGEST_RE.test(entity.extractor.digest)) {
      throw new Error("software_graph_entity_extractor_invalid");
    }
    if (!DERIVATIONS.has(entity.derivation)) throw new Error("software_graph_entity_derivation_invalid");
    if (!CONFIDENCE_BASES.has(entity.confidenceBasis)) throw new Error("software_graph_entity_confidence_basis_invalid");
    if (!entity.validFrom) throw new Error("software_graph_entity_validity_invalid");
    exactUtc(entity.validFrom, "software_graph_entity_validity_invalid");
    if (entity.validFrom > input.observedAt) {
      throw new Error("software_graph_entity_validity_invalid");
    }
    if (entity.validTo) exactUtc(entity.validTo, "software_graph_entity_validity_invalid");
    if (entity.validTo && entity.validTo <= entity.validFrom) {
      throw new Error("software_graph_entity_validity_invalid");
    }
    if (entity.conflictRefs) validateEvidence(entity.conflictRefs, "software_graph_entity_conflicts_invalid");
    return {
      ...entity,
      aliases,
      evidenceRefs: [...entity.evidenceRefs].sort(compareCodeUnits),
      conflictRefs: entity.conflictRefs
        ? [...new Set(entity.conflictRefs)].sort(compareCodeUnits)
        : undefined,
    };
  }).sort((a, b) => compareCodeUnits(a.id, b.id));

  const relationshipIds = new Set<string>();
  const entityKinds = new Map(entities.map((entity) => [entity.id, entity.kind]));
  const relationships = input.relationships.map((relationship) => {
    onlyKeys(relationship, [
      "id", "kind", "sourceId", "targetId", "evidenceRefs", "extractor",
      "derivation", "confidenceBasis", "status", "validFrom", "validTo", "conflictRefs",
    ], "software_graph_relationship_shape_invalid");
    if (!ID_RE.test(relationship.id)) throw new Error("software_graph_relationship_id_invalid");
    if (relationshipIds.has(relationship.id)) throw new Error("software_graph_relationship_id_duplicate");
    relationshipIds.add(relationship.id);
    if (!RELATIONSHIP_KINDS.has(relationship.kind)) throw new Error("software_graph_relationship_kind_invalid");
    if (!GRAPH_STATUSES.has(relationship.status)) throw new Error("software_graph_relationship_status_invalid");
    if (!entityIds.has(relationship.sourceId)) throw new Error("software_graph_relationship_source_missing");
    if (!entityIds.has(relationship.targetId)) throw new Error("software_graph_relationship_target_missing");
    const sourceKind = entityKinds.get(relationship.sourceId)!;
    const targetKind = entityKinds.get(relationship.targetId)!;
    const semanticPairIsValid =
      (relationship.kind === "uses_endpoint" && sourceKind === "provider_sdk_method" && targetKind === "endpoint") ||
      (relationship.kind === "uses_sdk_method" && sourceKind === "internal_sdk_method" && targetKind === "provider_sdk_method") ||
      (relationship.kind === "wraps" && sourceKind === "function" && (targetKind === "function" || targetKind === "internal_sdk_method")) ||
      (relationship.kind === "calls" &&
        (sourceKind === "function" || sourceKind === "test") &&
        (targetKind === "function" || targetKind === "internal_sdk_method" || targetKind === "test")) ||
      (relationship.kind === "tests" && sourceKind === "test" && (targetKind === "function" || targetKind === "internal_sdk_method"));
    if (!semanticPairIsValid) throw new Error("software_graph_relationship_semantics_invalid");
    if (!DERIVATIONS.has(relationship.derivation)) throw new Error("software_graph_relationship_derivation_invalid");
    if (!CONFIDENCE_BASES.has(relationship.confidenceBasis)) throw new Error("software_graph_relationship_confidence_basis_invalid");
    validateEvidence(relationship.evidenceRefs, "software_graph_relationship_evidence_invalid");
    onlyKeys(relationship.extractor, ["id", "version", "digest"], "software_graph_extractor_invalid");
    boundedString(relationship.extractor.id, "software_graph_extractor_invalid");
    boundedString(relationship.extractor.version, "software_graph_extractor_invalid");
    if (!DIGEST_RE.test(relationship.extractor.digest)) throw new Error("software_graph_extractor_digest_invalid");
    if (!relationship.validFrom) throw new Error("software_graph_relationship_validity_invalid");
    exactUtc(relationship.validFrom, "software_graph_relationship_validity_invalid");
    if (relationship.validFrom > input.observedAt) {
      throw new Error("software_graph_relationship_validity_invalid");
    }
    if (relationship.validTo) exactUtc(relationship.validTo, "software_graph_relationship_validity_invalid");
    if (relationship.validFrom && relationship.validTo && relationship.validTo <= relationship.validFrom) throw new Error("software_graph_relationship_validity_invalid");
    if (relationship.conflictRefs) validateEvidence(relationship.conflictRefs, "software_graph_relationship_conflicts_invalid");
    return {
      ...relationship,
      evidenceRefs: [...relationship.evidenceRefs].sort(compareCodeUnits),
      conflictRefs: relationship.conflictRefs ? [...new Set(relationship.conflictRefs)].sort(compareCodeUnits) : undefined,
    };
  }).sort((a, b) => compareCodeUnits(a.id, b.id));

  const stages = new Set<string>();
  const coverage = input.coverage.map((stage) => {
    onlyKeys(stage, [
      "stage", "basis", "analyzed", "omitted", "reasons", "evidenceRefs", "extractor",
    ], "software_graph_coverage_shape_invalid");
    if (!COVERAGE_STAGES.has(stage.stage)) throw new Error("software_graph_coverage_stage_invalid");
    if (stages.has(stage.stage)) throw new Error("software_graph_coverage_stage_duplicate");
    stages.add(stage.stage);
    if (!COVERAGE_BASES.has(stage.basis)) throw new Error("software_graph_coverage_basis_invalid");
    if (!Number.isSafeInteger(stage.analyzed) || stage.analyzed < 0 || !Number.isSafeInteger(stage.omitted) || stage.omitted < 0) throw new Error("software_graph_coverage_counts_invalid");
    if (stage.reasons) validateEvidence(stage.reasons, "software_graph_coverage_reasons_invalid");
    onlyKeys(stage.extractor, ["id", "version", "digest"], "software_graph_coverage_extractor_invalid");
    boundedString(stage.extractor.id, "software_graph_coverage_extractor_invalid");
    boundedString(stage.extractor.version, "software_graph_coverage_extractor_invalid");
    if (!DIGEST_RE.test(stage.extractor.digest)) {
      throw new Error("software_graph_coverage_extractor_invalid");
    }
    if (
      (stage.basis === "complete" && (stage.omitted !== 0 || stage.reasons !== undefined)) ||
      (stage.basis === "partial" && stage.omitted < 1) ||
      (stage.basis === "not_analyzed" && stage.analyzed !== 0) ||
      (stage.basis !== "complete" && !stage.reasons?.length)
    ) throw new Error("software_graph_coverage_semantics_invalid");
    validateEvidence(stage.evidenceRefs, "software_graph_coverage_evidence_invalid");
    return {
      ...stage,
      reasons: stage.reasons ? [...new Set(stage.reasons)].sort(compareCodeUnits) : undefined,
      evidenceRefs: [...stage.evidenceRefs].sort(compareCodeUnits),
    };
  }).sort((a, b) => compareCodeUnits(a.stage, b.stage));
  if (stages.size !== COVERAGE_STAGES.size) throw new Error("software_graph_coverage_incomplete");
  return { ...input, entities, relationships, coverage };
}

export function resolveSoftwareEntity(entities: readonly SoftwareGraphEntityV1[], key: string): SoftwareEntityResolution {
  const exact = entities.filter((entity) => entity.canonicalKey === key);
  if (exact.length === 1) return { status: "exact", entity: structuredClone(exact[0]!) };
  if (exact.length > 1) return { status: "collision", candidates: structuredClone(exact) };
  const aliases = entities.filter((entity) => entity.aliases.includes(key));
  if (aliases.length === 1) return { status: "alias", entity: structuredClone(aliases[0]!) };
  if (aliases.length > 1) return { status: "ambiguous", candidates: structuredClone(aliases) };
  return { status: "unresolved", candidates: [] };
}

type VersionRow = { version_id: string; tenant_id: string; repository_id: string; content_digest: string; content_json: string };

export function getSoftwareGraphHead(
  db: GraphLearnDb,
  tenantId: string,
  repositoryId: string,
  providerId: string,
): { versionId: string; contentDigest: string } | undefined {
  const row = db.raw.prepare(`SELECT version_id, content_digest FROM gl_software_heads_v1 WHERE tenant_id = ? AND repository_id = ? AND provider_id = ?`).get(tenantId, repositoryId, providerId) as { version_id: string; content_digest: string } | undefined;
  return row ? { versionId: row.version_id, contentDigest: row.content_digest } : undefined;
}

/** Tenant+repository heads across providers. Used to pin a Mission only when the version is unambiguous. */
export function listSoftwareGraphHeads(
  db: GraphLearnDb,
  tenantId: string,
  repositoryId: string,
): ReadonlyArray<{ providerId: string; versionId: string; contentDigest: string }> {
  const rows = db.raw.prepare(
    `SELECT provider_id, version_id, content_digest FROM gl_software_heads_v1 WHERE tenant_id = ? AND repository_id = ? ORDER BY provider_id`,
  ).all(tenantId, repositoryId) as Array<{ provider_id: string; version_id: string; content_digest: string }>;
  return rows.map((row) => Object.freeze({
    providerId: row.provider_id, versionId: row.version_id, contentDigest: row.content_digest,
  }));
}

export function publishSoftwareGraphVersion(db: GraphLearnDb, input: SoftwareGraphPublicationV1): { versionId: string; contentDigest: string; replayed: boolean } {
  const normalized = normalizedPublication(structuredClone(input));
  const contentJson = canonicalJson(normalized);
  const contentDigest = sha256(contentJson);
  const versionId = `sgv1:${contentDigest.slice(7)}`;
  const owns = !db.raw.isTransaction;
  const savepoint = `software_graph_publish_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
  if (owns) db.raw.exec("BEGIN IMMEDIATE"); else db.raw.exec(`SAVEPOINT ${savepoint}`);
  try {
    const existing = db.raw.prepare(`SELECT version_id, tenant_id, repository_id, content_digest, content_json FROM gl_software_versions_v1 WHERE version_id = ? AND tenant_id = ? AND repository_id = ?`).get(versionId, normalized.tenantId, normalized.repositoryId) as VersionRow | undefined;
    if (existing) {
      if (existing.content_digest !== contentDigest || existing.content_json !== contentJson) {
        throw new Error("software_graph_version_collision");
      }
      if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
      return { versionId, contentDigest, replayed: true };
    }
    const head = db.raw.prepare(`SELECT version_id, content_digest FROM gl_software_heads_v1 WHERE tenant_id = ? AND repository_id = ? AND provider_id = ?`).get(normalized.tenantId, normalized.repositoryId, normalized.providerId) as { version_id: string; content_digest: string } | undefined;
    if (head) {
      const headRow = db.raw.prepare(`SELECT content_digest, content_json FROM gl_software_versions_v1 WHERE version_id = ? AND tenant_id = ? AND repository_id = ?`).get(head.version_id, normalized.tenantId, normalized.repositoryId) as { content_digest: string; content_json: string } | undefined;
      if (!headRow || headRow.content_digest !== head.content_digest || sha256(headRow.content_json) !== headRow.content_digest) {
        throw new Error("software_graph_head_integrity_failed");
      }
      const headPublication = JSON.parse(headRow.content_json) as SoftwareGraphPublicationV1;
      const withoutParent = (publication: SoftwareGraphPublicationV1) => {
        const clone = structuredClone(publication) as SoftwareGraphPublicationV1 & { parentVersionId?: string };
        delete clone.parentVersionId;
        return canonicalJson(clone);
      };
      if (withoutParent(headPublication) === withoutParent(normalized)) {
        if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
        return { versionId: head.version_id, contentDigest: head.content_digest, replayed: true };
      }
    }
    if ((head && normalized.parentVersionId !== head.version_id) || (!head && normalized.parentVersionId !== undefined)) throw new Error("software_graph_parent_head_mismatch");
    db.raw.prepare(`INSERT INTO gl_software_versions_v1 (version_id, tenant_id, repository_id, repository_snapshot_id, repository_revision, parent_version_id, content_digest, content_json, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      versionId, normalized.tenantId, normalized.repositoryId, normalized.repositorySnapshotId,
      normalized.repositoryRevision, normalized.parentVersionId ?? null, contentDigest, contentJson, normalized.observedAt,
    );
    db.raw.prepare(`INSERT INTO gl_software_heads_v1 (tenant_id, repository_id, provider_id, version_id, content_digest, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, repository_id, provider_id) DO UPDATE SET version_id = excluded.version_id, content_digest = excluded.content_digest, updated_at = excluded.updated_at`).run(normalized.tenantId, normalized.repositoryId, normalized.providerId, versionId, contentDigest, normalized.observedAt);
    if (owns) db.raw.exec("COMMIT"); else db.raw.exec(`RELEASE ${savepoint}`);
    return { versionId, contentDigest, replayed: false };
  } catch (error) {
    if (owns) db.raw.exec("ROLLBACK"); else { db.raw.exec(`ROLLBACK TO ${savepoint}`); db.raw.exec(`RELEASE ${savepoint}`); }
    throw error;
  }
}

export function readSoftwareGraphVersion(db: GraphLearnDb, tenantId: string, repositoryId: string, versionId: string): PublishedSoftwareGraphVersionV1 {
  const row = db.raw.prepare(`SELECT version_id, tenant_id, repository_id, content_digest, content_json FROM gl_software_versions_v1 WHERE version_id = ? AND tenant_id = ? AND repository_id = ?`).get(versionId, tenantId, repositoryId) as VersionRow | undefined;
  if (!row) throw new Error("software_graph_version_not_found");
  if (sha256(row.content_json) !== row.content_digest) throw new Error("software_graph_version_integrity_failed");
  const parsed = JSON.parse(row.content_json) as SoftwareGraphPublicationV1;
  if (parsed.tenantId !== tenantId || parsed.repositoryId !== repositoryId) {
    throw new Error("software_graph_version_scope_mismatch");
  }
  if (row.version_id !== `sgv1:${row.content_digest.slice(7)}`) throw new Error("software_graph_version_identity_mismatch");
  const normalized = normalizedPublication(structuredClone(parsed));
  if (canonicalJson(normalized) !== row.content_json) throw new Error("software_graph_version_canonical_mismatch");
  return structuredClone({ ...normalized, versionId: row.version_id, contentDigest: row.content_digest });
}

export function diffSoftwareGraphVersions(
  db: GraphLearnDb,
  input: {
    tenantId: string;
    repositoryId: string;
    fromVersionId: string;
    toVersionId: string;
  },
) {
  const from = readSoftwareGraphVersion(
    db,
    input.tenantId,
    input.repositoryId,
    input.fromVersionId,
  );
  const to = readSoftwareGraphVersion(
    db,
    input.tenantId,
    input.repositoryId,
    input.toVersionId,
  );
  const compare = <T extends { id: string }>(left: T[], right: T[]) => {
    const a = new Map(left.map((value) => [value.id, canonicalJson(value)]));
    const b = new Map(right.map((value) => [value.id, canonicalJson(value)]));
    const added = [...b.keys()].filter((id) => !a.has(id)).sort(compareCodeUnits);
    const removed = [...a.keys()].filter((id) => !b.has(id)).sort(compareCodeUnits);
    const changed = [...a.keys()]
      .filter((id) => b.has(id) && a.get(id) !== b.get(id))
      .sort(compareCodeUnits);
    const reused = [...a.keys()].filter((id) => b.has(id) && a.get(id) === b.get(id)).length;
    return { added, removed, changed, reused };
  };
  const entities = compare(from.entities, to.entities);
  const relationships = compare(from.relationships, to.relationships);
  return {
    addedEntityIds: entities.added,
    removedEntityIds: entities.removed,
    changedEntityIds: entities.changed,
    addedRelationshipIds: relationships.added,
    removedRelationshipIds: relationships.removed,
    changedRelationshipIds: relationships.changed,
    reusedEntities: entities.reused,
    reusedRelationships: relationships.reused,
  };
}

export type FettlerEndpointImpactQuery = {
  tenantId: string; repositoryId: string; graphVersionId: string; endpointKey: string;
  allowedRelationshipKinds?: SoftwareRelationshipKind[];
  maxHops: number; maxEntities: number; maxRelationships: number;
};
export type FettlerEndpointImpactResult = {
  schemaVersion: "mendpoint.fettler-impact-context.v1";
  tenantId: string; repositoryId: string; graphVersionId: string; graphContentDigest: string;
  target: SoftwareEntityResolution;
  impact: "impact" | "no_impact" | "unknown_impact";
  entities: SoftwareGraphEntityV1[]; relationships: SoftwareGraphRelationshipV1[]; paths: string[][];
  coverage: { basis: "complete" | "partial" | "target_absent"; reasons: string[]; truncated: boolean };
  resultDigest: string;
};

export function queryFettlerEndpointImpact(db: GraphLearnDb, query: FettlerEndpointImpactQuery): FettlerEndpointImpactResult {
  if (!Number.isInteger(query.maxHops) || query.maxHops < 1 || query.maxHops > 12 || !Number.isInteger(query.maxEntities) || query.maxEntities < 1 || query.maxEntities > 2_000 || !Number.isInteger(query.maxRelationships) || query.maxRelationships < 1 || query.maxRelationships > 10_000) throw new Error("software_graph_query_bounds_invalid");
  const graph = readSoftwareGraphVersion(db, query.tenantId, query.repositoryId, query.graphVersionId);
  const target = resolveSoftwareEntity(graph.entities, query.endpointKey);
  if (target.status !== "exact" && target.status !== "alias") {
    const base = { schemaVersion: "mendpoint.fettler-impact-context.v1" as const, tenantId: query.tenantId, repositoryId: query.repositoryId, graphVersionId: graph.versionId, graphContentDigest: graph.contentDigest, target, impact: "unknown_impact" as const, entities: [], relationships: [], paths: [], coverage: { basis: "target_absent" as const, reasons: [target.status], truncated: false } };
    return { ...base, resultDigest: sha256(canonicalJson(base)) };
  }
  const allowed = new Set<SoftwareRelationshipKind>(query.allowedRelationshipKinds ?? ["uses_endpoint", "uses_sdk_method", "wraps", "calls", "tests"]);
  if ([...allowed].some((kind) => !RELATIONSHIP_KINDS.has(kind))) {
    throw new Error("software_graph_query_relationship_kind_invalid");
  }
  const relationshipKindsFiltered = allowed.size !== RELATIONSHIP_KINDS.size;
  const incoming = new Map<string, SoftwareGraphRelationshipV1[]>();
  for (const edge of graph.relationships) {
    if (edge.status !== "active" || !allowed.has(edge.kind)) continue;
    const list = incoming.get(edge.targetId) ?? [];
    list.push(edge); incoming.set(edge.targetId, list);
  }
  for (const list of incoming.values()) list.sort((a, b) => compareCodeUnits(a.id, b.id));
  const byId = new Map(graph.entities.map((entity) => [entity.id, entity]));
  const foundEntities = new Map<string, SoftwareGraphEntityV1>([[target.entity.id, target.entity]]);
  const foundRelationships = new Map<string, SoftwareGraphRelationshipV1>();
  const paths: string[][] = [];
  let hasRepositoryImpact = false;
  const queue: Array<{ id: string; depth: number; path: string[] }> = [{ id: target.entity.id, depth: 0, path: [target.entity.id] }];
  const visitedDepth = new Map<string, number>([[target.entity.id, 0]]);
  let truncated = false;
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth >= query.maxHops) { if ((incoming.get(current.id)?.length ?? 0) > 0) truncated = true; continue; }
    for (const edge of incoming.get(current.id) ?? []) {
      if (foundRelationships.size >= query.maxRelationships) { truncated = true; break; }
      const source = byId.get(edge.sourceId);
      if (!source || source.status !== "active") continue;
      if (!foundEntities.has(source.id) && foundEntities.size >= query.maxEntities) { truncated = true; continue; }
      foundRelationships.set(edge.id, edge); foundEntities.set(source.id, source);
      const nextPath = [...current.path, source.id];
      if (
        source.kind === "internal_sdk_method" || source.kind === "function" ||
        source.kind === "test"
      ) {
        hasRepositoryImpact = true;
      }
      const pathHasRepositoryEntity = nextPath.some((id) => {
        const kind = byId.get(id)?.kind;
        return kind === "internal_sdk_method" || kind === "function" || kind === "test";
      });
      if (
        pathHasRepositoryEntity &&
        (source.kind === "test" || (incoming.get(source.id)?.length ?? 0) === 0)
      ) paths.push(nextPath);
      const prior = visitedDepth.get(source.id);
      if (prior === undefined || prior > current.depth + 1) { visitedDepth.set(source.id, current.depth + 1); queue.push({ id: source.id, depth: current.depth + 1, path: nextPath }); }
    }
  }
  const incomplete = graph.coverage.filter((stage) => stage.basis !== "complete");
  const reasons = incomplete.map((stage) => `${stage.stage}:${stage.basis}`);
  const hasNonActiveEvidence = graph.entities.some((entity) => entity.status !== "active") ||
    graph.relationships.some((relationship) => relationship.status !== "active");
  if (hasNonActiveEvidence) reasons.push("graph_non_active_evidence");
  if (truncated) reasons.push("query_truncated");
  if (relationshipKindsFiltered) reasons.push("relationship_kinds_filtered");
  const complete = incomplete.length === 0 && !hasNonActiveEvidence && !truncated && !relationshipKindsFiltered;
  const impact: FettlerEndpointImpactResult["impact"] = hasRepositoryImpact
    ? "impact"
    : complete
      ? "no_impact"
      : "unknown_impact";
  const base = {
    schemaVersion: "mendpoint.fettler-impact-context.v1" as const,
    tenantId: query.tenantId, repositoryId: query.repositoryId, graphVersionId: graph.versionId,
    graphContentDigest: graph.contentDigest, target, impact,
    entities: [...foundEntities.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    relationships: [...foundRelationships.values()].sort((a, b) => compareCodeUnits(a.id, b.id)),
    paths: paths.sort((a, b) => compareCodeUnits(a.join("\0"), b.join("\0"))),
    coverage: { basis: complete ? "complete" as const : "partial" as const, reasons: reasons.sort(compareCodeUnits), truncated },
  };
  return { ...base, resultDigest: sha256(canonicalJson(base)) };
}

export function compileFettlerImpactContext(result: FettlerEndpointImpactResult, options: { maxBytes: number }): { content: string; byteLength: number; contentDigest: string } {
  if (!Number.isInteger(options.maxBytes) || options.maxBytes < 512 || options.maxBytes > 262_144) throw new Error("fettler_impact_context_bounds_invalid");
  const entityById = new Map(result.entities.map((entity) => [entity.id, entity]));
  const edgeByPair = new Map(result.relationships.map((edge) => [`${edge.targetId}\0${edge.sourceId}`, edge]));
  const paths = result.paths.map((path) => path.map((id, index) => {
    const entity = entityById.get(id);
    if (!entity) throw new Error("fettler_impact_context_entity_missing");
    if (index === 0) {
      return {
        kind: entity.kind,
        label: entity.label,
        evidenceRefs: entity.evidenceRefs,
      };
    }
    const targetId = path[index - 1]!;
    const edge = edgeByPair.get(`${targetId}\0${id}`);
    if (!edge) throw new Error("fettler_impact_context_relationship_missing");
    return {
      via: edge.kind,
      kind: entity.kind,
      label: entity.label,
      derivation: edge.derivation,
      confidenceBasis: edge.confidenceBasis,
      evidenceRefs: [...new Set([...entity.evidenceRefs, ...edge.evidenceRefs])]
        .sort(compareCodeUnits),
    };
  }));
  const content = canonicalJson({
    schemaVersion: result.schemaVersion,
    binding: {
      tenantId: result.tenantId,
      repositoryId: result.repositoryId,
      graphVersionId: result.graphVersionId,
      graphContentDigest: result.graphContentDigest,
      resultDigest: result.resultDigest,
    },
    impact: result.impact,
    coverage: result.coverage,
    paths,
  });
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > options.maxBytes) throw new Error("fettler_impact_context_too_large");
  return Object.freeze({ content, byteLength, contentDigest: sha256(content) });
}

/**
 * Named MissionGraphProjection (spec §8.16): the bounded, versioned,
 * evidence-bearing Change Graph view compiled for one mission or task.
 * Wraps `compileFettlerImpactContext` so callers receive one typed object
 * rather than an unbounded dump or an anonymous `{ content, byteLength }`.
 */
export type MissionGraphImpactProjection = Readonly<{
  schemaVersion: "mendpoint.mission-graph-projection.v1";
  missionId: string | null;
  tenantId: string;
  repositoryId: string;
  graphVersionId: string;
  graphContentDigest: string;
  resultDigest: string;
  impact: FettlerEndpointImpactResult["impact"];
  coverage: FettlerEndpointImpactResult["coverage"];
  compiled: Readonly<{ content: string; byteLength: number; contentDigest: string }>;
}>;

export type MissionGraphTopologyCoverage = "complete" | "unknown" | "not_consulted";
export type MissionGraphTopologyRepository = Readonly<{
  repositoryId: string;
  serviceId: string | null;
  manifestPath: string | null;
  manifestContentDigest: string | null;
  manifestVersionId: string | null;
  snapshotId: string | null;
  snapshotRevision: string | null;
  snapshotDigest: string | null;
  coverage: MissionGraphTopologyCoverage;
  reason: string;
  dependsOnRepositoryIds: readonly string[];
  evidenceRefs: readonly string[];
}>;
export type MissionGraphTopologyEdge = Readonly<{
  sourceRepositoryId: string;
  targetRepositoryId: string;
  graphEdgeId: string;
  sourceSystem: "manifest";
  confidence: number;
  evidenceRefs: readonly string[];
}>;
export type MissionGraphTopologyProjection = Readonly<{
  schemaVersion: "mendpoint.mission-graph-projection.topology.v1";
  projectionKind: "dependency_topology";
  missionId: string | null;
  tenantId: string;
  requestedRepositoryIds: readonly string[];
  repositories: readonly MissionGraphTopologyRepository[];
  edges: readonly MissionGraphTopologyEdge[];
  contentDigest: string;
}>;
export type MissionGraphProjection = MissionGraphImpactProjection | MissionGraphTopologyProjection;

export function compileMissionGraphTopologyProjection(input: Omit<
  MissionGraphTopologyProjection,
  "schemaVersion" | "projectionKind" | "contentDigest"
>): MissionGraphTopologyProjection {
  boundedString(input.tenantId, "mission_graph_topology_invalid", 1_000);
  if (input.missionId !== null) boundedString(input.missionId, "mission_graph_topology_invalid", 1_000);
  const requestedRepositoryIds = [...new Set(input.requestedRepositoryIds)].sort(compareCodeUnits);
  if (!requestedRepositoryIds.length || requestedRepositoryIds.length !== input.requestedRepositoryIds.length) {
    throw new Error("mission_graph_topology_invalid");
  }
  const requested = new Set(requestedRepositoryIds);
  for (const repositoryId of requestedRepositoryIds) {
    boundedString(repositoryId, "mission_graph_topology_invalid", 1_000);
  }
  const repositories = input.repositories.map((repository) => ({
    ...repository,
    dependsOnRepositoryIds: [...new Set(repository.dependsOnRepositoryIds)].sort(compareCodeUnits),
    evidenceRefs: [...new Set(repository.evidenceRefs)].sort(compareCodeUnits),
  })).sort((left, right) => compareCodeUnits(left.repositoryId, right.repositoryId));
  if (repositories.length !== requestedRepositoryIds.length || repositories.some((repository, index) =>
    repository.repositoryId !== requestedRepositoryIds[index] ||
    (repository.serviceId !== null && (typeof repository.serviceId !== "string" || !repository.serviceId)) ||
    (repository.manifestPath !== null && !["package.json", "pyproject.toml", "go.mod"].includes(repository.manifestPath)) ||
    (repository.manifestContentDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(repository.manifestContentDigest)) ||
    (repository.manifestVersionId !== null && !/^sha256:[a-f0-9]{64}$/.test(repository.manifestVersionId)) ||
    (repository.snapshotId !== null && (typeof repository.snapshotId !== "string" || !repository.snapshotId)) ||
    (repository.snapshotRevision !== null && !/^[a-f0-9]{40}$/.test(repository.snapshotRevision)) ||
    (repository.snapshotDigest !== null && !/^sha256:[a-f0-9]{64}$/.test(repository.snapshotDigest)) ||
    typeof repository.reason !== "string" || !repository.reason ||
    repository.evidenceRefs.some((ref) => typeof ref !== "string" || !ref) ||
    !["complete", "unknown", "not_consulted"].includes(repository.coverage) ||
    (repository.coverage === "complete" && (
      !repository.serviceId || !repository.manifestPath || !repository.manifestContentDigest ||
      !repository.manifestVersionId || !repository.snapshotId || !repository.snapshotRevision ||
      !repository.snapshotDigest || repository.reason !== "manifest_ingest_complete" ||
      !repository.evidenceRefs.includes("manifest-ingest:" + repository.manifestContentDigest))) ||
    (repository.coverage !== "complete" && repository.dependsOnRepositoryIds.length > 0) ||
    repository.dependsOnRepositoryIds.some((id) => !requested.has(id) || id === repository.repositoryId)
  )) throw new Error("mission_graph_topology_invalid");
  const edges = input.edges.map((edge) => ({
    ...edge,
    evidenceRefs: [...new Set(edge.evidenceRefs)].sort(compareCodeUnits),
  })).sort((left, right) => compareCodeUnits(
    [left.sourceRepositoryId, left.targetRepositoryId, left.graphEdgeId].join("|"),
    [right.sourceRepositoryId, right.targetRepositoryId, right.graphEdgeId].join("|"),
  ));
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    const source = repositories.find((repository) => repository.repositoryId === edge.sourceRepositoryId);
    if (!source || edge.sourceSystem !== "manifest" || edgeIds.has(edge.graphEdgeId) ||
        typeof edge.graphEdgeId !== "string" || !edge.graphEdgeId ||
        !source.dependsOnRepositoryIds.includes(edge.targetRepositoryId) ||
        !requested.has(edge.targetRepositoryId) || edge.confidence < 0 || edge.confidence > 1 ||
        !Number.isFinite(edge.confidence) || !edge.evidenceRefs.length ||
        !source.evidenceRefs.every((ref) => edge.evidenceRefs.includes(ref))) {
      throw new Error("mission_graph_topology_invalid");
    }
    edgeIds.add(edge.graphEdgeId);
  }
  for (const repository of repositories) {
    for (const target of repository.dependsOnRepositoryIds) {
      if (!edges.some((edge) => edge.sourceRepositoryId === repository.repositoryId && edge.targetRepositoryId === target)) {
        throw new Error("mission_graph_topology_invalid");
      }
    }
  }
  const body = {
    schemaVersion: "mendpoint.mission-graph-projection.topology.v1" as const,
    projectionKind: "dependency_topology" as const,
    missionId: input.missionId,
    tenantId: input.tenantId,
    requestedRepositoryIds,
    repositories,
    edges,
  };
  return Object.freeze({ ...body, contentDigest: sha256(canonicalJson(body)) });
}

export function verifyMissionGraphTopologyProjection(value: MissionGraphTopologyProjection): MissionGraphTopologyProjection {
  try {
    const { schemaVersion, projectionKind, contentDigest, ...input } = structuredClone(value);
    if (schemaVersion !== "mendpoint.mission-graph-projection.topology.v1" || projectionKind !== "dependency_topology") {
      throw new Error("schema");
    }
    const expected = compileMissionGraphTopologyProjection(input);
    if (expected.contentDigest !== contentDigest || canonicalJson(expected) !== canonicalJson(value)) throw new Error("digest");
    return expected;
  } catch {
    throw new Error("mission_graph_topology_integrity_invalid");
  }
}

export function compileMissionGraphProjection(input: {
  impact: FettlerEndpointImpactResult;
  missionId?: string | null;
  maxBytes: number;
}): MissionGraphImpactProjection {
  const compiled = compileFettlerImpactContext(input.impact, { maxBytes: input.maxBytes });
  return Object.freeze({
    schemaVersion: "mendpoint.mission-graph-projection.v1",
    missionId: input.missionId ?? null,
    tenantId: input.impact.tenantId,
    repositoryId: input.impact.repositoryId,
    graphVersionId: input.impact.graphVersionId,
    graphContentDigest: input.impact.graphContentDigest,
    resultDigest: input.impact.resultDigest,
    impact: input.impact.impact,
    coverage: Object.freeze({ ...input.impact.coverage, reasons: [...input.impact.coverage.reasons] }),
    compiled,
  });
}

export type ChangeGraphFailureDestination =
  | "entity_resolution"
  | "parser"
  | "graph_runtime"
  | "query"
  | "context_compiler"
  | "model";

export function classifyChangeGraphFailure(code: string): {
  destination: ChangeGraphFailureDestination;
  category: string;
  modelWeightEligible: boolean;
} {
  if (code === "generator_incorrect_with_complete_graph") {
    return { destination: "model", category: "generator", modelWeightEligible: true };
  }
  if (code.includes("entity") || code.includes("resolution")) {
    return { destination: "entity_resolution", category: "entity_resolution", modelWeightEligible: false };
  }
  if (code.includes("parser") || code.includes("unsupported")) {
    return { destination: "parser", category: "parser", modelWeightEligible: false };
  }
  if (code.includes("query")) {
    return { destination: "query", category: "query", modelWeightEligible: false };
  }
  if (code.includes("context")) {
    return { destination: "context_compiler", category: "context", modelWeightEligible: false };
  }
  return { destination: "graph_runtime", category: "graph_runtime", modelWeightEligible: false };
}
