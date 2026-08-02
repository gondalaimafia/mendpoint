import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { newId } from "@mendpoint/shared";

export type ChangeSourceKind = "manual_provider_announcement" | "customer_incident";
export type ChangeSourceReviewState = "pending" | "approved" | "rejected" | "changes_requested";
export type IncidentConfirmationState = "not_applicable" | "provisional" | "confirmed" | "rejected";

export type ChangeSourceEvidence = Readonly<{
  kind: "document" | "release" | "ticket" | "log" | "trace" | "other";
  locator: string;
  sha256: string;
}>;

export type ChangeSourceProvenance = Readonly<{
  observedAt: string;
  capturedAt: string;
  capturedBy: string;
  sourceRevision?: string | null;
}>;

export type ChangeSourceReviewerOverride = Readonly<{
  confidence?: number;
  effectiveDate?: string | null;
  affectedProducts?: readonly string[];
  excerpt?: Readonly<{ text: string; location: string }>;
}>;

type ChangeSourceBaseInput = Readonly<{
  id?: string;
  tenantId: string;
  author: Readonly<{ principalId: string; displayName: string }>;
  source: Readonly<{
    kind: "provider_page" | "release" | "customer_ticket" | "support_case" | "other";
    uri: string;
  }>;
  effectiveDate: string | null;
  affectedProducts: readonly string[];
  evidence: readonly ChangeSourceEvidence[];
  provenance: ChangeSourceProvenance;
  excerpt: Readonly<{ text: string; location: string }>;
  confidence: number;
  createdAt?: string;
}>;

export type ManualProviderAnnouncementInput = ChangeSourceBaseInput &
  Readonly<{
    kind: "manual_provider_announcement";
    providerSlug: string;
    announcement: string;
  }>;

export type CustomerIncidentInput = ChangeSourceBaseInput &
  Readonly<{
    kind: "customer_incident";
    incidentRef: string;
    redactedDetails: string;
    redactionEvidence: Readonly<{
      method: string;
      sourceSha256: string;
      redactedFields: readonly string[];
    }>;
  }>;

export type ChangeSourceInput = ManualProviderAnnouncementInput | CustomerIncidentInput;

export type ChangeSourceRevision = Readonly<{
  id: string;
  tenantId: string;
  artifactId: string;
  revision: number;
  reviewState: ChangeSourceReviewState;
  reviewerPrincipalId: string | null;
  reviewerOverride: ChangeSourceReviewerOverride | null;
  incidentConfirmation: IncidentConfirmationState;
  escalation: Readonly<{ severity: string; target: string; reason: string }> | null;
  reason: string;
  createdAt: string;
}>;

export type ChangeSourceArtifact = Readonly<{
  id: string;
  tenantId: string;
  kind: ChangeSourceKind;
  contentSha256: string;
  content: Readonly<Record<string, unknown>>;
  author: Readonly<{ principalId: string; displayName: string }>;
  source: Readonly<{ kind: string; uri: string }>;
  effectiveDate: string | null;
  affectedProducts: readonly string[];
  evidence: readonly ChangeSourceEvidence[];
  provenance: ChangeSourceProvenance;
  excerpt: Readonly<{ text: string; location: string }>;
  confidence: number;
  redactionEvidence: Readonly<{
    method: string;
    sourceSha256: string;
    redactedContentSha256: string;
    redactedFields: readonly string[];
  }> | null;
  createdAt: string;
  latestRevision: ChangeSourceRevision;
}>;

export type ChangeSourceEvent = Readonly<{
  id: string;
  tenantId: string;
  artifactId: string;
  sequence: number;
  eventType: "change_source.created" | "change_source.reviewed" | "customer_incident.confirmed" | "customer_incident.escalated";
  actorPrincipalId: string;
  payload: Readonly<Record<string, unknown>>;
  previousHash: string | null;
  eventHash: string;
  createdAt: string;
}>;

export type ChangeSourceStore = Readonly<{
  raw: DatabaseSync;
  path: string;
  close: () => void;
}>;

