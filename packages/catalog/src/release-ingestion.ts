import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { parseChangelogEntry, type ChangelogParseResult } from "./changelog-parse.js";

export type ReleaseAdapter = "rss" | "atom" | "github_releases" | "provider_page" | "sdk_registry";

export type SdkReleaseChange = Readonly<{
  kind: "export_added" | "export_removed" | "runtime_changed";
  subject: string;
  before: string | null;
  after: string | null;
  breaking: boolean;
}>;

export type SdkReleaseEvidence = Readonly<{
  ecosystem: "npm";
  packageName: string;
  version: string;
  previousVersion: string | null;
  exportDiff: Readonly<{ added: readonly string[]; removed: readonly string[] }>;
  clientDiff: Readonly<{
    source: "package_exports_proxy";
    added: readonly string[];
    removed: readonly string[];
  }>;
  runtimeCompatibility: Readonly<{
    previousNode: string | null;
    currentNode: string | null;
    changed: boolean;
  }>;
  emittedChanges: readonly SdkReleaseChange[];
}>;

export type ReleaseReviewerOverride = Readonly<{
  revision: number;
  reviewerPrincipalId: string;
  confidence: number;
  excerpt: string;
  excerptLocation: string;
  reason: string;
  reviewedAt: string;
}>;

export type ReleaseArtifact = Readonly<{
  id: string;
  tenantId: string;
  providerSlug: string;
  adapter: ReleaseAdapter;
  collectionUrl: string;
  sourceUrl: string;
  sourceItemId: string;
  sourceBodySha256: string;
  contentSha256: string;
  normalizedClaimSha256: string;
  identityCanonical: boolean;
  title: string;
  version: string | null;
  publishedAt: string;
  observedAt: string;
  excerpt: string;
  excerptLocation: string;
  confidence: number;
  changeHints: ChangelogParseResult;
  sdk: SdkReleaseEvidence | null;
  reviewerOverride: ReleaseReviewerOverride | null;
  createdAt: string;
}>;

export type ReleaseObservation = Readonly<{
  id: string;
  tenantId: string;
  artifactId: string;
  observedAt: string;
  sourceBodySha256: string;
  createdAt: string;
}>;

export type ReleaseDispatchStatus = "pending" | "claimed" | "completed" | "failed";

export type ReleaseDispatch = Readonly<{
  id: string;
  tenantId: string;
  artifactId: string;
  artifactContentSha256: string;
  status: ReleaseDispatchStatus;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  leaseGeneration: number;
  claimedAt: string | null;
  attemptCount: number;
  maxAttempts: number;
  completedAt: string | null;
  failedAt: string | null;
  failureCode: string | null;
  lastFailureAt: string | null;
  lastFailureCode: string | null;
  createdAt: string;
}>;

export type ReleaseReviewerOverrideResult =
  | Readonly<{ status: "applied"; artifact: ReleaseArtifact }>
  | Readonly<{ status: "revision_conflict"; expectedRevision: number; actualRevision: number }>;

export type ReleaseIngestionStore = Readonly<{
  raw: DatabaseSync;
  path: string;
  trustedNow: () => string;
  close: () => void;
}>;

export type ReleaseIngestionStoreOptions = Readonly<{
  clock?: () => string;
}>;

export type ReleaseDocumentInput = Readonly<{
  tenantId: string;
  providerSlug: string;
  adapter: ReleaseAdapter;
  sourceUrl: string;
  body: string;
  observedAt: string;
  now?: string;
  maxBytes?: number;
  maxObservationAgeMs?: number;
}>;

type NormalizedItem = Omit<ReleaseArtifact, "id" | "tenantId" | "providerSlug" | "adapter" | "collectionUrl" | "sourceBodySha256" | "contentSha256" | "normalizedClaimSha256" | "identityCanonical" | "reviewerOverride" | "createdAt">;

type ArtifactRow = {
  id: string;
  tenant_id: string;
  provider_slug: string;
  adapter: ReleaseAdapter;
  collection_url: string;
  source_url: string;
  source_item_id: string;
  source_body_sha256: string;
  content_sha256: string;
  normalized_claim_sha256: string;
  identity_canonical: number;
  title: string;
  version: string | null;
  published_at: string;
  observed_at: string;
  excerpt: string;
  excerpt_location: string;
  confidence: number;
  change_hints_json: string;
  sdk_json: string | null;
  created_at: string;
};

type ObservationRow = {
  id: string;
  tenant_id: string;
  artifact_id: string;
  observed_at: string;
  source_body_sha256: string;
  created_at: string;
};

type DispatchRow = {
  id: string;
  tenant_id: string;
  artifact_id: string;
  artifact_content_sha256: string;
  status: ReleaseDispatchStatus;
  available_at: string;
  lease_owner: string | null;
  lease_expires_at: string | null;
  lease_generation: number;
  claimed_at: string | null;
  attempt_count: number;
  max_attempts: number;
  completed_at: string | null;
  failed_at: string | null;
  failure_code: string | null;
  last_failure_at: string | null;
  last_failure_code: string | null;
  created_at: string;
};

type OverrideRow = {
  revision: number;
  reviewer_principal_id: string;
  confidence: number;
  excerpt: string;
  excerpt_location: string;
  reason: string;
  reviewed_at: string;
};

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_OBSERVATION_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_MAX_DISPATCH_ATTEMPTS = 5;
const DISPATCH_RETRY_BASE_MS = 1_000;
const DISPATCH_RETRY_MAX_MS = 5 * 60_000;
const SQLITE_BUSY_RETRY_DELAYS_MS = Object.freeze([10, 25, 50, 100, 200, 400]);
const SQLITE_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const BLOCKED_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;
const SENSITIVE_QUERY = /^(?:access_?token|api_?key|authorization|credential|password|private_?key|secret|signature|token)$/i;

