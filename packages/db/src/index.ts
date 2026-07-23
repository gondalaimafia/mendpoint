import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { newId, nowIso } from "@mendpoint/shared";
import type {
  ApiChange,
  ApiKeyRow,
  ApiVersion,
  AuditEvent,
  Consumer,
  ConsumerRepo,
  FeedPollRow,
  GitHubInstallationRow,
  ImpactFindingRow,
  MigrationPrRow,
  MonitoredApi,
  Provider,
  TenantRow,
} from "./schema.js";

export type * from "./schema.js";

export type AppDb = {
  raw: DatabaseSync;
};

/** Walk up from cwd to find monorepo root (package name mendpoint). */
export function findMonorepoRoot(start = process.cwd()): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (pkg.name === "mendpoint") return dir;
      } catch {
        /* continue */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}


const DDL = `
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  website TEXT,
  openapi_url TEXT,
  changelog_url TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_versions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  version_label TEXT NOT NULL,
  openapi_json TEXT NOT NULL,
  changelog_md TEXT,
  published_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_changes (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  from_version_id TEXT NOT NULL REFERENCES api_versions(id),
  to_version_id TEXT NOT NULL REFERENCES api_versions(id),
  risk TEXT NOT NULL,
  summary TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'recommended',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_type_idx ON jobs(type);

-- Agentic repair sessions
CREATE TABLE IF NOT EXISTS repair_sessions (
  id TEXT PRIMARY KEY,
  consumer_id TEXT,
  repo_path TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  edits_count INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  report_md TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS repair_sessions_created_idx ON repair_sessions(created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  status TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  steps INTEGER NOT NULL DEFAULT 0,
  files_changed_json TEXT,
  report_md TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_created_idx ON agent_runs(created_at);

CREATE INDEX IF NOT EXISTS api_changes_provider_idx ON api_changes(provider_id);
CREATE TABLE IF NOT EXISTS consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  installation_id TEXT,
  tenant_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consumer_repos (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  local_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS monitored_apis (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  provider_id TEXT NOT NULL REFERENCES providers(id),
  detection_source TEXT NOT NULL DEFAULT 'manual'
);
CREATE TABLE IF NOT EXISTS impact_findings (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES api_changes(id),
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  file_path TEXT NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  confidence TEXT NOT NULL,
  evidence_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS impact_findings_change_idx ON impact_findings(change_id);
CREATE TABLE IF NOT EXISTS migration_prs (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES api_changes(id),
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL,
  risk TEXT NOT NULL,
  patch_unified TEXT NOT NULL,
  github_pr_number INTEGER,
  github_pr_url TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS migration_prs_status_idx ON migration_prs(status);
CREATE INDEX IF NOT EXISTS migration_prs_change_idx ON migration_prs(change_id);
CREATE INDEX IF NOT EXISTS migration_prs_consumer_idx ON migration_prs(consumer_id);
CREATE INDEX IF NOT EXISTS impact_findings_consumer_idx ON impact_findings(consumer_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS suppressed_patterns (
  id TEXT PRIMARY KEY,
  consumer_id TEXT,
  provider_slug TEXT,
  pattern TEXT NOT NULL,
  reason TEXT,
  source_pr_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS suppressed_patterns_consumer_idx ON suppressed_patterns(consumer_id);
CREATE INDEX IF NOT EXISTS suppressed_patterns_pattern_idx ON suppressed_patterns(pattern);

-- Phase D: multi-tenant API keys (hashed secrets)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  scopes_json TEXT NOT NULL DEFAULT '["*"]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys(tenant_id);

-- Phase D: continuous feed poll ledger
CREATE TABLE IF NOT EXISTS feed_polls (
  id TEXT PRIMARY KEY,
  provider_slug TEXT NOT NULL,
  openapi_url TEXT NOT NULL,
  content_hash TEXT,
  version_label TEXT,
  status TEXT NOT NULL,
  error TEXT,
  version_id TEXT,
  pipeline_change_id TEXT,
  polled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_polls_slug_idx ON feed_polls(provider_slug);
CREATE INDEX IF NOT EXISTS feed_polls_polled_idx ON feed_polls(polled_at);

-- Phase E: multi-tenant orgs + plans
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  billing_status TEXT NOT NULL DEFAULT 'active',
  seat_limit INTEGER NOT NULL DEFAULT 3,
  created_at TEXT NOT NULL
);

-- Phase E: GitHub App installations
CREATE TABLE IF NOT EXISTS github_installations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Organization',
  tenant_id TEXT,
  permissions_json TEXT,
  repositories_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_tenant_idx ON github_installations(tenant_id);
CREATE INDEX IF NOT EXISTS github_installations_login_idx ON github_installations(account_login);
`;