type ArtifactRow = {
  id: string;
  tenant_id: string;
  kind: ChangeSourceKind;
  content_sha256: string;
  content_json: string;
  author_principal_id: string;
  author_display_name: string;
  source_kind: string;
  source_uri: string;
  effective_date: string | null;
  affected_products_json: string;
  evidence_json: string;
  provenance_json: string;
  excerpt_text: string;
  excerpt_location: string;
  confidence: number;
  redaction_evidence_json: string | null;
  created_at: string;
};

type RevisionRow = {
  id: string;
  tenant_id: string;
  artifact_id: string;
  revision: number;
  review_state: ChangeSourceReviewState;
  reviewer_principal_id: string | null;
  reviewer_override_json: string | null;
  incident_confirmation: IncidentConfirmationState;
  escalation_json: string | null;
  reason: string;
  created_at: string;
};

type EventRow = {
  id: string;
  tenant_id: string;
  artifact_id: string;
  sequence: number;
  event_type: ChangeSourceEvent["eventType"];
  actor_principal_id: string;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
};

const HASH = /^[a-f0-9]{64}$/;
const SAFE_URN = /^urn:mendpoint:(?:incident|evidence|source):[a-zA-Z0-9._:/-]{1,512}$/;
const BLOCKED_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;
const SENSITIVE_QUERY_KEY = /^(?:access_?token|api_?key|authorization|credential|password|private_?key|secret|signature|token)$/i;
const SECRET_MATERIAL = /(?:authorization\s*:\s*bearer\s+(?!\[redacted\])|api[_-]?key\s*[:=]\s*(?!\[redacted\])|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

const MIGRATION_V1 = `
CREATE TABLE change_source_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual_provider_announcement', 'customer_incident')),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_json TEXT NOT NULL,
  author_principal_id TEXT NOT NULL,
  author_display_name TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  effective_date TEXT,
  affected_products_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  excerpt_text TEXT NOT NULL,
  excerpt_location TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  redaction_evidence_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, content_sha256),
  UNIQUE (id, tenant_id)
);
CREATE INDEX change_source_artifacts_tenant_created_idx
  ON change_source_artifacts(tenant_id, created_at, id);

CREATE TABLE change_source_revisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  review_state TEXT NOT NULL CHECK (review_state IN ('pending', 'approved', 'rejected', 'changes_requested')),
  reviewer_principal_id TEXT,
  reviewer_override_json TEXT,
  incident_confirmation TEXT NOT NULL CHECK (incident_confirmation IN ('not_applicable', 'provisional', 'confirmed', 'rejected')),
  escalation_json TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, artifact_id, revision),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES change_source_artifacts(id, tenant_id)
);

CREATE TABLE change_source_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  event_type TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  previous_hash TEXT,
  event_hash TEXT NOT NULL CHECK (length(event_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, artifact_id, sequence),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES change_source_artifacts(id, tenant_id)
);

CREATE TRIGGER change_source_artifacts_no_update BEFORE UPDATE ON change_source_artifacts
BEGIN SELECT RAISE(ABORT, 'change_source_artifacts_append_only'); END;
CREATE TRIGGER change_source_artifacts_no_delete BEFORE DELETE ON change_source_artifacts
BEGIN SELECT RAISE(ABORT, 'change_source_artifacts_append_only'); END;
CREATE TRIGGER change_source_revisions_no_update BEFORE UPDATE ON change_source_revisions
BEGIN SELECT RAISE(ABORT, 'change_source_revisions_append_only'); END;
CREATE TRIGGER change_source_revisions_no_delete BEFORE DELETE ON change_source_revisions
BEGIN SELECT RAISE(ABORT, 'change_source_revisions_append_only'); END;
CREATE TRIGGER change_source_events_no_update BEFORE UPDATE ON change_source_events
BEGIN SELECT RAISE(ABORT, 'change_source_events_append_only'); END;
CREATE TRIGGER change_source_events_no_delete BEFORE DELETE ON change_source_events
BEGIN SELECT RAISE(ABORT, 'change_source_events_append_only'); END;
`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function required(name: string, value: unknown, max = 4096): string {
  if (typeof value !== "string") throw new Error(`${name}_required`);
  const result = value.trim();
  if (!result || result.length > max) throw new Error(`${name}_invalid`);
  return result;
}

function timestamp(name: string, value: unknown): string {
  const text = required(name, value, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error(`${name}_invalid`);
  return new Date(parsed).toISOString();
}

function optionalTimestamp(name: string, value: unknown): string | null {
  return value === null ? null : timestamp(name, value);
}

function textList(name: string, values: unknown, maxItems = 100): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > maxItems) {
    throw new Error(`${name}_required`);
  }
  return [...new Set(values.map((value) => required(name, value, 256)))].sort();
}

function confidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("change_source_confidence_invalid");
  }
  return value;
}

function safeUri(name: string, value: unknown, requireHttps = false): string {
  const uri = required(name, value, 2048);
  if (!requireHttps && SAFE_URN.test(uri)) return uri;
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`${name}_unsafe`);
  }
  const hasSensitiveQuery = [...parsed.searchParams.keys()].some((key) =>
    SENSITIVE_QUERY_KEY.test(key),
  );
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    BLOCKED_HOST.test(parsed.hostname) ||
    hasSensitiveQuery
  ) {
    throw new Error(`${name}_unsafe`);
  }
  return parsed.toString();
}

function evidenceList(values: unknown): ChangeSourceEvidence[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
    throw new Error("change_source_evidence_required");
  }
  return values.map((value, index) => {
    if (!value || typeof value !== "object") throw new Error("change_source_evidence_invalid");
    const item = value as Record<string, unknown>;
    const kind = required("change_source_evidence_kind", item.kind, 32) as ChangeSourceEvidence["kind"];
    if (!new Set(["document", "release", "ticket", "log", "trace", "other"]).has(kind)) {
      throw new Error("change_source_evidence_kind_invalid");
    }
    const digest = required("change_source_evidence_sha256", item.sha256, 64).toLowerCase();
    if (!HASH.test(digest)) throw new Error("change_source_evidence_sha256_invalid");
    return Object.freeze({
      kind,
      locator: safeUri(`change_source_evidence_locator_${index}`, item.locator),
      sha256: digest,
    });
  });
}

function reviewerOverride(value: unknown): ChangeSourceReviewerOverride | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("change_source_reviewer_override_invalid");
  }
  const item = value as Record<string, unknown>;
  const allowed = new Set(["confidence", "effectiveDate", "affectedProducts", "excerpt"]);
  if (Object.keys(item).some((key) => !allowed.has(key))) {
    throw new Error("change_source_reviewer_override_invalid");
  }
  let excerpt: { text: string; location: string } | undefined;
  if (item.excerpt !== undefined) {
    if (!item.excerpt || typeof item.excerpt !== "object" || Array.isArray(item.excerpt)) {
      throw new Error("change_source_reviewer_override_invalid");
    }
    const input = item.excerpt as Record<string, unknown>;
    excerpt = {
      text: required("change_source_override_excerpt", input.text, 4000),
      location: required("change_source_override_excerpt_location", input.location, 512),
    };
  }
  return Object.freeze({
    ...(item.confidence === undefined ? {} : { confidence: confidence(item.confidence) }),
    ...(item.effectiveDate === undefined
      ? {}
      : { effectiveDate: optionalTimestamp("change_source_override_effective_date", item.effectiveDate) }),
    ...(item.affectedProducts === undefined
      ? {}
      : { affectedProducts: textList("change_source_override_affected_products", item.affectedProducts) }),
    ...(excerpt ? { excerpt: Object.freeze(excerpt) } : {}),
  });
}

