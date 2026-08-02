import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const CHANGE_TAXONOMY_VERSION = "2026-08-02" as const;

export const CHANGE_TAXONOMY_KINDS = [
  "endpoint",
  "field",
  "enum",
  "constraint",
  "type",
  "format",
  "status",
  "header",
  "server",
  "security",
  "behavioral",
  "deprecation",
] as const;

export type ChangeTaxonomyKind = (typeof CHANGE_TAXONOMY_KINDS)[number];
export type UnifiedChangeSourceKind =
  | "openapi_upload"
  | "poll"
  | "feed"
  | "release"
  | "sdk_registry"
  | "provider_announcement"
  | "customer_incident";

export type TaxonomySignal = Readonly<{
  kind: ChangeTaxonomyKind;
  subject: string;
  before: unknown;
  after: unknown;
  breaking: boolean;
  evidenceLocation: string;
}>;

export type UnifiedSourceArtifact = Readonly<{
  id: string;
  tenantId: string;
  sourceKind: UnifiedChangeSourceKind;
  sourceUri: string;
  providerSlug: string;
  sourceRevision: string | null;
  contentSha256: string;
  contentType: string;
  content: string;
  observedAt: string;
  capturedAt: string;
  capturedBy: string;
  taxonomyVersion: typeof CHANGE_TAXONOMY_VERSION;
  taxonomySignals: readonly TaxonomySignal[];
  createdAt: string;
}>;

export type UnifiedSourceInput = Readonly<{
  id?: string;
  tenantId: string;
  sourceKind: UnifiedChangeSourceKind;
  sourceUri: string;
  providerSlug: string;
  sourceRevision?: string | null;
  contentType: string;
  content: string | Readonly<Record<string, unknown>>;
  observedAt: string;
  capturedAt: string;
  capturedBy: string;
  taxonomySignals?: readonly TaxonomySignal[];
  createdAt?: string;
}>;

export type MonitorSchedule = Readonly<{
  id: string;
  tenantId: string;
  sourceUri: string;
  sourceKind: Exclude<UnifiedChangeSourceKind, "openapi_upload" | "provider_announcement" | "customer_incident">;
  intervalSeconds: number;
  maxStalenessSeconds: number;
  enabled: boolean;
  createdAt: string;
}>;

export type MonitorObservation = Readonly<{
  sequence: number;
  status: "success" | "error";
  observedAt: string;
  artifactId: string | null;
  errorCode: string | null;
}>;

export type MonitorHealth = Readonly<{
  schedule: MonitorSchedule;
  state: "healthy" | "degraded" | "stale" | "never_observed" | "disabled";
  lastObservation: MonitorObservation | null;
  staleAt: string | null;
  operatorActionRequired: boolean;
}>;

export type UnifiedChangeEvidenceStore = Readonly<{
  raw: DatabaseSync;
  path: string;
  close: () => void;
}>;

type ArtifactRow = {
  id: string; tenant_id: string; source_kind: UnifiedChangeSourceKind; source_uri: string;
  provider_slug: string; source_revision: string | null; content_sha256: string;
  content_type: string; content: string; observed_at: string; captured_at: string;
  captured_by: string; taxonomy_version: typeof CHANGE_TAXONOMY_VERSION;
  taxonomy_signals_json: string; created_at: string;
};

type ScheduleRow = {
  id: string; tenant_id: string; source_uri: string; source_kind: MonitorSchedule["sourceKind"];
  interval_seconds: number; max_staleness_seconds: number; enabled: number; created_at: string;
};

type ObservationRow = {
  sequence: number; status: MonitorObservation["status"]; observed_at: string;
  artifact_id: string | null; error_code: string | null;
};

const HASH = /^[a-f0-9]{64}$/;
const SAFE_URN = /^urn:mendpoint:source:[a-zA-Z0-9._:/-]{1,512}$/;
const BLOCKED_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;
const SENSITIVE_QUERY = /^(?:access_?token|api_?key|authorization|credential|password|private_?key|secret|signature|token)$/i;