const MIGRATION_V1 = `
CREATE TABLE release_ingestion_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider_slug TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('rss', 'atom', 'github_releases', 'provider_page', 'sdk_registry')),
  collection_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_body_sha256 TEXT NOT NULL CHECK (length(source_body_sha256) = 64),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  title TEXT NOT NULL,
  version TEXT,
  published_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  excerpt_location TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  change_hints_json TEXT NOT NULL,
  sdk_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, adapter, collection_url, source_item_id, content_sha256),
  UNIQUE (id, tenant_id)
);
CREATE INDEX release_ingestion_artifacts_tenant_idx
  ON release_ingestion_artifacts(tenant_id, published_at DESC, id);

CREATE TABLE release_ingestion_overrides (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  reviewer_principal_id TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  excerpt TEXT NOT NULL,
  excerpt_location TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  UNIQUE (tenant_id, artifact_id, revision),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES release_ingestion_artifacts(id, tenant_id)
);

CREATE TRIGGER release_ingestion_artifacts_no_update BEFORE UPDATE ON release_ingestion_artifacts
BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
CREATE TRIGGER release_ingestion_artifacts_no_delete BEFORE DELETE ON release_ingestion_artifacts
BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
CREATE TRIGGER release_ingestion_overrides_no_update BEFORE UPDATE ON release_ingestion_overrides
BEGIN SELECT RAISE(ABORT, 'release_ingestion_overrides_append_only'); END;
CREATE TRIGGER release_ingestion_overrides_no_delete BEFORE DELETE ON release_ingestion_overrides
BEGIN SELECT RAISE(ABORT, 'release_ingestion_overrides_append_only'); END;
`;

const MIGRATION_V2_SCHEMA = `
DROP TRIGGER release_ingestion_artifacts_no_update;
DROP TRIGGER release_ingestion_artifacts_no_delete;

CREATE TABLE release_ingestion_artifacts_v2 (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider_slug TEXT NOT NULL,
  adapter TEXT NOT NULL CHECK (adapter IN ('rss', 'atom', 'github_releases', 'provider_page', 'sdk_registry')),
  collection_url TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_item_id TEXT NOT NULL,
  source_body_sha256 TEXT NOT NULL CHECK (length(source_body_sha256) = 64),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  normalized_claim_sha256 TEXT NOT NULL CHECK (length(normalized_claim_sha256) = 64),
  identity_canonical INTEGER NOT NULL CHECK (identity_canonical IN (0, 1)),
  title TEXT NOT NULL,
  version TEXT,
  published_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  excerpt_location TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  change_hints_json TEXT NOT NULL,
  sdk_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, tenant_id)
);

CREATE TABLE release_ingestion_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_body_sha256 TEXT NOT NULL CHECK (length(source_body_sha256) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, artifact_id, observed_at, source_body_sha256),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES release_ingestion_artifacts_v2(id, tenant_id)
);

CREATE TABLE release_ingestion_dispatches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  artifact_content_sha256 TEXT NOT NULL CHECK (length(artifact_content_sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_DISPATCH_ATTEMPTS}
    CHECK (max_attempts > 0 AND attempt_count <= max_attempts),
  completed_at TEXT,
  failed_at TEXT,
  failure_code TEXT,
  last_failure_at TEXT,
  last_failure_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, artifact_id),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES release_ingestion_artifacts_v2(id, tenant_id)
);
`;

const MIGRATION_V2_FINALIZE = `
DROP TABLE release_ingestion_artifacts;
ALTER TABLE release_ingestion_artifacts_v2 RENAME TO release_ingestion_artifacts;
CREATE INDEX release_ingestion_artifacts_tenant_idx
  ON release_ingestion_artifacts(tenant_id, published_at DESC, id);
CREATE UNIQUE INDEX release_ingestion_artifacts_canonical_identity_idx
  ON release_ingestion_artifacts(
    tenant_id, provider_slug, adapter, collection_url, source_item_id, normalized_claim_sha256
  ) WHERE identity_canonical = 1;
CREATE INDEX release_ingestion_observations_tenant_idx
  ON release_ingestion_observations(tenant_id, artifact_id, observed_at, id);
CREATE INDEX release_ingestion_dispatches_claim_idx
  ON release_ingestion_dispatches(tenant_id, status, available_at, lease_expires_at, id);

CREATE TRIGGER release_ingestion_artifacts_no_update BEFORE UPDATE ON release_ingestion_artifacts
BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
CREATE TRIGGER release_ingestion_artifacts_no_delete BEFORE DELETE ON release_ingestion_artifacts
BEGIN SELECT RAISE(ABORT, 'release_ingestion_artifacts_append_only'); END;
CREATE TRIGGER release_ingestion_observations_no_update BEFORE UPDATE ON release_ingestion_observations
BEGIN SELECT RAISE(ABORT, 'release_ingestion_observations_append_only'); END;
CREATE TRIGGER release_ingestion_observations_no_delete BEFORE DELETE ON release_ingestion_observations
BEGIN SELECT RAISE(ABORT, 'release_ingestion_observations_append_only'); END;
`;

const MIGRATION_V3_CLOCK_SCHEMA = `
CREATE TABLE IF NOT EXISTS release_ingestion_clock_authority (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  watermark_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS release_ingestion_clock_authority_no_delete
BEFORE DELETE ON release_ingestion_clock_authority
BEGIN SELECT RAISE(ABORT, 'release_ingestion_clock_authority_required'); END;
`;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedClaim(item: NormalizedItem): Omit<NormalizedItem, "observedAt"> {
  const { observedAt: _observedAt, ...claim } = item;
  return claim;
}

function normalizedClaimSha256FromRow(row: Omit<ArtifactRow, "normalized_claim_sha256" | "identity_canonical">): string {
  return sha256(canonicalJson({
    sourceUrl: row.source_url,
    sourceItemId: row.source_item_id,
    title: row.title,
    version: row.version,
    publishedAt: row.published_at,
    excerpt: row.excerpt,
    excerptLocation: row.excerpt_location,
    confidence: row.confidence,
    changeHints: JSON.parse(row.change_hints_json) as unknown,
    sdk: row.sdk_json ? JSON.parse(row.sdk_json) as unknown : null,
  }));
}

function releaseArtifactId(identity: Readonly<{
  tenantId: string;
  providerSlug: string;
  adapter: ReleaseAdapter;
  collectionUrl: string;
  sourceItemId: string;
  normalizedClaimSha256: string;
}>): string {
  return `rel_${sha256(canonicalJson(identity)).slice(0, 32)}`;
}

function releaseObservationId(input: Readonly<{
  tenantId: string;
  artifactId: string;
  observedAt: string;
  sourceBodySha256: string;
}>): string {
  return `rob_${sha256(canonicalJson(input)).slice(0, 32)}`;
}

function releaseDispatchId(tenantId: string, artifactId: string, contentSha256: string): string {
  return `rdi_${sha256(canonicalJson({ tenantId, artifactId, contentSha256 })).slice(0, 32)}`;
}