function parseJson<T>(name: string, raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name}_corrupt`);
  }
}

function one<T>(store: ChangeSourceStore, sql: string, params: SQLInputValue[] = []): T | undefined {
  return store.raw.prepare(sql).get(...params) as T | undefined;
}

function all<T>(store: ChangeSourceStore, sql: string, params: SQLInputValue[] = []): T[] {
  return store.raw.prepare(sql).all(...params) as T[];
}

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS change_source_schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare("SELECT MAX(version) AS version FROM change_source_schema_migrations").get() as
    | { version: number | null }
    | undefined;
  const version = Number(row?.version ?? 0);
  if (version > 1) throw new Error("change_source_schema_newer_than_runtime");
  if (version === 1) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(MIGRATION_V1);
    db.prepare("INSERT INTO change_source_schema_migrations (version, applied_at) VALUES (1, ?)")
      .run(new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openChangeSourceStore(dbPath = ":memory:"): ChangeSourceStore {
  const path = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  migrate(raw);
  return Object.freeze({ raw, path, close: () => raw.close() });
}

export function canonicalChangeSourceContentHash(input: ChangeSourceInput): string {
  const content = input.kind === "manual_provider_announcement"
    ? {
        kind: input.kind,
        providerSlug: required("change_source_provider_slug", input.providerSlug, 128).toLowerCase(),
        announcement: required("change_source_announcement", input.announcement, 100_000),
      }
    : {
        kind: input.kind,
        incidentRef: required("change_source_incident_ref", input.incidentRef, 256),
        redactedDetails: required("change_source_incident_details", input.redactedDetails, 100_000),
      };
  return sha256(canonicalJson(content));
}

function normalizedInput(input: ChangeSourceInput) {
  if (!input || typeof input !== "object") throw new Error("change_source_input_required");
  const tenantId = required("change_source_tenant_id", input.tenantId, 256);
  const createdAt = timestamp("change_source_created_at", input.createdAt ?? new Date().toISOString());
  const sourceUri = safeUri(
    "change_source_source_uri",
    input.source?.uri,
    input.kind === "manual_provider_announcement",
  );
  const evidence = evidenceList(input.evidence);
  const affectedProducts = textList("change_source_affected_products", input.affectedProducts);
  const provenance = {
    observedAt: timestamp("change_source_observed_at", input.provenance?.observedAt),
    capturedAt: timestamp("change_source_captured_at", input.provenance?.capturedAt),
    capturedBy: required("change_source_captured_by", input.provenance?.capturedBy, 256),
    sourceRevision: input.provenance?.sourceRevision == null
      ? null
      : required("change_source_source_revision", input.provenance.sourceRevision, 512),
  };
  if (Date.parse(provenance.capturedAt) < Date.parse(provenance.observedAt)) {
    throw new Error("change_source_provenance_time_invalid");
  }
  const author = {
    principalId: required("change_source_author_principal", input.author?.principalId, 256),
    displayName: required("change_source_author_name", input.author?.displayName, 256),
  };
  const excerpt = {
    text: required("change_source_excerpt", input.excerpt?.text, 4000),
    location: required("change_source_excerpt_location", input.excerpt?.location, 512),
  };
  const common = {
    id: input.id === undefined ? newId() : required("change_source_artifact_id", input.id, 256),
    tenantId,
    author,
    source: {
      kind: required("change_source_source_kind", input.source?.kind, 32),
      uri: sourceUri,
    },
    effectiveDate: optionalTimestamp("change_source_effective_date", input.effectiveDate),
    affectedProducts,
    evidence,
    provenance,
    excerpt,
    confidence: confidence(input.confidence),
    createdAt,
  };

  if (input.kind === "manual_provider_announcement") {
    if (!new Set(["provider_page", "release", "other"]).has(input.source.kind)) {
      throw new Error("change_source_manual_source_kind_invalid");
    }
    const content = {
      kind: input.kind,
      providerSlug: required("change_source_provider_slug", input.providerSlug, 128).toLowerCase(),
      announcement: required("change_source_announcement", input.announcement, 100_000),
    };
    return { ...common, kind: input.kind, content, redactionEvidence: null } as const;
  }

  const raw = input as unknown as Record<string, unknown>;
  if (["rawDetails", "rawLogs", "unredactedDetails", "secret", "token", "authorization"].some((key) => key in raw)) {
    throw new Error("change_source_unredacted_incident_material_rejected");
  }
  if (!new Set(["customer_ticket", "support_case", "other"]).has(input.source.kind)) {
    throw new Error("change_source_incident_source_kind_invalid");
  }
  const redactedDetails = required("change_source_incident_details", input.redactedDetails, 100_000);
  if (SECRET_MATERIAL.test(redactedDetails)) {
    throw new Error("change_source_incident_details_not_redacted");
  }
  if (!input.redactionEvidence || typeof input.redactionEvidence !== "object") {
    throw new Error("change_source_redaction_evidence_required");
  }
  const sourceSha256 = required(
    "change_source_redaction_source_sha256",
    input.redactionEvidence.sourceSha256,
    64,
  ).toLowerCase();
  if (!HASH.test(sourceSha256)) throw new Error("change_source_redaction_source_sha256_invalid");
  const redactionEvidence = {
    method: required("change_source_redaction_method", input.redactionEvidence.method, 256),
    sourceSha256,
    redactedContentSha256: sha256(redactedDetails),
    redactedFields: textList("change_source_redacted_fields", input.redactionEvidence.redactedFields),
  };
  const content = {
    kind: input.kind,
    incidentRef: required("change_source_incident_ref", input.incidentRef, 256),
    redactedDetails,
  };
  return { ...common, kind: input.kind, content, redactionEvidence } as const;
}

function revisionFrom(row: RevisionRow): ChangeSourceRevision {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    revision: row.revision,
    reviewState: row.review_state,
    reviewerPrincipalId: row.reviewer_principal_id,
    reviewerOverride: row.reviewer_override_json
      ? Object.freeze(parseJson<ChangeSourceReviewerOverride>("change_source_reviewer_override", row.reviewer_override_json))
      : null,
    incidentConfirmation: row.incident_confirmation,
    escalation: row.escalation_json
      ? Object.freeze(parseJson<{ severity: string; target: string; reason: string }>("change_source_escalation", row.escalation_json))
      : null,
    reason: row.reason,
    createdAt: row.created_at,
  });
}

function artifactFrom(store: ChangeSourceStore, row: ArtifactRow): ChangeSourceArtifact {
  const latest = one<RevisionRow>(store, `SELECT * FROM change_source_revisions
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY revision DESC LIMIT 1`, [row.tenant_id, row.id]);
  if (!latest) throw new Error("change_source_revision_missing");
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    kind: row.kind,
    contentSha256: row.content_sha256,
    content: Object.freeze(parseJson<Record<string, unknown>>("change_source_content", row.content_json)),
    author: Object.freeze({ principalId: row.author_principal_id, displayName: row.author_display_name }),
    source: Object.freeze({ kind: row.source_kind, uri: row.source_uri }),
    effectiveDate: row.effective_date,
    affectedProducts: Object.freeze(parseJson<string[]>("change_source_affected_products", row.affected_products_json)),
    evidence: Object.freeze(parseJson<ChangeSourceEvidence[]>("change_source_evidence", row.evidence_json)),
    provenance: Object.freeze(parseJson<ChangeSourceProvenance>("change_source_provenance", row.provenance_json)),
    excerpt: Object.freeze({ text: row.excerpt_text, location: row.excerpt_location }),
    confidence: row.confidence,
    redactionEvidence: row.redaction_evidence_json
      ? Object.freeze(parseJson<NonNullable<ChangeSourceArtifact["redactionEvidence"]>>(
          "change_source_redaction_evidence",
          row.redaction_evidence_json,
        ))
      : null,
    createdAt: row.created_at,
    latestRevision: revisionFrom(latest),
  });
}

function eventFrom(row: EventRow): ChangeSourceEvent {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    sequence: row.sequence,
    eventType: row.event_type,
    actorPrincipalId: row.actor_principal_id,
    payload: Object.freeze(parseJson<Record<string, unknown>>("change_source_event_payload", row.payload_json)),
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    createdAt: row.created_at,
  });
}

function appendEvent(
  store: ChangeSourceStore,
  input: Omit<ChangeSourceEvent, "id" | "sequence" | "previousHash" | "eventHash">,
): ChangeSourceEvent {
  const previous = one<EventRow>(store, `SELECT * FROM change_source_events
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY sequence DESC LIMIT 1`, [input.tenantId, input.artifactId]);
  const sequence = (previous?.sequence ?? 0) + 1;
  const payloadJson = canonicalJson(input.payload);
  const eventHash = sha256(canonicalJson({
    tenantId: input.tenantId,
    artifactId: input.artifactId,
    sequence,
    eventType: input.eventType,
    actorPrincipalId: input.actorPrincipalId,
    payload: input.payload,
    previousHash: previous?.event_hash ?? null,
    createdAt: input.createdAt,
  }));
  const id = newId();
  store.raw.prepare(`INSERT INTO change_source_events
    (id, tenant_id, artifact_id, sequence, event_type, actor_principal_id, payload_json,
     previous_hash, event_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.tenantId, input.artifactId, sequence, input.eventType, input.actorPrincipalId,
      payloadJson, previous?.event_hash ?? null, eventHash, input.createdAt);
  return eventFrom(one<EventRow>(store, "SELECT * FROM change_source_events WHERE id = ?", [id])!);
}