const MIGRATION = `
CREATE TABLE unified_change_source_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  provider_slug TEXT NOT NULL,
  source_revision TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  captured_by TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_signals_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, source_kind, source_uri, content_sha256),
  UNIQUE (id, tenant_id)
);
CREATE INDEX unified_change_source_artifacts_tenant_idx
  ON unified_change_source_artifacts(tenant_id, observed_at DESC, id);

CREATE TABLE change_source_monitor_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds >= 60),
  max_staleness_seconds INTEGER NOT NULL CHECK (max_staleness_seconds >= interval_seconds),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (id, tenant_id)
);
CREATE TABLE change_source_monitor_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  observed_at TEXT NOT NULL,
  artifact_id TEXT,
  error_code TEXT,
  UNIQUE (tenant_id, schedule_id, sequence),
  FOREIGN KEY (schedule_id, tenant_id) REFERENCES change_source_monitor_schedules(id, tenant_id),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES unified_change_source_artifacts(id, tenant_id)
);
CREATE TRIGGER unified_artifacts_no_update BEFORE UPDATE ON unified_change_source_artifacts
BEGIN SELECT RAISE(ABORT, 'unified_change_source_artifacts_append_only'); END;
CREATE TRIGGER unified_artifacts_no_delete BEFORE DELETE ON unified_change_source_artifacts
BEGIN SELECT RAISE(ABORT, 'unified_change_source_artifacts_append_only'); END;
CREATE TRIGGER monitor_schedules_no_update BEFORE UPDATE ON change_source_monitor_schedules
BEGIN SELECT RAISE(ABORT, 'change_source_monitor_schedules_append_only'); END;
CREATE TRIGGER monitor_schedules_no_delete BEFORE DELETE ON change_source_monitor_schedules
BEGIN SELECT RAISE(ABORT, 'change_source_monitor_schedules_append_only'); END;
CREATE TRIGGER monitor_observations_no_update BEFORE UPDATE ON change_source_monitor_observations
BEGIN SELECT RAISE(ABORT, 'change_source_monitor_observations_append_only'); END;
CREATE TRIGGER monitor_observations_no_delete BEFORE DELETE ON change_source_monitor_observations
BEGIN SELECT RAISE(ABORT, 'change_source_monitor_observations_append_only'); END;
`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
  return value;
}

function canonicalJson(value: unknown): string { return JSON.stringify(canonicalize(value)); }
function sha256(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function required(name: string, value: unknown, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${name}_required`);
  const text = value.trim();
  if (!text || text.length > max) throw new Error(`${name}_invalid`);
  return text;
}
function timestamp(name: string, value: unknown): string {
  const text = required(name, value, 64);
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${name}_invalid`);
  return new Date(text).toISOString();
}
function safeUri(value: unknown): string {
  const text = required("change_artifact_source_uri", value, 2048);
  if (SAFE_URN.test(text)) return text;
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error("change_artifact_source_uri_unsafe"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || BLOCKED_HOST.test(parsed.hostname) ||
      [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) {
    throw new Error("change_artifact_source_uri_unsafe");
  }
  return parsed.toString();
}
function one<T>(store: UnifiedChangeEvidenceStore, sql: string, params: SQLInputValue[] = []): T | undefined {
  return store.raw.prepare(sql).get(...params) as T | undefined;
}
function all<T>(store: UnifiedChangeEvidenceStore, sql: string, params: SQLInputValue[] = []): T[] {
  return store.raw.prepare(sql).all(...params) as T[];
}
function taxonomySignals(value: unknown): TaxonomySignal[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error("change_taxonomy_signals_invalid");
  const kinds = new Set<string>(CHANGE_TAXONOMY_KINDS);
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("change_taxonomy_signal_invalid");
    const item = raw as Record<string, unknown>;
    const kind = required("change_taxonomy_kind", item.kind, 32);
    if (!kinds.has(kind)) throw new Error("change_taxonomy_kind_invalid");
    if (typeof item.breaking !== "boolean") throw new Error("change_taxonomy_breaking_invalid");
    return Object.freeze({
      kind: kind as ChangeTaxonomyKind,
      subject: required("change_taxonomy_subject", item.subject, 1024),
      before: canonicalize(item.before ?? null),
      after: canonicalize(item.after ?? null),
      breaking: item.breaking,
      evidenceLocation: required("change_taxonomy_evidence_location", item.evidenceLocation, 1024),
    });
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.subject.localeCompare(b.subject));
}

