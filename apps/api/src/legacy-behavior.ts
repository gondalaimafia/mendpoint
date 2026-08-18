import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import type { Hono } from "hono";
import {
  appendDomainEvent,
  getConnectedRepository,
  getPrincipal,
  getRepositorySnapshotDeletionStatus,
  insertArtifactManifest,
  insertEvidenceRecord,
  listArtifactManifests,
  listDomainEvents,
  listEvidenceRecords,
  listRepositorySnapshotFiles,
  listRepositorySnapshots,
  verifyDomainEventIntegrity,
  type AppDb,
  type ArtifactManifestRow,
  type RepositorySnapshotRow,
} from "@mendpoint/db";
import {
  collectBsgAnnotations,
  extractLegacyBehavior,
  generateBehaviorDocumentation,
  verifyExtractedBehavioralSpecGraph,
  type BsgEvidenceAssertion,
  type LegacyBehaviorArtifact,
  type LegacyBehaviorCollector,
} from "@mendpoint/transformer";
import { can } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 2_000_000;
const MAX_PATH_CHARS = 1_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/;
const CODE_PATH = /\.(?:[cm]?[jt]sx?|py|rb|php|java|kt|kts|go|rs|cs|swift)$/i;
const TEST_PATH = /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|(?:_test\.(?:py|rb|go)$)/i;
const SCHEMA_PATH = /(?:^|\/)(?:schema|schemas)(?:\/|$)|(?:^|\/)(?:schema|openapi|swagger)\.[^/]+$|\.(?:graphql|gql|sql)$/i;
const BUILTIN_COLLECTOR_VERSION = "1.0.0";
const BUILTIN_COLLECTOR_DIGEST = prefixedDigest("mendpoint:legacy-observable-collector:1.0.0");

type SnapshotFile = Readonly<{
  path: string;
  kind: LegacyBehaviorArtifact["kind"];
  bytes: Buffer;
  text: string;
  sha256: string;
}>;

type PersistedRunPayload = Readonly<{
  runId: string;
  repositoryId: string;
  snapshotId: string;
  revision: string;
  snapshotManifestSha256: string;
  snapshotEvidenceArtifactId: string;
  snapshotEvidenceSha256: string;
  graphArtifactId: string;
  graphArtifactSha256: string;
  graphId: string;
  graphDigest: string;
  documentationArtifactId: string;
  documentationArtifactSha256: string;
  graphEvidenceRecordId: string;
  documentationEvidenceRecordId: string;
  excludedStatementCount: number;
  collectorEvidenceRefs: readonly string[];
}>;

export class LegacyBehaviorApiError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 410 | 413 | 422) {
    super(code);
    this.name = "LegacyBehaviorApiError";
  }
}

