import { createHash } from "node:crypto";
import type { AppDb } from "./index.js";
import { insertArtifactManifest, insertEvidenceRecord } from "./trust.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const SOURCE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const SUBJECT_TYPE = "graphql_schema_source";

export type StoredGraphQLSourceFormat = "sdl" | "introspection";
export type StoredGraphQLClassification = "breaking" | "dangerous" | "additive" | "non_breaking";

export type StoredGraphQLSchema = Readonly<{
  sourceFormat: StoredGraphQLSourceFormat;
  canonicalSdl: string;
  definitions: readonly unknown[];
  digest: string;
}>;

export type StoredGraphQLDiff = Readonly<{
  classification: StoredGraphQLClassification;
  changes: readonly Readonly<{
    kind: string;
    coordinate: string;
    classification: StoredGraphQLClassification;
    oldLocation?: unknown;
    newLocation?: unknown;
    migrationHint: string;
  }>[];
  oracle: Readonly<{ breaking: readonly string[]; dangerous: readonly string[] }>;
  oldDigest: string | null;
  newDigest: string;
}>;

export type GraphQLSchemaVersionRecord = Readonly<{
  schemaVersion: 1;
  id: string;
  evidenceId: string;
  tenantId: string;
  sourceKey: string;
  versionLabel: string;
  sourceFormat: StoredGraphQLSourceFormat;
  sourceSha256: string;
  sourceArtifactId: string;
  schemaArtifactId: string;
  schema: StoredGraphQLSchema;
  baselineVersionId: string | null;
  diff: StoredGraphQLDiff;
  createdAt: string;
}>;

export type InsertGraphQLSchemaVersionInput = Readonly<{
  id: string;
  evidenceId: string;
  sourceArtifactId: string;
  schemaArtifactId: string;
  tenantId: string;
  sourceKey: string;
  versionLabel: string;
  sourceFormat: StoredGraphQLSourceFormat;
  sourceContent: string;
  schema: StoredGraphQLSchema;
  baselineVersionId: string | null;
  diff: StoredGraphQLDiff;
  createdAt: string;
}>;