function sqliteBusy(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

function configureReleaseIngestionConnection(raw: DatabaseSync): void {
  raw.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  for (let attempt = 0; ; attempt += 1) {
    try {
      raw.prepare("PRAGMA journal_mode = WAL").get();
      return;
    } catch (error) {
      const delay = SQLITE_BUSY_RETRY_DELAYS_MS[attempt];
      if (!sqliteBusy(error) || delay === undefined) throw error;
      Atomics.wait(SQLITE_WAIT_BUFFER, 0, 0, delay);
    }
  }
}

function migrateReleaseIngestionV2(raw: DatabaseSync, appliedAt: string): void {
  raw.exec(MIGRATION_V2_SCHEMA);
  const legacyRows = raw.prepare("SELECT * FROM release_ingestion_artifacts ORDER BY tenant_id, observed_at, id").all() as unknown as Array<Omit<ArtifactRow, "normalized_claim_sha256" | "identity_canonical">>;
  const insertArtifact = raw.prepare(`INSERT INTO release_ingestion_artifacts_v2
      (id, tenant_id, provider_slug, adapter, collection_url, source_url, source_item_id,
       source_body_sha256, content_sha256, normalized_claim_sha256, identity_canonical, title, version,
       published_at, observed_at, excerpt, excerpt_location, confidence, change_hints_json, sdk_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertObservation = raw.prepare(`INSERT INTO release_ingestion_observations
      (id, tenant_id, artifact_id, observed_at, source_body_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`);
  const insertDispatch = raw.prepare(`INSERT INTO release_ingestion_dispatches
      (id, tenant_id, artifact_id, artifact_content_sha256, status, available_at, lease_generation, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)`);
  const canonicalIdentities = new Set<string>();
  for (const row of legacyRows) {
    const normalizedClaimSha256 = normalizedClaimSha256FromRow(row);
    const identity = canonicalJson({
      tenantId: row.tenant_id,
      providerSlug: row.provider_slug,
      adapter: row.adapter,
      collectionUrl: row.collection_url,
      sourceItemId: row.source_item_id,
      normalizedClaimSha256,
    });
    const identityCanonical = canonicalIdentities.has(identity) ? 0 : 1;
    canonicalIdentities.add(identity);
    insertArtifact.run(row.id, row.tenant_id, row.provider_slug, row.adapter, row.collection_url,
      row.source_url, row.source_item_id, row.source_body_sha256, row.content_sha256,
      normalizedClaimSha256, identityCanonical, row.title, row.version, row.published_at, row.observed_at,
      row.excerpt, row.excerpt_location, row.confidence, row.change_hints_json, row.sdk_json,
      row.created_at);
    insertObservation.run(releaseObservationId({
      tenantId: row.tenant_id,
      artifactId: row.id,
      observedAt: row.observed_at,
      sourceBodySha256: row.source_body_sha256,
    }), row.tenant_id, row.id, row.observed_at, row.source_body_sha256, row.created_at);
    if (identityCanonical === 1) {
      insertDispatch.run(releaseDispatchId(row.tenant_id, row.id, row.content_sha256), row.tenant_id,
        row.id, row.content_sha256, row.created_at, row.created_at);
    }
  }
  raw.exec(MIGRATION_V2_FINALIZE);
  raw.prepare("INSERT INTO release_ingestion_schema_migrations (version, applied_at) VALUES (2, ?)")
    .run(appliedAt);
}

function migrateReleaseIngestionV3(raw: DatabaseSync, appliedAt: string): void {
  const dispatchColumns = raw.prepare("PRAGMA table_info(release_ingestion_dispatches)")
    .all() as unknown as Array<{ name: string }>;
  if (!dispatchColumns.some((column) => column.name === "claimed_at")) {
    raw.exec("ALTER TABLE release_ingestion_dispatches ADD COLUMN claimed_at TEXT");
  }
  raw.exec(MIGRATION_V3_CLOCK_SCHEMA);
  // Pre-v3 claims have no trustworthy claim time. Binding them to expiry prevents
  // old-owner completion while preserving the existing expiry takeover path.
  raw.exec(`UPDATE release_ingestion_dispatches
    SET claimed_at = lease_expires_at
    WHERE status = 'claimed' AND claimed_at IS NULL
      AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL`);
  const unboundedActiveClaim = raw.prepare(`SELECT id FROM release_ingestion_dispatches
    WHERE status = 'claimed'
      AND (lease_owner IS NULL OR lease_expires_at IS NULL OR claimed_at IS NULL)
    LIMIT 1`).get();
  if (unboundedActiveClaim) throw new Error("release_ingestion_v3_active_claim_unbounded");
  raw.prepare("INSERT INTO release_ingestion_schema_migrations (version, applied_at) VALUES (3, ?)")
    .run(appliedAt);
}

function convergeReleaseIngestionSchema(raw: DatabaseSync, appliedAt: string): void {
  raw.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    raw.exec(`CREATE TABLE IF NOT EXISTS release_ingestion_schema_migrations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    )`);
    const current = raw.prepare("SELECT MAX(version) AS version FROM release_ingestion_schema_migrations")
      .get() as { version: number | null };
    const currentVersion = Number(current.version ?? 0);
    if (currentVersion > 3) throw new Error("release_ingestion_schema_newer_than_runtime");
    if (currentVersion === 0) {
      raw.exec(MIGRATION_V1);
      raw.prepare("INSERT INTO release_ingestion_schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(appliedAt);
    }
    const afterV1 = raw.prepare("SELECT MAX(version) AS version FROM release_ingestion_schema_migrations")
      .get() as { version: number | null };
    if (Number(afterV1.version ?? 0) === 1) migrateReleaseIngestionV2(raw, appliedAt);
    const afterV2 = raw.prepare("SELECT MAX(version) AS version FROM release_ingestion_schema_migrations")
      .get() as { version: number | null };
    if (Number(afterV2.version ?? 0) === 2) migrateReleaseIngestionV3(raw, appliedAt);
    const foreignKeyViolation = raw.prepare("PRAGMA foreign_key_check").get();
    if (foreignKeyViolation) throw new Error("release_ingestion_v3_foreign_key_check_failed");
    raw.exec("COMMIT");
  } catch (error) {
    if (raw.isTransaction) raw.exec("ROLLBACK");
    throw error;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON;");
  }
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

function safeUrl(name: string, value: unknown): string {
  const text = required(name, value, 2048);
  let parsed: URL;
  try { parsed = new URL(text); } catch { throw new Error(`${name}_unsafe`); }
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password ||
    BLOCKED_HOST.test(parsed.hostname) ||
    [...parsed.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))
  ) throw new Error(`${name}_unsafe`);
  return parsed.toString();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"")
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

function xmlTag(block: string, tag: string): string | undefined {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeXml(match[1]!) : undefined;
}

function xmlLink(block: string, atom: boolean): string | undefined {
  if (atom) {
    const match = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i);
    return match?.[1];
  }
  return xmlTag(block, "link");
}

function makeItem(input: {
  sourceUrl: unknown;
  sourceItemId: unknown;
  title: unknown;
  version?: unknown;
  publishedAt: unknown;
  observedAt: string;
  excerpt: unknown;
  excerptLocation: string;
  confidence: number;
  sdk?: SdkReleaseEvidence | null;
}): NormalizedItem {
  const excerpt = required("release_excerpt", input.excerpt, 20_000);
  return Object.freeze({
    sourceUrl: safeUrl("release_item_source_url", input.sourceUrl),
    sourceItemId: required("release_source_item_id", input.sourceItemId, 512),
    title: required("release_title", input.title, 512),
    version: input.version ? required("release_version", input.version, 128) : null,
    publishedAt: timestamp("release_published_at", input.publishedAt),
    observedAt: input.observedAt,
    excerpt,
    excerptLocation: required("release_excerpt_location", input.excerptLocation, 512),
    confidence: input.confidence,
    changeHints: Object.freeze(parseChangelogEntry(excerpt)),
    sdk: input.sdk ?? null,
  });
}

function parseXml(input: ReleaseDocumentInput, sourceUrl: string, observedAt: string): NormalizedItem[] {
  const trimmed = input.body.trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(trimmed)) throw new Error("release_xml_declaration_unsupported");
  const hasRss = /^<\?xml[\s\S]*?\?>\s*<rss\b|^<rss\b/i.test(trimmed);
  const hasAtom = /^<\?xml[\s\S]*?\?>\s*<feed\b|^<feed\b/i.test(trimmed);
  if ((hasRss && hasAtom) || (/<rss\b/i.test(trimmed) && /<feed\b/i.test(trimmed))) {
    throw new Error("release_xml_adapter_ambiguous");
  }
  const atom = input.adapter === "atom";
  if (atom ? (!hasAtom || !/<\/feed>\s*$/i.test(trimmed)) : (!hasRss || !/<\/rss>\s*$/i.test(trimmed))) {
    throw new Error("release_xml_malformed");
  }
  const tag = atom ? "entry" : "item";
  const openingCount = (trimmed.match(new RegExp(`<${tag}\\b`, "gi")) ?? []).length;
  const closingCount = (trimmed.match(new RegExp(`<\\/${tag}>`, "gi")) ?? []).length;
  if (openingCount !== closingCount) throw new Error("release_xml_malformed");
  const blocks = [...trimmed.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
  if (blocks.length === 0 || blocks.length > 100) throw new Error("release_xml_items_invalid");
  return blocks.map((match, index) => {
    const block = match[1]!;
    const itemUrl = safeUrl("release_item_source_url", xmlLink(block, atom) ?? sourceUrl);
    const id = xmlTag(block, atom ? "id" : "guid") ?? itemUrl;
    const excerpt = xmlTag(block, atom ? "summary" : "description") ?? xmlTag(block, "content");
    return makeItem({
      sourceUrl: itemUrl,
      sourceItemId: id,
      title: xmlTag(block, "title"),
      publishedAt: xmlTag(block, atom ? "updated" : "pubDate") ?? xmlTag(block, "published"),
      observedAt,
      excerpt,
      excerptLocation: `${atom ? "atom.feed.entry" : "rss.channel.item"}[${index}].${atom ? "summary" : "description"}`,
      confidence: 0.9,
    });
  });
}

function jsonDocument(body: string): unknown {
  try { return JSON.parse(body) as unknown; } catch { throw new Error("release_json_malformed"); }
}

function object(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(error);
  return value as Record<string, unknown>;
}

function parseGitHub(input: ReleaseDocumentInput, observedAt: string): NormalizedItem[] {
  const document = jsonDocument(input.body);
  if (!Array.isArray(document) || document.length === 0 || document.length > 100) {
    throw new Error("github_releases_invalid");
  }
  return document.map((value, index) => {
    const item = object(value, "github_release_invalid");
    return makeItem({
      sourceUrl: safeUrl("release_item_source_url", item.html_url),
      sourceItemId: String(item.id ?? ""),
      title: item.name ?? item.tag_name,
      version: typeof item.tag_name === "string" ? item.tag_name : null,
      publishedAt: item.published_at,
      observedAt,
      excerpt: item.body,
      excerptLocation: `github.release[${index}].body`,
      confidence: 0.95,
    });
  });
}

function attr(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`\\b${name}=["']([^"']+)["']`, "i"));
  return match?.[1];
}

function parseProviderPage(input: ReleaseDocumentInput, sourceUrl: string, observedAt: string): NormalizedItem[] {
  const articles = [...input.body.matchAll(/<article\b([^>]*)>([\s\S]*?)<\/article>/gi)];
  if (articles.length === 0 || articles.length > 100) throw new Error("provider_page_structure_unsupported");
  return articles.map((match, index) => {
    const attributes = match[1]!;
    const body = match[2]!;
    const canonical = body.match(/<a\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["'][^>]*>/i)?.[1]
      ?? body.match(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']canonical["'][^>]*>/i)?.[1]
      ?? sourceUrl;
    return makeItem({
      sourceUrl: canonical,
      sourceItemId: attr(attributes, "data-release-id"),
      title: xmlTag(body, "h2") ?? xmlTag(body, "h1"),
      publishedAt: attr(attributes, "data-published-at"),
      observedAt,
      excerpt: decodeXml(body.replace(/<h[12][^>]*>[\s\S]*?<\/h[12]>/i, "").replace(/<a\b[\s\S]*?<\/a>/gi, "")),
      excerptLocation: `provider_page.article[${index}]`,
      confidence: 0.75,
    });
  });
}

function exportKeys(manifest: Record<string, unknown>): string[] {
  const value = manifest.exports;
  if (typeof value === "string") return ["."];
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value as Record<string, unknown>).sort();
}

function stringProperty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nodeEngine(manifest: Record<string, unknown>): string | null {
  const engines = manifest.engines;
  return engines && typeof engines === "object" && !Array.isArray(engines)
    ? stringProperty((engines as Record<string, unknown>).node)
    : null;
}

function parseSdkRegistry(input: ReleaseDocumentInput, sourceUrl: string, observedAt: string): NormalizedItem[] {
  const root = object(jsonDocument(input.body), "sdk_registry_invalid");
  const packageName = required("sdk_package_name", root.name, 256);
  const tags = object(root["dist-tags"], "sdk_dist_tags_invalid");
  const latest = required("sdk_latest_version", tags.latest, 128);
  const versions = object(root.versions, "sdk_versions_invalid");
  if (Object.keys(versions).length > 10_000) throw new Error("sdk_versions_oversized");
  const current = versions[latest];
  if (!current) throw new Error("sdk_latest_version_missing");
  const currentManifest = object(current, "sdk_latest_manifest_invalid");
  if (currentManifest.name !== packageName || currentManifest.version !== latest) {
    throw new Error("sdk_latest_manifest_ambiguous");
  }
  const time = object(root.time, "sdk_release_times_invalid");
  const publishedAt = timestamp("sdk_published_at", time[latest]);
  const prior = Object.keys(versions)
    .filter((version) => version !== latest && typeof time[version] === "string" && Date.parse(String(time[version])) < Date.parse(publishedAt))
    .sort((left, right) => Date.parse(String(time[right])) - Date.parse(String(time[left])))[0] ?? null;
  const previousManifest = prior ? object(versions[prior], "sdk_previous_manifest_invalid") : null;
  const before = previousManifest ? exportKeys(previousManifest) : [];
  const after = exportKeys(currentManifest);
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  const previousNode = previousManifest ? nodeEngine(previousManifest) : null;
  const currentNode = nodeEngine(currentManifest);
  const emittedChanges: SdkReleaseChange[] = [
    ...removed.map((subject) => ({ kind: "export_removed" as const, subject, before: subject, after: null, breaking: true })),
    ...added.map((subject) => ({ kind: "export_added" as const, subject, before: null, after: subject, breaking: false })),
    ...(previousNode !== currentNode ? [{ kind: "runtime_changed" as const, subject: "node", before: previousNode, after: currentNode, breaking: previousNode !== null }] : []),
  ];
  const diff = Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed) });
  const sdk: SdkReleaseEvidence = Object.freeze({
    ecosystem: "npm",
    packageName,
    version: latest,
    previousVersion: prior,
    exportDiff: diff,
    clientDiff: Object.freeze({ source: "package_exports_proxy", ...diff }),
    runtimeCompatibility: Object.freeze({ previousNode, currentNode, changed: previousNode !== currentNode }),
    emittedChanges: Object.freeze(emittedChanges),
  });
  return [makeItem({
    sourceUrl,
    sourceItemId: `${packageName}@${latest}`,
    title: `${packageName} ${latest}`,
    version: latest,
    publishedAt,
    observedAt,
    excerpt: canonicalJson(currentManifest).slice(0, 20_000),
    excerptLocation: `npm.versions[${JSON.stringify(latest)}]`,
    confidence: 0.98,
    sdk,
  })];
}

function assertNoAmbiguity(items: readonly NormalizedItem[]): void {
  const seen = new Map<string, string>();
  for (const item of items) {
    const digest = sha256(canonicalJson(normalizedClaim(item)));
    const previous = seen.get(item.sourceItemId);
    if (previous && previous !== digest) throw new Error("release_source_item_ambiguous");
    if (previous) throw new Error("release_source_item_duplicate");
    seen.set(item.sourceItemId, digest);
  }
}

function one<T>(store: ReleaseIngestionStore, sql: string, params: SQLInputValue[] = []): T | undefined {
  return store.raw.prepare(sql).get(...params) as T | undefined;
}

function all<T>(store: ReleaseIngestionStore, sql: string, params: SQLInputValue[] = []): T[] {
  return store.raw.prepare(sql).all(...params) as T[];
}

export function openReleaseIngestionStore(
  dbPath = ":memory:",
  options: ReleaseIngestionStoreOptions = {},
): ReleaseIngestionStore {
  const path = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  try {
    configureReleaseIngestionConnection(raw);
    convergeReleaseIngestionSchema(raw, new Date().toISOString());
  } catch (error) {
    raw.close();
    throw error;
  }
  const clock = options.clock ?? (() => new Date().toISOString());
  const trustedNow = () => timestamp("release_store_clock", clock());
  return Object.freeze({ raw, path, trustedNow, close: () => raw.close() });
}

function latestOverride(store: ReleaseIngestionStore, tenantId: string, artifactId: string): ReleaseReviewerOverride | null {
  const row = one<OverrideRow>(store, `SELECT revision, reviewer_principal_id, confidence, excerpt,
    excerpt_location, reason, reviewed_at FROM release_ingestion_overrides
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY revision DESC LIMIT 1`, [tenantId, artifactId]);
  return row ? Object.freeze({
    revision: row.revision,
    reviewerPrincipalId: row.reviewer_principal_id,
    confidence: row.confidence,
    excerpt: row.excerpt,
    excerptLocation: row.excerpt_location,
    reason: row.reason,
    reviewedAt: row.reviewed_at,
  }) : null;
}

function fromRow(store: ReleaseIngestionStore, row: ArtifactRow): ReleaseArtifact {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    providerSlug: row.provider_slug,
    adapter: row.adapter,
    collectionUrl: row.collection_url,
    sourceUrl: row.source_url,
    sourceItemId: row.source_item_id,
    sourceBodySha256: row.source_body_sha256,
    contentSha256: row.content_sha256,
    normalizedClaimSha256: row.normalized_claim_sha256,
    identityCanonical: row.identity_canonical === 1,
    title: row.title,
    version: row.version,
    publishedAt: row.published_at,
    observedAt: row.observed_at,
    excerpt: row.excerpt,
    excerptLocation: row.excerpt_location,
    confidence: row.confidence,
    changeHints: Object.freeze(JSON.parse(row.change_hints_json) as ChangelogParseResult),
    sdk: row.sdk_json ? Object.freeze(JSON.parse(row.sdk_json) as SdkReleaseEvidence) : null,
    reviewerOverride: latestOverride(store, row.tenant_id, row.id),
    createdAt: row.created_at,
  });
}

export function listReleaseArtifacts(store: ReleaseIngestionStore, tenantId: string): ReleaseArtifact[] {
  const tenant = required("release_tenant_id", tenantId, 256);
  return all<ArtifactRow>(store, `SELECT * FROM release_ingestion_artifacts
    WHERE tenant_id = ? ORDER BY published_at DESC, id`, [tenant]).map((row) => fromRow(store, row));
}

function observationFromRow(row: ObservationRow): ReleaseObservation {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    observedAt: row.observed_at,
    sourceBodySha256: row.source_body_sha256,
    createdAt: row.created_at,
  });
}

function dispatchFromRow(row: DispatchRow): ReleaseDispatch {
  return Object.freeze({
    id: row.id,
    tenantId: row.tenant_id,
    artifactId: row.artifact_id,
    artifactContentSha256: row.artifact_content_sha256,
    status: row.status,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    leaseGeneration: row.lease_generation,
    claimedAt: row.claimed_at,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    completedAt: row.completed_at,
    failedAt: row.failed_at,
    failureCode: row.failure_code,
    lastFailureAt: row.last_failure_at,
    lastFailureCode: row.last_failure_code,
    createdAt: row.created_at,
  });
}

export function listReleaseObservations(
  store: ReleaseIngestionStore,
  tenantId: string,
  artifactId: string,
): ReleaseObservation[] {
  const tenant = required("release_tenant_id", tenantId, 256);
  const artifact = required("release_artifact_id", artifactId, 128);
  return all<ObservationRow>(store, `SELECT * FROM release_ingestion_observations
    WHERE tenant_id = ? AND artifact_id = ? ORDER BY observed_at, id`, [tenant, artifact])
    .map(observationFromRow);
}

export function listReleaseDispatches(store: ReleaseIngestionStore, tenantId: string): ReleaseDispatch[] {
  const tenant = required("release_tenant_id", tenantId, 256);
  return all<DispatchRow>(store, `SELECT * FROM release_ingestion_dispatches
    WHERE tenant_id = ? ORDER BY created_at, id`, [tenant]).map(dispatchFromRow);
}

export function ingestReleaseDocument(
  store: ReleaseIngestionStore,
  input: ReleaseDocumentInput,
): Readonly<{ artifacts: readonly ReleaseArtifact[]; inserted: number }> {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const providerSlug = required("release_provider_slug", input.providerSlug, 128);
  const sourceUrl = safeUrl("release_source_url", input.sourceUrl);
  if (typeof input.body !== "string" || !input.body.trim()) throw new Error("release_document_required");
  const body = input.body;
  if (Buffer.byteLength(body, "utf8") > (input.maxBytes ?? DEFAULT_MAX_BYTES)) throw new Error("release_document_too_large");
  const observedAt = timestamp("release_observed_at", input.observedAt);
  const now = timestamp("release_now", input.now ?? new Date().toISOString());
  const age = Date.parse(now) - Date.parse(observedAt);
  if (age < -MAX_CLOCK_SKEW_MS) throw new Error("release_document_from_future");
  if (age > (input.maxObservationAgeMs ?? DEFAULT_MAX_OBSERVATION_AGE_MS)) throw new Error("release_document_stale");
  const sourceBodySha256 = sha256(body);
  const items = input.adapter === "rss" || input.adapter === "atom"
    ? parseXml(input, sourceUrl, observedAt)
    : input.adapter === "github_releases"
      ? parseGitHub(input, observedAt)
      : input.adapter === "provider_page"
        ? parseProviderPage(input, sourceUrl, observedAt)
        : parseSdkRegistry(input, sourceUrl, observedAt);
  for (const item of items) {
    if (Date.parse(item.publishedAt) > Date.parse(now) + MAX_CLOCK_SKEW_MS) {
      throw new Error("release_published_at_future");
    }
  }
  assertNoAmbiguity(items);
  let inserted = 0;
  const ids: string[] = [];
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const normalizedClaimSha256 = sha256(canonicalJson(normalizedClaim(item)));
      const contentSha256 = normalizedClaimSha256;
      const id = releaseArtifactId({
        tenantId,
        providerSlug,
        adapter: input.adapter,
        collectionUrl: sourceUrl,
        sourceItemId: item.sourceItemId,
        normalizedClaimSha256,
      });
      const result = store.raw.prepare(`INSERT OR IGNORE INTO release_ingestion_artifacts
        (id, tenant_id, provider_slug, adapter, collection_url, source_url, source_item_id, source_body_sha256,
         content_sha256, normalized_claim_sha256, identity_canonical, title, version, published_at,
         observed_at, excerpt, excerpt_location, confidence, change_hints_json, sdk_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, providerSlug, input.adapter, sourceUrl, item.sourceUrl, item.sourceItemId,
          sourceBodySha256, contentSha256, normalizedClaimSha256, item.title, item.version, item.publishedAt, observedAt,
          item.excerpt, item.excerptLocation, item.confidence, canonicalJson(item.changeHints),
          item.sdk ? canonicalJson(item.sdk) : null, observedAt);
      if (Number(result.changes) === 1) inserted += 1;
      const row = one<{ id: string; content_sha256: string }>(store, `SELECT id, content_sha256
        FROM release_ingestion_artifacts
        WHERE tenant_id = ? AND provider_slug = ? AND adapter = ? AND collection_url = ?
          AND source_item_id = ? AND normalized_claim_sha256 = ? AND identity_canonical = 1`,
      [tenantId, providerSlug, input.adapter, sourceUrl, item.sourceItemId, normalizedClaimSha256]);
      if (!row) throw new Error("release_ingestion_write_failed");
      const observationId = releaseObservationId({
        tenantId,
        artifactId: row.id,
        observedAt,
        sourceBodySha256,
      });
      store.raw.prepare(`INSERT OR IGNORE INTO release_ingestion_observations
        (id, tenant_id, artifact_id, observed_at, source_body_sha256, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(observationId, tenantId, row.id, observedAt, sourceBodySha256, now);
      const observation = one<ObservationRow>(store,
        "SELECT * FROM release_ingestion_observations WHERE id = ?", [observationId]);
      if (
        !observation || observation.tenant_id !== tenantId || observation.artifact_id !== row.id ||
        observation.observed_at !== observedAt || observation.source_body_sha256 !== sourceBodySha256
      ) throw new Error("release_observation_write_failed");
      const dispatchId = releaseDispatchId(tenantId, row.id, row.content_sha256);
      store.raw.prepare(`INSERT OR IGNORE INTO release_ingestion_dispatches
        (id, tenant_id, artifact_id, artifact_content_sha256, status, available_at,
         lease_generation, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, 0, ?)`)
        .run(dispatchId, tenantId, row.id, row.content_sha256, observedAt, now);
      const dispatch = one<DispatchRow>(store,
        "SELECT * FROM release_ingestion_dispatches WHERE id = ?", [dispatchId]);
      if (
        !dispatch || dispatch.tenant_id !== tenantId || dispatch.artifact_id !== row.id ||
        dispatch.artifact_content_sha256 !== row.content_sha256
      ) throw new Error("release_dispatch_write_failed");
      ids.push(row.id);
    }
    store.raw.exec("COMMIT");
  } catch (error) {
    store.raw.exec("ROLLBACK");
    throw error;
  }
  const artifacts = ids.map((id) => fromRow(store, one<ArtifactRow>(store,
    "SELECT * FROM release_ingestion_artifacts WHERE tenant_id = ? AND id = ?", [tenantId, id])!));
  return Object.freeze({ artifacts: Object.freeze(artifacts), inserted });
}

type ReleaseReviewerOverrideInput = Readonly<{
  tenantId: string;
  artifactId: string;
  expectedRevision: number;
  reviewerPrincipalId: string;
  confidence: number;
  excerpt: string;
  excerptLocation: string;
  reason: string;
  reviewedAt: string;
}>;

export function recordReleaseReviewerOverrideCas(
  store: ReleaseIngestionStore,
  input: ReleaseReviewerOverrideInput,
): ReleaseReviewerOverrideResult {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const artifactId = required("release_artifact_id", input.artifactId, 128);
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("release_override_revision_invalid");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("release_override_confidence_invalid");
  const reviewerPrincipalId = required("release_reviewer_principal", input.reviewerPrincipalId, 256);
  const excerpt = required("release_override_excerpt", input.excerpt, 20_000);
  const excerptLocation = required("release_override_excerpt_location", input.excerptLocation, 512);
  const reason = required("release_override_reason", input.reason, 4000);
  const reviewedAt = timestamp("release_reviewed_at", input.reviewedAt);
  const ownsTransaction = !store.raw.isTransaction;
  if (ownsTransaction) store.raw.exec("BEGIN IMMEDIATE");
  try {
    const artifact = one<ArtifactRow>(store,
      "SELECT * FROM release_ingestion_artifacts WHERE tenant_id = ? AND id = ?", [tenantId, artifactId]);
    if (!artifact) throw new Error("release_artifact_not_found");
    const current = one<{ revision: number | null }>(store, `SELECT MAX(revision) AS revision
      FROM release_ingestion_overrides WHERE tenant_id = ? AND artifact_id = ?`, [tenantId, artifactId]);
    const revision = Number(current?.revision ?? 0);
    if (revision !== input.expectedRevision) {
      if (ownsTransaction) store.raw.exec("COMMIT");
      return Object.freeze({
        status: "revision_conflict" as const,
        expectedRevision: input.expectedRevision,
        actualRevision: revision,
      });
    }
    const next = revision + 1;
    store.raw.prepare(`INSERT INTO release_ingestion_overrides
      (id, tenant_id, artifact_id, revision, reviewer_principal_id, confidence, excerpt,
       excerpt_location, reason, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(`rov_${sha256(`${tenantId}:${artifactId}:${next}`).slice(0, 32)}`, tenantId, artifactId, next,
        reviewerPrincipalId, input.confidence, excerpt, excerptLocation, reason, reviewedAt);
    const applied = fromRow(store, artifact);
    if (ownsTransaction) store.raw.exec("COMMIT");
    return Object.freeze({ status: "applied" as const, artifact: applied });
  } catch (error) {
    if (ownsTransaction && store.raw.isTransaction) store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function recordReleaseReviewerOverride(
  store: ReleaseIngestionStore,
  input: ReleaseReviewerOverrideInput,
): ReleaseArtifact {
  const result = recordReleaseReviewerOverrideCas(store, input);
  if (result.status === "revision_conflict") throw new Error("release_override_revision_conflict");
  return result.artifact;
}

function contentDigest(value: unknown): string {
  const digest = required("release_content_sha256", value, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("release_content_sha256_invalid");
  return digest;
}

function leaseGeneration(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("release_dispatch_lease_generation_invalid");
  return Number(value);
}

function advanceReleaseClock(store: ReleaseIngestionStore): string {
  if (!store.raw.isTransaction) throw new Error("release_store_clock_transaction_required");
  const now = store.trustedNow();
  const authority = one<{ watermark_at: string }>(store,
    "SELECT watermark_at FROM release_ingestion_clock_authority WHERE singleton_id = 1");
  if (authority && now < authority.watermark_at) throw new Error("release_store_clock_rollback");
  if (!authority) {
    store.raw.prepare(`INSERT INTO release_ingestion_clock_authority (singleton_id, watermark_at)
      VALUES (1, ?)`).run(now);
  } else if (now > authority.watermark_at) {
    const changed = store.raw.prepare(`UPDATE release_ingestion_clock_authority SET watermark_at = ?
      WHERE singleton_id = 1 AND watermark_at = ?`).run(now, authority.watermark_at);
    if (Number(changed.changes) !== 1) throw new Error("release_store_clock_write_failed");
  }
  return now;
}

export function rehydrateReleaseArtifact(
  store: ReleaseIngestionStore,
  input: Readonly<{ tenantId: string; artifactId: string; expectedContentSha256: string }>,
): ReleaseArtifact {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const artifactId = required("release_artifact_id", input.artifactId, 128);
  const expectedContentSha256 = contentDigest(input.expectedContentSha256);
  const artifact = one<ArtifactRow>(store,
    "SELECT * FROM release_ingestion_artifacts WHERE tenant_id = ? AND id = ?", [tenantId, artifactId]);
  if (!artifact) throw new Error("release_artifact_not_found");
  if (artifact.content_sha256 !== expectedContentSha256) throw new Error("release_artifact_digest_mismatch");
  return fromRow(store, artifact);
}

export function claimReleaseDispatch(
  store: ReleaseIngestionStore,
  input: Readonly<{ tenantId: string; workerId: string; leaseDurationMs: number }>,
): ReleaseDispatch | null {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const workerId = required("release_dispatch_worker_id", input.workerId, 256);
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 1 || input.leaseDurationMs > 86_400_000) {
    throw new Error("release_dispatch_lease_duration_invalid");
  }
  if (store.raw.isTransaction) throw new Error("release_dispatch_transaction_active");
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const now = advanceReleaseClock(store);
    const leaseExpiresAt = new Date(Date.parse(now) + input.leaseDurationMs).toISOString();
    store.raw.prepare(`UPDATE release_ingestion_dispatches
      SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          failed_at = ?, failure_code = 'dispatch_attempts_exhausted',
          last_failure_at = ?, last_failure_code = 'dispatch_attempts_exhausted'
      WHERE tenant_id = ? AND status = 'claimed' AND lease_expires_at <= ?
        AND attempt_count >= max_attempts`)
      .run(now, now, tenantId, now);
    const candidate = one<{ id: string }>(store, `SELECT id FROM release_ingestion_dispatches
      WHERE tenant_id = ? AND available_at <= ?
        AND attempt_count < max_attempts
        AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))
      ORDER BY available_at, id LIMIT 1`, [tenantId, now, now]);
    if (!candidate) {
      store.raw.exec("COMMIT");
      return null;
    }
    const changed = store.raw.prepare(`UPDATE release_ingestion_dispatches
      SET status = 'claimed', lease_owner = ?, lease_expires_at = ?,
          lease_generation = lease_generation + 1, claimed_at = ?, attempt_count = attempt_count + 1
      WHERE tenant_id = ? AND id = ? AND available_at <= ? AND attempt_count < max_attempts
        AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= ?))`)
      .run(workerId, leaseExpiresAt, now, tenantId, candidate.id, now, now);
    if (Number(changed.changes) !== 1) throw new Error("release_dispatch_claim_conflict");
    const claimed = one<DispatchRow>(store,
      "SELECT * FROM release_ingestion_dispatches WHERE tenant_id = ? AND id = ?", [tenantId, candidate.id]);
    if (!claimed) throw new Error("release_dispatch_claim_failed");
    store.raw.exec("COMMIT");
    return dispatchFromRow(claimed);
  } catch (error) {
    if (store.raw.isTransaction) store.raw.exec("ROLLBACK");
    throw error;
  }
}

function dispatchRetryDelayMs(attemptCount: number): number {
  const exponent = Math.max(0, Math.min(attemptCount - 1, 20));
  return Math.min(DISPATCH_RETRY_BASE_MS * (2 ** exponent), DISPATCH_RETRY_MAX_MS);
}

function finishReleaseDispatch(
  store: ReleaseIngestionStore,
  input: Readonly<{
    tenantId: string;
    dispatchId: string;
    workerId: string;
    leaseGeneration: number;
    status: "completed" | "failed";
    failureCode: string | null;
    retryable: boolean;
  }>,
): ReleaseDispatch {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const dispatchId = required("release_dispatch_id", input.dispatchId, 128);
  const workerId = required("release_dispatch_worker_id", input.workerId, 256);
  const generation = leaseGeneration(input.leaseGeneration);
  const failureCode = input.failureCode === null
    ? null
    : required("release_dispatch_failure_code", input.failureCode, 256);
  if (store.raw.isTransaction) throw new Error("release_dispatch_transaction_active");
  store.raw.exec("BEGIN IMMEDIATE");
  try {
    const finishedAt = advanceReleaseClock(store);
    const current = one<DispatchRow>(store,
      "SELECT * FROM release_ingestion_dispatches WHERE tenant_id = ? AND id = ?", [tenantId, dispatchId]);
    if (
      !current || current.status !== "claimed" || current.lease_owner !== workerId ||
      current.lease_generation !== generation || !current.claimed_at || !current.lease_expires_at ||
      finishedAt < current.claimed_at || current.lease_expires_at <= finishedAt
    ) {
      store.raw.exec("COMMIT");
      throw new Error("release_dispatch_lease_lost");
    }
    const retrying = input.status === "failed" && input.retryable && current.attempt_count < current.max_attempts;
    const nextStatus: ReleaseDispatchStatus = retrying ? "pending" : input.status;
    const availableAt = retrying
      ? new Date(Date.parse(finishedAt) + dispatchRetryDelayMs(current.attempt_count)).toISOString()
      : current.available_at;
    const changed = store.raw.prepare(`UPDATE release_ingestion_dispatches
      SET status = ?, available_at = ?, lease_owner = NULL, lease_expires_at = NULL,
          completed_at = ?, failed_at = ?, failure_code = ?,
          last_failure_at = ?, last_failure_code = ?
      WHERE tenant_id = ? AND id = ? AND status = 'claimed' AND lease_owner = ?
        AND lease_generation = ? AND claimed_at <= ? AND lease_expires_at > ?`)
      .run(nextStatus, availableAt, input.status === "completed" ? finishedAt : null,
        input.status === "failed" && !retrying ? finishedAt : null,
        input.status === "failed" && !retrying ? failureCode : null,
        input.status === "failed" ? finishedAt : current.last_failure_at,
        input.status === "failed" ? failureCode : current.last_failure_code,
        tenantId, dispatchId, workerId, generation, finishedAt, finishedAt);
    if (Number(changed.changes) !== 1) throw new Error("release_dispatch_lease_lost");
    const dispatch = one<DispatchRow>(store,
      "SELECT * FROM release_ingestion_dispatches WHERE tenant_id = ? AND id = ?", [tenantId, dispatchId]);
    if (!dispatch) throw new Error("release_dispatch_not_found");
    store.raw.exec("COMMIT");
    return dispatchFromRow(dispatch);
  } catch (error) {
    if (store.raw.isTransaction) store.raw.exec("ROLLBACK");
    throw error;
  }
}

export function completeReleaseDispatch(
  store: ReleaseIngestionStore,
  input: Readonly<{
    tenantId: string;
    dispatchId: string;
    workerId: string;
    leaseGeneration: number;
  }>,
): ReleaseDispatch {
  return finishReleaseDispatch(store, {
    ...input,
    status: "completed",
    failureCode: null,
    retryable: false,
  });
}

export function failReleaseDispatch(
  store: ReleaseIngestionStore,
  input: Readonly<{
    tenantId: string;
    dispatchId: string;
    workerId: string;
    leaseGeneration: number;
    failureCode: string;
    retryable: boolean;
  }>,
): ReleaseDispatch {
  return finishReleaseDispatch(store, {
    ...input,
    status: "failed",
    failureCode: input.failureCode,
    retryable: input.retryable,
  });
}