function fail(code: string, status: LegacyBehaviorApiError["status"]): never {
  throw new LegacyBehaviorApiError(code, status);
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function prefixedDigest(value: string | Buffer): string {
  return `sha256:${digest(value)}`;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${digest(parts.map((part) => `${part.length}:${part}`).join("" )).slice(0, 32)}`;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredText(value: unknown, code: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) fail(code, 400);
  return value.trim();
}

function classifyPath(path: string): LegacyBehaviorArtifact["kind"] | undefined {
  if (SCHEMA_PATH.test(path)) return "schema";
  if (TEST_PATH.test(path)) return "test";
  if (CODE_PATH.test(path)) return "code";
  return undefined;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function stat(path: string, code: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    fail(code, 409);
  }
}

function storageRoot(snapshot: RepositorySnapshotRow): string {
  if (!snapshot.storage_path.trim() || !isAbsolute(snapshot.storage_path)) {
    fail("legacy_behavior_snapshot_root_invalid", 409);
  }
  const rootStat = stat(snapshot.storage_path, "legacy_behavior_snapshot_root_invalid");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("legacy_behavior_snapshot_root_invalid", 409);
  }
  try {
    return realpathSync(resolve(snapshot.storage_path));
  } catch {
    fail("legacy_behavior_snapshot_root_invalid", 409);
  }
}

function readSnapshotFile(root: string, path: string): Buffer {
  let cursor = root;
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index++) {
    cursor = join(cursor, segments[index]!);
    const entry = stat(cursor, `legacy_behavior_snapshot_file_missing:${path}`);
    if (entry.isSymbolicLink()) fail("legacy_behavior_snapshot_symlink_forbidden", 409);
    if (index < segments.length - 1 && !entry.isDirectory()) {
      fail("legacy_behavior_snapshot_file_invalid", 409);
    }
    if (index === segments.length - 1 && !entry.isFile()) {
      fail("legacy_behavior_snapshot_file_invalid", 409);
    }
  }
  let real: string;
  let bytes: Buffer;
  try {
    real = realpathSync(cursor);
    if (!within(root, real)) fail("legacy_behavior_snapshot_path_escape", 409);
    bytes = readFileSync(real);
  } catch (error) {
    if (error instanceof LegacyBehaviorApiError) throw error;
    fail("legacy_behavior_snapshot_file_unreadable", 409);
  }
  return bytes;
}

function activeSnapshot(
  db: AppDb,
  tenantId: string,
  repositoryId: string,
  snapshotId: string,
  now: string,
): RepositorySnapshotRow {
  const repository = getConnectedRepository(db, repositoryId, tenantId);
  if (!repository) fail("repository_snapshot_not_found", 404);
  const matches = listRepositorySnapshots(db, tenantId, repositoryId)
    .filter((snapshot) => snapshot.id === snapshotId);
  if (matches.length !== 1) fail("repository_snapshot_not_found", 404);
  const snapshot = matches[0]!;
  const deletion = getRepositorySnapshotDeletionStatus(db, tenantId, snapshot.id);
  if (deletion?.status === "planned" || deletion?.status === "deleted") {
    fail("legacy_behavior_snapshot_unavailable", 410);
  }
  if (!SHA256.test(snapshot.manifest_sha256)) fail("legacy_behavior_snapshot_manifest_invalid", 409);
  if (snapshot.file_manifest_version !== 1) fail("legacy_behavior_snapshot_manifest_invalid", 409);
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(snapshot.expires_at);
  if (!Number.isFinite(nowMs)) fail("legacy_behavior_execution_time_invalid", 400);
  if (!Number.isFinite(expiresMs)) fail("legacy_behavior_snapshot_expiry_invalid", 409);
  if (expiresMs <= nowMs) fail("legacy_behavior_snapshot_expired", 410);
  return snapshot;
}

function loadSnapshotFiles(db: AppDb, tenantId: string, snapshot: RepositorySnapshotRow): SnapshotFile[] {
  const selected = listRepositorySnapshotFiles(db, tenantId, snapshot.id)
    .map((row) => ({ row, kind: classifyPath(row.path) }))
    .filter((entry): entry is typeof entry & { kind: LegacyBehaviorArtifact["kind"] } => Boolean(entry.kind));
  if (!selected.length) fail("legacy_behavior_snapshot_sources_missing", 422);
  if (selected.length > MAX_FILES) fail("legacy_behavior_snapshot_file_limit_exceeded", 413);
  let declaredTotal = 0;
  for (const { row } of selected) {
    if (!row.path || row.path.length > MAX_PATH_CHARS || row.kind !== "file" ||
      (row.mode !== "100644" && row.mode !== "100755") ||
      !Number.isSafeInteger(row.size) || row.size < 0 || !SHA256.test(row.sha256)) {
      fail("legacy_behavior_snapshot_manifest_invalid", 409);
    }
    if (row.size > MAX_FILE_BYTES) fail("legacy_behavior_snapshot_file_limit_exceeded", 413);
    declaredTotal += row.size;
    if (declaredTotal > MAX_TOTAL_BYTES) fail("legacy_behavior_snapshot_total_limit_exceeded", 413);
  }

  const root = storageRoot(snapshot);
  const loaded: SnapshotFile[] = [];
  let actualTotal = 0;
  for (const { row, kind } of selected.sort((left, right) => compareCodeUnits(left.row.path, right.row.path))) {
    const bytes = readSnapshotFile(root, row.path);
    if (bytes.byteLength !== row.size) fail("legacy_behavior_snapshot_file_size_mismatch", 409);
    if (digest(bytes) !== row.sha256) fail("legacy_behavior_snapshot_file_hash_mismatch", 409);
    actualTotal += bytes.byteLength;
    if (actualTotal > MAX_TOTAL_BYTES) fail("legacy_behavior_snapshot_total_limit_exceeded", 413);
    let text: string;
    try {
      text = UTF8.decode(bytes).replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n");
    } catch {
      fail("legacy_behavior_snapshot_utf8_invalid", 409);
    }
    loaded.push(Object.freeze({ path: row.path, kind, bytes, text, sha256: row.sha256 }));
  }
  return loaded;
}

function shortKey(prefix: string, locator: string, value: string): string {
  return `${prefix}:${digest(`${locator}\0${value}`).slice(0, 24)}`;
}

function automaticAssertions(
  kind: LegacyBehaviorArtifact["kind"],
  content: string,
  locator: string,
): BsgEvidenceAssertion[] {
  const assertions: BsgEvidenceAssertion[] = [];
  for (const [index, line] of content.split("\n").entries()) {
    const evidenceLocator = `${locator}:${index + 1}`;
    if (kind === "test") {
      const match = line.match(/\b(?:it|test|describe)\s*\(\s*(["'`])([^\n"'`]{1,300})\1/);
      if (match) {
        const title = match[2]!.trim();
        assertions.push({
          key: shortKey("test", evidenceLocator, title),
          kind: "invariant",
          label: `Test ${title}`,
          spec: `Test declares expected behavior: ${title}.`,
          locator: evidenceLocator,
        });
      }
      continue;
    }
    if (kind === "schema") {
      const graphQl = line.match(/^\s*(type|input|enum|interface|scalar|union)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      const sql = line.match(/^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+["`[]?([A-Za-z_][A-Za-z0-9_.-]*)/i);
      if (graphQl) {
        const schemaKind = graphQl[1]!;
        const name = graphQl[2]!;
        assertions.push({
          key: shortKey("schema", evidenceLocator, `${schemaKind}:${name}`),
          kind: "invariant",
          label: `GraphQL ${schemaKind} ${name}`,
          spec: `Schema declares GraphQL ${schemaKind} ${name}.`,
          locator: evidenceLocator,
        });
      } else if (sql) {
        const name = sql[1]!;
        assertions.push({
          key: shortKey("schema", evidenceLocator, `table:${name}`),
          kind: "invariant",
          label: `SQL table ${name}`,
          spec: `Schema declares SQL table ${name}.`,
          locator: evidenceLocator,
        });
      }
      continue;
    }
    const declaration = line.match(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/);
    const route = line.match(/\b(?:app|router|routes)\.(get|post|put|patch|delete)\s*\(\s*(["'`])([^\n"'`]{1,300})\2/i);
    if (declaration) {
      const declarationKind = declaration[1]!;
      const name = declaration[2]!;
      assertions.push({
        key: shortKey("code", evidenceLocator, `${declarationKind}:${name}`),
        kind: declarationKind === "interface" || declarationKind === "type" || declarationKind === "enum"
          ? "invariant"
          : "behavior",
        label: `${declarationKind[0]!.toUpperCase()}${declarationKind.slice(1)} ${name}`,
        spec: `Source declares ${declarationKind} ${name}.`,
        locator: evidenceLocator,
      });
    }
    if (route) {
      const method = route[1]!.toUpperCase();
      const path = route[3]!;
      assertions.push({
        key: shortKey("route", evidenceLocator, `${method}:${path}`),
        kind: "behavior",
        label: `Route ${method} ${path}`,
        spec: `Source registers ${method} ${path}.`,
        locator: evidenceLocator,
      });
    }
  }
  return assertions;
}

const BUILTIN_COLLECTOR: LegacyBehaviorCollector = Object.freeze({
  id: "mendpoint.observable-source",
  version: BUILTIN_COLLECTOR_VERSION,
  digest: BUILTIN_COLLECTOR_DIGEST,
  kinds: Object.freeze(["code", "test", "schema"] as const),
  collect(artifact) {
    const payload = artifact.payload as Readonly<{ text?: unknown }>;
    if (!payload || typeof payload.text !== "string") {
      throw new Error("legacy_behavior_builtin_payload_invalid");
    }
    const explicit = collectBsgAnnotations(payload.text, artifact.locator);
    return Object.freeze({
      assertions: Object.freeze([
        ...explicit.assertions,
        ...automaticAssertions(artifact.kind, payload.text, artifact.locator),
      ]),
      relations: explicit.relations,
    });
  },
});

function artifactContent(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function persistArtifact(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    kind: string;
    mediaType: string;
    content: string;
    principalId: string;
    createdAt: string;
  }>,
): ArtifactManifestRow {
  const contentSha = digest(input.content);
  const id = stableId("legacyart", input.tenantId, input.kind, contentSha);
  return insertArtifactManifest(db, {
    id,
    tenantId: input.tenantId,
    kind: input.kind,
    schemaVersion: 1,
    sha256: contentSha,
    mediaType: input.mediaType,
    sizeBytes: Buffer.byteLength(input.content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${id}#content_text`,
    content: input.content,
    producerPrincipalId: input.principalId,
    createdAt: input.createdAt,
  }).row;
}

function validateStoredArtifact(artifact: ArtifactManifestRow | undefined): ArtifactManifestRow {
  if (!artifact?.content_text || digest(artifact.content_text) !== artifact.sha256 ||
    Buffer.byteLength(artifact.content_text, "utf8") !== artifact.size_bytes) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  return artifact;
}

function validateStoredArtifactAuthority(
  artifact: ArtifactManifestRow,
  input: Readonly<{ kind: string; mediaType: string; producerPrincipalId: string }>,
): void {
  if (artifact.kind !== input.kind || artifact.schema_version !== 1 ||
    artifact.media_type !== input.mediaType ||
    artifact.storage_ref !== `sqlite://artifact_manifests/${artifact.id}#content_text` ||
    artifact.producer_principal_id !== input.producerPrincipalId) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
}

function runResponse(payload: PersistedRunPayload, markdown?: string, graph?: unknown) {
  return {
    id: payload.runId,
    status: "draft" as const,
    snapshot: {
      id: payload.snapshotId,
      repositoryId: payload.repositoryId,
      revision: payload.revision,
      manifestSha256: payload.snapshotManifestSha256,
    },
    graph: graph ?? {
      id: payload.graphId,
      digest: payload.graphDigest,
    },
    documentation: {
      artifactId: payload.documentationArtifactId,
      ...(markdown === undefined ? {} : { markdown }),
      excludedStatementCount: payload.excludedStatementCount,
    },
    evidence: {
      snapshotArtifactId: payload.snapshotEvidenceArtifactId,
      graphArtifactId: payload.graphArtifactId,
      graphEvidenceRecordId: payload.graphEvidenceRecordId,
      documentationEvidenceRecordId: payload.documentationEvidenceRecordId,
      collectorRefs: payload.collectorEvidenceRefs,
    },
    automation: { mayWriteRepository: false as const, mayPublish: false as const },
  };
}

function execute(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    principalId: string;
    repositoryId: string;
    snapshotId: string;
    title: string;
    targetSystem: string;
    now: string;
  }>,
) {
  const snapshot = activeSnapshot(db, input.tenantId, input.repositoryId, input.snapshotId, input.now);
  const repository = getConnectedRepository(db, input.repositoryId, input.tenantId)!;
  const files = loadSnapshotFiles(db, input.tenantId, snapshot);
  const snapshotDigest = `sha256:${snapshot.manifest_sha256}`;
  const artifacts: LegacyBehaviorArtifact[] = files.map((file) => {
    const payload = Object.freeze({ text: file.text });
    return Object.freeze({
      id: stableId("legacysrc", input.tenantId, snapshot.id, file.path, file.sha256),
      tenantId: input.tenantId,
      repositoryId: input.repositoryId,
      snapshotId: snapshot.id,
      revision: snapshot.resolved_sha,
      snapshotDigest,
      kind: file.kind,
      locator: `snapshot://${input.repositoryId}/${snapshot.id}/${file.path}`,
      contentDigest: prefixedDigest(JSON.stringify(payload)),
      observedAt: snapshot.created_at,
      payload,
    });
  });
  const extracted = extractLegacyBehavior({
    policy: {
      enabled: true,
      allowedCollectors: [{
        id: BUILTIN_COLLECTOR.id,
        version: BUILTIN_COLLECTOR.version,
        digest: BUILTIN_COLLECTOR.digest,
      }],
      maxArtifacts: MAX_FILES,
      maxAssertions: 2_000,
      maxRelations: 4_000,
      maxPayloadBytes: MAX_TOTAL_BYTES,
      allowModelInference: false,
    },
    tenantId: input.tenantId,
    title: input.title,
    sourceSystem: `${repository.owner}/${repository.name}@${snapshot.resolved_sha}`,
    targetSystem: input.targetSystem,
    evaluatedAt: snapshot.created_at,
    maxEvidenceAgeMs: 90 * 24 * 60 * 60 * 1_000,
    artifacts,
    collectors: [BUILTIN_COLLECTOR],
  });
  if (extracted.status !== "extracted" || extracted.graph.nodes.length === 0) {
    fail("legacy_behavior_observable_behavior_missing", 422);
  }
  const documentation = generateBehaviorDocumentation({
    policy: { enabled: true, includeInactiveAppendix: false, maxOutputChars: 500_000, maxStatements: 2_000 },
    graph: extracted.graph,
  });
  if (documentation.status !== "drafted") fail("legacy_behavior_documentation_failed", 422);

  const sourceEvidenceContent = artifactContent({
    schemaVersion: 1,
    tenantId: input.tenantId,
    repositoryId: input.repositoryId,
    snapshotId: snapshot.id,
    revision: snapshot.resolved_sha,
    manifestSha256: snapshot.manifest_sha256,
    files: files.map((file) => ({
      path: file.path,
      kind: file.kind,
      size: file.bytes.byteLength,
      sha256: file.sha256,
    })),
  });
  const graphContent = artifactContent(extracted.graph);
  const graphSha = digest(graphContent);
  const documentationSha = digest(documentation.markdown);
  const runId = stableId(
    "legacyrun",
    input.tenantId,
    snapshot.id,
    graphSha,
    documentationSha,
  );
  const payloadSeed = {
    runId,
    repositoryId: input.repositoryId,
    snapshotId: snapshot.id,
    revision: snapshot.resolved_sha,
    snapshotManifestSha256: snapshot.manifest_sha256,
    graphId: extracted.graph.id,
    graphDigest: extracted.graph.digest,
    excludedStatementCount: documentation.excludedStatementCount,
    collectorEvidenceRefs: extracted.collectorEvidenceRefs,
  };

  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const snapshotEvidence = persistArtifact(db, {
      tenantId: input.tenantId,
      kind: "legacy-behavior-snapshot-evidence",
      mediaType: "application/vnd.mendpoint.legacy-snapshot-evidence+json",
      content: sourceEvidenceContent,
      principalId: input.principalId,
      createdAt: input.now,
    });
    const graphArtifact = persistArtifact(db, {
      tenantId: input.tenantId,
      kind: "legacy-behavior-graph",
      mediaType: "application/vnd.mendpoint.behavior-graph+json",
      content: graphContent,
      principalId: input.principalId,
      createdAt: input.now,
    });
    const documentationArtifact = persistArtifact(db, {
      tenantId: input.tenantId,
      kind: "legacy-behavior-documentation-draft",
      mediaType: "text/markdown; charset=utf-8",
      content: documentation.markdown,
      principalId: input.principalId,
      createdAt: input.now,
    });
    const graphEvidenceRecordId = stableId("legacyevd", input.tenantId, graphArtifact.id, snapshotEvidence.id);
    const documentationEvidenceRecordId = stableId(
      "legacyevd",
      input.tenantId,
      documentationArtifact.id,
      graphArtifact.id,
    );
    insertEvidenceRecord(db, {
      id: graphEvidenceRecordId,
      tenantId: input.tenantId,
      subjectType: "repository_snapshot",
      subjectId: snapshot.id,
      artifactId: graphArtifact.id,
      inputArtifactId: snapshotEvidence.id,
      producerPrincipalId: input.principalId,
      tool: BUILTIN_COLLECTOR.id,
      toolVersion: BUILTIN_COLLECTOR.version,
      commitSha: snapshot.resolved_sha,
      // Graph extraction runs no verification, so its honest verdict is "unknown":
      // this record attests that the graph artifact was produced, not that it
      // passed any check. Asserting "passed" here would be a verdict never computed.
      verdict: "unknown",
      createdAt: input.now,
    });
    insertEvidenceRecord(db, {
      id: documentationEvidenceRecordId,
      tenantId: input.tenantId,
      subjectType: "legacy_behavior_graph",
      subjectId: extracted.graph.id,
      artifactId: documentationArtifact.id,
      inputArtifactId: graphArtifact.id,
      producerPrincipalId: input.principalId,
      tool: "mendpoint.behavior-documentation",
      toolVersion: "1.0.0",
      commitSha: snapshot.resolved_sha,
      // The documentation draft is unverified generated prose, so its honest
      // verdict is "unknown": the record attests the draft was produced, not that
      // it was checked. Asserting "passed" would claim a verdict never computed.
      verdict: "unknown",
      createdAt: input.now,
    });
    const payload: PersistedRunPayload = Object.freeze({
      ...payloadSeed,
      snapshotEvidenceArtifactId: snapshotEvidence.id,
      snapshotEvidenceSha256: snapshotEvidence.sha256,
      graphArtifactId: graphArtifact.id,
      graphArtifactSha256: graphArtifact.sha256,
      documentationArtifactId: documentationArtifact.id,
      documentationArtifactSha256: documentationArtifact.sha256,
      graphEvidenceRecordId,
      documentationEvidenceRecordId,
    });
    appendDomainEvent(db, {
      id: stableId("legacyevt", input.tenantId, runId),
      tenantId: input.tenantId,
      schemaVersion: 1,
      eventType: "legacy_behavior.documentation_drafted",
      aggregateType: "legacy_behavior_extraction",
      aggregateId: runId,
      actorPrincipalId: input.principalId,
      correlationId: runId,
      idempotencyKey: `legacy-behavior:${runId}`,
      payload,
      createdAt: input.now,
    });
    db.raw.exec("COMMIT");
    return {
      ...runResponse(payload),
      graph: {
        id: extracted.graph.id,
        digest: extracted.graph.digest,
        nodeCount: extracted.graph.nodes.length,
        edgeCount: extracted.graph.edges.length,
      },
    };
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function parseRunPayload(value: string): PersistedRunPayload {
  let payload: unknown;
  try {
    payload = JSON.parse(value);
  } catch {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  if (!payload || typeof payload !== "object") fail("legacy_behavior_persisted_artifact_corrupt", 409);
  const record = payload as Record<string, unknown>;
  const strings = [
    "runId", "repositoryId", "snapshotId", "revision", "snapshotManifestSha256",
    "snapshotEvidenceArtifactId", "snapshotEvidenceSha256", "graphArtifactId",
    "graphArtifactSha256", "graphId", "graphDigest", "documentationArtifactId",
    "documentationArtifactSha256", "graphEvidenceRecordId", "documentationEvidenceRecordId",
  ];
  if (strings.some((key) => typeof record[key] !== "string") ||
    !Number.isSafeInteger(record.excludedStatementCount) ||
    !Array.isArray(record.collectorEvidenceRefs) ||
    record.collectorEvidenceRefs.some((value) => typeof value !== "string")) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  return payload as PersistedRunPayload;
}

function retrieve(db: AppDb, tenantId: string, runId: string) {
  const integrity = verifyDomainEventIntegrity(db, tenantId);
  if (!integrity.ok) fail("legacy_behavior_persisted_artifact_corrupt", 409);
  const events = listDomainEvents(db, tenantId, "legacy_behavior_extraction", runId);
  if (events.length === 0) fail("legacy_behavior_extraction_not_found", 404);
  if (events.length !== 1) fail("legacy_behavior_persisted_artifact_corrupt", 409);
  const event = events[0]!;
  if (event.schema_version !== 1 || event.event_type !== "legacy_behavior.documentation_drafted" ||
    event.aggregate_type !== "legacy_behavior_extraction" || event.aggregate_id !== runId ||
    event.correlation_id !== runId || event.idempotency_key !== `legacy-behavior:${runId}`) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  const payload = parseRunPayload(event.payload_json);
  if (payload.runId !== runId) fail("legacy_behavior_persisted_artifact_corrupt", 409);
  const artifacts = listArtifactManifests(db, tenantId);
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const snapshotArtifact = validateStoredArtifact(byId.get(payload.snapshotEvidenceArtifactId));
  const graphArtifact = validateStoredArtifact(byId.get(payload.graphArtifactId));
  const documentationArtifact = validateStoredArtifact(byId.get(payload.documentationArtifactId));
  if (snapshotArtifact.sha256 !== payload.snapshotEvidenceSha256 ||
    graphArtifact.sha256 !== payload.graphArtifactSha256 ||
    documentationArtifact.sha256 !== payload.documentationArtifactSha256) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  validateStoredArtifactAuthority(snapshotArtifact, {
    kind: "legacy-behavior-snapshot-evidence",
    mediaType: "application/vnd.mendpoint.legacy-snapshot-evidence+json",
    producerPrincipalId: event.actor_principal_id,
  });
  validateStoredArtifactAuthority(graphArtifact, {
    kind: "legacy-behavior-graph",
    mediaType: "application/vnd.mendpoint.behavior-graph+json",
    producerPrincipalId: event.actor_principal_id,
  });
  validateStoredArtifactAuthority(documentationArtifact, {
    kind: "legacy-behavior-documentation-draft",
    mediaType: "text/markdown; charset=utf-8",
    producerPrincipalId: event.actor_principal_id,
  });
  let graph;
  try {
    graph = verifyExtractedBehavioralSpecGraph(JSON.parse(graphArtifact.content_text!));
  } catch {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  if (graph.id !== payload.graphId || graph.digest !== payload.graphDigest) {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  const graphEvidence = listEvidenceRecords(db, tenantId, "repository_snapshot", payload.snapshotId)
    .find((record) => record.id === payload.graphEvidenceRecordId);
  const docsEvidence = listEvidenceRecords(db, tenantId, "legacy_behavior_graph", payload.graphId)
    .find((record) => record.id === payload.documentationEvidenceRecordId);
  // Extraction and draft evidence run no verification, so replay must confirm the
  // honest "unknown" verdict was persisted, not "passed". Any other value (a
  // "passed" claimed for output that was never checked, or a rewritten verdict) is
  // the corruption this integrity check exists to catch, so it fails closed.
  if (!graphEvidence || graphEvidence.artifact_id !== graphArtifact.id ||
    graphEvidence.input_artifact_id !== payload.snapshotEvidenceArtifactId ||
    graphEvidence.producer_principal_id !== event.actor_principal_id ||
    graphEvidence.tool !== BUILTIN_COLLECTOR.id ||
    graphEvidence.tool_version !== BUILTIN_COLLECTOR.version ||
    graphEvidence.commit_sha !== payload.revision ||
    graphEvidence.verdict !== "unknown" || !docsEvidence ||
    docsEvidence.artifact_id !== documentationArtifact.id ||
    docsEvidence.input_artifact_id !== graphArtifact.id ||
    docsEvidence.producer_principal_id !== event.actor_principal_id ||
    docsEvidence.tool !== "mendpoint.behavior-documentation" ||
    docsEvidence.tool_version !== "1.0.0" || docsEvidence.commit_sha !== payload.revision ||
    docsEvidence.verdict !== "unknown") {
    fail("legacy_behavior_persisted_artifact_corrupt", 409);
  }
  return runResponse(payload, documentationArtifact.content_text!, graph);
}

export function registerLegacyBehaviorRoutes(
  app: Hono<ApiEnv>,
  db: AppDb,
  options: Readonly<{ enabled?: boolean; now?: () => string }> = {},
): void {
  const enabled = options.enabled === true;
  const now = options.now ?? (() => new Date().toISOString());

  const mount = (base: string): void => {
  app.post(`${base}/legacy-behavior/extractions`, async (c) => {
    const principal = c.get("principal");
    const tenantId = principal?.tenantId;
    const trustPrincipalId = c.get("trustPrincipalId");
    if (!tenantId || !trustPrincipalId || !getPrincipal(db, tenantId, trustPrincipalId)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    if (!principal || !can(principal, "graph:write")) return c.json({ error: "forbidden" }, 403);
    if (!enabled) return c.json({ error: "legacy_behavior_extraction_disabled" }, 404);
    const parsedBody: unknown = await c.req.json<unknown>().catch(() => ({}));
    const body: Record<string, unknown> = parsedBody && typeof parsedBody === "object" &&
      !Array.isArray(parsedBody)
      ? parsedBody as Record<string, unknown>
      : {};
    try {
      const result = execute(db, {
        tenantId,
        principalId: trustPrincipalId,
        repositoryId: requiredText(body.repositoryId, "repository_id_required", 500),
        snapshotId: requiredText(body.snapshotId, "snapshot_id_required", 500),
        title: requiredText(body.title, "legacy_behavior_title_required", 500),
        targetSystem: requiredText(body.targetSystem, "legacy_behavior_target_system_required", 500),
        now: now(),
      });
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json(result, 201);
    } catch (error) {
      if (error instanceof LegacyBehaviorApiError) return c.json({ error: error.code }, error.status);
      const code = error instanceof Error && /^legacy_behavior_|^bsg_|^behavior_documentation_/.test(error.message)
        ? error.message
        : "legacy_behavior_extraction_failed";
      return c.json({ error: code }, 422);
    }
  });

  app.get(`${base}/legacy-behavior/extractions/:id`, (c) => {
    const principal = c.get("principal");
    const tenantId = principal?.tenantId;
    if (!tenantId || !c.get("trustPrincipalId")) return c.json({ error: "unauthorized" }, 401);
    if (!principal || !can(principal, "graph:read")) return c.json({ error: "forbidden" }, 403);
    if (!enabled) return c.json({ error: "legacy_behavior_extraction_disabled" }, 404);
    try {
      const result = retrieve(db, tenantId, c.req.param("id"));
      c.header("Cache-Control", "private, no-store, max-age=0");
      return c.json(result);
    } catch (error) {
      if (error instanceof LegacyBehaviorApiError) return c.json({ error: error.code }, error.status);
      return c.json({ error: "legacy_behavior_retrieval_failed" }, 500);
    }
  });
  };
  // Canonical (Regauge) paths plus the legacy /transformer aliases (kept forever
  // for external/legacy callers). Both register the same handlers.
  mount("/regauge");
  mount("/transformer");
}
