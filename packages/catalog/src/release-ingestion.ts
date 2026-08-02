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

export type ReleaseIngestionStore = Readonly<{
  raw: DatabaseSync;
  path: string;
  close: () => void;
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

type NormalizedItem = Omit<ReleaseArtifact, "id" | "tenantId" | "providerSlug" | "adapter" | "collectionUrl" | "sourceBodySha256" | "contentSha256" | "reviewerOverride" | "createdAt">;

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
const BLOCKED_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|::1|10(?:\.\d{1,3}){3}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|192\.168(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2})$/i;
const SENSITIVE_QUERY = /^(?:access_?token|api_?key|authorization|credential|password|private_?key|secret|signature|token)$/i;

const MIGRATION = `
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
    const digest = sha256(canonicalJson(item));
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

export function openReleaseIngestionStore(dbPath = ":memory:"): ReleaseIngestionStore {
  const path = dbPath === ":memory:" ? dbPath : resolve(dbPath);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
  raw.exec(`CREATE TABLE IF NOT EXISTS release_ingestion_schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
  )`);
  const current = raw.prepare("SELECT MAX(version) AS version FROM release_ingestion_schema_migrations").get() as { version: number | null };
  if (Number(current.version ?? 0) > 1) throw new Error("release_ingestion_schema_newer_than_runtime");
  if (Number(current.version ?? 0) === 0) {
    raw.exec("BEGIN IMMEDIATE");
    try {
      raw.exec(MIGRATION);
      raw.prepare("INSERT INTO release_ingestion_schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(new Date().toISOString());
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
  }
  return Object.freeze({ raw, path, close: () => raw.close() });
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
      const contentSha256 = sha256(canonicalJson(item));
      const id = `rel_${sha256(canonicalJson({ tenantId, adapter: input.adapter, sourceUrl: item.sourceUrl, sourceItemId: item.sourceItemId, contentSha256 })).slice(0, 32)}`;
      const result = store.raw.prepare(`INSERT OR IGNORE INTO release_ingestion_artifacts
        (id, tenant_id, provider_slug, adapter, collection_url, source_url, source_item_id, source_body_sha256,
         content_sha256, title, version, published_at, observed_at, excerpt, excerpt_location,
         confidence, change_hints_json, sdk_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, tenantId, providerSlug, input.adapter, sourceUrl, item.sourceUrl, item.sourceItemId,
          sourceBodySha256, contentSha256, item.title, item.version, item.publishedAt, observedAt,
          item.excerpt, item.excerptLocation, item.confidence, canonicalJson(item.changeHints),
          item.sdk ? canonicalJson(item.sdk) : null, observedAt);
      if (Number(result.changes) === 1) inserted += 1;
      const row = one<{ id: string }>(store, `SELECT id FROM release_ingestion_artifacts
        WHERE tenant_id = ? AND adapter = ? AND collection_url = ? AND source_item_id = ? AND content_sha256 = ?`,
      [tenantId, input.adapter, sourceUrl, item.sourceItemId, contentSha256]);
      if (!row) throw new Error("release_ingestion_write_failed");
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

export function recordReleaseReviewerOverride(
  store: ReleaseIngestionStore,
  input: Readonly<{
    tenantId: string;
    artifactId: string;
    expectedRevision: number;
    reviewerPrincipalId: string;
    confidence: number;
    excerpt: string;
    excerptLocation: string;
    reason: string;
    reviewedAt: string;
  }>,
): ReleaseArtifact {
  const tenantId = required("release_tenant_id", input.tenantId, 256);
  const artifactId = required("release_artifact_id", input.artifactId, 128);
  const artifact = one<ArtifactRow>(store, "SELECT * FROM release_ingestion_artifacts WHERE tenant_id = ? AND id = ?", [tenantId, artifactId]);
  if (!artifact) throw new Error("release_artifact_not_found");
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("release_override_revision_invalid");
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("release_override_confidence_invalid");
  const current = one<{ revision: number | null }>(store, `SELECT MAX(revision) AS revision
    FROM release_ingestion_overrides WHERE tenant_id = ? AND artifact_id = ?`, [tenantId, artifactId]);
  const revision = Number(current?.revision ?? 0);
  if (revision !== input.expectedRevision) throw new Error("release_override_revision_conflict");
  const next = revision + 1;
  store.raw.prepare(`INSERT INTO release_ingestion_overrides
    (id, tenant_id, artifact_id, revision, reviewer_principal_id, confidence, excerpt,
     excerpt_location, reason, reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(`rov_${sha256(`${tenantId}:${artifactId}:${next}`).slice(0, 32)}`, tenantId, artifactId, next,
      required("release_reviewer_principal", input.reviewerPrincipalId, 256), input.confidence,
      required("release_override_excerpt", input.excerpt, 20_000),
      required("release_override_excerpt_location", input.excerptLocation, 512),
      required("release_override_reason", input.reason, 4000),
      timestamp("release_reviewed_at", input.reviewedAt));
  return fromRow(store, artifact);
}