function rowToArtifact(row: ArtifactRow): UnifiedSourceArtifact {
  const signals = taxonomySignals(JSON.parse(row.taxonomy_signals_json));
  if (!HASH.test(row.content_sha256)) throw new Error("change_artifact_hash_corrupt");
  return Object.freeze({
    id: row.id, tenantId: row.tenant_id, sourceKind: row.source_kind, sourceUri: row.source_uri,
    providerSlug: row.provider_slug, sourceRevision: row.source_revision, contentSha256: row.content_sha256,
    contentType: row.content_type, content: row.content, observedAt: row.observed_at,
    capturedAt: row.captured_at, capturedBy: row.captured_by, taxonomyVersion: row.taxonomy_version,
    taxonomySignals: Object.freeze(signals), createdAt: row.created_at,
  });
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

type OpenApiFact = Readonly<{ kind: ChangeTaxonomyKind; subject: string; value: unknown; location: string }>;

function openApiFacts(document: unknown): OpenApiFact[] {
  const root = objectValue(document);
  const facts: OpenApiFact[] = [];
  const add = (kind: ChangeTaxonomyKind, subject: string, value: unknown, location: string): void => {
    facts.push({ kind, subject, value: canonicalize(value), location });
  };
  for (const [index, server] of (Array.isArray(root.servers) ? root.servers : []).entries()) {
    add("server", `server:${index}`, objectValue(server).url ?? null, `servers[${index}].url`);
  }
  add("security", "root", root.security ?? null, "security");
  const paths = objectValue(root.paths);
  for (const path of Object.keys(paths).sort()) {
    const pathItem = objectValue(paths[path]);
    for (const method of ["get", "post", "put", "patch", "delete", "head", "options"] as const) {
      if (!(method in pathItem)) continue;
      const operation = objectValue(pathItem[method]);
      const operationKey = `${method.toUpperCase()} ${path}`;
      add("endpoint", operationKey, true, `paths[${JSON.stringify(path)}].${method}`);
      add("deprecation", operationKey, operation.deprecated === true, `paths[${JSON.stringify(path)}].${method}.deprecated`);
      add("security", operationKey, operation.security ?? root.security ?? null, `paths[${JSON.stringify(path)}].${method}.security`);
      if ("x-mendpoint-behavior" in operation) add("behavioral", operationKey, operation["x-mendpoint-behavior"], `paths[${JSON.stringify(path)}].${method}.x-mendpoint-behavior`);
      const parameters = Array.isArray(operation.parameters) ? operation.parameters : [];
      for (const [index, rawParameter] of parameters.entries()) {
        const parameter = objectValue(rawParameter);
        const name = String(parameter.name ?? index);
        if (parameter.in === "header") add("header", `${operationKey}:request:${name}`, parameter, `paths[${JSON.stringify(path)}].${method}.parameters[${index}]`);
      }
      const requestSchema = objectValue(objectValue(objectValue(operation.requestBody).content)["application/json"]);
      collectSchemaFacts(objectValue(requestSchema.schema), `${operationKey}:request`, `paths[${JSON.stringify(path)}].${method}.requestBody.content.application/json.schema`, add);
      const responses = objectValue(operation.responses);
      for (const status of Object.keys(responses).sort()) {
        const response = objectValue(responses[status]);
        add("status", `${operationKey}:${status}`, true, `paths[${JSON.stringify(path)}].${method}.responses[${JSON.stringify(status)}]`);
        for (const [name, header] of Object.entries(objectValue(response.headers))) {
          add("header", `${operationKey}:response:${status}:${name}`, header, `paths[${JSON.stringify(path)}].${method}.responses[${JSON.stringify(status)}].headers[${JSON.stringify(name)}]`);
        }
        const responseSchema = objectValue(objectValue(objectValue(response.content)["application/json"]).schema);
        collectSchemaFacts(responseSchema, `${operationKey}:response:${status}`, `paths[${JSON.stringify(path)}].${method}.responses[${JSON.stringify(status)}].content.application/json.schema`, add);
      }
    }
  }
  return facts;
}

function collectSchemaFacts(
  schema: Record<string, unknown>,
  prefix: string,
  location: string,
  add: (kind: ChangeTaxonomyKind, subject: string, value: unknown, location: string) => void,
): void {
  for (const [name, rawProperty] of Object.entries(objectValue(schema.properties))) {
    const property = objectValue(rawProperty);
    const subject = `${prefix}:${name}`;
    const propertyLocation = `${location}.properties[${JSON.stringify(name)}]`;
    add("field", subject, { present: true, required: Array.isArray(schema.required) && schema.required.includes(name) }, propertyLocation);
    if ("type" in property) add("type", subject, property.type, `${propertyLocation}.type`);
    if ("format" in property) add("format", subject, property.format, `${propertyLocation}.format`);
    if (Array.isArray(property.enum)) add("enum", subject, property.enum, `${propertyLocation}.enum`);
    const constraints = Object.fromEntries(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems", "maxItems", "pattern"]
      .filter((key) => key in property).map((key) => [key, property[key]]));
    if (Object.keys(constraints).length) add("constraint", subject, constraints, propertyLocation);
  }
}

/** Produce a complete, versioned taxonomy diff from two parsed OpenAPI documents. */
export function taxonomySignalsFromOpenApi(previous: unknown, current: unknown): TaxonomySignal[] {
  const before = new Map(openApiFacts(previous).map((fact) => [`${fact.kind}\0${fact.subject}`, fact]));
  const after = new Map(openApiFacts(current).map((fact) => [`${fact.kind}\0${fact.subject}`, fact]));
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return taxonomySignals(keys.flatMap((key) => {
    const oldFact = before.get(key);
    const newFact = after.get(key);
    if (oldFact && newFact && canonicalJson(oldFact.value) === canonicalJson(newFact.value)) return [];
    const fact = newFact ?? oldFact!;
    const removed = Boolean(oldFact && !newFact);
    return [{
      kind: fact.kind,
      subject: fact.subject,
      before: oldFact?.value ?? null,
      after: newFact?.value ?? null,
      breaking: removed || (Boolean(oldFact && newFact) && fact.kind !== "endpoint"),
      evidenceLocation: fact.location,
    }];
  }));
}

/** Parse an OpenAPI upload and bind its taxonomy observations into the shared envelope. */
export function normalizeOpenApiSourceInput(
  input: Omit<UnifiedSourceInput, "sourceKind" | "contentType" | "content" | "taxonomySignals"> & {
    content: string;
    previousContent?: string | null;
  },
): UnifiedSourceInput {
  let current: unknown;
  let previous: unknown = {};
  try { current = JSON.parse(input.content); } catch { throw new Error("openapi_upload_json_invalid"); }
  if (input.previousContent) {
    try { previous = JSON.parse(input.previousContent); } catch { throw new Error("openapi_previous_json_invalid"); }
  }
  const root = objectValue(current);
  if (typeof root.openapi !== "string" || !Object.keys(objectValue(root.paths)).length) throw new Error("openapi_upload_document_invalid");
  return Object.freeze({ ...input, sourceKind: "openapi_upload", contentType: "application/openapi+json", content: input.content, taxonomySignals: Object.freeze(taxonomySignalsFromOpenApi(previous, current)) });
}

export function openUnifiedChangeEvidenceStore(dbPath = ":memory:"): UnifiedChangeEvidenceStore {
  const path = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  raw.exec("CREATE TABLE IF NOT EXISTS unified_change_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  const version = Number((raw.prepare("SELECT MAX(version) AS version FROM unified_change_schema_migrations").get() as { version: number | null }).version ?? 0);
  if (version > 1) throw new Error("unified_change_schema_newer_than_runtime");
  if (version === 0) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(MIGRATION);
      raw.prepare("INSERT INTO unified_change_schema_migrations(version, applied_at) VALUES (1, ?)").run(new Date().toISOString());
      raw.exec("COMMIT");
    } catch (error) { raw.exec("ROLLBACK"); throw error; }
  }
  return Object.freeze({ raw, path, close: () => raw.close() });
}