export function createChangeSourceArtifact(
  store: ChangeSourceStore,
  input: ChangeSourceInput,
): Readonly<{ artifact: ChangeSourceArtifact; inserted: boolean }> {
  const normalized = normalizedInput(input);
  const contentJson = canonicalJson(normalized.content);
  const contentSha256 = sha256(contentJson);
  const duplicate = one<ArtifactRow>(store, `SELECT * FROM change_source_artifacts
    WHERE tenant_id = ? AND kind = ? AND content_sha256 = ?`, [normalized.tenantId, normalized.kind, contentSha256]);
  if (duplicate) return Object.freeze({ artifact: artifactFrom(store, duplicate), inserted: false });

  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const byId = one<ArtifactRow>(store, "SELECT * FROM change_source_artifacts WHERE id = ?", [normalized.id]);
    if (byId) throw new Error("change_source_artifact_id_conflict");
    const raced = one<ArtifactRow>(store, `SELECT * FROM change_source_artifacts
      WHERE tenant_id = ? AND kind = ? AND content_sha256 = ?`, [normalized.tenantId, normalized.kind, contentSha256]);
    if (raced) {
      store.raw.exec("COMMIT");
      return Object.freeze({ artifact: artifactFrom(store, raced), inserted: false });
    }
    store.raw.prepare(`INSERT INTO change_source_artifacts
      (id, tenant_id, kind, content_sha256, content_json, author_principal_id, author_display_name,
       source_kind, source_uri, effective_date, affected_products_json, evidence_json, provenance_json,
       excerpt_text, excerpt_location, confidence, redaction_evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(normalized.id, normalized.tenantId, normalized.kind, contentSha256, contentJson,
        normalized.author.principalId, normalized.author.displayName, normalized.source.kind,
        normalized.source.uri, normalized.effectiveDate, canonicalJson(normalized.affectedProducts),
        canonicalJson(normalized.evidence), canonicalJson(normalized.provenance), normalized.excerpt.text,
        normalized.excerpt.location, normalized.confidence,
        normalized.redactionEvidence ? canonicalJson(normalized.redactionEvidence) : null, normalized.createdAt);
    const revisionId = newId();
    const incidentConfirmation: IncidentConfirmationState = normalized.kind === "customer_incident"
      ? "provisional"
      : "not_applicable";
    store.raw.prepare(`INSERT INTO change_source_revisions
      (id, tenant_id, artifact_id, revision, review_state, reviewer_principal_id,
       reviewer_override_json, incident_confirmation, escalation_json, reason, created_at)
      VALUES (?, ?, ?, 1, 'pending', NULL, NULL, ?, NULL, 'source captured', ?)`)
      .run(revisionId, normalized.tenantId, normalized.id, incidentConfirmation, normalized.createdAt);
    appendEvent(store, {
      tenantId: normalized.tenantId,
      artifactId: normalized.id,
      eventType: "change_source.created",
      actorPrincipalId: normalized.author.principalId,
      payload: Object.freeze({ revision: 1, kind: normalized.kind, contentSha256, reviewState: "pending", incidentConfirmation }),
      createdAt: normalized.createdAt,
    });
    const artifact = artifactFrom(store, one<ArtifactRow>(store, "SELECT * FROM change_source_artifacts WHERE id = ?", [normalized.id])!);
    store.raw.exec("COMMIT");
    return Object.freeze({ artifact, inserted: true });
  } catch (error) {
    store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function getChangeSourceArtifact(
  store: ChangeSourceStore,
  tenantId: string,
  artifactId: string,
): ChangeSourceArtifact | undefined {
  const row = one<ArtifactRow>(store, "SELECT * FROM change_source_artifacts WHERE tenant_id = ? AND id = ?", [
    required("change_source_tenant_id", tenantId, 256),
    required("change_source_artifact_id", artifactId, 256),
  ]);
  return row ? artifactFrom(store, row) : undefined;
}

export function listChangeSourceRevisions(
  store: ChangeSourceStore,
  tenantId: string,
  artifactId: string,
): ChangeSourceRevision[] {
  return all<RevisionRow>(store, `SELECT * FROM change_source_revisions
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY revision`, [tenantId, artifactId]).map(revisionFrom);
}

export function listChangeSourceEvents(
  store: ChangeSourceStore,
  tenantId: string,
  artifactId: string,
): ChangeSourceEvent[] {
  return all<EventRow>(store, `SELECT * FROM change_source_events
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY sequence`, [tenantId, artifactId]).map(eventFrom);
}

function appendRevision(
  store: ChangeSourceStore,
  input: {
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    actorPrincipalId: string;
    reviewState?: ChangeSourceReviewState;
    reviewerOverride?: ChangeSourceReviewerOverride | null;
    incidentConfirmation?: IncidentConfirmationState;
    escalation?: { severity: string; target: string; reason: string } | null;
    reason: string;
    createdAt: string;
    eventType: ChangeSourceEvent["eventType"];
  },
): ChangeSourceArtifact {
  const artifact = getChangeSourceArtifact(store, input.tenantId, input.artifactId);
  if (!artifact) throw new Error("change_source_artifact_not_found");
  if (artifact.latestRevision.revision !== input.expectedRevision) {
    throw new Error("change_source_revision_conflict");
  }
  const next = input.expectedRevision + 1;
  const reviewState = input.reviewState ?? artifact.latestRevision.reviewState;
  const override = input.reviewerOverride === undefined
    ? artifact.latestRevision.reviewerOverride
    : input.reviewerOverride;
  const confirmation = input.incidentConfirmation ?? artifact.latestRevision.incidentConfirmation;
  const escalation = input.escalation === undefined ? artifact.latestRevision.escalation : input.escalation;
  const id = newId();
  store.raw.prepare(`INSERT INTO change_source_revisions
    (id, tenant_id, artifact_id, revision, review_state, reviewer_principal_id,
     reviewer_override_json, incident_confirmation, escalation_json, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.tenantId, input.artifactId, next, reviewState, input.actorPrincipalId,
      override ? canonicalJson(override) : null, confirmation, escalation ? canonicalJson(escalation) : null,
      input.reason, input.createdAt);
  appendEvent(store, {
    tenantId: input.tenantId,
    artifactId: input.artifactId,
    eventType: input.eventType,
    actorPrincipalId: input.actorPrincipalId,
    payload: Object.freeze({ revision: next, reviewState, reviewerOverride: override, incidentConfirmation: confirmation, escalation, reason: input.reason }),
    createdAt: input.createdAt,
  });
  return getChangeSourceArtifact(store, input.tenantId, input.artifactId)!;
}

export function reviewChangeSourceArtifact(
  store: ChangeSourceStore,
  input: Readonly<{
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    reviewerPrincipalId: string;
    decision: "approve" | "reject" | "request_changes";
    reason: string;
    override?: ChangeSourceReviewerOverride | null;
    reviewedAt: string;
  }>,
): ChangeSourceArtifact {
  const state: ChangeSourceReviewState = input.decision === "approve"
    ? "approved"
    : input.decision === "reject"
      ? "rejected"
      : "changes_requested";
  const at = timestamp("change_source_reviewed_at", input.reviewedAt);
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = appendRevision(store, {
      tenantId: required("change_source_tenant_id", input.tenantId, 256),
      artifactId: required("change_source_artifact_id", input.artifactId, 256),
      expectedRevision: input.expectedRevision,
      actorPrincipalId: required("change_source_reviewer_principal", input.reviewerPrincipalId, 256),
      reviewState: state,
      reviewerOverride: reviewerOverride(input.override),
      reason: required("change_source_review_reason", input.reason, 4000),
      createdAt: at,
      eventType: "change_source.reviewed",
    });
    store.raw.exec("COMMIT");
    return result;
  } catch (error) {
    store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function confirmCustomerIncident(
  store: ChangeSourceStore,
  input: Readonly<{
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    actorPrincipalId: string;
    confirmed: boolean;
    reason: string;
    confirmedAt: string;
  }>,
): ChangeSourceArtifact {
  const artifact = getChangeSourceArtifact(store, input.tenantId, input.artifactId);
  if (!artifact) throw new Error("change_source_artifact_not_found");
  if (artifact.kind !== "customer_incident") throw new Error("change_source_not_customer_incident");
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = appendRevision(store, {
      tenantId: input.tenantId,
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      actorPrincipalId: required("change_source_confirmation_actor", input.actorPrincipalId, 256),
      incidentConfirmation: input.confirmed ? "confirmed" : "rejected",
      reason: required("change_source_confirmation_reason", input.reason, 4000),
      createdAt: timestamp("change_source_confirmed_at", input.confirmedAt),
      eventType: "customer_incident.confirmed",
    });
    store.raw.exec("COMMIT");
    return result;
  } catch (error) {
    store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function escalateCustomerIncident(
  store: ChangeSourceStore,
  input: Readonly<{
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    actorPrincipalId: string;
    severity: string;
    target: string;
    reason: string;
    escalatedAt: string;
  }>,
): ChangeSourceArtifact {
  const artifact = getChangeSourceArtifact(store, input.tenantId, input.artifactId);
  if (!artifact) throw new Error("change_source_artifact_not_found");
  if (artifact.kind !== "customer_incident") throw new Error("change_source_not_customer_incident");
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const reason = required("change_source_escalation_reason", input.reason, 4000);
    const result = appendRevision(store, {
      tenantId: input.tenantId,
      artifactId: input.artifactId,
      expectedRevision: input.expectedRevision,
      actorPrincipalId: required("change_source_escalation_actor", input.actorPrincipalId, 256),
      escalation: {
        severity: required("change_source_escalation_severity", input.severity, 32),
        target: required("change_source_escalation_target", input.target, 256),
        reason,
      },
      reason,
      createdAt: timestamp("change_source_escalated_at", input.escalatedAt),
      eventType: "customer_incident.escalated",
    });
    store.raw.exec("COMMIT");
    return result;
  } catch (error) {
    store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function requireApprovedChangeSourceForFanout(
  store: ChangeSourceStore,
  tenantId: string,
  artifactId: string,
): ChangeSourceArtifact {
  const artifact = getChangeSourceArtifact(store, tenantId, artifactId);
  if (!artifact) throw new Error("change_source_artifact_not_found");
  if (artifact.latestRevision.reviewState !== "approved") {
    throw new Error("change_source_not_approved_for_fanout");
  }
  if (artifact.kind === "customer_incident" && artifact.latestRevision.incidentConfirmation !== "confirmed") {
    throw new Error("change_source_incident_not_confirmed_for_fanout");
  }
  return artifact;
}

export function verifyChangeSourceEventIntegrity(
  store: ChangeSourceStore,
  tenantId: string,
  artifactId: string,
): Readonly<{ ok: boolean; checked: number; firstInvalidSequence: number | null }> {
  const events = listChangeSourceEvents(store, tenantId, artifactId);
  let previousHash: string | null = null;
  for (const event of events) {
    const expected = sha256(canonicalJson({
      tenantId: event.tenantId,
      artifactId: event.artifactId,
      sequence: event.sequence,
      eventType: event.eventType,
      actorPrincipalId: event.actorPrincipalId,
      payload: event.payload,
      previousHash,
      createdAt: event.createdAt,
    }));
    const suppliedBytes = Buffer.from(event.eventHash, "hex");
    const expectedBytes = Buffer.from(expected, "hex");
    if (event.previousHash !== previousHash || suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
      return Object.freeze({ ok: false, checked: event.sequence, firstInvalidSequence: event.sequence });
    }
    previousHash = event.eventHash;
  }
  return Object.freeze({ ok: true, checked: events.length, firstInvalidSequence: null });
}