export function resolveDbPath(urlOrPath?: string): string {
  const root = findMonorepoRoot();
  const fallback = join(root, "data", "mendpoint.sqlite");
  const raw = urlOrPath ?? process.env.DATABASE_URL;
  if (!raw) return fallback;

  const pathPart = raw.startsWith("file:") ? raw.slice("file:".length) : raw;
  if (pathPart.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathPart)) {
    return resolve(pathPart);
  }
  // Prefer monorepo root for relative paths so API/worker/scripts share one DB
  return resolve(root, pathPart);
}



export function createDb(urlOrPath?: string): AppDb {
  const path = resolveDbPath(urlOrPath);
  mkdirSync(dirname(path), { recursive: true });
  const raw = new DatabaseSync(path);
  // Reliability + concurrent reader/writer friendliness on Windows
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA synchronous = NORMAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  raw.exec("PRAGMA temp_store = MEMORY;");
  raw.exec(DDL);
  migrateProvidersFeedColumns({ raw });
  return { raw };
}

/** Additive columns for Phase D feed URLs + Phase E tenant on consumers. */
function migrateProvidersFeedColumns(db: AppDb) {
  const pcols = all<{ name: string }>(db, `PRAGMA table_info(providers)`).map((c) => c.name);
  if (!pcols.includes("openapi_url")) {
    run(db, `ALTER TABLE providers ADD COLUMN openapi_url TEXT`);
  }
  if (!pcols.includes("changelog_url")) {
    run(db, `ALTER TABLE providers ADD COLUMN changelog_url TEXT`);
  }
  const ccols = all<{ name: string }>(db, `PRAGMA table_info(consumers)`).map((c) => c.name);
  if (!ccols.includes("tenant_id")) {
    run(db, `ALTER TABLE consumers ADD COLUMN tenant_id TEXT`);
  }
  const chcols = all<{ name: string }>(db, `PRAGMA table_info(api_changes)`).map((c) => c.name);
  if (!chcols.includes("severity")) {
    run(db, `ALTER TABLE api_changes ADD COLUMN severity TEXT DEFAULT 'recommended'`);
  }
  // Ensure default tenant exists
  const t = get<{ id: string }>(db, `SELECT id FROM tenants WHERE slug = 'default'`);
  if (!t) {
    run(
      db,
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES (?, 'default', 'Default workspace', 'free', 'active', 3, ?)`,
      ["tenant_default", new Date().toISOString()],
    );
  }
}

function all<T>(db: AppDb, sql: string, params: unknown[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function get<T>(db: AppDb, sql: string, params: unknown[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function run(db: AppDb, sql: string, params: unknown[] = []): void {
  db.raw.prepare(sql).run(...params);
}

export function recordAudit(
  db: AppDb,
  input: {
    actor: string;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: unknown;
  },
) {
  run(
    db,
    `INSERT INTO audit_events (id, actor, action, resource_type, resource_id, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      input.actor,
      input.action,
      input.resourceType,
      input.resourceId ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      nowIso(),
    ],
  );
}

export function insertProvider(
  db: AppDb,
  row: {
    id: string;
    slug: string;
    name: string;
    website?: string | null;
    openapiUrl?: string | null;
    changelogUrl?: string | null;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO providers (id, slug, name, website, openapi_url, changelog_url, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.name,
      row.website ?? null,
      row.openapiUrl ?? null,
      row.changelogUrl ?? null,
      row.createdAt,
    ],
  );
}

export function updateProviderFeedUrls(
  db: AppDb,
  slug: string,
  urls: { openapiUrl?: string | null; changelogUrl?: string | null },
) {
  if (urls.openapiUrl !== undefined) {
    run(db, `UPDATE providers SET openapi_url = ? WHERE slug = ?`, [urls.openapiUrl, slug]);
  }
  if (urls.changelogUrl !== undefined) {
    run(db, `UPDATE providers SET changelog_url = ? WHERE slug = ?`, [
      urls.changelogUrl,
      slug,
    ]);
  }
}

export function insertApiVersion(
  db: AppDb,
  row: {
    id: string;
    providerId: string;
    versionLabel: string;
    openapiJson: string;
    changelogMd?: string | null;
    publishedAt: string;
  },
) {
  run(
    db,
    `INSERT INTO api_versions (id, provider_id, version_label, openapi_json, changelog_md, published_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.providerId,
      row.versionLabel,
      row.openapiJson,
      row.changelogMd ?? null,
      row.publishedAt,
    ],
  );
}

export function insertConsumer(
  db: AppDb,
  row: {
    id: string;
    name: string;
    githubOwner: string;
    githubRepo: string;
    installationId?: string | null;
    tenantId?: string | null;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO consumers (id, name, github_owner, github_repo, installation_id, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.githubOwner,
      row.githubRepo,
      row.installationId ?? null,
      row.tenantId ?? "tenant_default",
      row.createdAt,
    ],
  );
}

export function insertConsumerRepo(
  db: AppDb,
  row: {
    id: string;
    consumerId: string;
    localPath: string;
    defaultBranch?: string;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO consumer_repos (id, consumer_id, local_path, default_branch, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [row.id, row.consumerId, row.localPath, row.defaultBranch ?? "main", row.createdAt],
  );
}

export function insertMonitoredApi(
  db: AppDb,
  row: {
    id: string;
    consumerId: string;
    providerId: string;
    detectionSource?: string;
  },
) {
  run(
    db,
    `INSERT INTO monitored_apis (id, consumer_id, provider_id, detection_source) VALUES (?, ?, ?, ?)`,
    [row.id, row.consumerId, row.providerId, row.detectionSource ?? "manual"],
  );
}

export function insertPolicy(
  db: AppDb,
  row: { id: string; consumerId: string; key: string; valueJson: string },
) {
  run(db, `INSERT INTO policies (id, consumer_id, key, value_json) VALUES (?, ?, ?, ?)`, [
    row.id,
    row.consumerId,
    row.key,
    row.valueJson,
  ]);
}

export function insertApiChange(
  db: AppDb,
  row: {
    id: string;
    providerId: string;
    fromVersionId: string;
    toVersionId: string;
    risk: string;
    summary: string;
    diffJson: string;
    severity?: string;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO api_changes (id, provider_id, from_version_id, to_version_id, risk, summary, diff_json, severity, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.providerId,
      row.fromVersionId,
      row.toVersionId,
      row.risk,
      row.summary,
      row.diffJson,
      row.severity ?? "recommended",
      row.createdAt,
    ],
  );
}

export function updateChangeSeverity(db: AppDb, changeId: string, severity: string) {
  run(db, `UPDATE api_changes SET severity = ? WHERE id = ?`, [severity, changeId]);
}

export function insertImpactFinding(
  db: AppDb,
  row: {
    id: string;
    changeId: string;
    consumerId: string;
    filePath: string;
    lineStart: number;
    lineEnd: number;
    symbol: string;
    confidence: string;
    evidenceJson: string;
  },
) {
  run(
    db,
    `INSERT INTO impact_findings (id, change_id, consumer_id, file_path, line_start, line_end, symbol, confidence, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.changeId,
      row.consumerId,
      row.filePath,
      row.lineStart,
      row.lineEnd,
      row.symbol,
      row.confidence,
      row.evidenceJson,
    ],
  );
}

export function insertMigrationPr(
  db: AppDb,
  row: {
    id: string;
    changeId: string;
    consumerId: string;
    title: string;
    body: string;
    branchName: string;
    status: string;
    risk: string;
    patchUnified: string;
    githubPrNumber?: number | null;
    githubPrUrl?: string | null;
    createdAt: string;
    resolvedAt?: string | null;
  },
) {
  run(
    db,
    `INSERT INTO migration_prs (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified, github_pr_number, github_pr_url, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.changeId,
      row.consumerId,
      row.title,
      row.body,
      row.branchName,
      row.status,
      row.risk,
      row.patchUnified,
      row.githubPrNumber ?? null,
      row.githubPrUrl ?? null,
      row.createdAt,
      row.resolvedAt ?? null,
    ],
  );
}

export function updateMigrationPrStatus(
  db: AppDb,
  id: string,
  status: string,
  resolvedAt: string | null,
) {
  run(db, `UPDATE migration_prs SET status = ?, resolved_at = ? WHERE id = ?`, [
    status,
    resolvedAt,
    id,
  ]);
}

export function listProviders(db: AppDb): Provider[] {
  return all(db, `SELECT * FROM providers ORDER BY created_at`);
}

export function getProviderBySlug(db: AppDb, slug: string): Provider | undefined {
  return get(db, `SELECT * FROM providers WHERE slug = ?`, [slug]);
}

export function listChanges(db: AppDb): ApiChange[] {
  return all(db, `SELECT * FROM api_changes ORDER BY created_at DESC`);
}

export function getChange(db: AppDb, id: string): ApiChange | undefined {
  return get(db, `SELECT * FROM api_changes WHERE id = ?`, [id]);
}

export function listConsumers(db: AppDb): Consumer[] {
  return all(db, `SELECT * FROM consumers ORDER BY created_at`);
}

export function listPrs(db: AppDb): MigrationPrRow[] {
  return all(db, `SELECT * FROM migration_prs ORDER BY created_at DESC`);
}

export function listPrsForChange(db: AppDb, changeId: string): MigrationPrRow[] {
  return all(
    db,
    `SELECT * FROM migration_prs WHERE change_id = ? ORDER BY created_at DESC`,
    [changeId],
  );
}

export function getPr(db: AppDb, id: string): MigrationPrRow | undefined {
  return get(db, `SELECT * FROM migration_prs WHERE id = ?`, [id]);
}

export function listAudit(db: AppDb): AuditEvent[] {
  return all(db, `SELECT * FROM audit_events ORDER BY created_at DESC`);
}

export function listFindingsForChange(db: AppDb, changeId: string): ImpactFindingRow[] {
  return all(db, `SELECT * FROM impact_findings WHERE change_id = ?`, [changeId]);
}

export function listVersionsForProvider(db: AppDb, providerId: string): ApiVersion[] {
  return all(db, `SELECT * FROM api_versions WHERE provider_id = ? ORDER BY published_at`, [
    providerId,
  ]);
}

export function listMonitoredForProvider(db: AppDb, providerId: string): MonitoredApi[] {
  return all(db, `SELECT * FROM monitored_apis WHERE provider_id = ?`, [providerId]);
}

export function listMonitoredForConsumer(db: AppDb, consumerId: string): MonitoredApi[] {
  return all(db, `SELECT * FROM monitored_apis WHERE consumer_id = ?`, [consumerId]);
}

export function getConsumerRepo(db: AppDb, consumerId: string): ConsumerRepo | undefined {
  return get(db, `SELECT * FROM consumer_repos WHERE consumer_id = ?`, [consumerId]);
}

export function getConsumer(db: AppDb, id: string): Consumer | undefined {
  return get(db, `SELECT * FROM consumers WHERE id = ?`, [id]);
}

export function listPoliciesForConsumer(db: AppDb, consumerId: string) {
  return all<{ id: string; consumer_id: string; key: string; value_json: string }>(
    db,
    `SELECT * FROM policies WHERE consumer_id = ?`,
    [consumerId],
  );
}

export function getPoliciesMap(db: AppDb, consumerId: string): Record<string, unknown> {
  const rows = listPoliciesForConsumer(db, consumerId);
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value_json);
    } catch {
      out[r.key] = r.value_json;
    }
  }
  return out;
}

export { computeProductMetrics } from "./metrics.js";
export type { ProductMetrics } from "./metrics.js";

export type SuppressedPattern = {
  id: string;
  consumer_id: string | null;
  provider_slug: string | null;
  pattern: string;
  reason: string | null;
  source_pr_id: string | null;
  created_at: string;
};

export function insertSuppressedPattern(
  db: AppDb,
  row: {
    id: string;
    consumerId?: string | null;
    providerSlug?: string | null;
    pattern: string;
    reason?: string | null;
    sourcePrId?: string | null;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO suppressed_patterns (id, consumer_id, provider_slug, pattern, reason, source_pr_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.consumerId ?? null,
      row.providerSlug ?? null,
      row.pattern,
      row.reason ?? null,
      row.sourcePrId ?? null,
      row.createdAt,
    ],
  );
}

export function listSuppressedPatterns(
  db: AppDb,
  opts?: { consumerId?: string; providerSlug?: string },
): SuppressedPattern[] {
  if (opts?.consumerId && opts?.providerSlug) {
    return all(
      db,
      `SELECT * FROM suppressed_patterns WHERE consumer_id = ? OR provider_slug = ? OR consumer_id IS NULL ORDER BY created_at DESC`,
      [opts.consumerId, opts.providerSlug],
    );
  }
  if (opts?.consumerId) {
    return all(
      db,
      `SELECT * FROM suppressed_patterns WHERE consumer_id = ? OR consumer_id IS NULL ORDER BY created_at DESC`,
      [opts.consumerId],
    );
  }
  return all(db, `SELECT * FROM suppressed_patterns ORDER BY created_at DESC`);
}

export function isPatternSuppressed(
  db: AppDb,
  pattern: string,
  opts?: { consumerId?: string; providerSlug?: string },
): boolean {
  const rows = listSuppressedPatterns(db, opts);
  const p = pattern.toLowerCase();
  return rows.some(
    (r) => p.includes(r.pattern.toLowerCase()) || r.pattern.toLowerCase().includes(p),
  );
}

// ─── Phase D: API keys ───────────────────────────────────────────────────────

export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Generate a new key: returns plaintext once + stores hash. */
export function createApiKey(
  db: AppDb,
  row: {
    id: string;
    name: string;
    tenantId?: string;
    scopes?: string[];
    createdAt: string;
  },
): { id: string; token: string; prefix: string; tenantId: string } {
  const token = `me_${randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, 10);
  const keyHash = hashApiKey(token);
  run(
    db,
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, tenant_id, scopes_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      keyHash,
      prefix,
      row.tenantId ?? "default",
      JSON.stringify(row.scopes ?? ["*"]),
      row.createdAt,
    ],
  );
  return {
    id: row.id,
    token,
    prefix,
    tenantId: row.tenantId ?? "default",
  };
}

export function findApiKeyByToken(db: AppDb, token: string): ApiKeyRow | undefined {
  const keyHash = hashApiKey(token);
  return get<ApiKeyRow>(
    db,
    `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`,
    [keyHash],
  );
}

export function touchApiKey(db: AppDb, id: string, at: string) {
  run(db, `UPDATE api_keys SET last_used_at = ? WHERE id = ?`, [at, id]);
}

export function listApiKeys(db: AppDb): Array<Omit<ApiKeyRow, "key_hash">> {
  return all<ApiKeyRow>(
    db,
    `SELECT id, name, key_hash, key_prefix, tenant_id, scopes_json, created_at, last_used_at, revoked_at
     FROM api_keys ORDER BY created_at DESC`,
  ).map(({ key_hash: _h, ...rest }) => rest);
}

export function revokeApiKey(db: AppDb, id: string, at: string) {
  run(db, `UPDATE api_keys SET revoked_at = ? WHERE id = ?`, [at, id]);
}

export function countActiveApiKeys(db: AppDb): number {
  const row = get<{ n: number }>(
    db,
    `SELECT COUNT(*) as n FROM api_keys WHERE revoked_at IS NULL`,
  );
  return row?.n ?? 0;
}

// ─── Phase D: feed poll ledger ───────────────────────────────────────────────

export function insertFeedPoll(
  db: AppDb,
  row: {
    id: string;
    providerSlug: string;
    openapiUrl: string;
    contentHash?: string | null;
    versionLabel?: string | null;
    status: string;
    error?: string | null;
    versionId?: string | null;
    pipelineChangeId?: string | null;
    polledAt: string;
  },
) {
  run(
    db,
    `INSERT INTO feed_polls
     (id, provider_slug, openapi_url, content_hash, version_label, status, error, version_id, pipeline_change_id, polled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.providerSlug,
      row.openapiUrl,
      row.contentHash ?? null,
      row.versionLabel ?? null,
      row.status,
      row.error ?? null,
      row.versionId ?? null,
      row.pipelineChangeId ?? null,
      row.polledAt,
    ],
  );
}

export function listFeedPolls(db: AppDb, limit = 50): FeedPollRow[] {
  return all(db, `SELECT * FROM feed_polls ORDER BY polled_at DESC LIMIT ?`, [limit]);
}

export function latestFeedPollForSlug(db: AppDb, slug: string): FeedPollRow | undefined {
  return get(
    db,
    `SELECT * FROM feed_polls WHERE provider_slug = ? ORDER BY polled_at DESC LIMIT 1`,
    [slug],
  );
}

export function latestSuccessfulHash(db: AppDb, slug: string): string | undefined {
  const row = get<FeedPollRow>(
    db,
    `SELECT * FROM feed_polls
     WHERE provider_slug = ? AND content_hash IS NOT NULL AND status IN ('unchanged', 'new_version', 'pipeline_ran')
     ORDER BY polled_at DESC LIMIT 1`,
    [slug],
  );
  return row?.content_hash ?? undefined;
}

/** Map DB snake_case rows to API camelCase for HTTP responses */
export function providerToApi(p: Provider) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    website: p.website,
    openapiUrl: p.openapi_url ?? null,
    changelogUrl: p.changelog_url ?? null,
    createdAt: p.created_at,
  };
}

export function feedPollToApi(r: FeedPollRow) {
  return {
    id: r.id,
    providerSlug: r.provider_slug,
    openapiUrl: r.openapi_url,
    contentHash: r.content_hash,
    versionLabel: r.version_label,
    status: r.status,
    error: r.error,
    versionId: r.version_id,
    pipelineChangeId: r.pipeline_change_id,
    polledAt: r.polled_at,
  };
}

export function apiKeyToApi(k: Omit<ApiKeyRow, "key_hash">) {
  return {
    id: k.id,
    name: k.name,
    prefix: k.key_prefix,
    tenantId: k.tenant_id,
    scopes: JSON.parse(k.scopes_json) as string[],
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    revokedAt: k.revoked_at,
  };
}

export function changeToApi(c: ApiChange) {
  return {
    id: c.id,
    providerId: c.provider_id,
    fromVersionId: c.from_version_id,
    toVersionId: c.to_version_id,
    risk: c.risk,
    summary: c.summary,
    severity: c.severity ?? "recommended",
    diffJson: c.diff_json,
    createdAt: c.created_at,
  };
}

// ─── Job queue (fan-out) ─────────────────────────────────────────────────────

export type JobRow = {
  id: string;
  type: string;
  payload_json: string;
  status: string;
  attempts: number;
  max_attempts: number;
  error: string | null;
  result_json: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export function enqueueJob(
  db: AppDb,
  row: {
    id: string;
    type: string;
    payload: unknown;
    maxAttempts?: number;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO jobs (id, type, payload_json, status, attempts, max_attempts, created_at)
     VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    [row.id, row.type, JSON.stringify(row.payload), row.maxAttempts ?? 3, row.createdAt],
  );
}

export function claimNextJob(db: AppDb, types?: string[]): JobRow | undefined {
  const typeFilter = types?.length
    ? `AND type IN (${types.map(() => "?").join(",")})`
    : "";
  const params = types?.length ? types : [];
  const job = get<JobRow>(
    db,
    `SELECT * FROM jobs WHERE status = 'pending' ${typeFilter} ORDER BY created_at LIMIT 1`,
    params,
  );
  if (!job) return undefined;
  run(
    db,
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, started_at = ? WHERE id = ? AND status = 'pending'`,
    [new Date().toISOString(), job.id],
  );
  return get(db, `SELECT * FROM jobs WHERE id = ?`, [job.id]);
}

export function completeJob(
  db: AppDb,
  id: string,
  result: unknown,
  finishedAt: string,
) {
  run(
    db,
    `UPDATE jobs SET status = 'done', result_json = ?, finished_at = ?, error = NULL WHERE id = ?`,
    [JSON.stringify(result), finishedAt, id],
  );
}

export function failJob(db: AppDb, id: string, error: string, finishedAt: string) {
  const job = get<JobRow>(db, `SELECT * FROM jobs WHERE id = ?`, [id]);
  if (!job) return;
  const retry = job.attempts < job.max_attempts;
  run(
    db,
    `UPDATE jobs SET status = ?, error = ?, finished_at = ? WHERE id = ?`,
    [retry ? "pending" : "failed", error, finishedAt, id],
  );
}

export function listJobs(db: AppDb, limit = 50): JobRow[] {
  return all(db, `SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`, [limit]);
}

export function exportAuditJson(db: AppDb, limit = 5000) {
  const rows = all(
    db,
    `SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?`,
    [limit],
  );
  return {
    exportedAt: new Date().toISOString(),
    count: rows.length,
    events: rows,
  };
}

export function exportAuditCsv(db: AppDb, limit = 5000): string {
  const rows = all(
    db,
    `SELECT id, actor, action, resource_type, resource_id, created_at FROM audit_events ORDER BY created_at DESC LIMIT ?`,
    [limit],
  ) as Array<{
    id: string;
    actor: string;
    action: string;
    resource_type: string;
    resource_id: string | null;
    created_at: string;
  }>;
  const header = "id,actor,action,resource_type,resource_id,created_at";
  const lines = rows.map((r) =>
    [r.id, r.actor, r.action, r.resource_type, r.resource_id ?? "", r.created_at]
      .map((c) => `"${String(c).replace(/"/g, '""')}"`)
      .join(","),
  );
  return [header, ...lines].join("\n");
}

export type RepairSessionRow = {
  id: string;
  consumer_id: string | null;
  repo_path: string;
  status: string;
  attempts: number;
  edits_count: number;
  ok: number;
  report_md: string | null;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
};

export function insertRepairSession(
  db: AppDb,
  row: {
    id: string;
    consumerId?: string | null;
    repoPath: string;
    status: string;
    attempts: number;
    editsCount: number;
    ok: boolean;
    reportMd?: string | null;
    resultJson?: string | null;
    createdAt: string;
    finishedAt?: string | null;
  },
) {
  run(
    db,
    `INSERT INTO repair_sessions
     (id, consumer_id, repo_path, status, attempts, edits_count, ok, report_md, result_json, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.consumerId ?? null,
      row.repoPath,
      row.status,
      row.attempts,
      row.editsCount,
      row.ok ? 1 : 0,
      row.reportMd ?? null,
      row.resultJson ?? null,
      row.createdAt,
      row.finishedAt ?? null,
    ],
  );
}

export function listRepairSessions(db: AppDb, limit = 30): RepairSessionRow[] {
  return all(db, `SELECT * FROM repair_sessions ORDER BY created_at DESC LIMIT ?`, [limit]);
}

export function getRepairSession(db: AppDb, id: string): RepairSessionRow | undefined {
  return get(db, `SELECT * FROM repair_sessions WHERE id = ?`, [id]);
}

export function repairSessionToApi(r: RepairSessionRow) {
  return {
    id: r.id,
    consumerId: r.consumer_id,
    repoPath: r.repo_path,
    status: r.status,
    attempts: r.attempts,
    editsCount: r.edits_count,
    ok: Boolean(r.ok),
    reportMd: r.report_md,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export type AgentRunRow = {
  id: string;
  goal: string;
  repo_path: string;
  status: string;
  ok: number;
  steps: number;
  files_changed_json: string | null;
  report_md: string | null;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
};

export function insertAgentRun(
  db: AppDb,
  row: {
    id: string;
    goal: string;
    repoPath: string;
    status: string;
    ok: boolean;
    steps: number;
    filesChanged?: string[];
    reportMd?: string | null;
    resultJson?: string | null;
    createdAt: string;
    finishedAt?: string | null;
  },
) {
  // Upsert so async queue → complete can reuse the same session id
  run(
    db,
    `INSERT INTO agent_runs
     (id, goal, repo_path, status, ok, steps, files_changed_json, report_md, result_json, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       ok = excluded.ok,
       steps = excluded.steps,
       files_changed_json = excluded.files_changed_json,
       report_md = excluded.report_md,
       result_json = excluded.result_json,
       finished_at = excluded.finished_at`,
    [
      row.id,
      row.goal,
      row.repoPath,
      row.status,
      row.ok ? 1 : 0,
      row.steps,
      JSON.stringify(row.filesChanged ?? []),
      row.reportMd ?? null,
      row.resultJson ?? null,
      row.createdAt,
      row.finishedAt ?? null,
    ],
  );
}

export function listAgentRuns(db: AppDb, limit = 30): AgentRunRow[] {
  return all(db, `SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?`, [limit]);
}

export function getAgentRun(db: AppDb, id: string): AgentRunRow | undefined {
  return get(db, `SELECT * FROM agent_runs WHERE id = ?`, [id]);
}

export function agentRunToApi(r: AgentRunRow) {
  return {
    id: r.id,
    goal: r.goal,
    repoPath: r.repo_path,
    status: r.status,
    ok: Boolean(r.ok),
    steps: r.steps,
    filesChanged: r.files_changed_json ? JSON.parse(r.files_changed_json) : [],
    reportMd: r.report_md,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export function computeDesignPartnerMetrics(db: AppDb) {
  const base = computeProductMetrics(db);
  const suppressed = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM suppressed_patterns`).get() as { c: number }
  ).c;
  const consumers = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM consumers`).get() as { c: number }
  ).c;
  const monitored = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM monitored_apis`).get() as { c: number }
  ).c;
  const changes = (
    db.raw.prepare(`SELECT COUNT(*) as c FROM api_changes`).get() as { c: number }
  ).c;
  const notifications = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM audit_events WHERE action = 'pr.notification_only' OR action = 'pipeline.notification_only'`,
      )
      .get() as { c: number }
  ).c;
  return {
    ...base,
    consumers,
    monitoredApis: monitored,
    changes,
    suppressedPatterns: suppressed,
    notificationOnlyEvents: notifications,
    coverage: consumers > 0 ? monitored / consumers : null,
  };
}

export function consumerToApi(c: Consumer) {
  return {
    id: c.id,
    name: c.name,
    githubOwner: c.github_owner,
    githubRepo: c.github_repo,
    installationId: c.installation_id,
    tenantId: c.tenant_id ?? null,
    createdAt: c.created_at,
  };
}

// ─── Phase E: tenants + GitHub installations ─────────────────────────────────

export const BILLING_PLANS = [
  {
    id: "free",
    name: "Free",
    priceMonthlyUsd: 0,
    seatLimit: 3,
    features: ["1 consumer repo", "Local mock GitHub", "Acme fixture pipeline"],
  },
  {
    id: "pro",
    name: "Pro",
    priceMonthlyUsd: 99,
    seatLimit: 25,
    features: [
      "Unlimited consumers",
      "Continuous OpenAPI feeds",
      "GitHub App install",
      "API keys + audit export",
    ],
  },
  {
    id: "enterprise",
    name: "Enterprise",
    priceMonthlyUsd: null as number | null,
    seatLimit: 500,
    features: [
      "SSO (stub)",
      "Self-hosted runner path",
      "Custom policy packs",
      "First-party branded agents",
      "Dedicated support",
    ],
  },
] as const;

export function listTenants(db: AppDb): TenantRow[] {
  return all(db, `SELECT * FROM tenants ORDER BY created_at`);
}

export function getTenant(db: AppDb, id: string): TenantRow | undefined {
  return get(db, `SELECT * FROM tenants WHERE id = ?`, [id]);
}

export function getTenantBySlug(db: AppDb, slug: string): TenantRow | undefined {
  return get(db, `SELECT * FROM tenants WHERE slug = ?`, [slug]);
}

export function insertTenant(
  db: AppDb,
  row: {
    id: string;
    slug: string;
    name: string;
    plan?: string;
    billingStatus?: string;
    seatLimit?: number;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.name,
      row.plan ?? "free",
      row.billingStatus ?? "active",
      row.seatLimit ?? 3,
      row.createdAt,
    ],
  );
}

export function updateTenantPlan(db: AppDb, id: string, plan: string, seatLimit?: number) {
  const planMeta = BILLING_PLANS.find((p) => p.id === plan);
  const seats = seatLimit ?? planMeta?.seatLimit ?? 3;
  run(db, `UPDATE tenants SET plan = ?, seat_limit = ? WHERE id = ?`, [plan, seats, id]);
}

export function tenantToApi(t: TenantRow) {
  const planMeta = BILLING_PLANS.find((p) => p.id === t.plan);
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    plan: t.plan,
    billingStatus: t.billing_status,
    seatLimit: t.seat_limit,
    planMeta: planMeta ?? null,
    createdAt: t.created_at,
  };
}

export function upsertGitHubInstallation(
  db: AppDb,
  row: {
    id: string;
    installationId: string;
    accountLogin: string;
    accountType?: string;
    tenantId?: string | null;
    permissions?: unknown;
    repositories?: unknown;
    createdAt: string;
    updatedAt: string;
  },
) {
  const existing = get<GitHubInstallationRow>(
    db,
    `SELECT * FROM github_installations WHERE installation_id = ?`,
    [row.installationId],
  );
  if (existing) {
    run(
      db,
      `UPDATE github_installations
       SET account_login = ?, account_type = ?, tenant_id = COALESCE(?, tenant_id),
           permissions_json = ?, repositories_json = ?, updated_at = ?
       WHERE installation_id = ?`,
      [
        row.accountLogin,
        row.accountType ?? "Organization",
        row.tenantId ?? null,
        row.permissions ? JSON.stringify(row.permissions) : existing.permissions_json,
        row.repositories ? JSON.stringify(row.repositories) : existing.repositories_json,
        row.updatedAt,
        row.installationId,
      ],
    );
    return existing.id;
  }
  run(
    db,
    `INSERT INTO github_installations
     (id, installation_id, account_login, account_type, tenant_id, permissions_json, repositories_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.installationId,
      row.accountLogin,
      row.accountType ?? "Organization",
      row.tenantId ?? null,
      row.permissions ? JSON.stringify(row.permissions) : null,
      row.repositories ? JSON.stringify(row.repositories) : null,
      row.createdAt,
      row.updatedAt,
    ],
  );
  return row.id;
}