export function createUnifiedSourceArtifact(store: UnifiedChangeEvidenceStore, input: UnifiedSourceInput): UnifiedSourceArtifact {
  const tenantId = required("change_artifact_tenant_id", input.tenantId, 256);
  const sourceKind = required("change_artifact_source_kind", input.sourceKind, 64) as UnifiedChangeSourceKind;
  const allowedKinds = new Set<string>(["openapi_upload", "poll", "feed", "release", "sdk_registry", "provider_announcement", "customer_incident"]);
  if (!allowedKinds.has(sourceKind)) throw new Error("change_artifact_source_kind_invalid");
  const sourceUri = safeUri(input.sourceUri);
  const content = typeof input.content === "string" ? input.content : canonicalJson(input.content);
  if (!content || Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("change_artifact_content_invalid");
  const observedAt = timestamp("change_artifact_observed_at", input.observedAt);
  const capturedAt = timestamp("change_artifact_captured_at", input.capturedAt);
  if (Date.parse(capturedAt) < Date.parse(observedAt)) throw new Error("change_artifact_provenance_time_invalid");
  const signals = taxonomySignals(input.taxonomySignals ?? []);
  const digest = sha256(content);
  const id = input.id === undefined ? `csa_${sha256(`${tenantId}\0${sourceKind}\0${sourceUri}\0${digest}`).slice(0, 32)}` : required("change_artifact_id", input.id, 256);
  const row = {
    id, tenantId, sourceKind, sourceUri, providerSlug: required("change_artifact_provider_slug", input.providerSlug, 128).toLowerCase(),
    sourceRevision: input.sourceRevision == null ? null : required("change_artifact_source_revision", input.sourceRevision, 512),
    contentSha256: digest, contentType: required("change_artifact_content_type", input.contentType, 128).toLowerCase(), content,
    observedAt, capturedAt, capturedBy: required("change_artifact_captured_by", input.capturedBy, 256),
    taxonomyVersion: CHANGE_TAXONOMY_VERSION, taxonomySignals: signals,
    createdAt: timestamp("change_artifact_created_at", input.createdAt ?? capturedAt),
  } as const;
  const existing = one<ArtifactRow>(store, `SELECT * FROM unified_change_source_artifacts
    WHERE tenant_id = ? AND source_kind = ? AND source_uri = ? AND content_sha256 = ?`, [tenantId, sourceKind, sourceUri, digest]);
  if (existing) {
    const artifact = rowToArtifact(existing);
    if (canonicalJson(artifact.taxonomySignals) !== canonicalJson(signals) || artifact.providerSlug !== row.providerSlug || artifact.sourceRevision !== row.sourceRevision) {
      throw new Error("change_artifact_identity_conflict");
    }
    return artifact;
  }
  store.raw.prepare(`INSERT INTO unified_change_source_artifacts
    (id, tenant_id, source_kind, source_uri, provider_slug, source_revision, content_sha256, content_type,
     content, observed_at, captured_at, captured_by, taxonomy_version, taxonomy_signals_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.tenantId, row.sourceKind, row.sourceUri, row.providerSlug, row.sourceRevision,
      row.contentSha256, row.contentType, row.content, row.observedAt, row.capturedAt, row.capturedBy,
      row.taxonomyVersion, canonicalJson(row.taxonomySignals), row.createdAt,
    );
  return getUnifiedSourceArtifact(store, tenantId, id)!;
}

export function getUnifiedSourceArtifact(store: UnifiedChangeEvidenceStore, tenantId: string, id: string): UnifiedSourceArtifact | null {
  const row = one<ArtifactRow>(store, "SELECT * FROM unified_change_source_artifacts WHERE tenant_id = ? AND id = ?", [required("change_artifact_tenant_id", tenantId, 256), required("change_artifact_id", id, 256)]);
  return row ? rowToArtifact(row) : null;
}

export function listUnifiedSourceArtifacts(store: UnifiedChangeEvidenceStore, tenantId: string): UnifiedSourceArtifact[] {
  return all<ArtifactRow>(store, "SELECT * FROM unified_change_source_artifacts WHERE tenant_id = ? ORDER BY observed_at, id", [required("change_artifact_tenant_id", tenantId, 256)]).map(rowToArtifact);
}

export function registerMonitorSchedule(store: UnifiedChangeEvidenceStore, input: Omit<MonitorSchedule, "createdAt"> & { createdAt?: string }): MonitorSchedule {
  const kind = input.sourceKind;
  if (["openapi_upload", "provider_announcement", "customer_incident"].includes(kind)) throw new Error("monitor_source_kind_invalid");
  if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60 || !Number.isInteger(input.maxStalenessSeconds) || input.maxStalenessSeconds < input.intervalSeconds) throw new Error("monitor_schedule_invalid");
  const schedule = Object.freeze({
    id: required("monitor_id", input.id, 256), tenantId: required("monitor_tenant_id", input.tenantId, 256),
    sourceUri: safeUri(input.sourceUri), sourceKind: kind, intervalSeconds: input.intervalSeconds,
    maxStalenessSeconds: input.maxStalenessSeconds, enabled: input.enabled,
    createdAt: timestamp("monitor_created_at", input.createdAt ?? new Date().toISOString()),
  });
  store.raw.prepare(`INSERT INTO change_source_monitor_schedules
    (id, tenant_id, source_uri, source_kind, interval_seconds, max_staleness_seconds, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(schedule.id, schedule.tenantId, schedule.sourceUri, schedule.sourceKind, schedule.intervalSeconds, schedule.maxStalenessSeconds, schedule.enabled ? 1 : 0, schedule.createdAt);
  return schedule;
}

export function recordMonitorObservation(store: UnifiedChangeEvidenceStore, input: Readonly<{
  tenantId: string; scheduleId: string; status: MonitorObservation["status"]; observedAt: string;
  artifactId?: string | null; errorCode?: string | null;
}>): MonitorObservation {
  const tenantId = required("monitor_tenant_id", input.tenantId, 256);
  const scheduleId = required("monitor_id", input.scheduleId, 256);
  const schedule = one<ScheduleRow>(store, "SELECT * FROM change_source_monitor_schedules WHERE tenant_id = ? AND id = ?", [tenantId, scheduleId]);
  if (!schedule) throw new Error("monitor_not_found");
  const observedAt = timestamp("monitor_observed_at", input.observedAt);
  const artifactId = input.artifactId == null ? null : required("monitor_artifact_id", input.artifactId, 256);
  if (input.status === "success" && !artifactId) throw new Error("monitor_success_artifact_required");
  if (input.status === "error" && artifactId) throw new Error("monitor_error_artifact_forbidden");
  const errorCode = input.status === "error" ? required("monitor_error_code", input.errorCode, 128) : null;
  if (artifactId && !getUnifiedSourceArtifact(store, tenantId, artifactId)) throw new Error("monitor_artifact_not_found");
  const last = one<ObservationRow>(store, "SELECT * FROM change_source_monitor_observations WHERE tenant_id = ? AND schedule_id = ? ORDER BY sequence DESC LIMIT 1", [tenantId, scheduleId]);
  if (last && Date.parse(observedAt) <= Date.parse(last.observed_at)) throw new Error("monitor_observation_time_not_monotonic");
  const sequence = (last?.sequence ?? 0) + 1;
  const id = `mobs_${sha256(`${tenantId}\0${scheduleId}\0${sequence}\0${observedAt}`)}`;
  store.raw.prepare(`INSERT INTO change_source_monitor_observations
    (id, tenant_id, schedule_id, sequence, status, observed_at, artifact_id, error_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, tenantId, scheduleId, sequence, input.status, observedAt, artifactId, errorCode);
  return Object.freeze({ sequence, status: input.status, observedAt, artifactId, errorCode });
}

export function getMonitorHealth(store: UnifiedChangeEvidenceStore, tenantIdInput: string, scheduleIdInput: string, nowInput: string): MonitorHealth {
  const tenantId = required("monitor_tenant_id", tenantIdInput, 256);
  const scheduleId = required("monitor_id", scheduleIdInput, 256);
  const now = timestamp("monitor_health_now", nowInput);
  const row = one<ScheduleRow>(store, "SELECT * FROM change_source_monitor_schedules WHERE tenant_id = ? AND id = ?", [tenantId, scheduleId]);
  if (!row) throw new Error("monitor_not_found");
  const schedule: MonitorSchedule = Object.freeze({ id: row.id, tenantId: row.tenant_id, sourceUri: row.source_uri, sourceKind: row.source_kind, intervalSeconds: row.interval_seconds, maxStalenessSeconds: row.max_staleness_seconds, enabled: row.enabled === 1, createdAt: row.created_at });
  const latest = one<ObservationRow>(store, "SELECT * FROM change_source_monitor_observations WHERE tenant_id = ? AND schedule_id = ? ORDER BY sequence DESC LIMIT 1", [tenantId, scheduleId]);
  const lastObservation = latest ? Object.freeze({ sequence: latest.sequence, status: latest.status, observedAt: latest.observed_at, artifactId: latest.artifact_id, errorCode: latest.error_code }) : null;
  const staleAt = lastObservation ? new Date(Date.parse(lastObservation.observedAt) + schedule.maxStalenessSeconds * 1000).toISOString() : null;
  const state = !schedule.enabled ? "disabled" : !lastObservation ? "never_observed" : Date.parse(now) > Date.parse(staleAt!) ? "stale" : lastObservation.status === "error" ? "degraded" : "healthy";
  return Object.freeze({ schedule, state, lastObservation, staleAt, operatorActionRequired: state === "degraded" || state === "stale" || state === "never_observed" });
}