type StoredRow = {
  evidence_id: string;
  subject_id: string;
  input_artifact_id: string;
  schema_artifact_id: string;
  content_text: string | null;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validate(input: InsertGraphQLSchemaVersionInput): void {
  for (const value of [input.id, input.evidenceId, input.sourceArtifactId, input.schemaArtifactId]) {
    if (!ID.test(value)) throw new Error("graphql_schema_version_id_invalid");
  }
  if (!input.tenantId.trim() || input.tenantId.length > 200) throw new Error("graphql_schema_tenant_invalid");
  if (!SOURCE_KEY.test(input.sourceKey)) throw new Error("graphql_schema_source_key_invalid");
  if (!input.versionLabel.trim() || input.versionLabel.length > 200) throw new Error("graphql_schema_version_label_invalid");
  if (input.sourceFormat !== "sdl" && input.sourceFormat !== "introspection") throw new Error("graphql_schema_source_format_invalid");
  if (!input.sourceContent || Buffer.byteLength(input.sourceContent, "utf8") > 2_100_000) throw new Error("graphql_schema_source_content_invalid");
  if (!SHA256.test(input.schema.digest) || input.schema.sourceFormat !== input.sourceFormat || input.schema.canonicalSdl.trim().length === 0 || !Array.isArray(input.schema.definitions)) throw new Error("graphql_schema_normalized_invalid");
  if (input.baselineVersionId !== null && !ID.test(input.baselineVersionId)) throw new Error("graphql_schema_baseline_invalid");
  if (input.diff.newDigest !== input.schema.digest || (input.baselineVersionId === null) !== (input.diff.oldDigest === null)) throw new Error("graphql_schema_diff_binding_invalid");
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("graphql_schema_created_at_invalid");
}

function parse(row: StoredRow | undefined, tenantId: string): GraphQLSchemaVersionRecord | undefined {
  if (!row) return undefined;
  try {
    const record = JSON.parse(row.content_text ?? "") as GraphQLSchemaVersionRecord;
    if (record.schemaVersion !== 1 || record.tenantId !== tenantId || record.evidenceId !== row.evidence_id || record.sourceKey !== row.subject_id || record.sourceArtifactId !== row.input_artifact_id || record.schemaArtifactId !== row.schema_artifact_id || !SHA256.test(record.schema.digest)) throw new Error("graphql_schema_version_corrupt");
    return record;
  } catch (error) {
    if (error instanceof Error && error.message === "graphql_schema_version_corrupt") throw error;
    throw new Error("graphql_schema_version_corrupt");
  }
}

function rowsForSource(db: AppDb, tenantId: string, sourceKey: string, limit: number): StoredRow[] {
  return db.raw.prepare(
    `SELECT e.id AS evidence_id, e.subject_id, e.input_artifact_id,
            a.id AS schema_artifact_id, a.content_text
       FROM evidence_records e
       JOIN artifact_manifests a ON a.id = e.artifact_id AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.subject_type = ? AND e.subject_id = ?
      ORDER BY e.created_at DESC, e.id DESC LIMIT ?`,
  ).all(tenantId, SUBJECT_TYPE, sourceKey, limit) as StoredRow[];
}

export function getGraphQLSchemaVersion(db: AppDb, tenantId: string, sourceKey: string, versionId: string): GraphQLSchemaVersionRecord | undefined {
  if (!tenantId.trim() || !SOURCE_KEY.test(sourceKey) || !ID.test(versionId)) return undefined;
  const row = db.raw.prepare(
    `SELECT e.id AS evidence_id, e.subject_id, e.input_artifact_id,
            a.id AS schema_artifact_id, a.content_text
       FROM evidence_records e
       JOIN artifact_manifests a ON a.id = e.artifact_id AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.subject_type = ? AND e.subject_id = ?
        AND a.kind = ? AND a.storage_ref = ?
      LIMIT 1`,
  ).get(
    tenantId,
    SUBJECT_TYPE,
    sourceKey,
    `graphql-schema-version:${sourceKey}`,
    `db:graphql-version:${sourceKey}:${versionId}`,
  ) as StoredRow | undefined;
  const record = parse(row, tenantId);
  if (record && record.id !== versionId) throw new Error("graphql_schema_version_corrupt");
  return record;
}

export function listGraphQLSchemaVersions(db: AppDb, tenantId: string, sourceKey: string, limit = 100): GraphQLSchemaVersionRecord[] {
  if (!tenantId.trim() || !SOURCE_KEY.test(sourceKey)) return [];
  const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 100;
  const rows = rowsForSource(db, tenantId, sourceKey, bounded);
  return rows.map((row) => parse(row, tenantId)!);
}

export function getGraphQLSchemaVersionByLabel(db: AppDb, tenantId: string, sourceKey: string, versionLabel: string): GraphQLSchemaVersionRecord | undefined {
  if (!tenantId.trim() || !SOURCE_KEY.test(sourceKey) || !versionLabel.trim() || versionLabel.length > 200) return undefined;
  const row = db.raw.prepare(
    `SELECT e.id AS evidence_id, e.subject_id, e.input_artifact_id,
            a.id AS schema_artifact_id, a.content_text
       FROM evidence_records e
       JOIN artifact_manifests a ON a.id = e.artifact_id AND a.tenant_id = e.tenant_id
      WHERE e.tenant_id = ? AND e.subject_type = ? AND e.subject_id = ?
        AND a.kind = ?
        AND CASE WHEN json_valid(a.content_text) THEN json_extract(a.content_text, '$.versionLabel') END = ?
      LIMIT 1`,
  ).get(tenantId, SUBJECT_TYPE, sourceKey, `graphql-schema-version:${sourceKey}`, versionLabel) as StoredRow | undefined;
  const record = parse(row, tenantId);
  if (record && record.versionLabel !== versionLabel) throw new Error("graphql_schema_version_corrupt");
  return record;
}

export function getGraphQLSchemaSourceContent(db: AppDb, tenantId: string, artifactId: string): string | undefined {
  if (!tenantId.trim() || !ID.test(artifactId)) return undefined;
  const row = db.raw.prepare(
    `SELECT content_text FROM artifact_manifests
      WHERE tenant_id = ? AND id = ? AND kind LIKE 'graphql-schema-source:%'`,
  ).get(tenantId, artifactId) as { content_text: string | null } | undefined;
  return row?.content_text ?? undefined;
}

export function insertGraphQLSchemaVersion(db: AppDb, input: InsertGraphQLSchemaVersionInput): { record: GraphQLSchemaVersionRecord; inserted: boolean } {
  validate(input);
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = getGraphQLSchemaVersionByLabel(db, input.tenantId, input.sourceKey, input.versionLabel);
    const sourceSha256 = digest(input.sourceContent);
    if (existing) {
      if (existing.sourceFormat !== input.sourceFormat || existing.sourceSha256 !== sourceSha256 || existing.schema.digest !== input.schema.digest || existing.baselineVersionId !== input.baselineVersionId || JSON.stringify(existing.diff) !== JSON.stringify(input.diff)) throw new Error("graphql_schema_version_label_conflict");
      if (ownsTransaction) db.raw.exec("COMMIT");
      return { record: existing, inserted: false };
    }
    if (input.baselineVersionId && !getGraphQLSchemaVersion(db, input.tenantId, input.sourceKey, input.baselineVersionId)) throw new Error("graphql_schema_baseline_not_found");
    const sourceArtifact = insertArtifactManifest(db, {
      id: input.sourceArtifactId,
      tenantId: input.tenantId,
      kind: `graphql-schema-source:${input.sourceKey}`,
      schemaVersion: 1,
      sha256: sourceSha256,
      mediaType: input.sourceFormat === "sdl" ? "application/graphql" : "application/json",
      sizeBytes: Buffer.byteLength(input.sourceContent, "utf8"),
      storageRef: `db:graphql-source:${input.sourceKey}:${sourceSha256}`,
      content: input.sourceContent,
      createdAt: input.createdAt,
    }).row;
    const record: GraphQLSchemaVersionRecord = {
      schemaVersion: 1,
      id: input.id,
      evidenceId: input.evidenceId,
      tenantId: input.tenantId,
      sourceKey: input.sourceKey,
      versionLabel: input.versionLabel,
      sourceFormat: input.sourceFormat,
      sourceSha256,
      sourceArtifactId: sourceArtifact.id,
      schemaArtifactId: input.schemaArtifactId,
      schema: input.schema,
      baselineVersionId: input.baselineVersionId,
      diff: input.diff,
      createdAt: input.createdAt,
    };
    const content = JSON.stringify(record);
    const schemaArtifact = insertArtifactManifest(db, {
      id: input.schemaArtifactId,
      tenantId: input.tenantId,
      kind: `graphql-schema-version:${input.sourceKey}`,
      schemaVersion: 1,
      sha256: digest(content),
      mediaType: "application/vnd.mendpoint.graphql-schema-version+json",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageRef: `db:graphql-version:${input.sourceKey}:${input.id}`,
      content,
      createdAt: input.createdAt,
    }).row;
    if (schemaArtifact.id !== input.schemaArtifactId) throw new Error("graphql_schema_artifact_identity_conflict");
    insertEvidenceRecord(db, {
      id: input.evidenceId,
      tenantId: input.tenantId,
      subjectType: SUBJECT_TYPE,
      subjectId: input.sourceKey,
      artifactId: schemaArtifact.id,
      inputArtifactId: sourceArtifact.id,
      tool: "@mendpoint/change-intel/graphql",
      toolVersion: "1",
      verdict: "passed",
      createdAt: input.createdAt,
    });
    if (ownsTransaction) db.raw.exec("COMMIT");
    return { record, inserted: true };
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}