export function listGitHubInstallations(db: AppDb): GitHubInstallationRow[] {
  return all(db, `SELECT * FROM github_installations ORDER BY updated_at DESC`);
}

export function getGitHubInstallationByLogin(
  db: AppDb,
  login: string,
): GitHubInstallationRow | undefined {
  return get(
    db,
    `SELECT * FROM github_installations WHERE lower(account_login) = lower(?) ORDER BY updated_at DESC LIMIT 1`,
    [login],
  );
}

export function githubInstallationToApi(r: GitHubInstallationRow) {
  return {
    id: r.id,
    installationId: r.installation_id,
    accountLogin: r.account_login,
    accountType: r.account_type,
    tenantId: r.tenant_id,
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : null,
    repositories: r.repositories_json ? JSON.parse(r.repositories_json) : null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function linkConsumersToInstallation(
  db: AppDb,
  accountLogin: string,
  installationId: string,
  tenantId?: string | null,
) {
  run(
    db,
    `UPDATE consumers SET installation_id = ?, tenant_id = COALESCE(?, tenant_id)
     WHERE lower(github_owner) = lower(?)`,
    [installationId, tenantId ?? null, accountLogin],
  );
}

export function prToApi(p: MigrationPrRow) {
  return {
    id: p.id,
    changeId: p.change_id,
    consumerId: p.consumer_id,
    title: p.title,
    body: p.body,
    branchName: p.branch_name,
    status: p.status,
    risk: p.risk,
    patchUnified: p.patch_unified,
    githubPrNumber: p.github_pr_number,
    githubPrUrl: p.github_pr_url,
    createdAt: p.created_at,
    resolvedAt: p.resolved_at,
  };
}

export function findingToApi(f: ImpactFindingRow) {
  return {
    id: f.id,
    changeId: f.change_id,
    consumerId: f.consumer_id,
    filePath: f.file_path,
    lineStart: f.line_start,
    lineEnd: f.line_end,
    symbol: f.symbol,
    confidence: f.confidence,
    evidenceJson: f.evidence_json,
  };
}

export function auditToApi(a: AuditEvent) {
  return {
    id: a.id,
    actor: a.actor,
    action: a.action,
    resourceType: a.resource_type,
    resourceId: a.resource_id,
    metadataJson: a.metadata_json,
    createdAt: a.created_at,
  };
}

export function versionToApi(v: ApiVersion) {
  return {
    id: v.id,
    providerId: v.provider_id,
    versionLabel: v.version_label,
    openapiJson: v.openapi_json,
    changelogMd: v.changelog_md,
    publishedAt: v.published_at,
  };
}
