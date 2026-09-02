import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { newId, nowIso, GraphPathSchema, type GraphPath } from "@mendpoint/shared";
import { computeProductMetrics } from "./metrics.js";
import { settleExpiredWardenModelReservations } from "./warden-model-accounting.js";
import { assertTenantScope } from "./tenant-scope.js";
import { createTenantMembership, getTenantMembership } from "./identity.js";
import { insertPrincipal } from "./trust.js";
import { ensureAuditGovernanceSchema } from "./audit-governance-store.js";
import type {
  ApiChange,
  ApiKeyRow,
  ApiVersion,
  AuditEvent,
  Consumer,
  ConsumerRepo,
  FeedPollRow,
  FeedScheduleRow,
  FeedScheduleWindowRow,
  FeedValidationEvidenceInput,
  GitHubInstallationRow,
  GitHubInstallStateRow,
  ImpactFindingRow,
  MigrationPrRow,
  MonitoredApi,
  PrincipalRow,
  Provider,
  RoutingExecutorHealthRow,
  RoutingLedgerRow,
  TenantMembershipRow,
  TenantRow,
} from "./schema.js";

export type * from "./schema.js";
export { assertTenantScope } from "./tenant-scope.js";
export * from "./warden-model-accounting.js";
export * from "./external-baseline.js";
export * from "./graphql-schema-version.js";
export * from "./outcome-metrics.js";
export * from "./retrieval-context-gap.js";
export * from "./agent-run-meter.js";
export * from "./fettler-delegation-evidence.js";
export * from "./organization-memory.js";
export * from "./developer-satisfaction.js";
export * from "./self-serve-dashboard.js";
export * from "./capability-adoption-opportunity.js";
export * from "./mission-decisions.js";
export * from "./mission-exceptions.js";
export * from "./mission-verification.js";
export * from "./mission-artifacts.js";
export * from "./mission-timeline.js";
export * from "./mission-handoff.js";
export * from "./mission-task.js";
export * from "./policy-envelope.js";
export * from "./task-ownership.js";
export * from "./secret-lifecycle.js";
export * from "./audit-governance-store.js";

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
  -- tenant_id (S1.1 tenant-private providers): NULL = shared/system catalog. Nullable with
  -- no default so legacy rows read NULL (shared). No static index/view references it, so an
  -- existing DB that has not yet run the additive migration never touches it in this DDL.
  tenant_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_versions (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  version_label TEXT NOT NULL,
  openapi_json TEXT NOT NULL,
  content_hash TEXT,
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
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  available_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  last_error_at TEXT,
  dead_at TEXT,
  cancelled_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status);
CREATE INDEX IF NOT EXISTS jobs_type_idx ON jobs(type);

CREATE TABLE IF NOT EXISTS fettler_model_reservations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  run_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
  call_index INTEGER NOT NULL CHECK (call_index > 0),
  request_digest TEXT NOT NULL,
  reservation_digest TEXT NOT NULL,
  settlement_digest TEXT,
  provider TEXT NOT NULL,
  configured_model TEXT NOT NULL,
  actual_model TEXT,
  endpoint_host TEXT NOT NULL,
  body_request_id TEXT,
  header_request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'succeeded', 'failed', 'over_budget', 'unknown')),
  maximum_input_tokens INTEGER NOT NULL CHECK (maximum_input_tokens >= 0),
  maximum_output_tokens INTEGER NOT NULL CHECK (maximum_output_tokens > 0),
  maximum_total_tokens INTEGER NOT NULL CHECK (maximum_total_tokens > 0),
  maximum_cost_usd REAL NOT NULL CHECK (maximum_cost_usd >= 0),
  job_budget_usd REAL NOT NULL CHECK (job_budget_usd >= 0),
  reported_input_tokens INTEGER,
  reported_output_tokens INTEGER,
  reported_total_tokens INTEGER,
  reported_cost_usd REAL,
  charged_input_tokens INTEGER,
  charged_output_tokens INTEGER,
  charged_total_tokens INTEGER,
  charged_cost_usd REAL,
  error_code TEXT,
  reserved_at TEXT NOT NULL,
  settled_at TEXT,
  UNIQUE (tenant_id, job_id, lease_generation, call_index)
);
CREATE INDEX IF NOT EXISTS fettler_model_reservations_job_idx
  ON fettler_model_reservations(tenant_id, job_id, status, reserved_at);

-- Agentic repair sessions
CREATE TABLE IF NOT EXISTS repair_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
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
  tenant_id TEXT NOT NULL,
  job_id TEXT,
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
-- agent_runs_tenant_job_uidx references job_id, which is added by an additive
-- migration for pre-existing databases. It is created in migrateProvidersFeedColumns
-- AFTER that column exists so booting on an old DB does not throw "no such column: job_id".

CREATE INDEX IF NOT EXISTS api_changes_provider_idx ON api_changes(provider_id);
CREATE TABLE IF NOT EXISTS consumers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  github_owner TEXT NOT NULL,
  github_repo TEXT NOT NULL,
  installation_id TEXT,
  github_delivery_mode TEXT NOT NULL DEFAULT 'app'
    CHECK (github_delivery_mode IN ('app', 'legacy_pat', 'revoked')),
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consumer_repos (
  id TEXT PRIMARY KEY,
  consumer_id TEXT NOT NULL REFERENCES consumers(id),
  local_path TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  scm_connection_id TEXT,
  connected_repository_id TEXT,
  snapshot_id TEXT,
  exact_commit TEXT,
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
  evidence_json TEXT NOT NULL,
  -- Provider->code path behind this finding (FET-016). Nullable, no default:
  -- rows written before this column existed read NULL ("not computed"), which is
  -- distinct from a computed path. Added to the additive migration list below so
  -- a pre-change DB converges on the identical shape. No static
  -- index/view/constraint references it.
  graph_path_json TEXT
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
  github_repository_id TEXT,
  github_installation_id TEXT,
  github_account_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  coverage_json TEXT
);
CREATE INDEX IF NOT EXISTS migration_prs_status_idx ON migration_prs(status);
CREATE INDEX IF NOT EXISTS migration_prs_change_idx ON migration_prs(change_id);
CREATE INDEX IF NOT EXISTS migration_prs_consumer_idx ON migration_prs(consumer_id);
CREATE INDEX IF NOT EXISTS impact_findings_consumer_idx ON impact_findings(consumer_id);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_sequence INTEGER,
  schema_version INTEGER NOT NULL DEFAULT 1,
  prev_hash TEXT,
  event_hash TEXT,
  metadata_sha256 TEXT,
  actor TEXT NOT NULL,
  principal_id TEXT,
  api_key_id TEXT,
  request_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  metadata_json TEXT,
  impact_change_id TEXT GENERATED ALWAYS AS (
    CASE WHEN action = 'impact.analyzed' AND json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.changeId') END
  ) VIRTUAL,
  impact_fallback TEXT GENERATED ALWAYS AS (
    CASE WHEN action = 'impact.analyzed' AND json_valid(metadata_json)
      THEN json_extract(metadata_json, '$.fallback') END
  ) VIRTUAL,
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
  tenant_id TEXT NOT NULL,
  consumer_id TEXT,
  provider_slug TEXT,
  pattern TEXT NOT NULL,
  reason TEXT,
  source_pr_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS suppressed_patterns_consumer_idx ON suppressed_patterns(consumer_id);
CREATE INDEX IF NOT EXISTS suppressed_patterns_pattern_idx ON suppressed_patterns(pattern);

-- Persist the exact row boundary discovered when nullable legacy tenant columns
-- first reach the repaired schema. Records inside this boundary require an
-- operator attestation before the application may boot; later writes are not
-- retrospectively classified as legacy.
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_reconciliation_scope (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id, tenant_id)
);
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_reconciliation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  sealed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_reconciliation_discovery_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 2),
  source_schema_digest TEXT NOT NULL,
  scope_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_attestations (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  attested_by TEXT NOT NULL,
  attested_at TEXT NOT NULL,
  attestation_digest TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id, tenant_id)
);
-- Rows that reached this migration without attributable ownership must remain
-- unknown across an older-binary rollback. The source triggers installed by the
-- migration reference this durable ledger, so a predecessor backfill cannot
-- turn quarantine into tenant authority.
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_quarantine_scope (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
);
CREATE TABLE IF NOT EXISTS legacy_tenant_ownership_quarantine_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  scope_digest TEXT NOT NULL,
  sealed_at TEXT NOT NULL
);

-- Warden capability-adoption opportunities: NEW provider capabilities that linked
-- consumers are not yet using (measured from static code presence). Idempotent per
-- (tenant, change, capability); re-measurement upserts the counts.
CREATE TABLE IF NOT EXISTS capability_adoption_opportunities (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  change_id TEXT NOT NULL,
  provider_slug TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  op TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  path TEXT,
  method TEXT,
  field TEXT,
  linked_consumer_count INTEGER NOT NULL DEFAULT 0,
  adopting_count INTEGER NOT NULL DEFAULT 0,
  non_adopting_count INTEGER NOT NULL DEFAULT 0,
  adoption_rate REAL NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 0,
  adopting_consumers_json TEXT NOT NULL DEFAULT '[]',
  non_adopting_consumers_json TEXT NOT NULL DEFAULT '[]',
  suggested_action TEXT NOT NULL DEFAULT '',
  value_basis TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, change_id, capability_id)
);
CREATE INDEX IF NOT EXISTS capability_adoption_opportunities_tenant_idx
  ON capability_adoption_opportunities(tenant_id, provider_slug, priority);
CREATE INDEX IF NOT EXISTS capability_adoption_opportunities_change_idx
  ON capability_adoption_opportunities(tenant_id, change_id);

-- Phase D: multi-tenant API keys (hashed secrets)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  principal_id TEXT,
  scopes_json TEXT NOT NULL DEFAULT '["*"]',
  authority_principal_id TEXT,
  authority_role TEXT CHECK (authority_role IN ('owner', 'admin', 'engineer', 'viewer', 'fde', 'agent')),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx ON api_keys(tenant_id);

CREATE TABLE IF NOT EXISTS delegated_request_nonces (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id),
  request_id TEXT NOT NULL,
  signature_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (api_key_id, request_id)
);
CREATE INDEX IF NOT EXISTS delegated_request_nonces_created_idx
  ON delegated_request_nonces(created_at);

-- Phase D: continuous feed poll ledger
CREATE TABLE IF NOT EXISTS feed_polls (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
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

CREATE TABLE IF NOT EXISTS feed_validation_evidence (
  id TEXT PRIMARY KEY,
  poll_id TEXT NOT NULL UNIQUE REFERENCES feed_polls(id),
  provider_slug TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('catalog', 'provider', 'unknown')),
  source_url TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('json', 'unknown')),
  format_status TEXT NOT NULL CHECK (format_status IN ('accepted', 'rejected', 'not_observed')),
  schema_version TEXT,
  schema_status TEXT NOT NULL CHECK (schema_status IN ('accepted', 'rejected', 'not_observed')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected', 'skipped')),
  error TEXT,
  http_status INTEGER,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_validation_evidence_slug_idx
  ON feed_validation_evidence(provider_slug, observed_at);
CREATE TRIGGER IF NOT EXISTS feed_validation_evidence_no_update
BEFORE UPDATE ON feed_validation_evidence
BEGIN SELECT RAISE(ABORT, 'feed_validation_evidence_immutable'); END;
CREATE TRIGGER IF NOT EXISTS feed_validation_evidence_no_delete
BEFORE DELETE ON feed_validation_evidence
BEGIN SELECT RAISE(ABORT, 'feed_validation_evidence_immutable'); END;

CREATE TABLE IF NOT EXISTS feed_schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider_slug TEXT NOT NULL,
  interval_ms INTEGER NOT NULL CHECK (interval_ms >= 1000),
  stale_after_ms INTEGER NOT NULL CHECK (stale_after_ms >= interval_ms),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_attempt_at TEXT,
  last_success_at TEXT,
  release_last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  alert_state TEXT NOT NULL DEFAULT 'healthy' CHECK (alert_state IN ('healthy', 'stale', 'failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, provider_slug)
);
CREATE INDEX IF NOT EXISTS feed_schedules_tenant_idx
  ON feed_schedules(tenant_id, enabled, provider_slug);

CREATE TABLE IF NOT EXISTS feed_schedule_windows (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES feed_schedules(id),
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  error TEXT,
  attempted_at TEXT NOT NULL,
  lease_expires_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  UNIQUE (schedule_id, window_started_at)
);
CREATE INDEX IF NOT EXISTS feed_schedule_windows_schedule_idx
  ON feed_schedule_windows(schedule_id, window_started_at);

CREATE TABLE IF NOT EXISTS feed_tenant_dispatches (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  provider_slug TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  pipeline_ref TEXT,
  error TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 1,
  attempted_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY (tenant_id, provider_slug, content_hash)
);
CREATE INDEX IF NOT EXISTS feed_tenant_dispatches_status_idx
  ON feed_tenant_dispatches(status, attempted_at);

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
  account_id TEXT,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT 'Organization',
  tenant_id TEXT,
  permissions_json TEXT,
  repositories_json TEXT,
  repository_selection TEXT NOT NULL DEFAULT 'selected',
  suspended_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS github_installations_tenant_idx ON github_installations(tenant_id);
CREATE INDEX IF NOT EXISTS github_installations_login_idx ON github_installations(account_login);

CREATE TABLE IF NOT EXISTS github_install_states (
  state_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  created_by_principal_id TEXT,
  expected_account_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  completed_at TEXT,
  completed_installation_id TEXT
);
CREATE INDEX IF NOT EXISTS github_install_states_tenant_idx ON github_install_states(tenant_id);

CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processing',
  updated_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);

-- Durable per-delivery record of how an inbound customer pull_request
-- (opened/synchronize) webhook was handled. One row per GitHub delivery id.
-- The outcome column is the single source of truth that keeps the three states
-- distinguishable forever: a run was enqueued, the event was deliberately
-- ignored (draft/bot/out-of-scope), it was refused (unknown/unauthorized
-- installation, malformed path), it deduplicated to an existing run, or it
-- failed to process. tenant_id is nullable because an unknown installation has
-- no resolved tenant, yet the refusal must still be recorded, never dropped.
CREATE TABLE IF NOT EXISTS fettler_pr_review_events (
  delivery_id TEXT PRIMARY KEY,
  tenant_id TEXT,
  installation_id TEXT,
  remote_repository_id TEXT,
  pull_request_number INTEGER,
  head_sha TEXT,
  action TEXT,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('enqueued', 'duplicate', 'ignored', 'refused', 'failed')),
  reason TEXT,
  dispatch_job_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fettler_pr_review_events_tenant_idx
  ON fettler_pr_review_events(tenant_id, created_at);

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'service', 'api_key', 'webhook')),
  subject TEXT NOT NULL,
  display_name TEXT NOT NULL,
  audience TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, subject)
);
CREATE INDEX IF NOT EXISTS principals_tenant_idx ON principals(tenant_id, kind);
CREATE UNIQUE INDEX IF NOT EXISTS principals_id_tenant_uidx ON principals(id, tenant_id);
CREATE TRIGGER IF NOT EXISTS api_keys_principal_tenant_insert
BEFORE INSERT ON api_keys
WHEN NEW.principal_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM principals
  WHERE id = NEW.principal_id AND tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'api_key_principal_tenant_mismatch');
END;
CREATE TRIGGER IF NOT EXISTS api_keys_principal_tenant_update
BEFORE UPDATE OF principal_id, tenant_id ON api_keys
WHEN NEW.principal_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM principals
  WHERE id = NEW.principal_id AND tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'api_key_principal_tenant_mismatch');
END;

CREATE TABLE IF NOT EXISTS tenant_memberships (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'engineer', 'viewer', 'fde')),
  status TEXT NOT NULL CHECK (status IN ('active', 'offboarded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  offboarded_at TEXT,
  PRIMARY KEY (tenant_id, issuer, subject),
  CHECK ((status = 'active' AND offboarded_at IS NULL)
    OR (status = 'offboarded' AND offboarded_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS tenant_memberships_subject_idx
  ON tenant_memberships(issuer, subject, tenant_id, status);

CREATE TABLE IF NOT EXISTS identity_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  principal_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  membership_updated_at TEXT NOT NULL,
  auth_strength TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by_principal_id TEXT,
  revoke_reason TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL AND revoked_by_principal_id IS NULL AND revoke_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_principal_id IS NOT NULL AND revoke_reason IS NOT NULL)),
  FOREIGN KEY (principal_id, tenant_id) REFERENCES principals(id, tenant_id),
  FOREIGN KEY (revoked_by_principal_id, tenant_id) REFERENCES principals(id, tenant_id)
);
CREATE INDEX IF NOT EXISTS identity_sessions_member_idx
  ON identity_sessions(tenant_id, issuer, subject, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS identity_sessions_principal_idx
  ON identity_sessions(tenant_id, principal_id, expires_at, revoked_at);
CREATE TRIGGER IF NOT EXISTS identity_sessions_identity_immutable
BEFORE UPDATE OF tenant_id, principal_id, issuer, subject, membership_updated_at,
  auth_strength, token_sha256, issued_at, expires_at, created_at ON identity_sessions
BEGIN
  SELECT RAISE(ABORT, 'identity_session_identity_immutable');
END;
CREATE TRIGGER IF NOT EXISTS identity_sessions_revocation_immutable
BEFORE UPDATE OF revoked_at, revoked_by_principal_id, revoke_reason ON identity_sessions
WHEN NOT (
  (OLD.revoked_at IS NULL AND OLD.revoked_by_principal_id IS NULL AND OLD.revoke_reason IS NULL
    AND NEW.revoked_at IS NOT NULL AND NEW.revoked_by_principal_id IS NOT NULL AND NEW.revoke_reason IS NOT NULL)
  OR
  (OLD.revoked_at = NEW.revoked_at
    AND OLD.revoked_by_principal_id = NEW.revoked_by_principal_id
    AND OLD.revoke_reason = NEW.revoke_reason)
)
BEGIN
  SELECT RAISE(ABORT, 'identity_session_revocation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS identity_sessions_no_delete
BEFORE DELETE ON identity_sessions
BEGIN
  SELECT RAISE(ABORT, 'identity_session_delete_forbidden');
END;
CREATE TRIGGER IF NOT EXISTS identity_sessions_principal_authority_insert
BEFORE INSERT ON identity_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM principals
  WHERE id = NEW.principal_id
    AND tenant_id = NEW.tenant_id
    AND kind = 'human'
    AND audience = NEW.issuer
    AND subject = NEW.issuer || '|' || NEW.subject
)
BEGIN
  SELECT RAISE(ABORT, 'identity_session_principal_authority_mismatch');
END;
CREATE TABLE IF NOT EXISTS artifact_manifests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  storage_ref TEXT NOT NULL,
  content_text TEXT,
  producer_principal_id TEXT REFERENCES principals(id),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, kind, sha256)
);
CREATE INDEX IF NOT EXISTS artifact_manifests_tenant_idx ON artifact_manifests(tenant_id, kind, created_at);

CREATE TABLE IF NOT EXISTS evidence_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
  input_artifact_id TEXT REFERENCES artifact_manifests(id),
  producer_principal_id TEXT REFERENCES principals(id),
  tool TEXT NOT NULL,
  command TEXT,
  tool_version TEXT,
  commit_sha TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'unknown', 'waived')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_price_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  formula_version TEXT NOT NULL,
  currency TEXT NOT NULL,
  price_per_mcu_money_micros INTEGER NOT NULL CHECK (price_per_mcu_money_micros >= 0),
  effective_at TEXT NOT NULL,
  expires_at TEXT,
  contract_reference TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, effective_at, id)
);
CREATE INDEX IF NOT EXISTS usage_price_versions_effective_idx
  ON usage_price_versions(tenant_id, effective_at, expires_at);

CREATE TABLE IF NOT EXISTS usage_entitlements (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  version INTEGER NOT NULL CHECK (version > 0),
  price_version_id TEXT NOT NULL REFERENCES usage_price_versions(id),
  quota_mcu_micros INTEGER NOT NULL CHECK (quota_mcu_micros >= 0),
  features_json TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, version)
);
CREATE INDEX IF NOT EXISTS usage_entitlements_period_idx
  ON usage_entitlements(tenant_id, period_start, period_end, version);

CREATE TABLE IF NOT EXISTS usage_ledger_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  entry_type TEXT NOT NULL CHECK (
    entry_type IN ('reservation', 'settlement', 'release', 'adjustment', 'credit')
  ),
  entitlement_id TEXT NOT NULL REFERENCES usage_entitlements(id),
  idempotency_key TEXT NOT NULL,
  task_id TEXT NOT NULL,
  campaign_id TEXT,
  reservation_id TEXT REFERENCES usage_ledger_entries(id),
  price_version TEXT NOT NULL,
  reserved_mcu_micros_delta INTEGER NOT NULL,
  consumed_mcu_micros_delta INTEGER NOT NULL,
  invoice_reference TEXT,
  reason TEXT NOT NULL,
  actor_principal_id TEXT,
  entry_sequence INTEGER NOT NULL,
  prev_hash TEXT,
  entry_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, entry_sequence)
);
CREATE INDEX IF NOT EXISTS usage_ledger_tenant_time_idx
  ON usage_ledger_entries(tenant_id, entitlement_id, created_at, id);
CREATE INDEX IF NOT EXISTS usage_ledger_task_idx
  ON usage_ledger_entries(tenant_id, task_id, campaign_id);
CREATE INDEX IF NOT EXISTS usage_ledger_reservation_idx
  ON usage_ledger_entries(tenant_id, reservation_id);
CREATE TRIGGER IF NOT EXISTS usage_entitlements_append_only_update
BEFORE UPDATE ON usage_entitlements BEGIN
  SELECT RAISE(ABORT, 'usage_entitlements_append_only');
END;
CREATE TRIGGER IF NOT EXISTS usage_price_versions_append_only_update
BEFORE UPDATE ON usage_price_versions BEGIN
  SELECT RAISE(ABORT, 'usage_price_versions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS usage_price_versions_append_only_delete
BEFORE DELETE ON usage_price_versions BEGIN
  SELECT RAISE(ABORT, 'usage_price_versions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS usage_entitlements_append_only_delete
BEFORE DELETE ON usage_entitlements BEGIN
  SELECT RAISE(ABORT, 'usage_entitlements_append_only');
END;
CREATE TRIGGER IF NOT EXISTS usage_ledger_entries_append_only_update
BEFORE UPDATE ON usage_ledger_entries BEGIN
  SELECT RAISE(ABORT, 'usage_ledger_entries_append_only');
END;
CREATE TRIGGER IF NOT EXISTS usage_ledger_entries_append_only_delete
BEFORE DELETE ON usage_ledger_entries BEGIN
  SELECT RAISE(ABORT, 'usage_ledger_entries_append_only');
END;

CREATE TABLE IF NOT EXISTS invoice_exports (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  currency TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  tax_basis_points INTEGER NOT NULL CHECK (tax_basis_points >= 0 AND tax_basis_points <= 10000),
  tax_jurisdiction TEXT NOT NULL,
  tax_policy_version TEXT NOT NULL,
  subtotal_money_micros INTEGER NOT NULL,
  tax_money_micros INTEGER NOT NULL,
  total_money_micros INTEGER NOT NULL,
  canonical_payload TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  signing_key_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  initial_state TEXT NOT NULL CHECK (initial_state = 'issued'),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  issued_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS invoice_exports_tenant_period_idx
  ON invoice_exports(tenant_id, period_start, period_end, issued_at, id);

CREATE TABLE IF NOT EXISTS invoice_export_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoice_exports(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  usage_entry_id TEXT NOT NULL REFERENCES usage_ledger_entries(id),
  usage_entry_sequence INTEGER NOT NULL CHECK (usage_entry_sequence > 0),
  usage_entry_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('usage', 'adjustment', 'credit', 'refund')),
  task_id TEXT NOT NULL,
  campaign_id TEXT,
  price_version_id TEXT NOT NULL REFERENCES usage_price_versions(id),
  formula_version TEXT NOT NULL,
  contract_reference TEXT NOT NULL,
  currency TEXT NOT NULL,
  mcu_micros INTEGER NOT NULL,
  money_micros INTEGER NOT NULL,
  reason TEXT NOT NULL,
  UNIQUE (tenant_id, invoice_id, ordinal),
  UNIQUE (tenant_id, usage_entry_id)
);
CREATE INDEX IF NOT EXISTS invoice_export_lines_source_idx
  ON invoice_export_lines(tenant_id, usage_entry_id, invoice_id);

CREATE TABLE IF NOT EXISTS invoice_export_state_events (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoice_exports(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  state TEXT NOT NULL CHECK (state IN ('issued', 'exported', 'acknowledged', 'overdue', 'resolved', 'void')),
  policy_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  authority_key_id TEXT NOT NULL,
  authority_signature TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  UNIQUE (tenant_id, invoice_id, idempotency_key),
  UNIQUE (tenant_id, invoice_id, sequence)
);
CREATE INDEX IF NOT EXISTS invoice_export_state_events_tenant_idx
  ON invoice_export_state_events(tenant_id, invoice_id, sequence);

CREATE TRIGGER IF NOT EXISTS invoice_exports_append_only_update
BEFORE UPDATE ON invoice_exports BEGIN
  SELECT RAISE(ABORT, 'invoice_exports_append_only');
END;
CREATE TRIGGER IF NOT EXISTS invoice_exports_append_only_delete
BEFORE DELETE ON invoice_exports BEGIN
  SELECT RAISE(ABORT, 'invoice_exports_append_only');
END;
CREATE TRIGGER IF NOT EXISTS invoice_export_lines_append_only_update
BEFORE UPDATE ON invoice_export_lines BEGIN
  SELECT RAISE(ABORT, 'invoice_export_lines_append_only');
END;
CREATE TRIGGER IF NOT EXISTS invoice_export_lines_append_only_delete
BEFORE DELETE ON invoice_export_lines BEGIN
  SELECT RAISE(ABORT, 'invoice_export_lines_append_only');
END;
CREATE TRIGGER IF NOT EXISTS invoice_export_state_events_append_only_update
BEFORE UPDATE ON invoice_export_state_events BEGIN
  SELECT RAISE(ABORT, 'invoice_export_state_events_append_only');
END;
CREATE TRIGGER IF NOT EXISTS invoice_export_state_events_append_only_delete
BEFORE DELETE ON invoice_export_state_events BEGIN
  SELECT RAISE(ABORT, 'invoice_export_state_events_append_only');
END;

CREATE TABLE IF NOT EXISTS actual_execution_cost_entries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  campaign_id TEXT,
  task_class TEXT NOT NULL,
  route TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  retry_number INTEGER NOT NULL CHECK (retry_number >= 0),
  fallback_from_execution_id TEXT,
  outcome_status TEXT NOT NULL CHECK (
    outcome_status IN ('accepted', 'rejected', 'unresolved')
  ),
  accepted_outcome_id TEXT,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
  model_id TEXT NOT NULL,
  model_price_version TEXT NOT NULL,
  model_cost_money_micros INTEGER NOT NULL CHECK (model_cost_money_micros >= 0),
  cache_cost_money_micros INTEGER NOT NULL CHECK (cache_cost_money_micros >= 0),
  gpu_millis INTEGER NOT NULL CHECK (gpu_millis >= 0),
  gpu_cost_money_micros INTEGER NOT NULL CHECK (gpu_cost_money_micros >= 0),
  graph_cost_money_micros INTEGER NOT NULL CHECK (graph_cost_money_micros >= 0),
  sandbox_cost_money_micros INTEGER NOT NULL CHECK (sandbox_cost_money_micros >= 0),
  verification_cost_money_micros INTEGER NOT NULL CHECK (
    verification_cost_money_micros >= 0
  ),
  total_cost_money_micros INTEGER NOT NULL CHECK (
    total_cost_money_micros = model_cost_money_micros + cache_cost_money_micros +
      gpu_cost_money_micros + graph_cost_money_micros +
      sandbox_cost_money_micros + verification_cost_money_micros
  ),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  entry_sequence INTEGER NOT NULL CHECK (entry_sequence > 0),
  prev_hash TEXT,
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  -- Mission this execution's cost is attributable to (ReGauge live path), or
  -- NULL when there is no mission link (every Fettler row today: the Fettler
  -- agent.run payload carries no campaign/mission id). Nullable FK to our own
  -- mission table; an unresolved mission is honestly null, never fabricated.
  mission_id TEXT REFERENCES mission(id),
  -- Per-component measurement state. 1 = measured, 0 = not measured. An
  -- unmeasured component always carries 0 money-micros (so the arithmetic total
  -- CHECK still holds); the flag is the sole carrier of "not measured", keeping
  -- it distinguishable from "measured zero". Defaults are 1 so an existing
  -- (HTTP-written) row — where the caller supplied real numbers for every
  -- component — reads as measured after an in-place column add.
  model_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (model_cost_measured IN (0, 1)),
  cache_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (cache_cost_measured IN (0, 1)),
  gpu_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (gpu_cost_measured IN (0, 1)),
  graph_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (graph_cost_measured IN (0, 1)),
  sandbox_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (sandbox_cost_measured IN (0, 1)),
  verification_cost_measured INTEGER NOT NULL DEFAULT 1 CHECK (verification_cost_measured IN (0, 1)),
  measurement_provenance_json TEXT NOT NULL DEFAULT '{}',
  -- Hash-payload version. 1 = original field set (pre-change rows, hashed
  -- without the columns above so a pre-change volume still verifies); 2 =
  -- includes mission id and the measurement flags in the hash.
  cost_schema_version INTEGER NOT NULL DEFAULT 1 CHECK (cost_schema_version >= 1),
  CHECK (
    (outcome_status = 'accepted' AND accepted_outcome_id IS NOT NULL) OR
    (outcome_status != 'accepted' AND accepted_outcome_id IS NULL)
  ),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, execution_id),
  UNIQUE (tenant_id, entry_sequence)
);
CREATE INDEX IF NOT EXISTS actual_execution_cost_task_idx
  ON actual_execution_cost_entries(tenant_id, task_id, campaign_id, entry_sequence);
CREATE INDEX IF NOT EXISTS actual_execution_cost_task_attempt_idx
  ON actual_execution_cost_entries(tenant_id, task_id, attempt_number DESC, entry_sequence DESC);
CREATE INDEX IF NOT EXISTS actual_execution_cost_route_idx
  ON actual_execution_cost_entries(tenant_id, task_class, route, outcome_status);
CREATE TRIGGER IF NOT EXISTS actual_execution_cost_entries_append_only_update
BEFORE UPDATE ON actual_execution_cost_entries BEGIN
  SELECT RAISE(ABORT, 'actual_execution_cost_entries_append_only');
END;
CREATE TRIGGER IF NOT EXISTS actual_execution_cost_entries_append_only_delete
BEFORE DELETE ON actual_execution_cost_entries BEGIN
  SELECT RAISE(ABORT, 'actual_execution_cost_entries_append_only');
END;

CREATE TABLE IF NOT EXISTS actual_execution_cost_outcomes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  idempotency_key TEXT NOT NULL,
  cost_entry_id TEXT NOT NULL REFERENCES actual_execution_cost_entries(id),
  execution_id TEXT NOT NULL,
  outcome_status TEXT NOT NULL CHECK (
    outcome_status IN ('accepted', 'rejected', 'corrected', 'rolled_back')
  ),
  accepted_outcome_id TEXT,
  authority_kind TEXT NOT NULL CHECK (authority_kind IN ('reviewer', 'delivery', 'rollback')),
  authority_digest TEXT NOT NULL CHECK (length(authority_digest) = 64),
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  outcome_sequence INTEGER NOT NULL CHECK (outcome_sequence > 0),
  prev_hash TEXT,
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  CHECK (
    (outcome_status IN ('accepted', 'corrected') AND accepted_outcome_id IS NOT NULL) OR
    (outcome_status IN ('rejected', 'rolled_back') AND accepted_outcome_id IS NULL)
  ),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, cost_entry_id, outcome_sequence)
);
CREATE INDEX IF NOT EXISTS actual_execution_cost_outcomes_execution_idx
  ON actual_execution_cost_outcomes(tenant_id, execution_id, outcome_sequence);
CREATE TRIGGER IF NOT EXISTS actual_execution_cost_outcomes_append_only_update
BEFORE UPDATE ON actual_execution_cost_outcomes BEGIN
  SELECT RAISE(ABORT, 'actual_execution_cost_outcomes_append_only');
END;
CREATE TRIGGER IF NOT EXISTS actual_execution_cost_outcomes_append_only_delete
BEFORE DELETE ON actual_execution_cost_outcomes BEGIN
  SELECT RAISE(ABORT, 'actual_execution_cost_outcomes_append_only');
END;

CREATE TABLE IF NOT EXISTS fettler_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'cancelling', 'cancelled', 'completed', 'failed', 'rolling_back', 'rolled_back')),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit > 0),
  completion_policy TEXT NOT NULL CHECK (completion_policy IN ('all', 'continue_on_failure')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS fettler_campaigns_tenant_status_idx
  ON fettler_campaigns(tenant_id, status, updated_at);

CREATE TABLE IF NOT EXISTS fettler_campaign_targets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  campaign_id TEXT NOT NULL REFERENCES fettler_campaigns(id),
  repository_id TEXT NOT NULL REFERENCES connected_repositories(id),
  snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id),
  package_artifact_id TEXT REFERENCES artifact_manifests(id),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  stage TEXT NOT NULL CHECK (stage IN ('queued', 'analyzing', 'editing', 'verifying', 'review', 'delivering', 'completed', 'blocked', 'failed', 'cancelled', 'rolling_back', 'rolled_back')),
  depends_on_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
  exception_code TEXT,
  enrollment_source TEXT NOT NULL DEFAULT 'manual' CHECK (enrollment_source IN ('manual', 'auto')),
  enrolled_installation_id TEXT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, campaign_id, repository_id)
);
CREATE INDEX IF NOT EXISTS fettler_targets_campaign_stage_idx
  ON fettler_campaign_targets(tenant_id, campaign_id, stage, created_at);

CREATE TABLE IF NOT EXISTS fettler_rollout_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  campaign_id TEXT NOT NULL REFERENCES fettler_campaigns(id),
  campaign_revision INTEGER NOT NULL CHECK (campaign_revision > 0),
  canary_target_id TEXT NOT NULL REFERENCES fettler_campaign_targets(id),
  max_cohort_size INTEGER NOT NULL CHECK (max_cohort_size > 0),
  decision_json TEXT NOT NULL,
  decision_sha256 TEXT NOT NULL CHECK (length(decision_sha256) = 64),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS fettler_rollout_decisions_campaign_idx
  ON fettler_rollout_decisions(tenant_id, campaign_id, campaign_revision, created_at);

-- Mission: the shared, tenant-scoped execution primitive (spec 6.1, 8.6). The
-- single join point across the two previously disjoint execution stacks. Both
-- linkages are carried here, on this new table, so neither stack is
-- restructured. Fettler/Warden campaigns are referenced by a same-database
-- foreign key (fettler_campaign_id); ReGauge/Transformer campaigns live in a
-- separate database (TransformerControlPlaneStore) and are projected here by
-- reference (regauge_campaign_id, no cross-database foreign key). Spec 6.1
-- composition fields are held by reference (repository/snapshot scope and the
-- linked execution record) rather than duplicated: migration tasks, evidence,
-- execution history, verification results, and learning provenance are reachable
-- through the linked records. As a brand-new table this converges on fresh and
-- pre-change databases purely through CREATE TABLE/INDEX IF NOT EXISTS, with no
-- ALTER and no shape change to any existing table.
CREATE TABLE IF NOT EXISTS mission (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  product TEXT NOT NULL CHECK (product IN ('fettler', 'regauge')),
  state TEXT NOT NULL CHECK (state IN ('created', 'discovering', 'scoped', 'planning', 'executing', 'verifying', 'awaiting_review', 'accepted', 'rejected', 'partial', 'failed', 'cancelled')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('provider_change', 'migration_objective')),
  objective TEXT NOT NULL,
  repository_id TEXT REFERENCES connected_repositories(id),
  snapshot_id TEXT REFERENCES repository_snapshots(id),
  fettler_campaign_id TEXT REFERENCES fettler_campaigns(id),
  regauge_campaign_id TEXT,
  graph_version_id TEXT,
  policy_envelope_version TEXT,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS mission_tenant_state_idx
  ON mission(tenant_id, state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS mission_fettler_campaign_uidx
  ON mission(tenant_id, fettler_campaign_id) WHERE fettler_campaign_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS mission_regauge_campaign_uidx
  ON mission(tenant_id, regauge_campaign_id) WHERE regauge_campaign_id IS NOT NULL;

-- Policy Envelope store (spec §6.7 / §8.18). Versioned, tenant-scoped, and
-- IMMUTABLE by (tenant_id, version): the envelope text a mission pinned through
-- mission.policy_envelope_version must never change under it. The envelope body
-- is stored as opaque canonical JSON (owned/parsed by @mendpoint/policy), with a
-- content digest so a re-create of the same (tenant, version) is idempotent and a
-- conflicting re-create fails closed. Brand-new table, so it converges on fresh
-- AND pre-change databases through CREATE TABLE IF NOT EXISTS with no ALTER.
CREATE TABLE IF NOT EXISTS policy_envelopes (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  version INTEGER NOT NULL CHECK (version > 0),
  policy_envelope_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, version)
);
CREATE TRIGGER IF NOT EXISTS policy_envelopes_immutable
  BEFORE UPDATE ON policy_envelopes
  BEGIN SELECT RAISE(ABORT, 'policy_envelope_immutable'); END;
CREATE TRIGGER IF NOT EXISTS policy_envelopes_no_delete
  BEFORE DELETE ON policy_envelopes
  BEGIN SELECT RAISE(ABORT, 'policy_envelope_immutable'); END;

-- Mission durable records (spec 6.1 / 8.6 companion to the mission primitive
-- above). Three append-only, tenant-content-addressed stores that let a later
-- task read what an earlier task already established for the SAME mission: a
-- DECISION log, an EXCEPTION register, and VERIFICATION history. Each row's
-- primary key is a sha256 content digest over canonical JSON that INCLUDES
-- tenant_id (Change Graph Tier-1 binding), so a different tenant produces a
-- different primary key by construction; cross-tenant collision is arithmetically
-- impossible, not merely filtered. The composite foreign key (tenant_id,
-- mission_id) -> mission(tenant_id, id) binds every row to a mission of the same
-- tenant, and mission_verifications additionally binds (snapshot_id, tenant_id)
-- -> repository_snapshots(id, tenant_id), so a row can never reference another
-- tenant's mission or snapshot. All three tables are brand-new, so — like the
-- mission table above — they converge on fresh AND pre-change databases purely
-- through CREATE TABLE/INDEX IF NOT EXISTS, with no ALTER and no shape change to
-- any existing table. All three are append-only, enforced by BEFORE UPDATE/DELETE
-- triggers: a change of mind is a new superseding row, never an overwrite, so the
-- full chain survives and stays readable.
CREATE TABLE IF NOT EXISTS mission_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  decision TEXT NOT NULL,
  scope TEXT NOT NULL,
  author_principal_id TEXT NOT NULL REFERENCES principals(id),
  evidence_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'retracted')),
  supersedes_id TEXT REFERENCES mission_decisions(id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL,
  -- §8.19 annotation. Nullable, not in the content digest: existing rows keep
  -- their id. ALTER ADD COLUMN does not fire the append-only UPDATE trigger.
  decision_type TEXT,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS mission_decisions_mission_idx
  ON mission_decisions(tenant_id, mission_id, created_at);
-- A decision may be superseded by at most one successor: supersession is a
-- linear chain, never a fork and never an overwrite.
CREATE UNIQUE INDEX IF NOT EXISTS mission_decisions_supersedes_uidx
  ON mission_decisions(tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS mission_decisions_no_update
BEFORE UPDATE ON mission_decisions BEGIN
  SELECT RAISE(ABORT, 'mission_decisions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_decisions_no_delete
BEFORE DELETE ON mission_decisions BEGIN
  SELECT RAISE(ABORT, 'mission_decisions_append_only');
END;

CREATE TABLE IF NOT EXISTS mission_exceptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  impact TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  resolution_path TEXT NOT NULL,
  blocking INTEGER NOT NULL CHECK (blocking IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'withdrawn')),
  observed_snapshot_id TEXT,
  observed_resolved_sha TEXT,
  supersedes_id TEXT REFERENCES mission_exceptions(id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL,
  -- §8.20 annotations. Nullable, not in the content digest.
  task_id TEXT,
  category TEXT,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  FOREIGN KEY (observed_snapshot_id, tenant_id) REFERENCES repository_snapshots(id, tenant_id),
  -- A context-bound exception carries both snapshot-identity fields; a
  -- context-independent one carries neither.
  CHECK ((observed_snapshot_id IS NULL AND observed_resolved_sha IS NULL)
      OR (observed_snapshot_id IS NOT NULL AND observed_resolved_sha IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mission_exceptions_mission_idx
  ON mission_exceptions(tenant_id, mission_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS mission_exceptions_supersedes_uidx
  ON mission_exceptions(tenant_id, supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE TRIGGER IF NOT EXISTS mission_exceptions_no_update
BEFORE UPDATE ON mission_exceptions BEGIN
  SELECT RAISE(ABORT, 'mission_exceptions_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_exceptions_no_delete
BEFORE DELETE ON mission_exceptions BEGIN
  SELECT RAISE(ABORT, 'mission_exceptions_append_only');
END;

CREATE TABLE IF NOT EXISTS mission_verifications (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  verification TEXT NOT NULL,
  scope TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  resolved_sha TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'inconclusive')),
  verifier_principal_id TEXT NOT NULL REFERENCES principals(id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  FOREIGN KEY (snapshot_id, tenant_id) REFERENCES repository_snapshots(id, tenant_id)
);
CREATE INDEX IF NOT EXISTS mission_verifications_mission_idx
  ON mission_verifications(tenant_id, mission_id, scope, created_at);
CREATE TRIGGER IF NOT EXISTS mission_verifications_no_update
BEFORE UPDATE ON mission_verifications BEGIN
  SELECT RAISE(ABORT, 'mission_verifications_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_verifications_no_delete
BEFORE DELETE ON mission_verifications BEGIN
  SELECT RAISE(ABORT, 'mission_verifications_append_only');
END;

-- Mission Policy Envelope evaluation evidence (spec §6.7 / ME-PEV-001). One
-- immutable fact per enforcement decision: the exact envelope version a task was
-- evaluated under, the three-state outcome (enforced / no_envelope /
-- envelope_invalid), and the deny reasons. Brand-new, so — like the mission
-- durable-record tables above — it converges on fresh AND pre-change databases
-- purely through CREATE TABLE/INDEX IF NOT EXISTS, with no ALTER and no shape
-- change to any existing table. The composite foreign key (tenant_id, mission_id)
-- -> mission(tenant_id, id) binds every row to a mission of the same tenant, and
-- the primary key is a sha256 content digest that INCLUDES tenant_id, so a
-- different tenant produces a different id by construction. Append-only, enforced
-- by BEFORE UPDATE/DELETE triggers: a re-evaluation is a new row, never an
-- overwrite. The status/allowed/review_required CHECKs make an unenforced verdict
-- carrying a boolean decision unrepresentable.
CREATE TABLE IF NOT EXISTS mission_policy_evaluations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  envelope_version INTEGER,
  status TEXT NOT NULL CHECK (status IN ('enforced', 'no_envelope', 'envelope_invalid')),
  allowed INTEGER CHECK (allowed IN (0, 1) OR allowed IS NULL),
  review_required INTEGER CHECK (review_required IN (0, 1) OR review_required IS NULL),
  violations_json TEXT NOT NULL,
  task_digest TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS mission_policy_evaluations_mission_idx
  ON mission_policy_evaluations(tenant_id, mission_id, created_at);
CREATE TRIGGER IF NOT EXISTS mission_policy_evaluations_immutable
  BEFORE UPDATE ON mission_policy_evaluations
  BEGIN SELECT RAISE(ABORT, 'mission_policy_evaluation_immutable'); END;
CREATE TRIGGER IF NOT EXISTS mission_policy_evaluations_no_delete
  BEFORE DELETE ON mission_policy_evaluations
  BEGIN SELECT RAISE(ABORT, 'mission_policy_evaluation_immutable'); END;

-- Mission artifact registry (task brief §2). Mission outputs are first-class:
-- impact report, migration plan, candidate patch, pull request, test run,
-- verification report, architecture report, rollback plan, graph diff. These two
-- tables store REFERENCES and LINEAGE, never copies — the bytes live in
-- artifact_manifests (content-addressed). mission_artifacts binds a manifest to a
-- mission in a role; mission_artifact_lineage records which registered output
-- derived from which (a derived_from DAG). Both are brand-new, so — like the
-- mission durable-record tables above — they converge on fresh AND pre-change
-- databases purely through CREATE TABLE/INDEX IF NOT EXISTS, with no ALTER and no
-- shape change to any existing table. Both are append-only, enforced by BEFORE
-- UPDATE/DELETE triggers. Each row's primary key is a sha256 content digest over
-- canonical JSON that INCLUDES tenant_id (Change Graph Tier-1 binding), so a
-- different tenant produces a different primary key by construction. The
-- composite foreign keys (tenant_id, mission_id) -> mission(tenant_id, id) and
-- (tenant_id, artifact_id) -> artifact_manifests(tenant_id, id) make it
-- structurally impossible for a row to reference another tenant's mission or
-- artifact.
--
-- artifact_manifests_id_tenant_uidx is an additive index (existing columns,
-- index-only, no shape change) that the composite FK targets. It mirrors
-- repository_snapshots_id_tenant_uidx above. artifact_manifests.id is already the
-- PRIMARY KEY, so (id, tenant_id) is trivially unique and this index build cannot
-- fail on any pre-existing volume.
CREATE UNIQUE INDEX IF NOT EXISTS artifact_manifests_id_tenant_uidx
  ON artifact_manifests(id, tenant_id);

CREATE TABLE IF NOT EXISTS mission_artifacts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'impact_report', 'migration_plan', 'candidate_patch', 'pull_request', 'test_run',
    'verification_report', 'architecture_report', 'rollback_plan', 'graph_diff')),
  -- A REFERENCE to artifact_manifests(id); the content lives there and is never
  -- duplicated onto this row. artifact_sha256 is the manifest's canonical digest.
  artifact_id TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL CHECK (length(artifact_sha256) = 64),
  label TEXT NOT NULL,
  producer_principal_id TEXT NOT NULL REFERENCES principals(id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL,
  -- §8.21 annotations. Nullable, not in the content digest.
  task_id TEXT,
  source_snapshot TEXT,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES artifact_manifests(id, tenant_id),
  -- One registration per (mission, role, artifact): an artifact fills a role once.
  UNIQUE (tenant_id, mission_id, role, artifact_id)
);
CREATE INDEX IF NOT EXISTS mission_artifacts_mission_idx
  ON mission_artifacts(tenant_id, mission_id, role, created_at);
CREATE INDEX IF NOT EXISTS mission_artifacts_artifact_idx
  ON mission_artifacts(tenant_id, artifact_id);
CREATE TRIGGER IF NOT EXISTS mission_artifacts_no_update
BEFORE UPDATE ON mission_artifacts BEGIN
  SELECT RAISE(ABORT, 'mission_artifacts_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_artifacts_no_delete
BEFORE DELETE ON mission_artifacts BEGIN
  SELECT RAISE(ABORT, 'mission_artifacts_append_only');
END;

CREATE TABLE IF NOT EXISTS mission_artifact_lineage (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  -- artifact_id derived_from parent_artifact_id. Both are references to
  -- artifact_manifests and both must be registered outputs of this mission.
  artifact_id TEXT NOT NULL,
  parent_artifact_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK (relation IN ('derived_from')),
  recorded_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  FOREIGN KEY (artifact_id, tenant_id) REFERENCES artifact_manifests(id, tenant_id),
  FOREIGN KEY (parent_artifact_id, tenant_id) REFERENCES artifact_manifests(id, tenant_id),
  -- A DAG edge never points at itself; longer cycles are rejected in code.
  CHECK (artifact_id != parent_artifact_id),
  UNIQUE (tenant_id, mission_id, artifact_id, parent_artifact_id)
);
CREATE INDEX IF NOT EXISTS mission_artifact_lineage_child_idx
  ON mission_artifact_lineage(tenant_id, mission_id, artifact_id);
CREATE INDEX IF NOT EXISTS mission_artifact_lineage_parent_idx
  ON mission_artifact_lineage(tenant_id, mission_id, parent_artifact_id);
CREATE TRIGGER IF NOT EXISTS mission_artifact_lineage_no_update
BEFORE UPDATE ON mission_artifact_lineage BEGIN
  SELECT RAISE(ABORT, 'mission_artifact_lineage_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_artifact_lineage_no_delete
BEFORE DELETE ON mission_artifact_lineage BEGIN
  SELECT RAISE(ABORT, 'mission_artifact_lineage_append_only');
END;

-- Shared Mission Task engine (spec §6.8). The single work primitive both agents
-- and humans operate on, so work moves agent -> human -> agent without
-- reconstructing Mission context. Unlike the append-only record stores above, a
-- task TRANSITIONS in place under optimistic concurrency (revision), and the
-- hash-chained domain_events carry the audit trail (mirroring the mission row).
-- owner_type is the CURRENT owner (null while UNASSIGNED); handoff_reason records
-- why the last agent/human boundary was crossed; retry_count is the replan
-- history counter. Brand-new table + a companion dependency-edge table, so both
-- converge on fresh AND pre-change databases via CREATE TABLE/INDEX IF NOT EXISTS
-- with no ALTER. The composite FK (tenant_id, mission_id) -> mission(tenant_id,
-- id) binds every task to a mission of the same tenant.
CREATE TABLE IF NOT EXISTS mission_task (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
  status TEXT NOT NULL CHECK (status IN (
    'unassigned', 'agent_assigned', 'agent_working', 'human_review_required',
    'human_assigned', 'human_working', 'agent_resume', 'complete',
    'blocked', 'failed', 'cancelled', 'escalated')),
  owner_type TEXT CHECK (owner_type IN ('agent', 'human')),
  assigned_principal_id TEXT REFERENCES principals(id),
  handoff_reason TEXT,
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  revision INTEGER NOT NULL CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS mission_task_mission_idx
  ON mission_task(tenant_id, mission_id, status, created_at);

-- Task dependency edges (task depends_on prerequisite). Append-only DAG within a
-- single mission; a task is READY only when every prerequisite is COMPLETE. Both
-- endpoints must be tasks of the same (tenant, mission); self-edges are rejected
-- by CHECK and longer cycles in code.
CREATE TABLE IF NOT EXISTS mission_task_dependencies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on_task_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, mission_id) REFERENCES mission(tenant_id, id),
  FOREIGN KEY (task_id) REFERENCES mission_task(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES mission_task(id),
  CHECK (task_id != depends_on_task_id),
  UNIQUE (tenant_id, task_id, depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS mission_task_dependencies_task_idx
  ON mission_task_dependencies(tenant_id, task_id);
CREATE TRIGGER IF NOT EXISTS mission_task_dependencies_no_update
BEFORE UPDATE ON mission_task_dependencies BEGIN
  SELECT RAISE(ABORT, 'mission_task_dependencies_append_only');
END;
CREATE TRIGGER IF NOT EXISTS mission_task_dependencies_no_delete
BEFORE DELETE ON mission_task_dependencies BEGIN
  SELECT RAISE(ABORT, 'mission_task_dependencies_append_only');
END;

-- Trajectory capture (Intelligence Ownership Phases 4 + 7). The OBSERVATION layer
-- that closes Phase 0 blocker #1 (persist the input -> output pair) and blocker #4
-- (persist tool calls). It is NOT a learning-event store: learning-event
-- architecture, corpus, and pipeline are Codex-owned. A trajectory references a
-- learning event, router decision, or model reservation by id/digest only; it
-- never duplicates their fields. All three tables are brand-new, so — like the
-- mission table above — they converge on fresh AND pre-change databases purely
-- through CREATE TABLE/INDEX IF NOT EXISTS, with no ALTER and no shape change to
-- any existing table. trajectory_blobs and trajectory_steps are append-only.
--
-- trajectory_blobs is a per-tenant, content-addressed store of REDACTED text. It
-- is keyed by the digest of the ORIGINAL bytes (joinable to existing digests such
-- as fettler_model_reservations.request_digest), while content_text holds only the
-- redacted form. When redaction falls closed (redaction_excluded = 1), content_text
-- is NULL and only the digest + reason survive, so raw secret material is never
-- stored. Hidden chain-of-thought is never written (spec 8.12): callers pass only
-- observable request/response text.
CREATE TABLE IF NOT EXISTS trajectory_blobs (
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  content_text TEXT,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  redaction_applied INTEGER NOT NULL DEFAULT 1 CHECK (redaction_applied IN (0, 1)),
  redaction_excluded INTEGER NOT NULL DEFAULT 0 CHECK (redaction_excluded IN (0, 1)),
  redaction_reason TEXT,
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, content_sha256),
  CHECK (redaction_excluded = 0 OR content_text IS NULL)
);

CREATE TABLE IF NOT EXISTS trajectories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  mission_id TEXT REFERENCES mission(id),
  product TEXT NOT NULL CHECK (product IN ('fettler', 'regauge')),
  task_kind TEXT NOT NULL,
  task_summary TEXT NOT NULL,
  run_id TEXT,
  job_id TEXT,
  context_refs_json TEXT NOT NULL DEFAULT '[]',
  available_tools_json TEXT NOT NULL DEFAULT '[]',
  sandbox_backend TEXT,
  final_outcome TEXT,
  accepted TEXT,
  cost_usd REAL,
  cost_measured INTEGER NOT NULL DEFAULT 0 CHECK (cost_measured IN (0, 1)),
  latency_ms INTEGER,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS trajectories_tenant_created_idx
  ON trajectories(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS trajectories_mission_idx
  ON trajectories(tenant_id, mission_id) WHERE mission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trajectories_run_idx
  ON trajectories(tenant_id, run_id) WHERE run_id IS NOT NULL;

-- One append-only row per observable step. input_blob_sha256/output_blob_sha256
-- reference trajectory_blobs by digest (the (input -> output) pair, stored once and
-- deduplicated). model_id records whatever the call actually used (provider echo),
-- never a hardcoded model name. router_decision_ref, reservation_ref, and
-- learning_event_ref are cross-boundary references by id only.
CREATE TABLE IF NOT EXISTS trajectory_steps (
  id TEXT PRIMARY KEY,
  trajectory_id TEXT NOT NULL REFERENCES trajectories(id),
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  step_index INTEGER NOT NULL CHECK (step_index >= 0),
  step_kind TEXT NOT NULL CHECK (step_kind IN
    ('model_call', 'tool_call', 'router_decision', 'verification', 'retrieval', 'review', 'edit')),
  tool_name TEXT,
  planner_source TEXT,
  input_blob_sha256 TEXT,
  output_blob_sha256 TEXT,
  model_id TEXT,
  reservation_ref TEXT,
  router_decision_ref TEXT,
  learning_event_ref TEXT,
  verification_json TEXT,
  ok INTEGER CHECK (ok IN (0, 1)),
  error TEXT,
  -- Typed reason for a tool step's ok = 0, recorded verbatim from the tool
  -- result. Nullable: null is success (or a step kind that never sets it),
  -- never a fabricated class. No CHECK constraint so a new class value never
  -- requires a table rebuild on a deployed volume.
  failure_class TEXT,
  cost_usd REAL,
  latency_ms INTEGER,
  started_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, trajectory_id, step_index)
);
CREATE INDEX IF NOT EXISTS trajectory_steps_trajectory_idx
  ON trajectory_steps(tenant_id, trajectory_id, step_index);

CREATE TABLE IF NOT EXISTS learning_consents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  consent_version INTEGER NOT NULL CHECK (consent_version > 0),
  action TEXT NOT NULL CHECK (action IN ('granted', 'revoked')),
  purpose TEXT NOT NULL,
  residency_region TEXT NOT NULL,
  authorized_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  supersedes_consent_id TEXT REFERENCES learning_consents(id),
  effective_at TEXT NOT NULL,
  expires_at TEXT,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, purpose, residency_region, consent_version),
  UNIQUE (tenant_id, idempotency_key),
  CHECK (action != 'revoked' OR (supersedes_consent_id IS NOT NULL AND expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS learning_consents_scope_idx
  ON learning_consents(tenant_id, purpose, residency_region, consent_version);

CREATE TABLE IF NOT EXISTS learning_records (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  consent_id TEXT NOT NULL REFERENCES learning_consents(id),
  purpose TEXT NOT NULL,
  residency_region TEXT NOT NULL,
  source_object_type TEXT NOT NULL,
  source_object_id TEXT NOT NULL,
  source_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
  redacted_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
  redaction_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
  verification_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
  contamination_evidence_id TEXT NOT NULL REFERENCES evidence_records(id),
  accepted_review_id TEXT NOT NULL REFERENCES review_decisions(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  provenance_sha256 TEXT NOT NULL CHECK (length(provenance_sha256) = 64),
  observed_at TEXT NOT NULL,
  admitted_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS learning_records_consent_time_idx
  ON learning_records(tenant_id, consent_id, observed_at);
CREATE INDEX IF NOT EXISTS learning_records_content_idx
  ON learning_records(tenant_id, content_sha256);

CREATE TABLE IF NOT EXISTS learning_dataset_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  purpose TEXT NOT NULL,
  residency_region TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  temporal_cutoff_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'sealed')),
  dataset_sha256 TEXT CHECK (dataset_sha256 IS NULL OR length(dataset_sha256) = 64),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  sealed_by_principal_id TEXT REFERENCES principals(id),
  sealed_at TEXT,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, purpose, residency_region, version),
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((status = 'draft' AND dataset_sha256 IS NULL AND sealed_by_principal_id IS NULL AND sealed_at IS NULL)
    OR (status = 'sealed' AND dataset_sha256 IS NOT NULL AND sealed_by_principal_id IS NOT NULL AND sealed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS learning_dataset_members (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  dataset_version_id TEXT NOT NULL REFERENCES learning_dataset_versions(id),
  learning_record_id TEXT NOT NULL REFERENCES learning_records(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, dataset_version_id, learning_record_id),
  UNIQUE (tenant_id, dataset_version_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS learning_deletion_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  learning_record_id TEXT NOT NULL REFERENCES learning_records(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  action TEXT NOT NULL CHECK (action = 'deleted'),
  reason TEXT NOT NULL,
  requested_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, learning_record_id, action)
);

CREATE TRIGGER IF NOT EXISTS learning_consents_append_only_update BEFORE UPDATE ON learning_consents
BEGIN SELECT RAISE(ABORT, 'learning_consents_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_consents_append_only_delete BEFORE DELETE ON learning_consents
BEGIN SELECT RAISE(ABORT, 'learning_consents_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_records_append_only_update BEFORE UPDATE ON learning_records
BEGIN SELECT RAISE(ABORT, 'learning_records_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_records_append_only_delete BEFORE DELETE ON learning_records
BEGIN SELECT RAISE(ABORT, 'learning_records_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_dataset_versions_sealed_update BEFORE UPDATE ON learning_dataset_versions
WHEN OLD.status = 'sealed' BEGIN SELECT RAISE(ABORT, 'learning_dataset_versions_sealed'); END;
CREATE TRIGGER IF NOT EXISTS learning_dataset_versions_sealed_delete BEFORE DELETE ON learning_dataset_versions
WHEN OLD.status = 'sealed' BEGIN SELECT RAISE(ABORT, 'learning_dataset_versions_sealed'); END;
CREATE TRIGGER IF NOT EXISTS learning_dataset_members_append_only_update BEFORE UPDATE ON learning_dataset_members
BEGIN SELECT RAISE(ABORT, 'learning_dataset_members_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_dataset_members_append_only_delete BEFORE DELETE ON learning_dataset_members
BEGIN SELECT RAISE(ABORT, 'learning_dataset_members_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_deletion_events_append_only_update BEFORE UPDATE ON learning_deletion_events
BEGIN SELECT RAISE(ABORT, 'learning_deletion_events_append_only'); END;
CREATE TRIGGER IF NOT EXISTS learning_deletion_events_append_only_delete BEFORE DELETE ON learning_deletion_events
BEGIN SELECT RAISE(ABORT, 'learning_deletion_events_append_only'); END;
CREATE INDEX IF NOT EXISTS evidence_records_subject_idx ON evidence_records(tenant_id, subject_type, subject_id, created_at);

-- Organization Memory: a durable, tenant-scoped store for organizational
-- conventions and preferences, kept strictly separate from objective graph
-- facts (which live in the Change Graph). Tier 1 structural tenant binding:
-- record_id is the sha256 of the canonical body which INCLUDES tenant_id, so a
-- different tenant produces a different primary key by construction and a
-- cross-tenant collision is arithmetically impossible, not merely filtered
-- (mirrors gl_software_versions_v1). Append-only: every lifecycle transition and
-- every edit is a NEW immutable row on a supersession chain keyed by memory_id,
-- so history can never be destroyed by an edit or disable (see the append-only
-- triggers below). The whole table is self-contained in this static DDL; no
-- additive migration adds a column it depends on, so an existing volume that
-- predates the table gains it via CREATE TABLE IF NOT EXISTS on next boot.
CREATE TABLE IF NOT EXISTS organization_memory (
  record_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_record_id TEXT REFERENCES organization_memory(record_id),
  transition TEXT NOT NULL CHECK (transition IN (
    'observed', 'corroborated', 'validated', 'human_confirmed', 'activated',
    'created_explicit', 'edited', 'disabled', 'rejected', 'staled', 'deleted')),
  scope TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'ARCHITECTURE_CONVENTION', 'CODING_CONVENTION', 'MIGRATION_PREFERENCE',
    'TESTING_REQUIREMENT', 'REVIEW_PREFERENCE', 'DEPLOYMENT_POLICY',
    'RISK_PREFERENCE', 'INTERNAL_ABSTRACTION', 'PRESENTATION_PREFERENCE')),
  statement TEXT NOT NULL,
  structured_value TEXT,
  source TEXT NOT NULL CHECK (source IN (
    'explicit', 'policy_config', 'repeated_verified_behavior', 'reviewer_correction')),
  source_refs TEXT NOT NULL,
  observation_fingerprint TEXT,
  confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  status TEXT NOT NULL CHECK (status IN (
    'OBSERVATION', 'MEMORY_CANDIDATE', 'VALIDATION', 'CONFIRMED', 'ACTIVE',
    'REJECTED', 'STALE', 'DISABLED', 'DELETED')),
  applies_to TEXT NOT NULL,
  training_eligible INTEGER NOT NULL DEFAULT 0 CHECK (training_eligible IN (0, 1)),
  actor_principal_id TEXT REFERENCES principals(id),
  reason TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_at TEXT NOT NULL,
  last_confirmed_at TEXT,
  UNIQUE (tenant_id, memory_id, revision),
  UNIQUE (tenant_id, memory_id, observation_fingerprint)
);
CREATE INDEX IF NOT EXISTS organization_memory_chain_idx
  ON organization_memory(tenant_id, memory_id, revision);
CREATE INDEX IF NOT EXISTS organization_memory_status_idx
  ON organization_memory(tenant_id, status, memory_id);
CREATE TRIGGER IF NOT EXISTS organization_memory_append_only_update BEFORE UPDATE ON organization_memory
BEGIN SELECT RAISE(ABORT, 'organization_memory_append_only'); END;
CREATE TRIGGER IF NOT EXISTS organization_memory_append_only_delete BEFORE DELETE ON organization_memory
BEGIN SELECT RAISE(ABORT, 'organization_memory_append_only'); END;

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  candidate_artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
  reviewer_principal_id TEXT NOT NULL REFERENCES principals(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'request_changes', 'regenerate', 'waive')),
  rationale TEXT NOT NULL,
  waiver_expires_at TEXT,
  supersedes_id TEXT REFERENCES review_decisions(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_decisions_subject_idx ON review_decisions(tenant_id, subject_type, subject_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS review_decisions_chain_idx
  ON review_decisions(
    tenant_id,
    subject_type,
    subject_id,
    candidate_artifact_id,
    COALESCE(supersedes_id, '')
  );

CREATE TABLE IF NOT EXISTS pilot_success_contract_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  contract_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_version_id TEXT REFERENCES pilot_success_contract_versions(id),
  title TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES artifact_manifests(id),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  created_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, contract_id, version),
  UNIQUE (tenant_id, artifact_id)
);
CREATE INDEX IF NOT EXISTS pilot_success_contract_versions_tenant_idx
  ON pilot_success_contract_versions(tenant_id, contract_id, version);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  correlation_id TEXT NOT NULL,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  prev_hash TEXT,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, event_sequence),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS domain_events_aggregate_idx ON domain_events(tenant_id, aggregate_type, aggregate_id, event_sequence);

CREATE TABLE IF NOT EXISTS scm_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'local_git')),
  credential_ref TEXT NOT NULL,
  external_account_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (tenant_id, provider, external_account_id)
);
CREATE INDEX IF NOT EXISTS scm_connections_tenant_idx ON scm_connections(tenant_id, provider);

-- Durable encrypted secret generations. SCM rows keep their scheme://id reference;
-- source_ref resolves that compatibility locator to the current lifecycle record.
-- There is deliberately no plaintext column.
CREATE TABLE IF NOT EXISTS secret_lifecycle_versions (
  tenant_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
  audiences_json TEXT NOT NULL,
  expires_at TEXT,
  issued_at TEXT NOT NULL,
  rotate_after TEXT,
  retired_at TEXT,
  revoked_at TEXT,
  revocation_reason TEXT,
  key_provider TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_version TEXT NOT NULL,
  customer_managed INTEGER NOT NULL CHECK (customer_managed IN (0, 1)),
  key_attestation_sha256 TEXT NOT NULL CHECK (length(key_attestation_sha256) = 64),
  material_lineage_id TEXT NOT NULL CHECK (length(material_lineage_id) = 64),
  material_lineage_key_id TEXT NOT NULL,
  envelope_schema_version INTEGER NOT NULL CHECK (envelope_schema_version = 1),
  algorithm TEXT NOT NULL CHECK (algorithm = 'AES-256-GCM'),
  wrapped_data_key TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, credential_id, generation),
  UNIQUE (tenant_id, source_ref, generation),
  CHECK ((state = 'active' AND retired_at IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'retired' AND retired_at IS NOT NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR (state = 'revoked' AND revoked_at IS NOT NULL AND length(trim(revocation_reason)) > 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS secret_lifecycle_one_active_idx
  ON secret_lifecycle_versions(tenant_id, credential_id) WHERE state = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS secret_lifecycle_one_active_source_ref_idx
  ON secret_lifecycle_versions(tenant_id, source_ref) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS secret_lifecycle_source_ref_idx
  ON secret_lifecycle_versions(tenant_id, source_ref, generation);

-- Immutable protected-state binding between a lineage key's versioned ID and
-- a domain-separated commitment of its random key bytes. The commitment is
-- safe to retain; key material never enters the database.
CREATE TABLE IF NOT EXISTS secret_lineage_key_bindings (
  tenant_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  key_fingerprint TEXT NOT NULL CHECK (length(key_fingerprint) = 64),
  bound_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key_id)
);
CREATE TRIGGER IF NOT EXISTS secret_lineage_key_bindings_no_update
BEFORE UPDATE ON secret_lineage_key_bindings BEGIN
  SELECT RAISE(ABORT, 'secret_lineage_key_binding_immutable');
END;
CREATE TRIGGER IF NOT EXISTS secret_lineage_key_bindings_no_delete
BEFORE DELETE ON secret_lineage_key_bindings BEGIN
  SELECT RAISE(ABORT, 'secret_lineage_key_binding_delete_forbidden');
END;

CREATE TABLE IF NOT EXISTS secret_lifecycle_operations (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rotate')),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_commitment_key_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  result_generation INTEGER NOT NULL CHECK (result_generation >= 1),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, credential_id, result_generation)
    REFERENCES secret_lifecycle_versions(tenant_id, credential_id, generation)
);
CREATE INDEX IF NOT EXISTS secret_lifecycle_operations_result_idx
  ON secret_lifecycle_operations(tenant_id, credential_id, result_generation);
CREATE TRIGGER IF NOT EXISTS secret_lifecycle_operations_no_update
BEFORE UPDATE ON secret_lifecycle_operations
BEGIN
  SELECT RAISE(ABORT, 'secret_lifecycle_operation_immutable');
END;

CREATE TABLE IF NOT EXISTS secret_rewrap_operations (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_commitment_key_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  result_generation INTEGER NOT NULL CHECK (result_generation >= 1),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, credential_id, result_generation)
    REFERENCES secret_lifecycle_versions(tenant_id, credential_id, generation)
);
CREATE TRIGGER IF NOT EXISTS secret_rewrap_operations_no_update
BEFORE UPDATE ON secret_rewrap_operations BEGIN
  SELECT RAISE(ABORT, 'secret_rewrap_operation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS secret_rewrap_operations_no_delete
BEFORE DELETE ON secret_rewrap_operations BEGIN
  SELECT RAISE(ABORT, 'secret_rewrap_operation_delete_forbidden');
END;

CREATE TABLE IF NOT EXISTS secret_break_glass_operations (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_commitment_key_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, credential_id, generation)
    REFERENCES secret_lifecycle_versions(tenant_id, credential_id, generation)
);
CREATE INDEX IF NOT EXISTS secret_break_glass_operations_result_idx
  ON secret_break_glass_operations(tenant_id, credential_id, generation);
CREATE TRIGGER IF NOT EXISTS secret_break_glass_operations_no_update
BEFORE UPDATE ON secret_break_glass_operations
BEGIN
  SELECT RAISE(ABORT, 'secret_break_glass_operation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS secret_break_glass_operations_no_delete
BEFORE DELETE ON secret_break_glass_operations
BEGIN
  SELECT RAISE(ABORT, 'secret_break_glass_operation_delete_forbidden');
END;
CREATE TRIGGER IF NOT EXISTS secret_lifecycle_operations_no_delete
BEFORE DELETE ON secret_lifecycle_operations
BEGIN
  SELECT RAISE(ABORT, 'secret_lifecycle_operation_delete_forbidden');
END;

CREATE TABLE IF NOT EXISTS secret_revoke_operations (
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  request_commitment_key_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  completed_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, credential_id, generation)
    REFERENCES secret_lifecycle_versions(tenant_id, credential_id, generation)
);
CREATE TRIGGER IF NOT EXISTS secret_revoke_operations_no_update
BEFORE UPDATE ON secret_revoke_operations BEGIN
  SELECT RAISE(ABORT, 'secret_revoke_operation_immutable');
END;
CREATE TRIGGER IF NOT EXISTS secret_revoke_operations_no_delete
BEFORE DELETE ON secret_revoke_operations BEGIN
  SELECT RAISE(ABORT, 'secret_revoke_operation_delete_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS secret_lifecycle_versions_no_delete
BEFORE DELETE ON secret_lifecycle_versions
BEGIN
  SELECT RAISE(ABORT, 'secret_lifecycle_delete_forbidden');
END;

CREATE TRIGGER IF NOT EXISTS secret_lifecycle_versions_guard_update
BEFORE UPDATE ON secret_lifecycle_versions
WHEN
  NEW.tenant_id IS NOT OLD.tenant_id OR
  NEW.credential_id IS NOT OLD.credential_id OR
  NEW.source_ref IS NOT OLD.source_ref OR
  NEW.generation IS NOT OLD.generation OR
  NEW.audiences_json IS NOT OLD.audiences_json OR
  NEW.expires_at IS NOT OLD.expires_at OR
  NEW.issued_at IS NOT OLD.issued_at OR
  NEW.rotate_after IS NOT OLD.rotate_after OR
  NEW.key_provider IS NOT OLD.key_provider OR
  NEW.key_id IS NOT OLD.key_id OR
  NEW.key_version IS NOT OLD.key_version OR
  NEW.customer_managed IS NOT OLD.customer_managed OR
  NEW.key_attestation_sha256 IS NOT OLD.key_attestation_sha256 OR
  NEW.material_lineage_id IS NOT OLD.material_lineage_id OR
  NEW.material_lineage_key_id IS NOT OLD.material_lineage_key_id OR
  NEW.envelope_schema_version IS NOT OLD.envelope_schema_version OR
  NEW.algorithm IS NOT OLD.algorithm OR
  NEW.wrapped_data_key IS NOT OLD.wrapped_data_key OR
  NEW.iv IS NOT OLD.iv OR
  NEW.auth_tag IS NOT OLD.auth_tag OR
  NEW.ciphertext IS NOT OLD.ciphertext OR
  NEW.created_at IS NOT OLD.created_at OR
  NOT (
    (OLD.state = 'active' AND NEW.state = 'retired' AND
      NEW.retired_at IS NOT NULL AND NEW.revoked_at IS NULL AND NEW.revocation_reason IS NULL) OR
    (OLD.state IN ('active', 'retired') AND NEW.state = 'revoked' AND
      NEW.retired_at IS OLD.retired_at AND NEW.revoked_at IS NOT NULL AND
      length(trim(NEW.revocation_reason)) > 0)
  )
BEGIN
  SELECT RAISE(ABORT, 'secret_lifecycle_transition_invalid');
END;

CREATE TABLE IF NOT EXISTS connected_repositories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES scm_connections(id),
  remote_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  selected_branch TEXT NOT NULL,
  environment TEXT NOT NULL,
  retention_days INTEGER NOT NULL CHECK (retention_days > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'degraded', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, connection_id, remote_id)
);
CREATE INDEX IF NOT EXISTS connected_repositories_tenant_idx ON connected_repositories(tenant_id, status);

CREATE TABLE IF NOT EXISTS repository_snapshots (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  repository_id TEXT NOT NULL REFERENCES connected_repositories(id),
  requested_ref TEXT NOT NULL,
  resolved_sha TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  submodules_policy TEXT NOT NULL CHECK (submodules_policy IN ('reject', 'pinned')),
  lfs_policy TEXT NOT NULL CHECK (lfs_policy IN ('reject', 'pointer_only', 'fetch')),
  sparse_paths_json TEXT NOT NULL,
  file_manifest_version INTEGER NOT NULL DEFAULT 0 CHECK (file_manifest_version IN (0, 1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_snapshots_tenant_idx ON repository_snapshots(tenant_id, repository_id, created_at);
CREATE INDEX IF NOT EXISTS repository_snapshots_identity_idx
  ON repository_snapshots(tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS repository_snapshots_id_tenant_uidx
  ON repository_snapshots(id, tenant_id);

CREATE TABLE IF NOT EXISTS repository_snapshot_files (
  snapshot_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('100644', '100755', '120000')),
  kind TEXT NOT NULL CHECK (kind IN ('file', 'symlink')),
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (snapshot_id, path),
  FOREIGN KEY (snapshot_id, tenant_id) REFERENCES repository_snapshots(id, tenant_id),
  CHECK ((kind = 'file' AND mode IN ('100644', '100755')) OR
         (kind = 'symlink' AND mode = '120000'))
);
CREATE INDEX IF NOT EXISTS repository_snapshot_files_tenant_idx
  ON repository_snapshot_files(tenant_id, snapshot_id, path);

CREATE TABLE IF NOT EXISTS repository_snapshot_policies (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL UNIQUE REFERENCES repository_snapshots(id),
  codeowners_json TEXT NOT NULL,
  ci_files_json TEXT NOT NULL,
  verification_commands_json TEXT NOT NULL,
  protected_branch_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scm_connection_health (
  connection_id TEXT PRIMARY KEY REFERENCES scm_connections(id),
  tenant_id TEXT NOT NULL,
  configured INTEGER NOT NULL,
  authenticated INTEGER NOT NULL,
  read_access INTEGER NOT NULL,
  write_access INTEGER NOT NULL,
  webhook_ok INTEGER NOT NULL,
  ci_visible INTEGER NOT NULL,
  last_sync_at TEXT,
  last_delivery_at TEXT,
  revoked INTEGER NOT NULL,
  error_code TEXT,
  checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scm_connection_health_tenant_idx ON scm_connection_health(tenant_id, checked_at);

CREATE TABLE IF NOT EXISTS repository_snapshot_deletions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES repository_snapshots(id),
  status TEXT NOT NULL CHECK (status IN ('planned', 'deleted', 'failed')),
  actor_principal_id TEXT NOT NULL,
  error_code TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS repository_snapshot_deletions_tenant_idx
  ON repository_snapshot_deletions(tenant_id, snapshot_id, created_at);

-- Durable policy-routing ledger: one row per routing decision for a job/run.
-- Every column lives in this table's own CREATE, so the indexes below are safe
-- in the static DDL (no additive migration adds a column they depend on).
CREATE TABLE IF NOT EXISTS routing_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  run_id TEXT,
  task_kind TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  policy_snapshot_id TEXT NOT NULL,
  task_snapshot_id TEXT NOT NULL,
  action TEXT NOT NULL,
  selected_executor_id TEXT,
  executed_executor_id TEXT,
  provider_id TEXT,
  eliminated_json TEXT NOT NULL DEFAULT '[]',
  fallback_json TEXT NOT NULL DEFAULT '[]',
  breaker_json TEXT NOT NULL DEFAULT '[]',
  handoff_required INTEGER NOT NULL DEFAULT 0,
  handoff_reason TEXT,
  outcome TEXT,
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  started_at TEXT,
  completed_at TEXT,
  decision_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, job_id, envelope_id)
);
CREATE INDEX IF NOT EXISTS routing_ledger_job_idx
  ON routing_ledger(tenant_id, job_id, created_at);
CREATE INDEX IF NOT EXISTS routing_ledger_run_idx
  ON routing_ledger(tenant_id, run_id, created_at);

-- Exactly-once application record for routing outcomes. Kept in a separate
-- table so existing databases gain the invariant safely without an additive
-- routing_ledger column/index ordering hazard during boot.
CREATE TABLE IF NOT EXISTS routing_outcome_applications (
  tenant_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, job_id, idempotency_key),
  UNIQUE (tenant_id, job_id, envelope_id)
);
CREATE INDEX IF NOT EXISTS routing_outcome_applications_envelope_idx
  ON routing_outcome_applications(tenant_id, job_id, envelope_id);

-- Durable executor/provider circuit-breaker health used for outcome feedback.
-- Bounded: at most one row per (tenant, scope, executor, provider); success
-- deletes the row so the table never grows without failing executors.
CREATE TABLE IF NOT EXISTS routing_executor_health (
  tenant_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('executor', 'provider')),
  executor_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, executor_id, provider_id)
);

-- Wave 3b: per-agent-run metering feed. One row per run captures its outcome,
-- token usage, and MEASURED cost (null when unmeasured — never fabricated).
-- Cost/tokens are sourced from routing_ledger at metering time. Every column
-- lives in this table's own CREATE and the indexes reference only its own
-- columns, so the whole table is safe in the static DDL (no additive migration
-- adds a column it depends on).
CREATE TABLE IF NOT EXISTS agent_run_meters (
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL,
  candidate_ready_at TEXT,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  total_tokens INTEGER,
  cost_usd REAL,
  cost_measured INTEGER NOT NULL DEFAULT 0 CHECK (cost_measured IN (0, 1)),
  metered_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS agent_run_meters_tenant_created_idx
  ON agent_run_meters(tenant_id, created_at);

-- S3: optional developer-satisfaction capture. There is no pre-existing
-- satisfaction signal in the schema; rather than let the self-serve dashboard
-- fabricate one, a developer can attach a 1-5 rating to a reviewed run or PR.
-- The dashboard summarizes ONLY these real rows (unavailable when none exist).
-- The rating CHECK makes an out-of-range score impossible at the storage layer.
-- Every column lives in this table's own CREATE, so the index below is safe in
-- the static DDL (no additive migration adds a column it depends on).
CREATE TABLE IF NOT EXISTS developer_satisfaction_signals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  pr_id TEXT,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  submitted_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS developer_satisfaction_signals_tenant_created_idx
  ON developer_satisfaction_signals(tenant_id, created_at);

-- Durable review state for Transformer *adaptive* candidates. When the bounded
-- adaptive repair loop converges on a fix that DIVERGES from the deterministic
-- recipe output, that fix is not auto-promoted: it is recorded here as a
-- distinct kind ('adaptive') awaiting explicit human sign-off. The kind CHECK
-- makes it impossible for a recipe-candidate code path to ever approve one of
-- these rows. Every column lives in this table's own CREATE, so the index below
-- is safe in the static DDL (no additive migration adds a column it depends on).
CREATE TABLE IF NOT EXISTS regauge_adaptive_candidates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  expected_base_revision TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'adaptive'),
  status TEXT NOT NULL CHECK (
    status IN ('review_pending', 'approved', 'rejected', 'superseded', 'promoted', 'expired')
  ),
  review_tier TEXT NOT NULL DEFAULT 'standard',
  diverged_from_digest TEXT NOT NULL,
  candidate_digest TEXT NOT NULL,
  failing_command_id TEXT,
  family TEXT,
  provider TEXT,
  framework TEXT,
  sealed_path TEXT NOT NULL,
  sealed_sha256 TEXT NOT NULL,
  changed_paths_json TEXT NOT NULL,
  reviewer_principal_id TEXT,
  review_decision TEXT CHECK (review_decision IN ('approve', 'reject', 'regenerate')),
  review_rationale TEXT,
  reviewed_at TEXT,
  escalation_reviewer_principal_id TEXT,
  escalation_reviewed_at TEXT,
  escalation_rationale TEXT,
  promoted_at TEXT,
  supersedes_candidate_id TEXT,
  superseded_by_candidate_id TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, campaign_id, unit_id, attempt_id)
);
CREATE INDEX IF NOT EXISTS regauge_adaptive_candidates_tenant_idx
  ON regauge_adaptive_candidates(tenant_id, campaign_id, status, created_at);

CREATE TABLE IF NOT EXISTS regauge_adaptive_regenerations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  reviewer_principal_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  rationale_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'scheduled', 'completed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  superseding_candidate_id TEXT,
  requested_at TEXT NOT NULL,
  scheduled_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS regauge_adaptive_regenerations_pending_idx
  ON regauge_adaptive_regenerations(status, requested_at, id);

CREATE TABLE IF NOT EXISTS regauge_adaptive_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('delivery_pending', 'delivered', 'delivery_failed')
  ),
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  expected_base_revision TEXT NOT NULL,
  intent_digest TEXT,
  branch_name TEXT,
  base_revision TEXT,
  commit_sha TEXT,
  draft_pr INTEGER CHECK (draft_pr = 1),
  draft_pr_number INTEGER,
  draft_pr_url TEXT,
  requester_principal_id TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  intent_bound_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  last_error_at TEXT,
  -- Post-delivery acceptance signal (the PR real fate), orthogonal to the
  -- delivery-pipeline status. NULL means "no outcome received yet" (pending),
  -- which must never read as a negative. Populated later, once GitHub reports the
  -- PR merged/closed/reverted. Nullable, no default: an existing DB converges on
  -- boot via the additive column list and legacy rows read NULL. Validated in the
  -- mapper (values: merged, closed_unmerged, reverted); no static
  -- index/view/constraint references it, so the static DDL never touches it on a
  -- DB that has not yet run the migration.
  outcome TEXT,
  outcome_at TEXT,
  outcome_source TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS regauge_adaptive_deliveries_tenant_idx
  ON regauge_adaptive_deliveries(tenant_id, status, requested_at);

CREATE TABLE IF NOT EXISTS fettler_candidate_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('delivery_pending', 'delivered', 'delivery_failed')
  ),
  repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  expected_base_revision TEXT NOT NULL,
  sealed_path TEXT NOT NULL,
  sealed_sha256 TEXT NOT NULL,
  requester_principal_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  mission_authority_json TEXT,
  precursor_migration_pr_id TEXT,
  intent_digest TEXT,
  branch_name TEXT,
  base_revision TEXT,
  commit_sha TEXT,
  draft_pr INTEGER CHECK (draft_pr = 1),
  draft_pr_number INTEGER,
  draft_pr_url TEXT,
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  intent_bound_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  last_error_at TEXT,
  -- Post-delivery acceptance signal (the PR real fate), orthogonal to the
  -- delivery-pipeline status. NULL means "no outcome received yet" (pending),
  -- which must never read as a negative. Populated later, once GitHub reports the
  -- PR merged/closed/reverted. Nullable, no default: an existing DB converges on
  -- boot via the additive column list and legacy rows read NULL. Validated in the
  -- mapper (values: merged, closed_unmerged, reverted); no static
  -- index/view/constraint references it, so the static DDL never touches it on a
  -- DB that has not yet run the migration.
  outcome TEXT,
  outcome_at TEXT,
  outcome_source TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, run_id)
);
CREATE INDEX IF NOT EXISTS fettler_candidate_deliveries_tenant_idx
  ON fettler_candidate_deliveries(tenant_id, status, requested_at);

CREATE TABLE IF NOT EXISTS fettler_ci_cycles (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  observation_job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('observation_pending', 'checks_running', 'checks_failed', 'repair_pending',
      'candidate_ready', 'update_pending', 'awaiting_review', 'succeeded', 'paused', 'exhausted')
  ),
  repository_id TEXT NOT NULL,
  remote_repository_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  pull_request_number INTEGER NOT NULL,
  base_branch TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  current_head_sha TEXT NOT NULL,
  required_checks_json TEXT NOT NULL,
  allowed_changed_paths_json TEXT NOT NULL,
  max_cycles INTEGER NOT NULL,
  used_cycles INTEGER NOT NULL DEFAULT 0,
  max_model_calls INTEGER NOT NULL,
  maximum_cost_usd REAL NOT NULL,
  current_observation_digest TEXT,
  repair_run_id TEXT,
  repair_job_id TEXT,
  paused_by TEXT,
  pause_reason TEXT,
  mission_authority_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS fettler_ci_cycles_tenant_status_idx
  ON fettler_ci_cycles(tenant_id, status, updated_at);

CREATE TABLE IF NOT EXISTS fettler_ci_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('success', 'failure', 'running', 'missing')),
  observation_digest TEXT NOT NULL,
  evidence_artifact_id TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE (tenant_id, cycle_id, head_sha, observation_digest)
);
CREATE INDEX IF NOT EXISTS fettler_ci_observations_cycle_idx
  ON fettler_ci_observations(tenant_id, cycle_id, observed_at);

CREATE TABLE IF NOT EXISTS fettler_ci_updates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  repair_run_id TEXT NOT NULL,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'intent_bound', 'uncertain', 'delivered', 'failed')),
  expected_head_sha TEXT NOT NULL,
  expected_feedback_digest TEXT,
  sealed_path TEXT NOT NULL,
  sealed_sha256 TEXT NOT NULL,
  reviewer_principal_id TEXT NOT NULL,
  rationale TEXT NOT NULL,
  mission_authority_json TEXT,
  intent_digest TEXT,
  commit_sha TEXT,
  requested_at TEXT NOT NULL,
  delivered_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, cycle_id, repair_run_id)
);
CREATE INDEX IF NOT EXISTS fettler_ci_updates_tenant_status_idx
  ON fettler_ci_updates(tenant_id, status, updated_at);

CREATE TABLE IF NOT EXISTS mission_mutation_dispatches (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  mutation_kind TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  intent_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('authorized', 'dispatching', 'uncertain', 'settled', 'revoked')),
  lease_owner TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  authorized_at TEXT NOT NULL,
  dispatching_at TEXT,
  uncertain_at TEXT,
  settled_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, job_id)
);
CREATE INDEX IF NOT EXISTS mission_mutation_dispatches_mission_state_idx
  ON mission_mutation_dispatches(tenant_id, mission_id, state);

-- Retrieval context-gap sink. One row per admitted governed-learning lesson whose
-- attribution derived to retrieval (spec 17.4.2): objective verification failed AND
-- the run's captured trajectory confirmed the context the model needed was
-- recorded_absent. Every row therefore means required context was confirmed missing,
-- never that the model was wrong; the salient fact is the retrieval gap. Written
-- inside the admission transaction (packages/pipeline admitGovernedLearningEvent)
-- and read by the outcome-metrics surface (computeRetrievalContextGaps), the
-- downstream consumer that turns this destination from unrouted into a real sink.
-- Keyed 1:1 by the learning_record_id so idempotent re-admission never double counts
-- (INSERT OR IGNORE). A brand-new table: CREATE TABLE IF NOT EXISTS converges on both
-- a fresh database and an upgrade, so no additive-column migration is needed.
CREATE TABLE IF NOT EXISTS retrieval_context_gaps (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  learning_record_id TEXT NOT NULL REFERENCES learning_records(id),
  event_id TEXT NOT NULL,
  event_digest TEXT NOT NULL,
  product TEXT NOT NULL CHECK (product IN ('fettler', 'regauge')),
  capability TEXT NOT NULL,
  task_type TEXT NOT NULL,
  migration_family TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, learning_record_id)
);
CREATE INDEX IF NOT EXISTS retrieval_context_gaps_tenant_time_idx
  ON retrieval_context_gaps(tenant_id, observed_at);
`;


export function resolveDbPath(urlOrPath?: string): string {
  const root = findMonorepoRoot();
  const fallback = join(root, "data", "mendpoint.sqlite");
  const raw =
    urlOrPath ??
    process.env.DATABASE_URL ??
    (process.env.MENDPOINT_DATA_DIR
      ? join(process.env.MENDPOINT_DATA_DIR, "mendpoint.sqlite")
      : undefined);
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
  try {
    // Reliability + concurrent reader/writer friendliness on Windows
    raw.exec("PRAGMA foreign_keys = ON;");
    raw.exec("PRAGMA journal_mode = WAL;");
    raw.exec("PRAGMA synchronous = NORMAL;");
    raw.exec("PRAGMA busy_timeout = 5000;");
    raw.exec("PRAGMA temp_store = MEMORY;");
    raw.exec(DDL);
    ensureAuditGovernanceSchema({ raw });
    migrateTenantMembershipUserNameUniqueness({ raw });
    validateIdentitySessionPrincipalAuthority({ raw });
    migrateRepositorySnapshotIdentity({ raw });
    migrateProvidersFeedColumns({ raw });
    migrateAuditIntegrity({ raw });
    migrateArtifactContent({ raw });
    migrateSecretLifecycleOperationCommitments({ raw });
    migrateSecretLifecycleAttestation({ raw });
    migrateWardenTransformerTableNames({ raw });
    installFettlerCandidateDeliveryPrecursorIndex({ raw });
    migrateWardenCiAwaitingReview({ raw });
    installTrustImmutability({ raw });
    return { raw };
  } catch (error) {
    raw.close();
    throw error;
  }
}

function installFettlerCandidateDeliveryPrecursorIndex(db: AppDb): void {
  db.raw.exec(`
    CREATE INDEX IF NOT EXISTS fettler_candidate_deliveries_precursor_idx
      ON fettler_candidate_deliveries(tenant_id, precursor_migration_pr_id);
  `);
}

function validateIdentitySessionPrincipalAuthority(db: AppDb): void {
  const conflict = db.raw.prepare(
    `SELECT sessions.id
     FROM identity_sessions AS sessions
     LEFT JOIN principals
       ON principals.id = sessions.principal_id
      AND principals.tenant_id = sessions.tenant_id
      AND principals.kind = 'human'
      AND principals.audience = sessions.issuer
      AND principals.subject = sessions.issuer || '|' || sessions.subject
     WHERE principals.id IS NULL
     LIMIT 1`,
  ).get();
  if (conflict) throw new Error("identity_session_principal_authority_mismatch");
}

function migrateTenantMembershipUserNameUniqueness(db: AppDb): void {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const conflict = db.raw.prepare(
      `SELECT tenant_id, issuer, lower(email) AS user_name, COUNT(*) AS count
       FROM tenant_memberships
       WHERE email IS NOT NULL
       GROUP BY tenant_id, issuer, lower(email)
       HAVING COUNT(*) > 1
       LIMIT 1`,
    ).get() as { tenant_id: string; issuer: string; user_name: string; count: number } | undefined;
    if (conflict) throw new Error("tenant_membership_user_name_conflict");
    db.raw.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS tenant_memberships_username_domain_uidx
       ON tenant_memberships(tenant_id, issuer, lower(email))
       WHERE email IS NOT NULL`,
    );
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function migrateSecretLifecycleOperationCommitments(db: AppDb): void {
  const columns = all<{ name: string }>(
    db,
    "PRAGMA table_info(secret_lifecycle_operations)",
  ).map((column) => column.name);
  if (!columns.includes("request_commitment_key_id")) {
    run(db, "ALTER TABLE secret_lifecycle_operations ADD COLUMN request_commitment_key_id TEXT");
  }
  db.raw.exec(`
    CREATE TRIGGER IF NOT EXISTS secret_lifecycle_operations_commitment_required
    BEFORE INSERT ON secret_lifecycle_operations
    WHEN NEW.request_commitment_key_id IS NULL OR length(trim(NEW.request_commitment_key_id)) = 0
    BEGIN
      SELECT RAISE(ABORT, 'secret_lifecycle_commitment_key_required');
    END;
  `);
}

function migrateSecretLifecycleAttestation(db: AppDb): void {
  db.raw.exec("DROP TRIGGER IF EXISTS secret_lifecycle_versions_guard_update");
  const columns = all<{ name: string }>(
    db,
    "PRAGMA table_info(secret_lifecycle_versions)",
  ).map((column) => column.name);
  if (!columns.includes("key_attestation_sha256")) {
    run(db, "ALTER TABLE secret_lifecycle_versions ADD COLUMN key_attestation_sha256 TEXT");
  }
  if (!columns.includes("material_lineage_id")) {
    run(db, "ALTER TABLE secret_lifecycle_versions ADD COLUMN material_lineage_id TEXT");
  }
  if (!columns.includes("material_lineage_key_id")) {
    run(db, "ALTER TABLE secret_lifecycle_versions ADD COLUMN material_lineage_key_id TEXT");
  }
  run(db, `UPDATE secret_lifecycle_versions AS version
    SET material_lineage_key_id = (
      SELECT operation.request_commitment_key_id
      FROM secret_lifecycle_operations AS operation
      WHERE operation.tenant_id = version.tenant_id
        AND operation.credential_id = version.credential_id
        AND operation.result_generation <= version.generation
        AND operation.request_commitment_key_id IS NOT NULL
      ORDER BY operation.result_generation DESC
      LIMIT 1
    )
    WHERE material_lineage_key_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM secret_lifecycle_operations AS operation
        WHERE operation.tenant_id = version.tenant_id
          AND operation.credential_id = version.credential_id
          AND operation.result_generation <= version.generation
          AND operation.request_commitment_key_id IS NOT NULL
      )`);
  db.raw.exec(`
    CREATE TRIGGER secret_lifecycle_versions_guard_update
    BEFORE UPDATE ON secret_lifecycle_versions
    WHEN
      NEW.tenant_id IS NOT OLD.tenant_id OR
      NEW.credential_id IS NOT OLD.credential_id OR
      NEW.source_ref IS NOT OLD.source_ref OR
      NEW.generation IS NOT OLD.generation OR
      NEW.audiences_json IS NOT OLD.audiences_json OR
      NEW.expires_at IS NOT OLD.expires_at OR
      NEW.issued_at IS NOT OLD.issued_at OR
      NEW.rotate_after IS NOT OLD.rotate_after OR
      NEW.key_provider IS NOT OLD.key_provider OR
      NEW.key_id IS NOT OLD.key_id OR
      NEW.key_version IS NOT OLD.key_version OR
      NEW.customer_managed IS NOT OLD.customer_managed OR
      NEW.key_attestation_sha256 IS NOT OLD.key_attestation_sha256 OR
      NEW.material_lineage_id IS NOT OLD.material_lineage_id OR
      NEW.material_lineage_key_id IS NOT OLD.material_lineage_key_id OR
      NEW.envelope_schema_version IS NOT OLD.envelope_schema_version OR
      NEW.algorithm IS NOT OLD.algorithm OR
      NEW.wrapped_data_key IS NOT OLD.wrapped_data_key OR
      NEW.iv IS NOT OLD.iv OR
      NEW.auth_tag IS NOT OLD.auth_tag OR
      NEW.ciphertext IS NOT OLD.ciphertext OR
      NEW.created_at IS NOT OLD.created_at OR
      NOT (
        (OLD.state = 'active' AND NEW.state = 'retired' AND
          NEW.retired_at IS NOT NULL AND NEW.revoked_at IS NULL AND NEW.revocation_reason IS NULL) OR
        (OLD.state IN ('active', 'retired') AND NEW.state = 'revoked' AND
          NEW.retired_at IS OLD.retired_at AND NEW.revoked_at IS NOT NULL AND
          length(trim(NEW.revocation_reason)) > 0)
      )
    BEGIN
      SELECT RAISE(ABORT, 'secret_lifecycle_transition_invalid');
    END;
  `);
}

function migrateWardenCiAwaitingReview(db: AppDb): void {
  const row = db.raw.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fettler_ci_cycles'",
  ).get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'awaiting_review'")) return;
  const columns = [
    "id", "tenant_id", "delivery_id", "observation_job_id", "status", "repository_id",
    "remote_repository_id", "installation_id", "pull_request_number", "base_branch", "branch_name",
    "base_revision", "current_head_sha", "required_checks_json", "allowed_changed_paths_json",
    "max_cycles", "used_cycles", "max_model_calls", "maximum_cost_usd", "current_observation_digest",
    "repair_run_id", "repair_job_id", "paused_by", "pause_reason", "mission_authority_json",
    "created_at", "updated_at",
  ].join(", ");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    db.raw.exec(`
      CREATE TABLE fettler_ci_cycles_next (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        observation_job_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (
          status IN ('observation_pending', 'checks_running', 'checks_failed', 'repair_pending',
            'candidate_ready', 'update_pending', 'awaiting_review', 'succeeded', 'paused', 'exhausted')
        ),
        repository_id TEXT NOT NULL,
        remote_repository_id INTEGER NOT NULL,
        installation_id INTEGER NOT NULL,
        pull_request_number INTEGER NOT NULL,
        base_branch TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        base_revision TEXT NOT NULL,
        current_head_sha TEXT NOT NULL,
        required_checks_json TEXT NOT NULL,
        allowed_changed_paths_json TEXT NOT NULL,
        max_cycles INTEGER NOT NULL,
        used_cycles INTEGER NOT NULL DEFAULT 0,
        max_model_calls INTEGER NOT NULL,
        maximum_cost_usd REAL NOT NULL,
        current_observation_digest TEXT,
        repair_run_id TEXT,
        repair_job_id TEXT,
        paused_by TEXT,
        pause_reason TEXT,
        mission_authority_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (tenant_id, delivery_id)
      );
      INSERT INTO fettler_ci_cycles_next (${columns}) SELECT ${columns} FROM fettler_ci_cycles;
      DROP TABLE fettler_ci_cycles;
      ALTER TABLE fettler_ci_cycles_next RENAME TO fettler_ci_cycles;
      CREATE INDEX fettler_ci_cycles_tenant_status_idx
        ON fettler_ci_cycles(tenant_id, status, updated_at);
    `);
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Rename Warden/Transformer tables to Fettler/Regauge without assuming that the
 * new table is empty. This is the prerequisite release for a future dual-name
 * compatibility window: identical and disjoint rows converge, any conflicting
 * row fails closed, and the committed schema remains new-name-only.
 */
function migrateWardenTransformerTableNames(db: AppDb): void {
  const renames: ReadonlyArray<readonly [string, string]> = [
    ["warden_model_reservations", "fettler_model_reservations"],
    ["warden_campaigns", "fettler_campaigns"],
    ["warden_campaign_targets", "fettler_campaign_targets"],
    ["warden_rollout_decisions", "fettler_rollout_decisions"],
    ["warden_candidate_deliveries", "fettler_candidate_deliveries"],
    ["warden_ci_cycles", "fettler_ci_cycles"],
    ["warden_ci_observations", "fettler_ci_observations"],
    ["warden_ci_updates", "fettler_ci_updates"],
    ["transformer_adaptive_candidates", "regauge_adaptive_candidates"],
    ["transformer_adaptive_regenerations", "regauge_adaptive_regenerations"],
    ["transformer_adaptive_deliveries", "regauge_adaptive_deliveries"],
  ];
  const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const tableExists = (name: string): boolean =>
    get<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      [name],
    ) !== undefined;
  const pending = renames.filter(([oldName]) => tableExists(oldName));
  if (pending.length === 0) return;
  const legacyAdditions: ReadonlyArray<Readonly<{
    table: string;
    name: string;
    sql: string;
  }>> = [
    {
      table: "warden_campaign_targets",
      name: "enrollment_source",
      sql: "TEXT NOT NULL DEFAULT 'manual'",
    },
    { table: "warden_campaign_targets", name: "enrolled_installation_id", sql: "TEXT" },
    { table: "warden_ci_updates", name: "expected_feedback_digest", sql: "TEXT" },
    { table: "warden_candidate_deliveries", name: "mission_authority_json", sql: "TEXT" },
    { table: "warden_ci_cycles", name: "mission_authority_json", sql: "TEXT" },
    { table: "warden_ci_updates", name: "mission_authority_json", sql: "TEXT" },
    {
      table: "transformer_adaptive_candidates",
      name: "base_branch",
      sql: "TEXT NOT NULL DEFAULT ''",
    },
    { table: "transformer_adaptive_candidates", name: "review_rationale", sql: "TEXT" },
    {
      table: "transformer_adaptive_candidates",
      name: "review_tier",
      sql: "TEXT NOT NULL DEFAULT 'standard'",
    },
    {
      table: "transformer_adaptive_candidates",
      name: "escalation_reviewer_principal_id",
      sql: "TEXT",
    },
    { table: "transformer_adaptive_candidates", name: "escalation_reviewed_at", sql: "TEXT" },
    { table: "transformer_adaptive_candidates", name: "escalation_rationale", sql: "TEXT" },
    { table: "transformer_adaptive_candidates", name: "family", sql: "TEXT" },
    { table: "transformer_adaptive_candidates", name: "provider", sql: "TEXT" },
    { table: "transformer_adaptive_candidates", name: "framework", sql: "TEXT" },
    {
      table: "transformer_adaptive_deliveries",
      name: "base_branch",
      sql: "TEXT NOT NULL DEFAULT ''",
    },
    // Post-delivery acceptance outcome columns on the pre-rename delivery tables.
    // A pre-rename volume must gain these on the OLD table before the rename
    // compatibility assertion, so the old and new shapes match column-for-column
    // and the merge/drop can proceed. Mirrors the new-name entries in
    // migrateProvidersFeedColumns' additive list. Nullable, no default.
    { table: "warden_candidate_deliveries", name: "outcome", sql: "TEXT" },
    { table: "warden_candidate_deliveries", name: "outcome_at", sql: "TEXT" },
    { table: "warden_candidate_deliveries", name: "outcome_source", sql: "TEXT" },
    { table: "warden_candidate_deliveries", name: "precursor_migration_pr_id", sql: "TEXT" },
    { table: "transformer_adaptive_deliveries", name: "outcome", sql: "TEXT" },
    { table: "transformer_adaptive_deliveries", name: "outcome_at", sql: "TEXT" },
    { table: "transformer_adaptive_deliveries", name: "outcome_source", sql: "TEXT" },
  ];

  if (db.raw.isTransaction) {
    throw new Error("warden_transformer_rename_transaction_active");
  }
  const foreignKeysEnabled =
    Number(
      (db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
        .foreign_keys,
    ) === 1;
  const columns = (name: string) =>
    all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>(db, `PRAGMA table_info(${quoteIdentifier(name)})`);
  const normalizedColumns = (
    name: string,
    additiveDefaultColumns: ReadonlySet<string>,
  ): string =>
    JSON.stringify(
      columns(name)
        .map((column) => ({
          name: column.name,
          type: column.type.toUpperCase(),
          notnull: column.notnull,
          dflt_value: additiveDefaultColumns.has(column.name) ? null : column.dflt_value,
          pk: column.pk,
        }))
        .sort((left, right) => left.name.localeCompare(right.name)),
    );
  const oldToNew = new Map(renames);
  const normalizedForeignKeys = (name: string): string =>
    JSON.stringify(
      all<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>(db, `PRAGMA foreign_key_list(${quoteIdentifier(name)})`)
        .map((foreignKey) => ({
          ...foreignKey,
          table: oldToNew.get(foreignKey.table) ?? foreignKey.table,
        }))
        .sort((left, right) => left.id - right.id || left.seq - right.seq),
    );
  const uniqueSignatures = (name: string): string =>
    JSON.stringify(
      all<{ name: string; unique: number; origin: string; partial: number }>(
        db,
        `PRAGMA index_list(${quoteIdentifier(name)})`,
      )
        .filter((index) => index.unique === 1)
        .map((index) => ({
          origin: index.origin,
          partial: index.partial,
          columns: all<{
            seqno: number;
            cid: number;
            name: string | null;
            desc: number;
            coll: string;
            key: number;
          }>(db, `PRAGMA index_xinfo(${quoteIdentifier(index.name)})`)
            .filter((column) => column.key === 1)
            .sort((left, right) => left.seqno - right.seqno)
            .map(({ cid, name: columnName, desc, coll }) => ({
              cid,
              name: columnName,
              desc,
              coll,
            })),
        }))
        .map((signature) => JSON.stringify(signature))
        .sort(),
    );
  const assertCompatibleSchema = (oldName: string, newName: string): string[] => {
    const additiveDefaultColumns = new Set(
      legacyAdditions
        .filter((addition) => addition.table === oldName)
        .map((addition) => addition.name),
    );
    if (
      !tableExists(newName) ||
      normalizedColumns(oldName, additiveDefaultColumns) !==
        normalizedColumns(newName, additiveDefaultColumns) ||
      normalizedForeignKeys(oldName) !== normalizedForeignKeys(newName) ||
      uniqueSignatures(oldName) !== uniqueSignatures(newName)
    ) {
      throw new Error("warden_transformer_rename_schema_mismatch");
    }
    return columns(newName).map((column) => column.name);
  };
  const merge = (oldName: string, newName: string, columnNames: readonly string[]): void => {
    const list = columnNames.map(quoteIdentifier).join(", ");
    db.raw.exec(
      `INSERT OR IGNORE INTO ${quoteIdentifier(newName)} (${list}) ` +
        `SELECT ${list} FROM ${quoteIdentifier(oldName)}`,
    );
    const mismatch = db.raw
      .prepare(
        `SELECT 1 AS divergent FROM (` +
          `SELECT ${list} FROM ${quoteIdentifier(oldName)} ` +
          `EXCEPT SELECT ${list} FROM ${quoteIdentifier(newName)}` +
          `) LIMIT 1`,
      )
      .get();
    if (mismatch) throw new Error("warden_transformer_rename_data_conflict");
  };

  db.raw.exec("PRAGMA foreign_keys = OFF");
  try {
    db.raw.exec("BEGIN IMMEDIATE");
    // Another process may have completed the rename while this connection was
    // waiting for the write lock, so all transactional work uses fresh state.
    const lockedPending = renames.filter(([oldName]) => tableExists(oldName));
    for (const addition of legacyAdditions) {
      if (
        tableExists(addition.table) &&
        !columns(addition.table).some((column) => column.name === addition.name)
      ) {
        db.raw.exec(
          `ALTER TABLE ${quoteIdentifier(addition.table)} ADD COLUMN ` +
            `${quoteIdentifier(addition.name)} ${addition.sql}`,
        );
      }
    }
    if (tableExists("transformer_adaptive_candidates")) {
      db.raw.exec(`
        UPDATE transformer_adaptive_candidates
        SET base_branch = COALESCE((
          SELECT snapshot.requested_ref
          FROM repository_snapshots snapshot
          WHERE snapshot.id = transformer_adaptive_candidates.snapshot_id
            AND snapshot.tenant_id = transformer_adaptive_candidates.tenant_id
            AND snapshot.repository_id = transformer_adaptive_candidates.repository_id
        ), '')
        WHERE base_branch = '';
      `);
    }
    if (tableExists("transformer_adaptive_deliveries")) {
      const candidateTable = tableExists("transformer_adaptive_candidates")
        ? "transformer_adaptive_candidates"
        : "regauge_adaptive_candidates";
      db.raw.exec(`
        UPDATE transformer_adaptive_deliveries
        SET base_branch = COALESCE((
          SELECT candidate.base_branch
          FROM ${quoteIdentifier(candidateTable)} candidate
          WHERE candidate.id = transformer_adaptive_deliveries.candidate_id
            AND candidate.tenant_id = transformer_adaptive_deliveries.tenant_id
            AND candidate.repository_id = transformer_adaptive_deliveries.repository_id
            AND candidate.snapshot_id = transformer_adaptive_deliveries.snapshot_id
        ), '')
        WHERE base_branch = '';
      `);
    }
    const compatible = lockedPending.map(([oldName, newName]) => ({
      oldName,
      newName,
      columnNames: assertCompatibleSchema(oldName, newName),
    }));
    for (const { oldName, newName, columnNames } of compatible) {
      merge(oldName, newName, columnNames);
    }
    for (const { oldName } of compatible) {
      db.raw.exec(`DROP TABLE ${quoteIdentifier(oldName)}`);
    }
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeysEnabled) db.raw.exec("PRAGMA foreign_keys = ON");
  }
}

function migrateRepositorySnapshotIdentity(db: AppDb): void {
  const columns = all<{ name: string }>(
    db,
    "PRAGMA table_info(repository_snapshots)",
  ).map((column) => column.name);
  const tableSql = get<{ sql: string }>(
    db,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'repository_snapshots'",
  )?.sql ?? "";
  const legacyContentUniqueness = /UNIQUE\s*\(\s*tenant_id\s*,\s*repository_id\s*,\s*resolved_sha\s*,\s*manifest_sha256\s*\)/i
    .test(tableSql);
  if (columns.includes("file_manifest_version") && !legacyContentUniqueness) return;

  const foreignKeysEnabled = Number(
    (db.raw.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys,
  ) === 1;
  if (db.raw.isTransaction) throw new Error("repository_snapshot_migration_transaction_active");
  db.raw.exec("PRAGMA foreign_keys = OFF");
  try {
    db.raw.exec("BEGIN IMMEDIATE");
    db.raw.exec("DROP TABLE IF EXISTS repository_snapshots_next");
    db.raw.exec(`
      CREATE TABLE repository_snapshots_next (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        repository_id TEXT NOT NULL REFERENCES connected_repositories(id),
        requested_ref TEXT NOT NULL,
        resolved_sha TEXT NOT NULL,
        manifest_sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        submodules_policy TEXT NOT NULL CHECK (submodules_policy IN ('reject', 'pinned')),
        lfs_policy TEXT NOT NULL CHECK (lfs_policy IN ('reject', 'pointer_only', 'fetch')),
        sparse_paths_json TEXT NOT NULL,
        file_manifest_version INTEGER NOT NULL DEFAULT 0 CHECK (file_manifest_version IN (0, 1)),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    db.raw.exec(`
      INSERT INTO repository_snapshots_next
        (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
         storage_path, submodules_policy, lfs_policy, sparse_paths_json,
         file_manifest_version, created_at, expires_at)
      SELECT id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256,
             storage_path, submodules_policy, lfs_policy, sparse_paths_json,
             ${columns.includes("file_manifest_version") ? "file_manifest_version" : "0"},
             created_at, expires_at
      FROM repository_snapshots;
      DROP TABLE repository_snapshots;
      ALTER TABLE repository_snapshots_next RENAME TO repository_snapshots;
      CREATE INDEX repository_snapshots_tenant_idx
        ON repository_snapshots(tenant_id, repository_id, created_at);
      CREATE INDEX repository_snapshots_identity_idx
        ON repository_snapshots(
          tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, created_at
        );
      CREATE UNIQUE INDEX repository_snapshots_id_tenant_uidx
        ON repository_snapshots(id, tenant_id);
    `);
    // Scope the check to the only table this migration rewrites. A bare `foreign_key_check` inspects
    // every table, so a dangling row in an unrelated table would permanently block boot even though
    // this migration never touched it.
    const violations = db.raw.prepare("PRAGMA foreign_key_check(repository_snapshots)").all();
    if (violations.length) throw new Error("repository_snapshot_migration_foreign_key_invalid");
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  } finally {
    if (foreignKeysEnabled) db.raw.exec("PRAGMA foreign_keys = ON");
  }
}

/** Additive columns for Phase D feed URLs + Phase E tenant on consumers. */
function migrateProvidersFeedColumns(db: AppDb) {
  const nullableLegacyTenantTables = new Set<string>();
  const releasedFallbackTenantTables = new Set<string>();
  for (const table of LEGACY_TENANT_OWNERSHIP_TABLES) {
    const tenantColumn = all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>(
      db,
      `PRAGMA table_info(${table})`,
    ).find((column) => column.name === "tenant_id");
    if (!tenantColumn || tenantColumn.notnull !== 1) {
      nullableLegacyTenantTables.add(table);
    } else if (
      tenantColumn.type.trim().toUpperCase() === "TEXT" &&
      tenantColumn.dflt_value?.trim() === "'tenant_default'"
    ) {
      releasedFallbackTenantTables.add(table);
    }
  }
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
  const versionColumns = all<{ name: string }>(
    db,
    `PRAGMA table_info(api_versions)`,
  ).map((c) => c.name);
  if (!versionColumns.includes("content_hash")) {
    run(db, `ALTER TABLE api_versions ADD COLUMN content_hash TEXT`);
  }
  const versionsMissingHash = all<{
    id: string;
    provider_id: string;
    openapi_json: string;
  }>(
    db,
    `SELECT id, provider_id, openapi_json
     FROM api_versions
     WHERE content_hash IS NULL
     ORDER BY published_at, id`,
  );
  for (const version of versionsMissingHash) {
    const contentHash = createHash("sha256")
      .update(version.openapi_json)
      .digest("hex");
    const existing = get<{ id: string }>(
      db,
      `SELECT id FROM api_versions
       WHERE provider_id = ? AND content_hash = ? LIMIT 1`,
      [version.provider_id, contentHash],
    );
    if (!existing) {
      run(db, `UPDATE api_versions SET content_hash = ? WHERE id = ?`, [
        contentHash,
        version.id,
      ]);
    }
  }
  run(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS api_versions_provider_content_uidx
     ON api_versions(provider_id, content_hash)
     WHERE content_hash IS NOT NULL`,
  );
  // ALTER TABLE ADD COLUMN cannot attach a CHECK, a column-level FOREIGN KEY, or
  // a default that differs from the fresh CREATE TABLE, so an entry whose column
  // carries any of those in the static DDL leaves an upgraded volume permanently
  // divergent for that column. schema-upgrade-divergence.test.ts characterizes
  // every such case; add a new one there when introducing another.
  const additiveColumns: Array<{
    table: string;
    name: string;
    sql: string;
  }> = [
    // Typed tool-failure class on the append-only trajectory step. Mirrors the
    // CREATE TABLE column above so a pre-change volume (table present, column
    // absent) converges on boot. Nullable, no default: a step written before
    // this migration reads NULL ("no failure class recorded"), never a
    // fabricated class. No static index/view/constraint references it.
    { table: "trajectory_steps", name: "failure_class", sql: "TEXT" },
    // Mission execution-context version pins (v4 §6.7 Policy Envelope, §11.10
    // temporal graph versioning). Nullable TEXT, no default, so a pre-change
    // mission row reads NULL. No static index/view/constraint references them, so
    // an existing DB that has not run this migration never touches them in the
    // static DDL; the CREATE TABLE above carries them for fresh databases.
    { table: "mission", name: "graph_version_id", sql: "TEXT" },
    { table: "mission", name: "policy_envelope_version", sql: "TEXT" },
    // S1.1 tenant-private providers. Nullable, no default, so legacy rows read NULL (shared
    // catalog, byte-identical). No static index/view/constraint references it, so an existing
    // DB that has not run this migration never touches the column in the static DDL.
    { table: "providers", name: "tenant_id", sql: "TEXT" },
    { table: "api_keys", name: "authority_principal_id", sql: "TEXT" },
    { table: "api_keys", name: "authority_role", sql: "TEXT" },
    // Historical rows that predate tenant attribution must remain unknown. A
    // default here would silently claim them for the default customer tenant.
    // Fresh databases keep the NOT NULL column from the static DDL, while the
    // triggers installed below require attribution for every future write on an
    // upgraded volume.
    { table: "jobs", name: "tenant_id", sql: "TEXT" },
    { table: "api_keys", name: "principal_id", sql: "TEXT" },
    { table: "jobs", name: "lease_owner", sql: "TEXT" },
    { table: "jobs", name: "lease_expires_at", sql: "TEXT" },
    { table: "jobs", name: "available_at", sql: "TEXT" },
    { table: "jobs", name: "lease_generation", sql: "INTEGER NOT NULL DEFAULT 0" },
    { table: "jobs", name: "error_code", sql: "TEXT" },
    { table: "jobs", name: "last_error_at", sql: "TEXT" },
    { table: "jobs", name: "dead_at", sql: "TEXT" },
    { table: "jobs", name: "cancelled_at", sql: "TEXT" },
    { table: "repair_sessions", name: "tenant_id", sql: "TEXT" },
    { table: "agent_runs", name: "tenant_id", sql: "TEXT" },
    { table: "agent_runs", name: "job_id", sql: "TEXT" },
    { table: "audit_events", name: "tenant_id", sql: "TEXT" },
    { table: "audit_events", name: "principal_id", sql: "TEXT" },
    { table: "audit_events", name: "api_key_id", sql: "TEXT" },
    { table: "audit_events", name: "request_id", sql: "TEXT" },
    { table: "suppressed_patterns", name: "tenant_id", sql: "TEXT" },
    { table: "feed_polls", name: "tenant_id", sql: "TEXT NOT NULL DEFAULT 'tenant_default'" },
    { table: "feed_schedules", name: "release_last_success_at", sql: "TEXT" },
    { table: "feed_schedule_windows", name: "lease_expires_at", sql: "TEXT" },
    { table: "feed_schedule_windows", name: "lease_generation", sql: "INTEGER NOT NULL DEFAULT 0" },
    { table: "feed_tenant_dispatches", name: "lease_generation", sql: "INTEGER NOT NULL DEFAULT 1" },
    { table: "github_webhook_deliveries", name: "status", sql: "TEXT NOT NULL DEFAULT 'completed'" },
    { table: "github_webhook_deliveries", name: "updated_at", sql: "TEXT" },
    { table: "github_webhook_deliveries", name: "attempts", sql: "INTEGER NOT NULL DEFAULT 1" },
    { table: "github_webhook_deliveries", name: "last_error", sql: "TEXT" },
    { table: "github_install_states", name: "created_by_principal_id", sql: "TEXT" },
    { table: "github_install_states", name: "expected_account_id", sql: "TEXT" },
    { table: "github_install_states", name: "completed_at", sql: "TEXT" },
    { table: "github_install_states", name: "completed_installation_id", sql: "TEXT" },
    { table: "consumers", name: "github_delivery_mode", sql: "TEXT NOT NULL DEFAULT 'legacy_pat'" },
    { table: "github_installations", name: "repository_selection", sql: "TEXT NOT NULL DEFAULT 'selected'" },
    { table: "github_installations", name: "account_id", sql: "TEXT" },
    { table: "github_installations", name: "suspended_at", sql: "TEXT" },
    { table: "github_installations", name: "deleted_at", sql: "TEXT" },
    { table: "fettler_ci_updates", name: "expected_feedback_digest", sql: "TEXT" },
    { table: "fettler_candidate_deliveries", name: "mission_authority_json", sql: "TEXT" },
    { table: "fettler_ci_cycles", name: "mission_authority_json", sql: "TEXT" },
    { table: "fettler_ci_updates", name: "mission_authority_json", sql: "TEXT" },
    {
      table: "fettler_campaign_targets",
      name: "enrollment_source",
      sql: "TEXT NOT NULL DEFAULT 'manual'",
    },
    { table: "fettler_campaign_targets", name: "enrolled_installation_id", sql: "TEXT" },
    { table: "consumer_repos", name: "scm_connection_id", sql: "TEXT" },
    { table: "consumer_repos", name: "connected_repository_id", sql: "TEXT" },
    { table: "consumer_repos", name: "snapshot_id", sql: "TEXT" },
    { table: "consumer_repos", name: "exact_commit", sql: "TEXT" },
    { table: "migration_prs", name: "github_repository_id", sql: "TEXT" },
    { table: "migration_prs", name: "github_installation_id", sql: "TEXT" },
    { table: "migration_prs", name: "github_account_id", sql: "TEXT" },
    {
      table: "regauge_adaptive_candidates",
      name: "base_branch",
      sql: "TEXT NOT NULL DEFAULT ''",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "review_rationale",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "review_tier",
      sql: "TEXT NOT NULL DEFAULT 'standard'",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "escalation_reviewer_principal_id",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "escalation_reviewed_at",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "escalation_rationale",
      sql: "TEXT",
    },
    // G2.1c seal-time corpus labels. Nullable, no default, so legacy rows read as
    // null (byte-identical corpus for pre-labeling candidates). No static index,
    // view, or constraint references these columns, so an existing DB that has not
    // yet run this migration never touches them in the static DDL.
    {
      table: "regauge_adaptive_candidates",
      name: "family",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "provider",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_candidates",
      name: "framework",
      sql: "TEXT",
    },
    {
      table: "regauge_adaptive_deliveries",
      name: "base_branch",
      sql: "TEXT NOT NULL DEFAULT ''",
    },
    // Post-delivery acceptance outcome (the PR's real fate) on both candidate-
    // delivery lanes. Nullable, no default: an existing DB converges on boot by
    // adding the column, and rows written before this migration read as null
    // (pending / no outcome received) rather than a fabricated negative. No
    // static index/view/constraint references these, so the static DDL never
    // touches them on a DB that has not yet run this migration. Both tables are
    // in the warden->fettler / transformer->regauge rename sets, so the same
    // columns are mirrored into legacyAdditions (old names) so a pre-rename
    // volume upgrades the old table before the rename compatibility assertion.
    { table: "regauge_adaptive_deliveries", name: "outcome", sql: "TEXT" },
    { table: "regauge_adaptive_deliveries", name: "outcome_at", sql: "TEXT" },
    { table: "regauge_adaptive_deliveries", name: "outcome_source", sql: "TEXT" },
    { table: "fettler_candidate_deliveries", name: "outcome", sql: "TEXT" },
    { table: "fettler_candidate_deliveries", name: "outcome_at", sql: "TEXT" },
    { table: "fettler_candidate_deliveries", name: "outcome_source", sql: "TEXT" },
    { table: "fettler_candidate_deliveries", name: "precursor_migration_pr_id", sql: "TEXT" },
    // Coverage/basis discriminator for the analysis behind a migration PR
    // (§11.7, §12.4). Nullable, no default: an existing DB converges on boot by
    // adding the column, and rows written before this migration read as null
    // (coverage not recorded) rather than a fabricated "analyzed". No static
    // index/view/constraint references it, so the static DDL never touches it on
    // a DB that has not yet run this migration.
    {
      table: "migration_prs",
      name: "coverage_json",
      sql: "TEXT",
    },
    // Provider->code path behind an impact finding (FET-016, spec 8.8). Nullable,
    // no default: an existing DB converges by adding the column, and findings
    // written before this migration read as null ("not computed") rather than a
    // fabricated empty path. No static index/view/constraint references it.
    {
      table: "impact_findings",
      name: "graph_path_json",
      sql: "TEXT",
    },
    // Mission attribution + per-component measurement state on the six-way
    // execution cost ledger. These mirror the CREATE TABLE above so a pre-change
    // volume (which has the table but not these columns) converges on boot. The
    // measurement flags default to 1 (measured) so an existing HTTP-written row,
    // where the caller supplied real numbers for every component, reads as
    // measured; a new internal writer sets 0 for a component it did not measure.
    // cost_schema_version defaults to 1 so a pre-change row is hashed over the
    // original field set and its stored hash still verifies (see hashEntry).
    // mission_id is nullable with an FK to our own mission table; ADD COLUMN with
    // a foreign key requires the default to be NULL, which it is. No static
    // index/view/constraint references any of these, so the static DDL never
    // touches them on a DB that has not yet run this migration.
    {
      table: "actual_execution_cost_entries",
      name: "mission_id",
      sql: "TEXT REFERENCES mission(id)",
    },
    {
      table: "actual_execution_cost_entries",
      name: "model_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (model_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "cache_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (cache_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "gpu_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (gpu_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "graph_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (graph_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "sandbox_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (sandbox_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "verification_cost_measured",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (verification_cost_measured IN (0, 1))",
    },
    {
      table: "actual_execution_cost_entries",
      name: "cost_schema_version",
      sql: "INTEGER NOT NULL DEFAULT 1 CHECK (cost_schema_version >= 1)",
    },
    {
      table: "actual_execution_cost_entries",
      name: "measurement_provenance_json",
      sql: "TEXT NOT NULL DEFAULT '{}'",
    },
    // Which executor actually ran, recorded at outcome time (recordRoutingOutcome).
    // Mirrors the CREATE TABLE above so a pre-change volume (which has the table
    // but not this column) converges on boot. Nullable, no default: a decision
    // whose outcome has not been recorded, or a caller that did not observe the
    // executed executor, reads NULL ("not observed") rather than a value copied
    // from selected_executor_id. No static index/view/constraint references it,
    // so the static DDL never touches it on a DB that has not run this migration.
    {
      table: "routing_ledger",
      name: "executed_executor_id",
      sql: "TEXT",
    },
    // §8.19–8.21 annotations. Nullable TEXT, no default. Not part of any
    // content digest, so existing append-only rows keep their ids. ALTER ADD
    // COLUMN does not fire the no-update triggers.
    { table: "mission_decisions", name: "decision_type", sql: "TEXT" },
    { table: "mission_exceptions", name: "task_id", sql: "TEXT" },
    { table: "mission_exceptions", name: "category", sql: "TEXT" },
    { table: "mission_artifacts", name: "task_id", sql: "TEXT" },
    { table: "mission_artifacts", name: "source_snapshot", sql: "TEXT" },
  ];
  const addedColumns = new Set<string>();
  for (const column of additiveColumns) {
    const columns = all<{ name: string }>(
      db,
      `PRAGMA table_info(${column.table})`,
    ).map((c) => c.name);
    if (!columns.includes(column.name)) {
      run(db, `ALTER TABLE ${column.table} ADD COLUMN ${column.name} ${column.sql}`);
      addedColumns.add(`${column.table}.${column.name}`);
    }
  }
  reconcileLegacyTenantOwnership(
    db,
    nullableLegacyTenantTables,
    releasedFallbackTenantTables,
  );
  run(
    db,
    `UPDATE feed_schedule_windows
     SET lease_generation = 1,
         lease_expires_at = COALESCE(lease_expires_at, window_ends_at)
     WHERE status = 'running'
       AND (lease_generation = 0 OR lease_expires_at IS NULL)`,
  );
  db.raw.exec(`
    CREATE TRIGGER IF NOT EXISTS migration_prs_delivery_identity_immutable
    BEFORE UPDATE OF github_pr_number, github_repository_id,
      github_installation_id, github_account_id ON migration_prs
    WHEN (OLD.github_pr_number IS NOT NULL AND NEW.github_pr_number IS NOT OLD.github_pr_number)
      OR (OLD.github_repository_id IS NOT NULL AND NEW.github_repository_id IS NOT OLD.github_repository_id)
      OR (OLD.github_installation_id IS NOT NULL AND NEW.github_installation_id IS NOT OLD.github_installation_id)
      OR (OLD.github_account_id IS NOT NULL AND NEW.github_account_id IS NOT OLD.github_account_id)
    BEGIN
      SELECT RAISE(ABORT, 'migration_pr_delivery_identity_immutable');
    END;
  `);
  run(
    db,
    `UPDATE regauge_adaptive_candidates
     SET base_branch = COALESCE((
       SELECT snapshot.requested_ref
       FROM repository_snapshots snapshot
       WHERE snapshot.id = regauge_adaptive_candidates.snapshot_id
         AND snapshot.tenant_id = regauge_adaptive_candidates.tenant_id
         AND snapshot.repository_id = regauge_adaptive_candidates.repository_id
     ), '')
     WHERE base_branch = ''`,
  );
  run(
    db,
    `UPDATE regauge_adaptive_deliveries
     SET base_branch = COALESCE((
       SELECT candidate.base_branch
       FROM regauge_adaptive_candidates candidate
       WHERE candidate.id = regauge_adaptive_deliveries.candidate_id
         AND candidate.tenant_id = regauge_adaptive_deliveries.tenant_id
         AND candidate.repository_id = regauge_adaptive_deliveries.repository_id
         AND candidate.snapshot_id = regauge_adaptive_deliveries.snapshot_id
     ), '')
     WHERE base_branch = ''`,
  );
  if (
    addedColumns.has("consumers.github_delivery_mode") ||
    addedColumns.has("github_installations.account_id")
  ) {
    const boundConsumers = all<{
      id: string;
      tenant_id: string;
      github_owner: string;
      github_repo: string;
      installation_id: string;
    }>(
      db,
      `SELECT id, tenant_id, github_owner, github_repo, installation_id
       FROM consumers
       WHERE installation_id IS NOT NULL`,
    );
    for (const consumer of boundConsumers) {
      const installation = get<GitHubInstallationRow>(
        db,
        `SELECT * FROM github_installations WHERE installation_id = ?`,
        [consumer.installation_id],
      );
      const verified = Boolean(
        installation &&
        installation.tenant_id === consumer.tenant_id &&
        !installation.suspended_at &&
        !installation.deleted_at &&
        installationAuthorizesRepository(
          installation,
          consumer.github_owner,
          consumer.github_repo,
        ),
      );
      run(
        db,
        `UPDATE consumers
         SET installation_id = ?, github_delivery_mode = ?
         WHERE id = ?`,
        [
          verified ? consumer.installation_id : null,
          verified ? "app" : "revoked",
          consumer.id,
        ],
      );
    }
  }
  for (const statement of [
    `CREATE INDEX IF NOT EXISTS feed_polls_tenant_polled_idx
     ON feed_polls(tenant_id, polled_at)`,
    `CREATE INDEX IF NOT EXISTS api_changes_created_idx
     ON api_changes(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS consumers_tenant_created_idx
     ON consumers(tenant_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS monitored_apis_consumer_idx
     ON monitored_apis(consumer_id)`,
    `CREATE INDEX IF NOT EXISTS migration_prs_consumer_created_idx
     ON migration_prs(consumer_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_tenant_created_idx
     ON audit_events(tenant_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS audit_events_tenant_action_created_idx
     ON audit_events(tenant_id, action, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_tenant_job_uidx
     ON agent_runs(tenant_id, job_id) WHERE job_id IS NOT NULL`,
  ]) {
    run(db, statement);
  }
  run(
    db,
    `UPDATE jobs
     SET available_at = created_at
     WHERE available_at IS NULL`,
  );
  for (const table of [
    "consumers",
    "jobs",
    "repair_sessions",
    "agent_runs",
    "agent_run_meters",
    "audit_events",
    "suppressed_patterns",
  ]) {
    // Existing NULL, empty, or whitespace-only tenant ids are unattributable
    // historical data. Leave them byte-identical and quarantined. The versioned
    // nonblank triggers supplement any earlier exact-empty trigger definition
    // without rewriting historical ownership.
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_tenant_required_insert
       BEFORE INSERT ON ${table}
       WHEN NEW.tenant_id IS NULL OR NEW.tenant_id = ''
       BEGIN
         SELECT RAISE(ABORT, 'tenant_id_required');
       END`,
    );
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_tenant_required_update
       BEFORE UPDATE OF tenant_id ON ${table}
       WHEN NEW.tenant_id IS NULL OR NEW.tenant_id = ''
       BEGIN
         SELECT RAISE(ABORT, 'tenant_id_required');
       END`,
    );
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_tenant_nonblank_insert
       BEFORE INSERT ON ${table}
       WHEN NEW.tenant_id IS NULL OR trim(NEW.tenant_id) = ''
       BEGIN
         SELECT RAISE(ABORT, 'tenant_id_required');
       END`,
    );
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_tenant_nonblank_update
       BEFORE UPDATE OF tenant_id ON ${table}
       WHEN NEW.tenant_id IS NULL OR trim(NEW.tenant_id) = ''
       BEGIN
         SELECT RAISE(ABORT, 'tenant_id_required');
       END`,
    );
  }
  run(db, `CREATE INDEX IF NOT EXISTS jobs_tenant_status_idx ON jobs(tenant_id, status)`);
  run(
    db,
    `CREATE INDEX IF NOT EXISTS jobs_due_idx
     ON jobs(tenant_id, status, available_at, created_at)`,
  );
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

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function auditHash(input: {
  tenantId: string;
  sequence: number;
  schemaVersion: number;
  previousHash: string | null;
  id: string;
  actor: string;
  principalId: string | null;
  apiKeyId: string | null;
  requestId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadataSha256: string;
  createdAt: string;
}): string {
  return hashJson(input);
}

function migrateAuditIntegrity(db: AppDb) {
  const additions = [
    { name: "event_sequence", sql: "INTEGER" },
    { name: "schema_version", sql: "INTEGER NOT NULL DEFAULT 1" },
    { name: "prev_hash", sql: "TEXT" },
    { name: "event_hash", sql: "TEXT" },
    { name: "metadata_sha256", sql: "TEXT" },
  ];
  const columns = all<{ name: string }>(db, `PRAGMA table_info(audit_events)`).map(
    (column) => column.name,
  );
  for (const addition of additions) {
    if (!columns.includes(addition.name)) {
      run(db, `ALTER TABLE audit_events ADD COLUMN ${addition.name} ${addition.sql}`);
    }
  }
  const generatedAdditions = [
    {
      name: "impact_change_id",
      sql: "TEXT GENERATED ALWAYS AS (CASE WHEN action = 'impact.analyzed' AND json_valid(metadata_json) THEN json_extract(metadata_json, '$.changeId') END) VIRTUAL",
    },
    {
      name: "impact_fallback",
      sql: "TEXT GENERATED ALWAYS AS (CASE WHEN action = 'impact.analyzed' AND json_valid(metadata_json) THEN json_extract(metadata_json, '$.fallback') END) VIRTUAL",
    },
  ];
  const extendedColumns = all<{ name: string }>(
    db,
    `PRAGMA table_xinfo(audit_events)`,
  ).map((column) => column.name);
  for (const addition of generatedAdditions) {
    if (!extendedColumns.includes(addition.name)) {
      run(db, `ALTER TABLE audit_events ADD COLUMN ${addition.name} ${addition.sql}`);
    }
  }

  const missing = get<{ count: number }>(
    db,
    `SELECT COUNT(*) AS count FROM audit_events
     WHERE event_sequence IS NULL OR event_hash IS NULL OR metadata_sha256 IS NULL`,
  )?.count ?? 0;
  if (missing > 0) {
    const rows = all<AuditEvent>(
      db,
      `SELECT * FROM audit_events ORDER BY tenant_id, created_at, id`,
    );
    const sequences = new Map<string, number>();
    const previousHashes = new Map<string, string | null>();
    for (const row of rows) {
      const sequence = (sequences.get(row.tenant_id) ?? 0) + 1;
      const previousHash = previousHashes.get(row.tenant_id) ?? null;
      const metadataSha256 = hashJson(row.metadata_json ?? null);
      const eventHash = auditHash({
        tenantId: row.tenant_id,
        sequence,
        schemaVersion: 1,
        previousHash,
        id: row.id,
        actor: row.actor,
        principalId: row.principal_id,
        apiKeyId: row.api_key_id,
        requestId: row.request_id,
        action: row.action,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        metadataSha256,
        createdAt: row.created_at,
      });
      run(
        db,
        `UPDATE audit_events
         SET event_sequence = ?, schema_version = 1, prev_hash = ?, event_hash = ?, metadata_sha256 = ?
         WHERE id = ?`,
        [sequence, previousHash, eventHash, metadataSha256, row.id],
      );
      sequences.set(row.tenant_id, sequence);
      previousHashes.set(row.tenant_id, eventHash);
    }
  }
  run(
    db,
    `CREATE UNIQUE INDEX IF NOT EXISTS audit_events_tenant_sequence_uidx
     ON audit_events(tenant_id, event_sequence)`,
  );
  run(
    db,
    `CREATE INDEX IF NOT EXISTS audit_events_impact_current_idx
     ON audit_events(
       tenant_id,
       action,
       impact_change_id,
       impact_fallback,
       resource_type,
       resource_id,
       event_sequence DESC
     )`,
  );
}

function installTrustImmutability(db: AppDb) {
  for (const table of [
    "audit_events",
    "artifact_manifests",
    "evidence_records",
    "review_decisions",
    "pilot_success_contract_versions",
    "domain_events",
    "repository_snapshots",
    "repository_snapshot_files",
    "repository_snapshot_policies",
    "repository_snapshot_deletions",
  ]) {
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update
       BEFORE UPDATE ON ${table}
       BEGIN
         SELECT RAISE(ABORT, '${table}_append_only');
       END`,
    );
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete
       BEFORE DELETE ON ${table}
       BEGIN
         SELECT RAISE(ABORT, '${table}_append_only');
       END`,
    );
  }
}

function migrateArtifactContent(db: AppDb) {
  const columns = all<{ name: string }>(
    db,
    `PRAGMA table_info(artifact_manifests)`,
  ).map((column) => column.name);
  if (!columns.includes("content_text")) {
    run(db, `ALTER TABLE artifact_manifests ADD COLUMN content_text TEXT`);
  }
}

function all<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T[] {
  return db.raw.prepare(sql).all(...params) as T[];
}

function get<T>(db: AppDb, sql: string, params: SQLInputValue[] = []): T | undefined {
  return db.raw.prepare(sql).get(...params) as T | undefined;
}

function run(db: AppDb, sql: string, params: SQLInputValue[] = []): void {
  db.raw.prepare(sql).run(...params);
}

const LEGACY_TENANT_OWNERSHIP_TABLES = [
  "jobs",
  "repair_sessions",
  "agent_runs",
  "audit_events",
  "suppressed_patterns",
] as const;

export type LegacyTenantOwnershipAttestation = {
  tableName: (typeof LEGACY_TENANT_OWNERSHIP_TABLES)[number];
  rowId: string;
  tenantId: string;
  evidenceDigest: string;
  attestedBy: string;
  attestedAt: string;
};

export function computeLegacyTenantOwnershipAttestationDigest(
  input: LegacyTenantOwnershipAttestation,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 1,
      tableName: input.tableName,
      rowId: input.rowId,
      tenantId: input.tenantId,
      evidenceDigest: input.evidenceDigest,
      attestedBy: input.attestedBy,
      attestedAt: input.attestedAt,
    }))
    .digest("hex");
}

function reconcileLegacyTenantOwnership(
  db: AppDb,
  nullableLegacyTenantTables: ReadonlySet<string>,
  releasedFallbackTenantTables: ReadonlySet<string>,
): void {
  const state = get<{ schema_version: number }>(
    db,
    "SELECT schema_version FROM legacy_tenant_ownership_reconciliation_state WHERE id = 1",
  );
  const discoveryDigest = createHash("sha256")
    .update(JSON.stringify({
      schemaVersion: 2,
      releasedFallbackTenantTables: [...releasedFallbackTenantTables].sort(),
    }))
    .digest("hex");
  const discoveryColumns = all<{ name: string }>(
    db,
    "PRAGMA table_info(legacy_tenant_ownership_reconciliation_discovery_state)",
  ).map((column) => column.name);
  if (!discoveryColumns.includes("scope_digest")) {
    throw new Error("legacy_tenant_ownership_reconciliation_schema_unsupported");
  }
  const discoveryState = get<{
    schema_version: number;
    source_schema_digest: string;
    scope_digest: string;
  }>(
    db,
    `SELECT schema_version, source_schema_digest, scope_digest
     FROM legacy_tenant_ownership_reconciliation_discovery_state
     WHERE id = 1`,
  );
  const quarantineState = get<{
    schema_version: number;
    scope_digest: string;
  }>(
    db,
    `SELECT schema_version, scope_digest
     FROM legacy_tenant_ownership_quarantine_state
     WHERE id = 1`,
  );
  if (state && state.schema_version !== 1) {
    throw new Error("legacy_tenant_ownership_reconciliation_schema_unsupported");
  }
  if (discoveryState && (
    discoveryState.schema_version !== 2 ||
    discoveryState.source_schema_digest !== discoveryDigest
  )) throw new Error("legacy_tenant_ownership_reconciliation_schema_unsupported");
  if (!state && discoveryState) {
    throw new Error("legacy_tenant_ownership_reconciliation_schema_unsupported");
  }
  if (quarantineState && quarantineState.schema_version !== 1) {
    throw new Error("legacy_tenant_ownership_reconciliation_schema_unsupported");
  }
  if (!state || !discoveryState || !quarantineState) {
    db.raw.exec("BEGIN IMMEDIATE");
    try {
      const discoveredAt = new Date().toISOString();
      const tablesToDiscover = new Set<string>([
        ...(!state ? nullableLegacyTenantTables : []),
        ...(!discoveryState ? releasedFallbackTenantTables : []),
      ]);
      for (const table of LEGACY_TENANT_OWNERSHIP_TABLES) {
        if (!tablesToDiscover.has(table)) continue;
        run(
          db,
          `INSERT OR IGNORE INTO legacy_tenant_ownership_reconciliation_scope
             (table_name, row_id, tenant_id, discovered_at)
           SELECT ?, id, tenant_id, ?
           FROM ${table}
           WHERE tenant_id = 'tenant_default'`,
          [table, discoveredAt],
        );
      }
      if (!quarantineState) {
        for (const table of LEGACY_TENANT_OWNERSHIP_TABLES) {
          run(
            db,
            `INSERT OR IGNORE INTO legacy_tenant_ownership_quarantine_scope
               (table_name, row_id, discovered_at)
             SELECT ?, id, ?
             FROM ${table}
             WHERE tenant_id IS NULL OR trim(tenant_id) = ''`,
            [table, discoveredAt],
          );
        }
      }
      if (!state) {
        run(
          db,
          `INSERT INTO legacy_tenant_ownership_reconciliation_state
             (id, schema_version, sealed_at) VALUES (1, 1, ?)`,
          [discoveredAt],
        );
      }
      if (!discoveryState) {
        const scopeDigest = legacyTenantOwnershipScopeDigest(db);
        run(
          db,
          `INSERT INTO legacy_tenant_ownership_reconciliation_discovery_state
             (id, schema_version, source_schema_digest, scope_digest, sealed_at)
           VALUES (1, 2, ?, ?, ?)`,
          [discoveryDigest, scopeDigest, discoveredAt],
        );
      }
      if (!quarantineState) {
        run(
          db,
          `INSERT INTO legacy_tenant_ownership_quarantine_state
             (id, schema_version, scope_digest, sealed_at)
           VALUES (1, 1, ?, ?)`,
          [legacyTenantOwnershipQuarantineScopeDigest(db), discoveredAt],
        );
      }
      installLegacyTenantOwnershipSourceGuards(db);
      db.raw.exec("COMMIT");
    } catch (error) {
      if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
      throw error;
    }
  }

  installLegacyTenantOwnershipAppendOnlyTriggers(db, [
    "legacy_tenant_ownership_reconciliation_scope",
    "legacy_tenant_ownership_reconciliation_state",
    "legacy_tenant_ownership_reconciliation_discovery_state",
    "legacy_tenant_ownership_quarantine_scope",
    "legacy_tenant_ownership_quarantine_state",
  ]);
  run(
    db,
    `CREATE TRIGGER IF NOT EXISTS legacy_tenant_ownership_reconciliation_scope_append_only_insert
     BEFORE INSERT ON legacy_tenant_ownership_reconciliation_scope
     BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_reconciliation_scope_sealed'); END`,
  );
  run(
    db,
    `CREATE TRIGGER IF NOT EXISTS legacy_tenant_ownership_quarantine_scope_append_only_insert
     BEFORE INSERT ON legacy_tenant_ownership_quarantine_scope
     BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_quarantine_scope_sealed'); END`,
  );

  installLegacyTenantOwnershipSourceGuards(db);

  const sealedDiscoveryState = get<{ scope_digest: string }>(
    db,
    `SELECT scope_digest FROM legacy_tenant_ownership_reconciliation_discovery_state WHERE id = 1`,
  );
  if (!sealedDiscoveryState || sealedDiscoveryState.scope_digest !== legacyTenantOwnershipScopeDigest(db)) {
    throw new Error("legacy_tenant_ownership_reconciliation_required");
  }
  const sealedQuarantineState = get<{ scope_digest: string }>(
    db,
    `SELECT scope_digest FROM legacy_tenant_ownership_quarantine_state WHERE id = 1`,
  );
  if (
    !sealedQuarantineState ||
    sealedQuarantineState.scope_digest !== legacyTenantOwnershipQuarantineScopeDigest(db)
  ) {
    throw new Error("legacy_tenant_ownership_reconciliation_required");
  }

  const quarantinedRows = all<{
    table_name: string;
    row_id: string;
  }>(
    db,
    `SELECT table_name, row_id
     FROM legacy_tenant_ownership_quarantine_scope
     ORDER BY table_name, row_id`,
  );
  for (const quarantined of quarantinedRows) {
    if (!(LEGACY_TENANT_OWNERSHIP_TABLES as readonly string[]).includes(quarantined.table_name)) {
      throw new Error("legacy_tenant_ownership_reconciliation_required");
    }
    const source = get<{ tenant_id: string | null }>(
      db,
      `SELECT tenant_id FROM ${quarantined.table_name} WHERE id = ?`,
      [quarantined.row_id],
    );
    if (!source || (source.tenant_id !== null && source.tenant_id.trim() !== "")) {
      throw new Error("legacy_tenant_ownership_reconciliation_required");
    }
  }

  const scopedRows = all<{
    table_name: string;
    row_id: string;
    tenant_id: string;
  }>(
    db,
    `SELECT table_name, row_id, tenant_id
     FROM legacy_tenant_ownership_reconciliation_scope
     ORDER BY table_name, row_id`,
  );
  for (const scoped of scopedRows) {
    if (!(LEGACY_TENANT_OWNERSHIP_TABLES as readonly string[]).includes(scoped.table_name)) {
      throw new Error("legacy_tenant_ownership_reconciliation_required");
    }
    const attestation = get<{
      table_name: string;
      row_id: string;
      tenant_id: string;
      evidence_digest: string;
      attested_by: string;
      attested_at: string;
      attestation_digest: string;
    }>(
      db,
      `SELECT table_name, row_id, tenant_id, evidence_digest, attested_by,
              attested_at, attestation_digest
       FROM legacy_tenant_ownership_attestations
       WHERE table_name = ? AND row_id = ? AND tenant_id = ?`,
      [scoped.table_name, scoped.row_id, scoped.tenant_id],
    );
    const evidenceDigest = attestation?.evidence_digest ?? "";
    const attestedBy = attestation?.attested_by ?? "";
    const attestedAt = attestation?.attested_at ?? "";
    const validTimestamp = Number.isFinite(Date.parse(attestedAt)) &&
      new Date(attestedAt).toISOString() === attestedAt;
    if (
      !attestation ||
      !/^[a-f0-9]{64}$/.test(evidenceDigest) ||
      attestedBy.trim() === "" ||
      !validTimestamp ||
      attestation.attestation_digest !==
        computeLegacyTenantOwnershipAttestationDigest({
          tableName: scoped.table_name as LegacyTenantOwnershipAttestation["tableName"],
          rowId: scoped.row_id,
          tenantId: scoped.tenant_id,
          evidenceDigest,
          attestedBy,
          attestedAt,
        })
    ) {
      throw new Error("legacy_tenant_ownership_reconciliation_required");
    }
    const source = get<{ tenant_id: string | null }>(
      db,
      `SELECT tenant_id FROM ${scoped.table_name} WHERE id = ?`,
      [scoped.row_id],
    );
    if (!source || source.tenant_id !== scoped.tenant_id) {
      throw new Error("legacy_tenant_ownership_reconciliation_required");
    }
  }

  installLegacyTenantOwnershipAppendOnlyTriggers(db, [
    "legacy_tenant_ownership_attestations",
  ]);
}

function legacyTenantOwnershipScopeDigest(db: AppDb): string {
  const rows = all<{
    table_name: string;
    row_id: string;
    tenant_id: string;
    discovered_at: string;
  }>(
    db,
    `SELECT table_name, row_id, tenant_id, discovered_at
     FROM legacy_tenant_ownership_reconciliation_scope
     ORDER BY table_name, row_id, tenant_id`,
  );
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, rows })).digest("hex");
}

function legacyTenantOwnershipQuarantineScopeDigest(db: AppDb): string {
  const rows = all<{
    table_name: string;
    row_id: string;
    discovered_at: string;
  }>(
    db,
    `SELECT table_name, row_id, discovered_at
     FROM legacy_tenant_ownership_quarantine_scope
     ORDER BY table_name, row_id`,
  );
  return createHash("sha256").update(JSON.stringify({ schemaVersion: 1, rows })).digest("hex");
}

function installLegacyTenantOwnershipSourceGuards(db: AppDb): void {
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    for (const table of LEGACY_TENANT_OWNERSHIP_TABLES) {
      db.raw.exec(`
        DROP TRIGGER IF EXISTS ${table}_legacy_tenant_ownership_update;
        CREATE TRIGGER ${table}_legacy_tenant_ownership_update
        BEFORE UPDATE OF id, tenant_id ON ${table}
        WHEN (OLD.id IS NOT NEW.id OR OLD.tenant_id IS NOT NEW.tenant_id)
        AND (
          EXISTS (
            SELECT 1 FROM legacy_tenant_ownership_reconciliation_scope scope
            WHERE scope.table_name = '${table}' AND scope.row_id = OLD.id
          ) OR EXISTS (
            SELECT 1 FROM legacy_tenant_ownership_quarantine_scope quarantine
            WHERE quarantine.table_name = '${table}' AND quarantine.row_id = OLD.id
          )
        )
        BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_source_immutable'); END;
        DROP TRIGGER IF EXISTS ${table}_legacy_tenant_ownership_delete;
        CREATE TRIGGER ${table}_legacy_tenant_ownership_delete
        BEFORE DELETE ON ${table}
        WHEN EXISTS (
          SELECT 1 FROM legacy_tenant_ownership_reconciliation_scope scope
          WHERE scope.table_name = '${table}' AND scope.row_id = OLD.id
        ) OR EXISTS (
          SELECT 1 FROM legacy_tenant_ownership_quarantine_scope quarantine
          WHERE quarantine.table_name = '${table}' AND quarantine.row_id = OLD.id
        )
        BEGIN SELECT RAISE(ABORT, 'legacy_tenant_ownership_source_immutable'); END;
      `);
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function installLegacyTenantOwnershipAppendOnlyTriggers(
  db: AppDb,
  tables: readonly string[],
): void {
  for (const table of tables) {
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_append_only_update
       BEFORE UPDATE ON ${table}
       BEGIN SELECT RAISE(ABORT, '${table}_append_only'); END`,
    );
    run(
      db,
      `CREATE TRIGGER IF NOT EXISTS ${table}_append_only_delete
       BEFORE DELETE ON ${table}
       BEGIN SELECT RAISE(ABORT, '${table}_append_only'); END`,
    );
  }
}

export function recordAudit(
  db: AppDb,
  input: {
    id?: string;
    tenantId: string;
    actor: string;
    principalId?: string | null;
    apiKeyId?: string | null;
    requestId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: unknown;
  },
): string {
  const id = input.id ?? newId();
  const principalId = input.principalId ?? null;
  const apiKeyId = input.apiKeyId ?? null;
  const requestId = input.requestId ?? null;
  const resourceId = input.resourceId ?? null;
  const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
  const metadataSha256 = hashJson(metadataJson);
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = get<AuditEvent>(db, `SELECT * FROM audit_events WHERE id = ?`, [id]);
    if (existing) {
      const same =
        existing.tenant_id === input.tenantId &&
        existing.actor === input.actor &&
        existing.principal_id === principalId &&
        existing.api_key_id === apiKeyId &&
        existing.request_id === requestId &&
        existing.action === input.action &&
        existing.resource_type === input.resourceType &&
        existing.resource_id === resourceId &&
        existing.metadata_sha256 === metadataSha256;
      if (!same) throw new Error("audit_event_id_conflict");
      if (ownsTransaction) db.raw.exec("COMMIT");
      return id;
    }
    const previous = get<{ event_sequence: number; event_hash: string }>(
      db,
      `SELECT event_sequence, event_hash FROM audit_events
       WHERE tenant_id = ? ORDER BY event_sequence DESC LIMIT 1`,
      [input.tenantId],
    );
    const sequence = (previous?.event_sequence ?? 0) + 1;
    const previousHash = previous?.event_hash ?? null;
    const createdAt = nowIso();
    const eventHash = auditHash({
      tenantId: input.tenantId,
      sequence,
      schemaVersion: 1,
      previousHash,
      id,
      actor: input.actor,
      principalId,
      apiKeyId,
      requestId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId,
      metadataSha256,
      createdAt,
    });
    run(
      db,
      `INSERT INTO audit_events
       (id, tenant_id, event_sequence, schema_version, prev_hash, event_hash, metadata_sha256,
        actor, principal_id, api_key_id, request_id, action, resource_type, resource_id,
        metadata_json, created_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.tenantId,
        sequence,
        previousHash,
        eventHash,
        metadataSha256,
        input.actor,
        principalId,
        apiKeyId,
        requestId,
        input.action,
        input.resourceType,
        resourceId,
        metadataJson,
        createdAt,
      ],
    );
    if (ownsTransaction) db.raw.exec("COMMIT");
    return id;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function verifyAuditIntegrity(
  db: AppDb,
  tenantId: string,
): { ok: boolean; checked: number; error?: string } {
  const rows = all<AuditEvent>(
    db,
    `SELECT * FROM audit_events WHERE tenant_id = ? ORDER BY event_sequence`,
    [tenantId],
  );
  let previousHash: string | null = null;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const expectedSequence = index + 1;
    if (row.event_sequence !== expectedSequence || row.prev_hash !== previousHash) {
      return { ok: false, checked: index, error: `audit_chain_sequence:${row.id}` };
    }
    const metadataSha256 = hashJson(row.metadata_json ?? null);
    const expectedHash = auditHash({
      tenantId: row.tenant_id,
      sequence: expectedSequence,
      schemaVersion: row.schema_version,
      previousHash,
      id: row.id,
      actor: row.actor,
      principalId: row.principal_id,
      apiKeyId: row.api_key_id,
      requestId: row.request_id,
      action: row.action,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      metadataSha256,
      createdAt: row.created_at,
    });
    if (row.metadata_sha256 !== metadataSha256 || row.event_hash !== expectedHash) {
      return { ok: false, checked: index, error: `audit_chain_hash:${row.id}` };
    }
    previousHash = row.event_hash;
  }
  return { ok: true, checked: rows.length };
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
    /** S1.1: tenant-private owner. Omit / null => shared, system-admin catalog provider. */
    tenantId?: string | null;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO providers (id, slug, name, website, openapi_url, changelog_url, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.slug,
      row.name,
      row.website ?? null,
      row.openapiUrl ?? null,
      row.changelogUrl ?? null,
      row.tenantId ?? null,
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
  const result = insertApiVersionIfAbsent(db, row);
  if (!result.inserted) {
    throw new Error(`api_version_content_exists:${result.id}`);
  }
}

export function insertApiVersionIfAbsent(
  db: AppDb,
  row: {
    id: string;
    providerId: string;
    versionLabel: string;
    openapiJson: string;
    changelogMd?: string | null;
    publishedAt: string;
  },
): { inserted: boolean; id: string; contentHash: string } {
  const contentHash = createHash("sha256").update(row.openapiJson).digest("hex");
  const result = db.raw
    .prepare(
      `INSERT INTO api_versions
       (id, provider_id, version_label, openapi_json, content_hash, changelog_md, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
    )
    .run(
      row.id,
      row.providerId,
      row.versionLabel,
      row.openapiJson,
      contentHash,
      row.changelogMd ?? null,
      row.publishedAt,
    );
  if (Number(result.changes) === 1) {
    return { inserted: true, id: row.id, contentHash };
  }
  const existing = get<{ id: string }>(
    db,
    `SELECT id FROM api_versions
     WHERE provider_id = ? AND content_hash = ? LIMIT 1`,
    [row.providerId, contentHash],
  );
  if (!existing) throw new Error("api_version_insert_conflict");
  return { inserted: false, id: existing.id, contentHash };
}

export function insertConsumer(
  db: AppDb,
  row: {
    id: string;
    name: string;
    githubOwner: string;
    githubRepo: string;
    installationId?: string | null;
    deliveryMode?: "app" | "legacy_pat" | "revoked";
    tenantId: string;
    createdAt: string;
  },
) {
  run(
    db,
    `INSERT INTO consumers
     (id, name, github_owner, github_repo, installation_id, github_delivery_mode, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.githubOwner,
      row.githubRepo,
      row.installationId ?? null,
      row.deliveryMode ?? "app",
      row.tenantId,
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

export function getOrInsertApiChange(
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
): { change: ApiChange; inserted: boolean } {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = get<ApiChange>(
      db,
      `SELECT * FROM api_changes
       WHERE provider_id = ? AND from_version_id = ? AND to_version_id = ?
       ORDER BY created_at LIMIT 1`,
      [row.providerId, row.fromVersionId, row.toVersionId],
    );
    if (existing) {
      db.raw.exec("COMMIT");
      return { change: existing, inserted: false };
    }
    insertApiChange(db, row);
    const inserted = get<ApiChange>(db, `SELECT * FROM api_changes WHERE id = ?`, [row.id]);
    if (!inserted) throw new Error("api_change_insert_failed");
    db.raw.exec("COMMIT");
    return { change: inserted, inserted: true };
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
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
    /** Serialized GraphPath (FET-016); null when no path was computed. */
    graphPathJson?: string | null;
  },
) {
  run(
    db,
    `INSERT INTO impact_findings (id, change_id, consumer_id, file_path, line_start, line_end, symbol, confidence, evidence_json, graph_path_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.graphPathJson ?? null,
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
    /** JSON-serialized ImpactCoverage for the analysis behind this PR. */
    coverageJson?: string | null;
  },
) {
  run(
    db,
    `INSERT INTO migration_prs (id, change_id, consumer_id, title, body, branch_name, status, risk, patch_unified, github_pr_number, github_pr_url, created_at, resolved_at, coverage_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.coverageJson ?? null,
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

export function updateMigrationPrDelivery(
  db: AppDb,
  id: string,
  row: {
    status: string;
    githubPrNumber?: number | null;
    githubPrUrl?: string | null;
    body?: string;
    githubRepositoryId?: string;
    githubInstallationId?: string;
    githubAccountId?: string;
  },
) {
  const result = db.raw.prepare(
    `UPDATE migration_prs
     SET status = ?,
         github_pr_number = COALESCE(?, github_pr_number),
         github_pr_url = COALESCE(?, github_pr_url),
         body = COALESCE(?, body),
         github_repository_id = COALESCE(?, github_repository_id),
         github_installation_id = COALESCE(?, github_installation_id),
         github_account_id = COALESCE(?, github_account_id)
     WHERE id = ?
       AND (? IS NULL OR github_pr_number IS NULL OR github_pr_number = ?)
       AND (? IS NULL OR github_repository_id IS NULL OR github_repository_id = ?)
       AND (? IS NULL OR github_installation_id IS NULL OR github_installation_id = ?)
       AND (? IS NULL OR github_account_id IS NULL OR github_account_id = ?)`,
  ).run(
      row.status,
      row.githubPrNumber ?? null,
      row.githubPrUrl ?? null,
      row.body ?? null,
      row.githubRepositoryId ?? null,
      row.githubInstallationId ?? null,
      row.githubAccountId ?? null,
      id,
      row.githubPrNumber ?? null,
      row.githubPrNumber ?? null,
      row.githubRepositoryId ?? null,
      row.githubRepositoryId ?? null,
      row.githubInstallationId ?? null,
      row.githubInstallationId ?? null,
      row.githubAccountId ?? null,
      row.githubAccountId ?? null,
  );
  if (result.changes !== 1) throw new Error("migration_pr_delivery_identity_mismatch");
}

/**
 * List providers.
 *
 * `tenantId` follows the standard scope convention (assertTenantScope): `undefined` is the
 * explicit global/system read (every provider, unchanged legacy behavior); a real tenant id
 * returns the shared catalog (tenant_id IS NULL) PLUS that tenant's own private providers,
 * never another tenant's; a present-but-blank tenant fails closed. With no tenant-private
 * providers in the table this is byte-identical to the unscoped read.
 */
export function listProviders(
  db: AppDb,
  limit?: number,
  offset = 0,
  tenantId?: string,
): Provider[] {
  assertTenantScope(tenantId);
  const scoped = tenantId !== undefined;
  const params: SQLInputValue[] = [];
  if (scoped) params.push(tenantId);
  if (limit) params.push(limit, offset);
  return all(
    db,
    `SELECT * FROM providers
     ${scoped ? "WHERE tenant_id IS NULL OR tenant_id = ?" : ""}
     ORDER BY created_at, id ${limit ? "LIMIT ? OFFSET ?" : ""}`,
    params,
  );
}

export function getProviderBySlug(db: AppDb, slug: string): Provider | undefined {
  return get(db, `SELECT * FROM providers WHERE slug = ?`, [slug]);
}

export function getProviderById(db: AppDb, id: string): Provider | undefined {
  return get(db, `SELECT * FROM providers WHERE id = ?`, [id]);
}

/**
 * List API changes.
 *
 * `tenantId` follows the standard scope convention (assertTenantScope): `undefined` is the
 * explicit global/system read (every change, unchanged legacy behavior); a real tenant id
 * returns only changes whose provider is shared (tenant_id IS NULL) or owned by that tenant,
 * so a tenant-private provider's changes never leak to another tenant through the shared
 * `api_changes` catalog. With no tenant-private providers this is byte-identical to the
 * unscoped read.
 */
export function listChanges(
  db: AppDb,
  limit?: number,
  offset = 0,
  tenantId?: string,
): ApiChange[] {
  assertTenantScope(tenantId);
  const scoped = tenantId !== undefined;
  const params: SQLInputValue[] = [];
  if (scoped) params.push(tenantId);
  if (limit) params.push(limit, offset);
  return all(
    db,
    `SELECT * FROM api_changes
     ${scoped
       ? "WHERE provider_id IN (SELECT id FROM providers WHERE tenant_id IS NULL OR tenant_id = ?)"
       : ""}
     ORDER BY created_at DESC, id DESC ${limit ? "LIMIT ? OFFSET ?" : ""}`,
    params,
  );
}

/**
 * Shared-catalog read (intentionally tenant-agnostic).
 *
 * `api_changes` is a shared provider / API-change catalog: rows describe public provider
 * OpenAPI specs and the diff between two published versions. It has no tenant_id column by
 * design, so this accessor takes no tenantId and the same row is visible to every tenant.
 *
 * CONTRACT: `api_changes.diff_json` must only ever hold public provider spec data. It must
 * never carry tenant-private content (consumer code, findings, PR bodies, secrets). Anything
 * tenant-scoped (impact findings, migration PRs) is stored in tenant-scoped tables and read
 * through the tenant-filtered accessors (listFindingsForChange / listPrsForChange), never
 * embedded here. See the cross-tenant denial matrix for the test that pins this intent.
 */
export function getChange(db: AppDb, id: string): ApiChange | undefined {
  return get(db, `SELECT * FROM api_changes WHERE id = ?`, [id]);
}

export function listConsumers(
  db: AppDb,
  tenantId?: string,
  limit?: number,
  offset = 0,
): Consumer[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM consumers
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at, id ${limit ? "LIMIT ? OFFSET ?" : ""}`,
    tenantId ? (limit ? [tenantId, limit, offset] : [tenantId]) : limit ? [limit, offset] : [],
  );
}

export function listPrs(
  db: AppDb,
  tenantId?: string,
  limit?: number,
  offset = 0,
): MigrationPrRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT pr.*
     FROM migration_prs pr
     JOIN consumers c ON c.id = pr.consumer_id
     ${tenantId ? "WHERE c.tenant_id = ?" : ""}
     ORDER BY pr.created_at DESC, pr.id DESC ${limit ? "LIMIT ? OFFSET ?" : ""}`,
    tenantId ? (limit ? [tenantId, limit, offset] : [tenantId]) : limit ? [limit, offset] : [],
  );
}

export function listPrsForChange(
  db: AppDb,
  changeId: string,
  tenantId?: string,
): MigrationPrRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT pr.* FROM migration_prs pr
     JOIN consumers c ON c.id = pr.consumer_id
     WHERE pr.change_id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}
     ORDER BY pr.created_at DESC`,
    tenantId ? [changeId, tenantId] : [changeId],
  );
}

export function getPr(
  db: AppDb,
  id: string,
  tenantId?: string,
): MigrationPrRow | undefined {
  assertTenantScope(tenantId);
  return get(
    db,
    `SELECT pr.*
     FROM migration_prs pr
     JOIN consumers c ON c.id = pr.consumer_id
     WHERE pr.id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}`,
    tenantId ? [id, tenantId] : [id],
  );
}

export function listAudit(
  db: AppDb,
  tenantId?: string,
  limit?: number,
  offset = 0,
): AuditEvent[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM audit_events
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC, id DESC ${limit ? "LIMIT ? OFFSET ?" : ""}`,
    tenantId ? (limit ? [tenantId, limit, offset] : [tenantId]) : limit ? [limit, offset] : [],
  );
}

export function findPrByGitHubIdentityAndNumber(
  db: AppDb,
  input: {
    repositoryId: string;
    installationId: string;
    accountId: string;
    number: number;
  },
): MigrationPrRow | undefined {
  const rows = all<MigrationPrRow>(
    db,
    `SELECT pr.* FROM migration_prs pr
     WHERE pr.github_repository_id = ?
       AND pr.github_installation_id = ?
       AND pr.github_account_id = ?
       AND pr.github_pr_number = ?
     ORDER BY pr.created_at DESC
     LIMIT 2`,
    [input.repositoryId, input.installationId, input.accountId, input.number],
  );
  return rows.length === 1 ? rows[0] : undefined;
}

export function listFindingsForChange(
  db: AppDb,
  changeId: string,
  tenantId?: string,
): ImpactFindingRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT f.* FROM impact_findings f
     JOIN consumers c ON c.id = f.consumer_id
     WHERE f.change_id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}`,
    tenantId ? [changeId, tenantId] : [changeId],
  );
}

export function listVersionsForProvider(db: AppDb, providerId: string): ApiVersion[] {
  return all(db, `SELECT * FROM api_versions WHERE provider_id = ? ORDER BY published_at`, [
    providerId,
  ]);
}

export function listMonitoredForProvider(
  db: AppDb,
  providerId: string,
  tenantId?: string,
): MonitoredApi[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT m.* FROM monitored_apis m
     JOIN consumers c ON c.id = m.consumer_id
     WHERE m.provider_id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}`,
    tenantId ? [providerId, tenantId] : [providerId],
  );
}

export function listMonitoredForConsumer(db: AppDb, consumerId: string): MonitoredApi[] {
  return all(db, `SELECT * FROM monitored_apis WHERE consumer_id = ?`, [consumerId]);
}

export function listMonitoredForConsumers(
  db: AppDb,
  consumerIds: readonly string[],
): MonitoredApi[] {
  if (consumerIds.length === 0) return [];
  const placeholders = consumerIds.map(() => "?").join(", ");
  return all(
    db,
    `SELECT * FROM monitored_apis WHERE consumer_id IN (${placeholders})`,
    [...consumerIds],
  );
}

export function getConsumerRepo(
  db: AppDb,
  consumerId: string,
  tenantId?: string,
): ConsumerRepo | undefined {
  assertTenantScope(tenantId);
  return get(
    db,
    `SELECT r.* FROM consumer_repos r
     JOIN consumers c ON c.id = r.consumer_id
     WHERE r.consumer_id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}`,
    tenantId ? [consumerId, tenantId] : [consumerId],
  );
}

export function getConsumer(
  db: AppDb,
  id: string,
  tenantId?: string,
): Consumer | undefined {
  assertTenantScope(tenantId);
  return get(
    db,
    `SELECT * FROM consumers
     WHERE id = ? ${tenantId ? "AND tenant_id = ?" : ""}`,
    tenantId ? [id, tenantId] : [id],
  );
}

export function listPoliciesForConsumer(
  db: AppDb,
  consumerId: string,
  tenantId?: string,
) {
  assertTenantScope(tenantId);
  return all<{ id: string; consumer_id: string; key: string; value_json: string }>(
    db,
    `SELECT p.* FROM policies p
     JOIN consumers c ON c.id = p.consumer_id
     WHERE p.consumer_id = ? ${tenantId ? "AND c.tenant_id = ?" : ""}`,
    tenantId ? [consumerId, tenantId] : [consumerId],
  );
}

export function getPoliciesMap(
  db: AppDb,
  consumerId: string,
  tenantId?: string,
): Record<string, unknown> {
  const rows = listPoliciesForConsumer(db, consumerId, tenantId);
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

export { computeProductMetrics };
export type { ProductMetrics } from "./metrics.js";

export { buildExposureReport } from "./exposure.js";
export type { ExposureReport } from "./exposure.js";
export { summarizeChangeImpactCoverage } from "./change-impact-coverage.js";
export type { ChangeImpactCoverage } from "./change-impact-coverage.js";
export {
  loadChangeImpactCoverage,
  lookupChangeImpactAudit,
} from "./change-impact-audit.js";
export type {
  ChangeImpactAudit,
  ChangeImpactCoverageWithFallback,
  ChangeImpactFallback,
} from "./change-impact-audit.js";

export {
  appendDomainEvent,
  getPrincipal,
  getPrincipalBySubject,
  getLatestCandidateArtifactForSubject,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  listPrincipals,
  listArtifactManifests,
  listDomainEvents,
  listEvidenceRecords,
  listReviewDecisions,
  verifyDomainEventRecordIntegrity,
  revokePrincipal,
  verifyDomainEventIntegrity,
} from "./trust.js";

export {
  changeTenantMembershipRole,
  claimIdentitySession,
  countActiveTenantOwners,
  createTenantMembership,
  getIdentitySession,
  getTenantMembership,
  listTenantMemberships,
  offboardTenantMembership,
  putTenantMembership,
  revokeIdentitySession,
  revokeIdentitySessionsForMember,
  setTenantMembershipStatus,
} from "./identity.js";

export {
  approvePilotSuccessContract,
  createPilotSuccessContract,
  getPilotSuccessContract,
  listPilotSuccessContracts,
  revisePilotSuccessContract,
} from "./pilot-success-contract.js";
export type {
  PilotSuccessContract,
  PilotSuccessContractApproval,
  PilotSuccessContractDefinition,
} from "./pilot-success-contract.js";

export {
  bindConsumerRepoSnapshot,
  getConnectedRepository,
  getRepositorySnapshotPolicy,
  getRepositorySnapshotDeletionStatus,
  getScmConnection,
  getLatestRepositorySnapshot,
  getScmConnectionHealth,
  insertConnectedRepository,
  insertRepositorySnapshot,
  insertRepositorySnapshotFiles,
  insertRepositorySnapshotPolicy,
  listConnectedRepositories,
  listRepositorySnapshots,
  listRepositorySnapshotFiles,
  listExpiredRepositorySnapshots,
  listRepositorySnapshotReuseCandidates,
  listScmConnections,
  revokeScmConnection,
  recordRepositorySnapshotDeletion,
  setScmConnectionHealth,
  updateConnectedRepositoryStatus,
  upsertScmConnection,
} from "./repository.js";

export type {
  UsagePriceVersion,
  UsageEntitlement,
  UsageLedgerEntry,
  UsageSummary,
} from "./usage.js";
export * from "./invoice-export.js";

export type {
  ActualExecutionCostInput,
  ActualExecutionCostEntry,
  ExecutionCostFromRoutingLedgerInput,
  ExecutionCostIntegrity,
  ExecutionOutcomeStatus,
  ExecutionOutcomeResolutionStatus,
  ExecutionCostOutcome,
  GrossMarginAttribution,
  GrossMarginIncompleteAttribution,
  GrossMarginReconciliation,
} from "./gross-margin.js";

export type {
  WardenCampaign,
  WardenCampaignStatus,
  WardenCampaignTarget,
  WardenEnrollmentSource,
  WardenOrgEnrollmentResult,
  WardenOrgEnrollmentSkip,
  WardenOrgEnrollmentSkipReason,
  WardenOrgRepositoryCandidate,
  WardenRolloutDecision,
  WardenRolloutTargetProfile,
  WardenRolloutStopConditions,
  WardenTargetStage,
} from "./warden-campaign.js";

export {
  recordAdaptiveCandidate,
  getAdaptiveCandidate,
  listAdaptiveCandidates,
  listAdaptiveCandidateTenantIds,
  listAdaptiveAttentionCandidates,
  listAdaptiveCandidateHistory,
  listAdaptiveCandidatesForMaintenance,
  getAdaptiveRegenerationByCandidate,
  requestAdaptiveCandidateRegeneration,
  listPendingAdaptiveRegenerations,
  markAdaptiveRegenerationBlocked,
  markAdaptiveRegenerationScheduled,
  recordAdaptiveRegenerationScheduleFailure,
  reviewAdaptiveCandidate,
  signOffAdaptiveEscalation,
  promoteAdaptiveCandidate,
  expireAdaptiveCandidate,
  type AdaptiveCandidateStatus,
  type AdaptiveCandidateHistoryCursor,
  type AdaptiveCandidateHistoryPage,
  type AdaptiveReviewDecision,
  type AdaptiveReviewTier,
  type AdaptiveRegenerationStatus,
  type TransformerAdaptiveCandidateRecord,
  type TransformerAdaptiveRegenerationRecord,
  type RecordAdaptiveCandidateInput,
  type ReviewAdaptiveCandidateInput,
  type SignOffAdaptiveEscalationInput,
  type PromoteAdaptiveCandidateInput,
  type ExpireAdaptiveCandidateInput,
} from "./transformer-adaptive-candidate.js";

export {
  enqueueAdaptiveDelivery,
  getAdaptiveDelivery,
  getAdaptiveDeliveryByCandidate,
  listAdaptiveDeliveries,
  bindAdaptiveDeliveryIntent,
  recordAdaptiveDeliverySuccess,
  recordAdaptiveDeliveryFailure,
  findAdaptiveDeliveryByPrUrl,
  recordAdaptiveDeliveryOutcome,
  type AdaptiveDeliveryStatus,
  type AdaptiveDeliveryOutcome,
  type TransformerAdaptiveDeliveryRecord,
  type EnqueueAdaptiveDeliveryInput,
  type BindAdaptiveDeliveryIntentInput,
  type RecordAdaptiveDeliverySuccessInput,
  type RecordAdaptiveDeliveryFailureInput,
  type RecordAdaptiveDeliveryOutcomeInput,
} from "./transformer-adaptive-delivery.js";

export {
  enqueueWardenCandidateDelivery,
  getWardenCandidateDelivery,
  getWardenCandidateDeliveryByRun,
  bindWardenCandidateDeliveryScope,
  bindWardenCandidateDeliveryIntent,
  refreshWardenCandidateDeliveryMissionAuthority,
  replayWardenCandidateDeliveryMergedOutcome,
  replayPendingWardenCandidateDeliveryMergedOutcomes,
  recordWardenCandidateDeliverySuccess,
  recordWardenCandidateDeliveryFailure,
  findWardenCandidateDeliveryByPrUrl,
  recordWardenCandidateDeliveryOutcome,
  type WardenCandidateDeliveryStatus,
  type WardenCandidateDeliveryOutcome,
  type WardenCandidateDeliveryRecord,
  type EnqueueWardenCandidateDeliveryInput,
  type BindWardenCandidateDeliveryScopeResult,
} from "./warden-candidate-delivery.js";

export {
  enqueueWardenCiCycle,
  getWardenCiCycle,
  listWardenCiObservations,
  wakeWardenCiReviewObservation,
  recordWardenCiObservation,
  beginWardenCiRepair,
  exhaustWardenCiCycle,
  pauseWardenCiCycle,
  settleWardenCiRepairWithoutCandidate,
  rebindWardenCiRepair,
  failWardenCiOperation,
  getWardenCiUpdate,
  getWardenCiUpdateByRun,
  enqueueWardenCiUpdate,
  bindWardenCiUpdateIntent,
  authorizeWardenCiUpdateIntent,
  markWardenCiUpdateUncertain,
  markWardenCiUpdateTakeoverUncertain,
  reconcileWardenCiUpdateNotApplied,
  completeWardenCiUpdate,
  type WardenCiCycle,
  type WardenCiObservation,
  type WardenCiUpdate,
  type WardenCiCycleStatus,
  type WardenCiReviewWakeResult,
} from "./warden-ci-reentry.js";

export type {
  LearningConsentRow,
  LearningDatasetMemberRow,
  LearningDatasetVersionRow,
  LearningDeletionEventRow,
  LearningRecordLineage,
  LearningRecordRow,
} from "./learning.js";
export {
  addLearningDatasetMember,
  admitLearningRecord,
  countLearningDatasetMembers,
  createLearningDatasetVersion,
  deleteLearningRecord,
  findActiveLearningConsent,
  getLatestLearningDatasetVersion,
  getLatestSealedLearningDatasetVersion,
  getLearningDatasetVersion,
  getLearningRecord,
  getLearningRecordRedactedContent,
  grantLearningConsent,
  listAdmittableLearningRecords,
  listEligibleLearningDatasetMembers,
  listLearningConsentHistory,
  listLearningRecordLineage,
  revokeLearningConsent,
  sealLearningDatasetVersion,
} from "./learning.js";
export {
  LEARNING_CORPUS_SCHEMA_VERSION,
  buildLearningCorpus,
  formatLearningCorpusStats,
  serializeLearningCorpusJsonl,
} from "./learning-corpus.js";
export type {
  BuildLearningCorpusInput,
  LearningCorpusEdit,
  LearningCorpusExample,
  LearningCorpusExclusionReason,
  LearningCorpusResult,
  LearningCorpusStats,
} from "./learning-corpus.js";
export {
  addWardenCampaignTarget,
  autoEnrollWardenCampaignOrg,
  claimReadyWardenTargets,
  createWardenCampaign,
  getWardenCampaign,
  getWardenCampaignTarget,
  getWardenRolloutDecision,
  listWardenCampaignTargets,
  planWardenRollout,
  planWardenRollback,
  transitionWardenCampaign,
  transitionWardenTarget,
} from "./warden-campaign.js";
export {
  advanceMissionPolicyEnvelopeVersion,
  bindMissionGraphVersion,
  bindMissionPolicyEnvelopeVersion,
  bindMissionScope,
  createMission,
  getMission,
  linkFettlerCampaignToMission,
  linkRegaugeCampaignToMission,
  regaugeMissionId,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  transitionMission,
} from "./mission.js";
export type {
  Mission,
  MissionProduct,
  MissionState,
  MissionTriggerKind,
} from "./mission.js";
export {
  assertMissionMutationAuthority,
  createMissionMutationAuthority,
  parseMissionMutationAuthority,
  refreshMissionMutationAuthority,
} from "./mission-mutation-authority.js";
export type { MissionMutationAuthorityV1 } from "./mission-mutation-authority.js";
export {
  authorizeMissionMutationDispatch,
  beginMissionMutationRemoteCall,
  markMissionMutationDispatchUncertain,
  settleMissionMutationDispatch,
} from "./mission-mutation-dispatch.js";
export {
  revokePendingMissionMutationDispatches,
  revokePendingMissionTaskMutationDispatches,
} from "./mission-mutation-dispatch-fence.js";
export type { MissionMutationDispatchState } from "./mission-mutation-dispatch.js";
export {
  MAX_TRAJECTORY_BLOB_CHARS,
  finalizeTrajectory,
  getTrajectory,
  getTrajectoryByRun,
  getTrajectoryStepPair,
  listTrajectories,
  listTrajectorySteps,
  putTrajectoryBlob,
  readTrajectoryBlob,
  recordModelCall,
  recordRouterDecisionStep,
  recordToolCall,
  recordTrajectory,
  recordVerificationStep,
} from "./trajectory.js";
export type {
  Trajectory,
  TrajectoryBlob,
  TrajectoryBlobRef,
  TrajectoryProduct,
  TrajectorySignalClass,
  TrajectoryStep,
  TrajectoryStepKind,
  TrajectoryStepPair,
  TrajectoryVerification,
} from "./trajectory.js";
export {
  createUsagePriceVersion,
  getUsagePriceVersion,
  createUsageEntitlement,
  getActiveUsageEntitlement,
  reserveUsage,
  settleUsageReservation,
  releaseUsageReservation,
  adjustUsage,
  creditUsage,
  getUsageSummary,
  listUsageLedger,
  reconcileUsageLedger,
} from "./usage.js";
export {
  MCU_MICROS,
  RUN_MCU_ESTIMATE,
  RUN_USAGE_RESERVATION_KEY,
  RUN_USAGE_RESERVED_MCU_KEY,
  estimateRunMcuMicros,
  reserveRunUsage,
  settleRunUsage,
  releaseRunUsage,
} from "./usage-run.js";
export {
  USAGE_PLAN_CATALOG,
  USAGE_PLAN_CURRENCY,
  USAGE_PLAN_FORMULA_VERSION,
  USAGE_PLAN_PRICE_PER_MCU_MONEY_MICROS,
  getUsagePlanSpec,
  provisionEntitlementForPlan,
  resolvePlanQuotaMcuMicros,
  type UsagePlanAllowance,
  type UsagePlanId,
  type UsagePlanSpec,
} from "./usage-plan.js";
export {
  appendWardenRunEvent,
  replayWardenRun,
  WARDEN_RUN_EVENT_KINDS,
} from "./warden-replay.js";
export type {
  WardenRunArtifactReference,
  WardenRunCost,
  WardenRunEventKind,
  WardenRunReplayEnvelope,
  WardenRunReplayEvidence,
  WardenRunVersionReference,
} from "./warden-replay.js";
export {
  getLatestActualExecutionCostForTaskBeforeAttempt,
  listActualExecutionCosts,
  reconcileGrossMargin,
  recordActualExecutionCost,
  recordExecutionCostOutcome,
  listExecutionCostOutcomes,
  recordExecutionCostFromRoutingLedger,
  verifyExecutionCostIntegrity,
  verifyExecutionOutcomeIntegrity,
} from "./gross-margin.js";

export type SuppressedPattern = {
  id: string;
  tenant_id: string;
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
    tenantId: string;
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
    `INSERT OR IGNORE INTO suppressed_patterns
     (id, tenant_id, consumer_id, provider_slug, pattern, reason, source_pr_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenantId,
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
  opts?: { consumerId?: string; providerSlug?: string; tenantId?: string },
): SuppressedPattern[] {
  const tenantWhere = opts?.tenantId ? "tenant_id = ?" : "1 = 1";
  const tenantParams = opts?.tenantId ? [opts.tenantId] : [];
  if (opts?.consumerId && opts?.providerSlug) {
    return all(
      db,
      `SELECT * FROM suppressed_patterns
       WHERE ${tenantWhere}
         AND (consumer_id = ? OR provider_slug = ? OR consumer_id IS NULL)
       ORDER BY created_at DESC`,
      [...tenantParams, opts.consumerId, opts.providerSlug],
    );
  }
  if (opts?.consumerId) {
    return all(
      db,
      `SELECT * FROM suppressed_patterns
       WHERE ${tenantWhere} AND (consumer_id = ? OR consumer_id IS NULL)
       ORDER BY created_at DESC`,
      [...tenantParams, opts.consumerId],
    );
  }
  return all(
    db,
    `SELECT * FROM suppressed_patterns WHERE ${tenantWhere} ORDER BY created_at DESC`,
    tenantParams,
  );
}

export function isPatternSuppressed(
  db: AppDb,
  pattern: string,
  opts?: { consumerId?: string; providerSlug?: string; tenantId?: string },
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
    tenantId: string;
    principalId?: string | null;
    scopes?: string[];
    authorityPrincipalId?: string;
    authorityRole?: ApiKeyRow["authority_role"];
    createdAt: string;
  },
): { id: string; token: string; prefix: string; tenantId: string } {
  const token = `me_${randomBytes(24).toString("base64url")}`;
  const prefix = token.slice(0, 10);
  const keyHash = hashApiKey(token);
  const authorityPrincipalId = validatedApiKeyAuthorityPrincipal(
    db,
    row.tenantId,
    row.authorityPrincipalId,
  );
  const authorityRole = validatedApiKeyAuthorityRole(row.authorityRole);
  run(
    db,
    `INSERT INTO api_keys
     (id, name, key_hash, key_prefix, tenant_id, principal_id, scopes_json, authority_principal_id, authority_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      keyHash,
      prefix,
      row.tenantId,
      row.principalId ?? null,
      JSON.stringify(row.scopes ?? ["*"]),
      authorityPrincipalId,
      authorityRole,
      row.createdAt,
    ],
  );
  return {
    id: row.id,
    token,
    prefix,
    tenantId: row.tenantId,
  };
}

/** Store a caller-generated deployment secret without ever logging it. */
export function createApiKeyFromToken(
  db: AppDb,
  row: {
    id: string;
    name: string;
    tenantId: string;
    principalId?: string | null;
    token: string;
    scopes?: string[];
    authorityPrincipalId?: string;
    authorityRole?: ApiKeyRow["authority_role"];
    createdAt: string;
  },
): { id: string; prefix: string; tenantId: string } {
  const prefix = row.token.slice(0, 10);
  const authorityPrincipalId = validatedApiKeyAuthorityPrincipal(
    db,
    row.tenantId,
    row.authorityPrincipalId,
  );
  const authorityRole = validatedApiKeyAuthorityRole(row.authorityRole);
  run(
    db,
    `INSERT INTO api_keys
     (id, name, key_hash, key_prefix, tenant_id, principal_id, scopes_json, authority_principal_id, authority_role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      hashApiKey(row.token),
      prefix,
      row.tenantId,
      row.principalId ?? null,
      JSON.stringify(row.scopes ?? ["*"]),
      authorityPrincipalId,
      authorityRole,
      row.createdAt,
    ],
  );
  return { id: row.id, prefix, tenantId: row.tenantId };
}

function validatedApiKeyAuthorityRole(role: ApiKeyRow["authority_role"] | undefined): ApiKeyRow["authority_role"] {
  if (role === undefined || role === null) return null;
  if (!(new Set(["owner", "admin", "engineer", "viewer", "fde", "agent"])).has(role)) {
    throw new Error("api_key_authority_role_invalid");
  }
  return role;
}

function validatedApiKeyAuthorityPrincipal(
  db: AppDb,
  tenantId: string,
  authorityPrincipalId: string | undefined,
  observedAtMs = Date.now(),
): string | null {
  if (authorityPrincipalId === undefined) return null;
  const principal = get<PrincipalRow>(
    db,
    `SELECT * FROM principals WHERE tenant_id = ? AND id = ?`,
    [tenantId, authorityPrincipalId],
  );
  const createdAt = principal ? Date.parse(principal.created_at) : Number.NaN;
  const expiresAt = principal?.expires_at === null ? null : Date.parse(principal?.expires_at ?? "");
  if (
    !principal ||
    !Number.isFinite(observedAtMs) ||
    (principal.kind !== "human" && principal.kind !== "service") ||
    principal.revoked_at !== null ||
    !Number.isFinite(createdAt) ||
    createdAt > observedAtMs ||
    (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= observedAtMs))
  ) {
    throw new Error("api_key_authority_principal_invalid");
  }
  return principal.id;
}

export function bindApiKeyAuthorityPrincipal(
  db: AppDb,
  input: Readonly<{
    apiKeyId: string;
    tenantId: string;
    authorityPrincipalId: string;
    authorityRole?: Exclude<ApiKeyRow["authority_role"], null>;
    observedAt?: string;
  }>,
): void {
  const authorityPrincipalId = validatedApiKeyAuthorityPrincipal(
    db,
    input.tenantId,
    input.authorityPrincipalId,
    input.observedAt === undefined ? undefined : Date.parse(input.observedAt),
  );
  const authorityRole = validatedApiKeyAuthorityRole(input.authorityRole);
  const key = get<Pick<ApiKeyRow, "tenant_id" | "authority_principal_id" | "authority_role">>(
    db,
    `SELECT tenant_id, authority_principal_id, authority_role FROM api_keys WHERE id = ?`,
    [input.apiKeyId],
  );
  if (!key || key.tenant_id !== input.tenantId || !authorityPrincipalId) {
    throw new Error("api_key_authority_binding_invalid");
  }
  if (key.authority_principal_id !== null && key.authority_principal_id !== authorityPrincipalId) {
    throw new Error("api_key_authority_binding_conflict");
  }
  if (authorityRole !== null && key.authority_role !== null && key.authority_role !== authorityRole) {
    throw new Error("api_key_authority_binding_conflict");
  }
  if (key.authority_principal_id === null || (authorityRole !== null && key.authority_role === null)) {
    run(
      db,
      `UPDATE api_keys
       SET authority_principal_id = COALESCE(authority_principal_id, ?),
           authority_role = COALESCE(authority_role, ?)
       WHERE id = ? AND tenant_id = ?`,
      [authorityPrincipalId, authorityRole, input.apiKeyId, input.tenantId],
    );
  }
}

/**
 * Bind a wildcard owner key to one durable authority. The only replaceable
 * legacy binding is the exact key-specific service principal created by the
 * pre-authority authentication compatibility path, and only while its role is
 * still unbound. This keeps migration from amplifying arbitrary legacy keys.
 */
export function bindOwnerApiKeyAuthority(
  db: AppDb,
  input: Readonly<{
    apiKeyId: string;
    tenantId: string;
    authorityPrincipalId: string;
  }>,
): ApiKeyRow {
  const authorityPrincipalId = validatedApiKeyAuthorityPrincipal(
    db,
    input.tenantId,
    input.authorityPrincipalId,
  );
  if (!authorityPrincipalId) throw new Error("api_key_authority_binding_invalid");
  const key = get<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?`, [
    input.apiKeyId,
    input.tenantId,
  ]);
  if (!key) throw new Error("api_key_authority_binding_invalid");
  let scopes: unknown;
  try {
    scopes = JSON.parse(key.scopes_json);
  } catch {
    throw new Error("api_key_authority_binding_invalid");
  }
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== "*") {
    throw new Error("api_key_authority_binding_invalid");
  }
  if (key.authority_principal_id === authorityPrincipalId && key.authority_role === "owner") {
    return key;
  }
  const legacy = key.authority_principal_id === null
    ? null
    : get<PrincipalRow>(db, `SELECT * FROM principals WHERE id = ? AND tenant_id = ?`, [
        key.authority_principal_id,
        input.tenantId,
      ]);
  const exactLegacyCompatibilityBinding = key.authority_role === null && legacy?.kind === "service" &&
    legacy.subject === `api-key-authority:${key.id}` && legacy.audience === "mendpoint-api";
  const replaceable = key.authority_role === null && (
    key.authority_principal_id === null ||
    key.authority_principal_id === authorityPrincipalId ||
    exactLegacyCompatibilityBinding
  );
  if (!replaceable) throw new Error("api_key_authority_binding_conflict");
  const updated = db.raw.prepare(
    `UPDATE api_keys SET authority_principal_id = ?, authority_role = 'owner'
     WHERE id = ? AND tenant_id = ? AND authority_role IS NULL
       AND authority_principal_id IS ?`,
  ).run(authorityPrincipalId, key.id, input.tenantId, key.authority_principal_id);
  if (updated.changes !== 1) throw new Error("api_key_authority_binding_conflict");
  return get<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE id = ?`, [key.id])!;
}

export function ensureDeploymentBootstrapOwnerPrincipal(
  db: AppDb,
  tenantId: string,
  createdAt: string,
): PrincipalRow {
  const subject = "deployment-bootstrap-owner";
  return insertPrincipal(db, {
    id: `principal-service-${createHash("sha256")
      .update(`${tenantId}\n${subject}`)
      .digest("hex")
      .slice(0, 32)}`,
    tenantId,
    kind: "service",
    subject,
    displayName: "Deployment bootstrap owner",
    audience: "mendpoint-api",
    createdAt,
  });
}

export function migrateLegacySelfServeOwnerKeyAuthority(
  db: AppDb,
  apiKeyId: string,
): ApiKeyRow {
  const key = get<ApiKeyRow>(db, `SELECT * FROM api_keys WHERE id = ?`, [apiKeyId]);
  if (!key || !key.id.startsWith("key_ss_") || !key.tenant_id.startsWith("tenant_ss_")) {
    throw new Error("api_key_authority_binding_invalid");
  }
  const memberships = all<TenantMembershipRow>(db, `SELECT * FROM tenant_memberships
    WHERE tenant_id = ? AND issuer = ? AND role = 'owner' AND status = 'active'`, [
    key.tenant_id,
    "https://self-serve.mendpoint.ai",
  ]);
  if (memberships.length !== 1) throw new Error("api_key_authority_binding_invalid");
  const membership = memberships[0]!;
  const trustSubject = `${membership.issuer}|${membership.subject}`;
  const principal = insertPrincipal(db, {
    id: `principal-human-${createHash("sha256")
      .update(`${key.tenant_id}\n${trustSubject}`)
      .digest("hex")
      .slice(0, 32)}`,
    tenantId: key.tenant_id,
    kind: "human",
    subject: trustSubject,
    displayName: membership.display_name,
    audience: membership.issuer,
    createdAt: membership.created_at,
  });
  return bindOwnerApiKeyAuthority(db, {
    apiKeyId: key.id,
    tenantId: key.tenant_id,
    authorityPrincipalId: principal.id,
  });
}

export type CreateTenantResult = {
  /** false when the tenant already existed and no second key was minted. */
  created: boolean;
  tenant: TenantRow;
  membership: TenantMembershipRow;
  /** Plaintext key, returned once, only on first provisioning. */
  apiKey: { id: string; token: string; prefix: string } | null;
};

/**
 * Self-serve tenant provisioning: create a tenant, its founding owner
 * membership, and a scoped API key in one transaction.
 *
 * Idempotent on tenant slug. A repeat call by the same founding owner returns
 * the existing tenant + owner membership without minting a second key
 * (created === false, apiKey === null). A different owner claiming an existing
 * slug is rejected with tenant_slug_taken so a stranger can never be attached
 * to another tenant.
 */
export function createTenant(
  db: AppDb,
  input: {
    tenantId: string;
    slug: string;
    name: string;
    plan?: string;
    seatLimit?: number;
    owner: {
      issuer: string;
      subject: string;
      email: string | null;
      displayName: string;
    };
    apiKeyId: string;
    apiKeyName?: string;
    apiKeyScopes?: string[];
    createdAt: string;
  },
): CreateTenantResult {
  const tenantId = input.tenantId.trim();
  const slug = input.slug.trim();
  const name = input.name.trim();
  if (!tenantId) throw new Error("tenant_id_required");
  if (!slug) throw new Error("tenant_slug_required");
  if (!name) throw new Error("tenant_name_required");

  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = get<TenantRow>(db, `SELECT * FROM tenants WHERE slug = ?`, [slug]);
    if (existing) {
      const membership = getTenantMembership(
        db,
        existing.id,
        input.owner.issuer,
        input.owner.subject,
      );
      if (!membership) throw new Error("tenant_slug_taken");
      if (owns) db.raw.exec("COMMIT");
      return { created: false, tenant: existing, membership, apiKey: null };
    }
    run(
      db,
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [tenantId, slug, name, input.plan ?? "free", input.seatLimit ?? 3, input.createdAt],
    );
    const membership = createTenantMembership(db, {
      tenantId,
      issuer: input.owner.issuer,
      subject: input.owner.subject,
      email: input.owner.email,
      displayName: input.owner.displayName,
      role: "owner",
      createdAt: input.createdAt,
    });
    const trustSubject = `${input.owner.issuer}|${input.owner.subject}`;
    const ownerAuthority = insertPrincipal(db, {
      id: `principal-human-${createHash("sha256")
        .update(`${tenantId}\n${trustSubject}`)
        .digest("hex")
        .slice(0, 32)}`,
      tenantId,
      kind: "human",
      subject: trustSubject,
      displayName: input.owner.displayName,
      audience: input.owner.issuer,
      createdAt: input.createdAt,
    });
    const apiKey = createApiKey(db, {
      id: input.apiKeyId,
      name: input.apiKeyName ?? `${name} owner key`,
      tenantId,
      scopes: input.apiKeyScopes ?? ["*"],
      authorityPrincipalId: ownerAuthority.id,
      authorityRole: "owner",
      createdAt: input.createdAt,
    });
    const tenant = get<TenantRow>(db, `SELECT * FROM tenants WHERE id = ?`, [tenantId])!;
    if (owns) db.raw.exec("COMMIT");
    return {
      created: true,
      tenant,
      membership,
      apiKey: { id: apiKey.id, token: apiKey.token, prefix: apiKey.prefix },
    };
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
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

export function claimDelegatedRequestNonce(
  db: AppDb,
  input: {
    apiKeyId: string;
    requestId: string;
    signatureSha256: string;
    createdAt: string;
  },
): boolean {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.requestId)) {
    throw new Error("delegated_request_id_invalid");
  }
  if (!/^[a-f0-9]{64}$/.test(input.signatureSha256)) {
    throw new Error("delegated_signature_hash_invalid");
  }
  try {
    db.raw
      .prepare(
        `INSERT INTO delegated_request_nonces
         (api_key_id, request_id, signature_sha256, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.apiKeyId, input.requestId, input.signatureSha256, input.createdAt);
    return true;
  } catch (error) {
    if (error instanceof Error && /UNIQUE|PRIMARY KEY/i.test(error.message)) return false;
    throw error;
  }
}

export function listApiKeys(
  db: AppDb,
  tenantId?: string,
): Array<Omit<ApiKeyRow, "key_hash">> {
  assertTenantScope(tenantId);
  return all<ApiKeyRow>(
    db,
    `SELECT id, name, key_hash, key_prefix, tenant_id, principal_id, scopes_json,
            authority_principal_id, authority_role, created_at, last_used_at, revoked_at
     FROM api_keys
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC`,
    tenantId ? [tenantId] : [],
  ).map(({ key_hash: _h, ...rest }) => rest);
}

export function revokeApiKey(
  db: AppDb,
  id: string,
  at: string,
  tenantId?: string,
): boolean {
  assertTenantScope(tenantId);
  const result = db.raw
    .prepare(
      `UPDATE api_keys SET revoked_at = ?
       WHERE id = ? ${tenantId ? "AND tenant_id = ?" : ""}`,
    )
    .run(...(tenantId ? [at, id, tenantId] : [at, id]));
  return Number(result.changes) > 0;
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
    tenantId: string;
    providerSlug: string;
    openapiUrl: string;
    contentHash?: string | null;
    versionLabel?: string | null;
    status: string;
    error?: string | null;
    versionId?: string | null;
    pipelineChangeId?: string | null;
    polledAt: string;
    validationEvidence?: FeedValidationEvidenceInput;
  },
) {
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    run(
      db,
      `INSERT INTO feed_polls
       (id, tenant_id, provider_slug, openapi_url, content_hash, version_label, status, error, version_id, pipeline_change_id, polled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.tenantId,
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
    const evidence = row.validationEvidence;
    if (evidence) {
      run(
        db,
        `INSERT INTO feed_validation_evidence
         (id, poll_id, provider_slug, source, source_url, format, format_status,
          schema_version, schema_status, size_bytes, content_sha256, status, error,
          http_status, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          evidence.id,
          row.id,
          row.providerSlug,
          evidence.source,
          row.openapiUrl,
          evidence.format,
          evidence.formatStatus,
          evidence.schemaVersion ?? null,
          evidence.schemaStatus,
          evidence.sizeBytes,
          evidence.contentSha256 ?? null,
          evidence.status,
          evidence.error ?? null,
          evidence.httpStatus ?? null,
          evidence.observedAt,
        ],
      );
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function listFeedPolls(
  db: AppDb,
  limit = 50,
  tenantId?: string,
): FeedPollRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT poll.*,
            evidence.id AS validation_evidence_id,
            evidence.source AS validation_source,
            evidence.format AS validation_format,
            evidence.format_status AS validation_format_status,
            evidence.schema_version AS validation_schema_version,
            evidence.schema_status AS validation_schema_status,
            evidence.size_bytes AS validation_size_bytes,
            evidence.content_sha256 AS validation_content_sha256,
            evidence.status AS validation_status,
            evidence.error AS validation_error,
            evidence.http_status AS validation_http_status,
            evidence.observed_at AS validation_observed_at
     FROM feed_polls poll
     LEFT JOIN feed_validation_evidence evidence ON evidence.poll_id = poll.id
     ${tenantId ? "WHERE poll.tenant_id = ?" : ""}
     ORDER BY poll.polled_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  );
}

export function claimFeedTenantDispatch(
  db: AppDb,
  input: {
    tenantId: string;
    providerSlug: string;
    contentHash: string;
    versionId?: string;
    attemptedAt: string;
    staleAfterMs?: number;
  },
): number | null {
  const attemptedAtMs = Date.parse(input.attemptedAt);
  if (!Number.isFinite(attemptedAtMs)) {
    throw new Error("feed_dispatch_attempt_time_invalid");
  }
  const staleBefore = new Date(
    attemptedAtMs - (input.staleAfterMs ?? 15 * 60_000),
  ).toISOString();
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db.raw
      .prepare(
        `INSERT INTO feed_tenant_dispatches
         (tenant_id, provider_slug, content_hash, version_id, status, attempted_at)
         VALUES (?, ?, ?, ?, 'running', ?)
         ON CONFLICT (tenant_id, provider_slug, content_hash) DO NOTHING`,
      )
      .run(
        input.tenantId,
        input.providerSlug,
        input.contentHash,
        input.versionId ?? null,
        input.attemptedAt,
      );
    let claimed = Number(inserted.changes) === 1;
    if (!claimed) {
      const reclaimed = db.raw
        .prepare(
          `UPDATE feed_tenant_dispatches
           SET version_id = ?, status = 'running', pipeline_ref = NULL,
               lease_generation = lease_generation + 1,
               error = NULL, attempted_at = ?, completed_at = NULL
           WHERE tenant_id = ? AND provider_slug = ? AND content_hash = ?
             AND (status = 'failed' OR (status = 'running' AND attempted_at <= ?))`,
        )
        .run(
          input.versionId ?? null,
          input.attemptedAt,
          input.tenantId,
          input.providerSlug,
          input.contentHash,
          staleBefore,
        );
      claimed = Number(reclaimed.changes) === 1;
    }
    const generation = claimed
      ? get<{ lease_generation: number }>(
          db,
          `SELECT lease_generation FROM feed_tenant_dispatches
           WHERE tenant_id = ? AND provider_slug = ? AND content_hash = ?`,
          [input.tenantId, input.providerSlug, input.contentHash],
        )?.lease_generation ?? null
      : null;
    if (ownsTransaction) db.raw.exec("COMMIT");
    return generation;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function completeFeedTenantDispatch(
  db: AppDb,
  input: {
    tenantId: string;
    providerSlug: string;
    contentHash: string;
    leaseGeneration: number;
    succeeded: boolean;
    completedAt: string;
    pipelineRef?: string;
    error?: string;
  },
): boolean {
  const updated = db.raw
    .prepare(
      `UPDATE feed_tenant_dispatches
       SET status = ?, pipeline_ref = ?, error = ?, completed_at = ?
       WHERE tenant_id = ? AND provider_slug = ? AND content_hash = ?
         AND status = 'running' AND lease_generation = ?`,
    )
    .run(
      input.succeeded ? "succeeded" : "failed",
      input.pipelineRef ?? null,
      input.succeeded ? null : input.error ?? "feed_pipeline_failed",
      input.completedAt,
      input.tenantId,
      input.providerSlug,
      input.contentHash,
      input.leaseGeneration,
    );
  return Number(updated.changes) === 1;
}

export function latestFeedPollForSlug(db: AppDb, slug: string): FeedPollRow | undefined {
  return get(
    db,
    `SELECT poll.*,
            evidence.id AS validation_evidence_id,
            evidence.source AS validation_source,
            evidence.format AS validation_format,
            evidence.format_status AS validation_format_status,
            evidence.schema_version AS validation_schema_version,
            evidence.schema_status AS validation_schema_status,
            evidence.size_bytes AS validation_size_bytes,
            evidence.content_sha256 AS validation_content_sha256,
            evidence.status AS validation_status,
            evidence.error AS validation_error,
            evidence.http_status AS validation_http_status,
            evidence.observed_at AS validation_observed_at
     FROM feed_polls poll
     LEFT JOIN feed_validation_evidence evidence ON evidence.poll_id = poll.id
     WHERE poll.provider_slug = ?
     ORDER BY poll.polled_at DESC, poll.rowid DESC
     LIMIT 1`,
    [slug],
  );
}

export function latestSuccessfulHash(db: AppDb, slug: string): string | undefined {
  const row = get<FeedPollRow>(
    db,
    `SELECT * FROM feed_polls
     WHERE provider_slug = ? AND content_hash IS NOT NULL
       AND status IN ('unchanged', 'new_version', 'pipeline_ran', 'pipeline_enqueued')
     ORDER BY polled_at DESC, rowid DESC
     LIMIT 1`,
    [slug],
  );
  return row?.content_hash ?? undefined;
}

export function upsertFeedSchedule(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    providerSlug: string;
    intervalMs: number;
    staleAfterMs: number;
    enabled?: boolean;
    createdAt: string;
  },
): FeedScheduleRow {
  if (!Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1_000) {
    throw new Error("feed_schedule_interval_invalid");
  }
  if (!Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < input.intervalMs) {
    throw new Error("feed_schedule_stale_window_invalid");
  }
  const providerSlug = input.providerSlug.trim();
  if (!providerSlug) throw new Error("feed_schedule_provider_invalid");
  db.raw
    .prepare(
      `INSERT INTO feed_schedules
       (id, tenant_id, provider_slug, interval_ms, stale_after_ms, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, provider_slug) DO UPDATE SET
         interval_ms = excluded.interval_ms,
         stale_after_ms = excluded.stale_after_ms,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.tenantId,
      providerSlug,
      input.intervalMs,
      input.staleAfterMs,
      input.enabled === false ? 0 : 1,
      input.createdAt,
      input.createdAt,
    );
  return get<FeedScheduleRow>(
    db,
    `SELECT * FROM feed_schedules WHERE tenant_id = ? AND provider_slug = ?`,
    [input.tenantId, providerSlug],
  )!;
}

export function listFeedSchedules(db: AppDb, tenantId?: string): FeedScheduleRow[] {
  return tenantId
    ? all(db, `SELECT * FROM feed_schedules WHERE tenant_id = ? ORDER BY provider_slug`, [tenantId])
    : all(db, `SELECT * FROM feed_schedules ORDER BY tenant_id, provider_slug`);
}

export function setFeedScheduleEnabled(
  db: AppDb,
  input: {
    tenantId: string;
    providerSlug: string;
    enabled: boolean;
    updatedAt: string;
  },
): boolean {
  const changed = db.raw.prepare(
    `UPDATE feed_schedules
     SET enabled = ?, updated_at = ?
     WHERE tenant_id = ? AND provider_slug = ? AND enabled <> ?`,
  ).run(
    input.enabled ? 1 : 0,
    input.updatedAt,
    input.tenantId,
    input.providerSlug,
    input.enabled ? 1 : 0,
  );
  return Number(changed.changes) === 1;
}

export function listFeedScheduleWindows(
  db: AppDb,
  scheduleId: string,
): FeedScheduleWindowRow[] {
  return all(
    db,
    `SELECT * FROM feed_schedule_windows WHERE schedule_id = ? ORDER BY window_started_at`,
    [scheduleId],
  );
}

export function claimFeedScheduleWindow(
  db: AppDb,
  input: {
    id: string;
    scheduleId: string;
    windowStartedAt: string;
    windowEndsAt: string;
    attemptedAt: string;
    leaseDurationMs?: number;
  },
): boolean {
  return claimFeedScheduleWindowLease(db, input) !== null;
}

export type FeedScheduleWindowClaim = Readonly<{
  leaseGeneration: number;
  leaseExpiresAt: string;
}>;

export function claimFeedScheduleWindowLease(
  db: AppDb,
  input: {
    id: string;
    scheduleId: string;
    windowStartedAt: string;
    windowEndsAt: string;
    attemptedAt: string;
    leaseDurationMs?: number;
  },
): FeedScheduleWindowClaim | null {
  const attemptedAtMs = Date.parse(input.attemptedAt);
  const windowEndsAtMs = Date.parse(input.windowEndsAt);
  const leaseDurationMs = input.leaseDurationMs ?? windowEndsAtMs - attemptedAtMs;
  if (!Number.isFinite(attemptedAtMs) || !Number.isFinite(windowEndsAtMs)) {
    throw new Error("feed_schedule_claim_time_invalid");
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error("feed_schedule_claim_lease_invalid");
  }
  const leaseExpiresAt = new Date(attemptedAtMs + leaseDurationMs).toISOString();
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db.raw
      .prepare(
        `INSERT INTO feed_schedule_windows
         (id, schedule_id, window_started_at, window_ends_at, status, attempted_at,
          lease_expires_at, lease_generation)
         VALUES (?, ?, ?, ?, 'running', ?, ?, 1)
         ON CONFLICT (schedule_id, window_started_at) DO NOTHING`,
      )
      .run(
        input.id,
        input.scheduleId,
        input.windowStartedAt,
        input.windowEndsAt,
        input.attemptedAt,
        leaseExpiresAt,
      );
    let claimed = Number(inserted.changes) === 1;
    if (!claimed) {
      const reclaimed = db.raw.prepare(
        `UPDATE feed_schedule_windows
         SET attempted_at = ?, lease_expires_at = ?, lease_generation = lease_generation + 1,
             error = NULL, completed_at = NULL
         WHERE schedule_id = ? AND window_started_at = ? AND status = 'running'
           AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      ).run(
        input.attemptedAt,
        leaseExpiresAt,
        input.scheduleId,
        input.windowStartedAt,
        input.attemptedAt,
      );
      claimed = Number(reclaimed.changes) === 1;
    }
    if (claimed) {
      db.raw
        .prepare(`UPDATE feed_schedules SET last_attempt_at = ?, updated_at = ? WHERE id = ?`)
        .run(input.attemptedAt, input.attemptedAt, input.scheduleId);
    }
    const claimAuthority = claimed
      ? get<Pick<FeedScheduleWindowRow, "lease_generation" | "lease_expires_at">>(
          db,
          `SELECT lease_generation, lease_expires_at FROM feed_schedule_windows
           WHERE schedule_id = ? AND window_started_at = ?`,
          [input.scheduleId, input.windowStartedAt],
        )
      : undefined;
    if (claimed && !claimAuthority?.lease_expires_at) {
      throw new Error("feed_schedule_claim_authority_missing");
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
    return claimAuthority?.lease_expires_at
      ? Object.freeze({
          leaseGeneration: claimAuthority.lease_generation,
          leaseExpiresAt: claimAuthority.lease_expires_at,
        })
      : null;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function completeFeedScheduleWindow(
  db: AppDb,
  input: {
    scheduleId: string;
    windowStartedAt: string;
    succeeded: boolean;
    completedAt: string;
    error?: string | null;
    leaseGeneration?: number;
    releaseSucceeded?: boolean;
  },
): boolean {
  const leaseGeneration = input.leaseGeneration ?? 1;
  if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
    throw new Error("feed_schedule_completion_generation_invalid");
  }
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.raw
      .prepare(
        `UPDATE feed_schedule_windows
         SET status = ?, error = ?, completed_at = ?
         WHERE schedule_id = ? AND window_started_at = ? AND status = 'running'
           AND lease_generation = ? AND attempted_at <= ? AND lease_expires_at > ?`,
      )
      .run(
        input.succeeded ? "succeeded" : "failed",
        input.succeeded ? null : input.error ?? "feed_schedule_failed",
        input.completedAt,
        input.scheduleId,
        input.windowStartedAt,
        leaseGeneration,
        input.completedAt,
        input.completedAt,
      );
    if (Number(updated.changes) !== 1) {
      if (ownsTransaction) db.raw.exec("COMMIT");
      return false;
    }
    if (input.succeeded) {
      db.raw
        .prepare(
          `UPDATE feed_schedules
           SET last_success_at = ?, consecutive_failures = 0, alert_state = 'healthy',
               release_last_success_at = CASE WHEN ? THEN ? ELSE release_last_success_at END,
               last_error = NULL, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.completedAt,
          input.releaseSucceeded === true ? 1 : 0,
          input.completedAt,
          input.completedAt,
          input.scheduleId,
        );
    } else {
      db.raw
        .prepare(
          `UPDATE feed_schedules
           SET consecutive_failures = consecutive_failures + 1, alert_state = 'failed',
               release_last_success_at = CASE WHEN ? THEN ? ELSE release_last_success_at END,
               last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.releaseSucceeded === true ? 1 : 0,
          input.completedAt,
          input.error ?? "feed_schedule_failed",
          input.completedAt,
          input.scheduleId,
        );
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
    return true;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function getFeedScheduleHealth(db: AppDb, at: string, tenantId?: string) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("feed_schedule_health_time_invalid");
  const schedules = listFeedSchedules(db, tenantId);
  for (const schedule of schedules) {
    if (!schedule.enabled || schedule.alert_state === "failed") continue;
    const baseline = Date.parse(schedule.last_success_at ?? schedule.created_at);
    const nextState = atMs - baseline > schedule.stale_after_ms ? "stale" : "healthy";
    if (schedule.alert_state !== nextState) {
      db.raw
        .prepare(`UPDATE feed_schedules SET alert_state = ?, updated_at = ? WHERE id = ?`)
        .run(nextState, at, schedule.id);
      schedule.alert_state = nextState;
      schedule.updated_at = at;
    }
  }
  const active = schedules.filter((schedule) => schedule.enabled === 1);
  const counts = {
    healthy: active.filter((schedule) => schedule.alert_state === "healthy").length,
    stale: active.filter((schedule) => schedule.alert_state === "stale").length,
    failed: active.filter((schedule) => schedule.alert_state === "failed").length,
  };
  return {
    ok: counts.stale === 0 && counts.failed === 0,
    status: counts.stale === 0 && counts.failed === 0 ? "healthy" as const : "degraded" as const,
    checkedAt: at,
    counts,
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      tenantId: schedule.tenant_id,
      providerSlug: schedule.provider_slug,
      intervalMs: schedule.interval_ms,
      staleAfterMs: schedule.stale_after_ms,
      enabled: schedule.enabled === 1,
      alertState: schedule.alert_state,
      lastAttemptAt: schedule.last_attempt_at,
      lastSuccessAt: schedule.last_success_at,
      releaseLastSuccessAt: schedule.release_last_success_at,
      consecutiveFailures: schedule.consecutive_failures,
      lastError: schedule.last_error,
      updatedAt: schedule.updated_at,
    })),
  };
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
    tenantId: r.tenant_id,
    providerSlug: r.provider_slug,
    openapiUrl: r.openapi_url,
    contentHash: r.content_hash,
    versionLabel: r.version_label,
    status: r.status,
    error: r.error,
    versionId: r.version_id,
    pipelineChangeId: r.pipeline_change_id,
    polledAt: r.polled_at,
    validation: r.validation_evidence_id
      ? {
          id: r.validation_evidence_id,
          source: r.validation_source,
          format: r.validation_format,
          formatStatus: r.validation_format_status,
          schemaVersion: r.validation_schema_version,
          schemaStatus: r.validation_schema_status,
          sizeBytes: r.validation_size_bytes,
          contentSha256: r.validation_content_sha256,
          status: r.validation_status,
          error: r.validation_error,
          httpStatus: r.validation_http_status,
          observedAt: r.validation_observed_at,
        }
      : null,
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
  tenant_id: string;
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
  lease_owner: string | null;
  lease_expires_at: string | null;
  available_at: string | null;
  lease_generation: number;
  error_code: string | null;
  last_error_at: string | null;
  dead_at: string | null;
  cancelled_at: string | null;
};

export type JobLeaseFence = {
  workerId: string;
  leaseGeneration: number;
};

export type JobFailureOptions = Partial<JobLeaseFence> & {
  errorCode?: string;
  retryable?: boolean;
  /** Keep reconciliation work pending when an external write may have succeeded. */
  retryPastMaxAttempts?: boolean;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type JobFailureResult = {
  applied: boolean;
  status: "pending" | "dead_letter" | string;
  availableAt: string | null;
  deadAt: string | null;
};

export type JobRecoverySummary = {
  tenantId: string;
  pending: number;
  due: number;
  scheduled: number;
  running: number;
  expiredLeases: number;
  done: number;
  recovered: number;
  simulated: number;
  deadLetter: number;
  cancelled: number;
  oldestPendingAt: string | null;
};

function boundedDelayMs(attempts: number, baseMs = 1_000, maxMs = 300_000): number {
  const base = Math.max(1_000, Math.min(baseMs, 86_400_000));
  const ceiling = Math.max(base, Math.min(maxMs, 86_400_000));
  const exponent = Math.max(0, Math.min(attempts - 1, 16));
  return Math.min(ceiling, base * 2 ** exponent);
}

function normalizeJobErrorCode(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "job_failed";
}

export function enqueueJob(
  db: AppDb,
  row: {
    id: string;
    tenantId: string;
    type: string;
    payload: unknown;
    maxAttempts?: number;
    createdAt: string;
    availableAt?: string;
  },
) {
  if (typeof row.tenantId !== "string" || row.tenantId.trim() === "") {
    throw new Error("tenant_id_required");
  }
  run(
    db,
    `INSERT INTO jobs
     (id, tenant_id, type, payload_json, status, attempts, max_attempts, created_at,
      available_at, lease_generation)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, 0)`,
    [
      row.id,
      row.tenantId,
      row.type,
      JSON.stringify(row.payload),
      row.maxAttempts ?? 3,
      row.createdAt,
      row.availableAt ?? row.createdAt,
    ],
  );
}

export function recoverExpiredJobs(
  db: AppDb,
  now = new Date().toISOString(),
  tenantId?: string,
): number {
  assertTenantScope(tenantId);
  settleExpiredWardenModelReservations(db, now, tenantId);
  const adaptiveSideEffectMayExist = `(
    jobs.type = 'transformer.adaptive.deliver' AND EXISTS (
      SELECT 1 FROM regauge_adaptive_deliveries delivery
      WHERE delivery.job_id = jobs.id
        AND delivery.tenant_id = jobs.tenant_id
        AND delivery.status = 'delivery_pending'
        AND delivery.intent_digest IS NOT NULL
    )
  )`;
  const wardenSideEffectMayExist = `(
    jobs.type = 'warden.candidate.deliver' AND EXISTS (
      SELECT 1 FROM fettler_candidate_deliveries delivery
      WHERE delivery.job_id = jobs.id
        AND delivery.tenant_id = jobs.tenant_id
        AND delivery.status = 'delivery_pending'
        AND delivery.intent_digest IS NOT NULL
    )
  )`;
  const externalSideEffectMayExist = `(${adaptiveSideEffectMayExist} OR ${wardenSideEffectMayExist})`;
  const shouldRetry = `(attempts < max_attempts OR ${externalSideEffectMayExist})`;
  const result = db.raw
    .prepare(
      `UPDATE jobs
       SET status = CASE WHEN ${shouldRetry} THEN 'pending' ELSE 'dead_letter' END,
           error = CASE
             WHEN attempts < max_attempts THEN 'lease_expired'
             WHEN ${externalSideEffectMayExist}
               THEN 'lease_expired_external_side_effect_uncertain'
             ELSE 'lease_expired_max_attempts'
           END,
           error_code = CASE
             WHEN attempts < max_attempts THEN 'lease_expired'
             WHEN ${externalSideEffectMayExist}
               THEN 'lease_expired_external_side_effect_uncertain'
             ELSE 'lease_expired_max_attempts'
           END,
           last_error_at = ?,
           available_at = CASE WHEN ${shouldRetry} THEN ? ELSE NULL END,
           finished_at = CASE WHEN ${shouldRetry} THEN NULL ELSE ? END,
           dead_at = CASE WHEN ${shouldRetry} THEN NULL ELSE ? END,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE status = 'running'
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
         ${tenantId ? "AND tenant_id = ?" : ""}`,
    )
    .run(...(tenantId ? [now, now, now, now, now, tenantId] : [now, now, now, now, now]));
  return Number(result.changes);
}

export function claimNextJob(
  db: AppDb,
  types?: string[],
  opts?: {
    tenantId?: string;
    workerId?: string;
    leaseMs?: number;
    now?: string;
    maxRunningPerTenant?: number;
  },
): JobRow | undefined {
  assertTenantScope(opts?.tenantId);
  const typeFilter = types?.length
    ? `AND type IN (${types.map(() => "?").join(",")})`
    : "";
  const tenantFilter = opts?.tenantId ? "AND tenant_id = ?" : "";
  const attributableTenantFilter =
    "AND tenant_id IS NOT NULL AND trim(tenant_id) <> ''";
  const tenantCapacityFilter = opts?.maxRunningPerTenant
    ? `AND (
         SELECT COUNT(*) FROM jobs running
         WHERE running.tenant_id = jobs.tenant_id AND running.status = 'running'
       ) < ?`
    : "";
  const now = opts?.now ?? new Date().toISOString();
  const workerId =
    opts?.workerId ?? `worker:${process.pid}:${randomBytes(8).toString("hex")}`;
  const leaseExpiresAt = new Date(
    Date.parse(now) + Math.max(1_000, opts?.leaseMs ?? 60_000),
  ).toISOString();
  const params: SQLInputValue[] = [
    ...(types?.length ? types : []),
    ...(opts?.tenantId ? [opts.tenantId] : []),
    now,
    ...(opts?.maxRunningPerTenant ? [opts.maxRunningPerTenant] : []),
  ];

  db.raw.exec("BEGIN IMMEDIATE");
  try {
    recoverExpiredJobs(db, now, opts?.tenantId);
    const job = get<JobRow>(
      db,
      `SELECT * FROM jobs
       WHERE status = 'pending' ${typeFilter} ${tenantFilter} ${attributableTenantFilter}
         AND cancelled_at IS NULL
         AND (available_at IS NULL OR available_at <= ?)
         ${tenantCapacityFilter}
       ORDER BY available_at, created_at, id LIMIT 1`,
      params,
    );
    if (!job) {
      db.raw.exec("COMMIT");
      return undefined;
    }
    const claimed = db.raw
      .prepare(
        `UPDATE jobs
         SET status = 'running',
             attempts = attempts + 1,
             started_at = ?,
             finished_at = NULL,
             lease_owner = ?,
             lease_expires_at = ?,
             lease_generation = lease_generation + 1
         WHERE id = ? AND status = 'pending'`,
      )
      .run(now, workerId, leaseExpiresAt, job.id);
    if (Number(claimed.changes) !== 1) {
      db.raw.exec("ROLLBACK");
      return undefined;
    }
    const out = get<JobRow>(db, `SELECT * FROM jobs WHERE id = ?`, [job.id]);
    db.raw.exec("COMMIT");
    return out;
  } catch (error) {
    db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function completeJob(
  db: AppDb,
  id: string,
  result: unknown,
  finishedAt: string,
  fence?: JobLeaseFence,
): boolean {
  const completed = db.raw
    .prepare(
      `UPDATE jobs
       SET status = 'done', result_json = ?, finished_at = ?, error = NULL,
           error_code = NULL, available_at = NULL,
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = ? AND status = 'running'
         ${fence ? "AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?" : ""}`,
    )
    .run(
      JSON.stringify(result),
      finishedAt,
      id,
      ...(fence ? [fence.workerId, fence.leaseGeneration, finishedAt] : []),
    );
  return Number(completed.changes) === 1;
}

export function renewJobLease(
  db: AppDb,
  id: string,
  opts: JobLeaseFence & { now?: string; leaseMs?: number },
): boolean {
  const now = opts.now ?? new Date().toISOString();
  const leaseMs = Math.max(1_000, Math.min(opts.leaseMs ?? 60_000, 86_400_000));
  const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
  const renewed = db.raw
    .prepare(
      `UPDATE jobs
       SET lease_expires_at = ?
       WHERE id = ?
         AND status = 'running'
         AND lease_owner = ?
         AND lease_generation = ?
         AND lease_expires_at > ?`,
    )
    .run(leaseExpiresAt, id, opts.workerId, opts.leaseGeneration, now);
  return Number(renewed.changes) === 1;
}

export function failJob(
  db: AppDb,
  id: string,
  error: string,
  finishedAt: string,
  opts: JobFailureOptions = {},
): JobFailureResult {
  const hasWorkerId = opts.workerId !== undefined;
  const hasLeaseGeneration = opts.leaseGeneration !== undefined;
  if (hasWorkerId !== hasLeaseGeneration) {
    throw new Error("Job failure fencing requires workerId and leaseGeneration");
  }
  const job = get<JobRow>(db, `SELECT * FROM jobs WHERE id = ?`, [id]);
  if (!job) {
    return { applied: false, status: "missing", availableAt: null, deadAt: null };
  }
  const retry =
    opts.retryable !== false &&
    (opts.retryPastMaxAttempts === true || job.attempts < job.max_attempts);
  const delayMs = retry
    ? boundedDelayMs(job.attempts, opts.baseDelayMs, opts.maxDelayMs)
    : 0;
  const availableAt = retry
    ? new Date(Date.parse(finishedAt) + delayMs).toISOString()
    : null;
  const status = retry ? "pending" : "dead_letter";
  const errorCode = normalizeJobErrorCode(opts.errorCode);
  const failed = db.raw
    .prepare(
      `UPDATE jobs
       SET status = ?,
           error = ?,
           error_code = ?,
           last_error_at = ?,
           available_at = ?,
           finished_at = ?,
           dead_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ? AND status = 'running'
         ${
           hasWorkerId && hasLeaseGeneration
             ? "AND lease_owner = ? AND lease_generation = ? AND lease_expires_at > ?"
             : ""
         }`,
    )
    .run(
      status,
      error,
      errorCode,
      finishedAt,
      availableAt,
      retry ? null : finishedAt,
      retry ? null : finishedAt,
      id,
      ...(hasWorkerId && hasLeaseGeneration
        ? [opts.workerId!, opts.leaseGeneration!, finishedAt]
        : []),
    );
  const applied = Number(failed.changes) === 1;
  return {
    applied,
    status: applied ? status : job.status,
    availableAt: applied ? availableAt : job.available_at,
    deadAt: applied && !retry ? finishedAt : job.dead_at,
  };
}

export function retryJob(
  db: AppDb,
  id: string,
  opts: {
    tenantId?: string;
    now?: string;
    resetAttempts?: boolean;
    // For agent.run jobs, `result_json` holds the Warden checkpoint head (see
    // apps/worker warden-checkpoint-journal); a re-run resumes from it instead of
    // restarting from zero. Retry therefore preserves it by default. Pass
    // `discardCheckpoint: true` to explicitly throw the resumable progress away.
    discardCheckpoint?: boolean;
  } = {},
): boolean {
  assertTenantScope(opts.tenantId);
  const now = opts.now ?? new Date().toISOString();
  const retried = db.raw
    .prepare(
      `UPDATE jobs
       SET status = 'pending',
           attempts = CASE WHEN ? THEN 0 ELSE attempts END,
           error = NULL,
           result_json = CASE WHEN ? THEN NULL ELSE result_json END,
           error_code = NULL,
           last_error_at = NULL,
           available_at = ?,
           started_at = NULL,
           finished_at = NULL,
           dead_at = NULL,
           cancelled_at = NULL,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ?
         AND status IN ('dead_letter', 'failed', 'cancelled')
         ${opts.tenantId ? "AND tenant_id = ?" : ""}`,
    )
    .run(
      opts.resetAttempts === false ? 0 : 1,
      opts.discardCheckpoint === true ? 1 : 0,
      now,
      id,
      ...(opts.tenantId ? [opts.tenantId] : []),
    );
  return Number(retried.changes) === 1;
}

export function cancelJob(
  db: AppDb,
  id: string,
  cancelledAt: string,
  opts: { tenantId?: string; reason?: string } = {},
): boolean {
  assertTenantScope(opts.tenantId);
  const cancelled = db.raw
    .prepare(
      `UPDATE jobs
       SET status = 'cancelled',
           error = CASE WHEN status = 'pending' THEN ? ELSE error END,
           error_code = CASE WHEN status = 'pending' THEN 'job_cancelled' ELSE error_code END,
           last_error_at = CASE WHEN status = 'pending' THEN ? ELSE last_error_at END,
           available_at = NULL,
           finished_at = CASE WHEN status = 'pending' THEN ? ELSE finished_at END,
           dead_at = CASE WHEN status = 'pending' THEN NULL ELSE dead_at END,
           cancelled_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL
       WHERE id = ?
          AND status IN ('pending', 'dead_letter', 'failed')
         ${opts.tenantId ? "AND tenant_id = ?" : ""}`,
    )
    .run(
      opts.reason?.slice(0, 500) ?? "cancelled",
      cancelledAt,
      cancelledAt,
      cancelledAt,
      id,
      ...(opts.tenantId ? [opts.tenantId] : []),
    );
  return Number(cancelled.changes) === 1;
}

export function listJobs(db: AppDb, limit = 50, tenantId?: string): JobRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM jobs
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  );
}

export function getJob(db: AppDb, id: string, tenantId?: string): JobRow | undefined {
  assertTenantScope(tenantId);
  return get<JobRow>(
    db,
    `SELECT * FROM jobs WHERE id = ? ${tenantId ? "AND tenant_id = ?" : ""}`,
    tenantId ? [id, tenantId] : [id],
  );
}

export function getJobRecoverySummary(
  db: AppDb,
  tenantId?: string,
  now = new Date().toISOString(),
): JobRecoverySummary {
  assertTenantScope(tenantId);
  const row = get<{
    pending: number;
    due: number;
    scheduled: number;
    running: number;
    expired_leases: number;
    done: number;
    recovered: number;
    simulated: number;
    dead_letter: number;
    cancelled: number;
    oldest_pending_at: string | null;
  }>(
    db,
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'pending' AND (available_at IS NULL OR available_at <= ?) THEN 1 ELSE 0 END) AS due,
       SUM(CASE WHEN status = 'pending' AND available_at > ? THEN 1 ELSE 0 END) AS scheduled,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       SUM(CASE WHEN status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ? THEN 1 ELSE 0 END) AS expired_leases,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
       SUM(CASE
         WHEN status = 'done'
          AND type IN ('agent.run', 'repair.run')
          AND COALESCE(json_extract(result_json, '$.ok'), 0) = 1
          AND COALESCE(json_extract(result_json, '$.simulated'), 0) = 0
          AND (
            (type = 'agent.run' AND COALESCE(json_array_length(json_extract(result_json, '$.filesChanged')), 0) > 0)
            OR
            (type = 'repair.run' AND COALESCE(json_extract(result_json, '$.edits'), 0) > 0)
          )
         THEN 1 ELSE 0 END) AS recovered,
       SUM(CASE
         WHEN status = 'done'
          AND COALESCE(json_extract(result_json, '$.simulated'), 0) = 1
         THEN 1 ELSE 0 END) AS simulated,
       SUM(CASE WHEN status IN ('dead_letter', 'failed') THEN 1 ELSE 0 END) AS dead_letter,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
       MIN(CASE WHEN status = 'pending' THEN created_at END) AS oldest_pending_at
     FROM jobs
     ${tenantId ? "WHERE tenant_id = ?" : ""}`,
    tenantId ? [now, now, now, tenantId] : [now, now, now],
  );
  return {
    tenantId: tenantId ?? "*",
    pending: Number(row?.pending ?? 0),
    due: Number(row?.due ?? 0),
    scheduled: Number(row?.scheduled ?? 0),
    running: Number(row?.running ?? 0),
    expiredLeases: Number(row?.expired_leases ?? 0),
    done: Number(row?.done ?? 0),
    recovered: Number(row?.recovered ?? 0),
    simulated: Number(row?.simulated ?? 0),
    deadLetter: Number(row?.dead_letter ?? 0),
    cancelled: Number(row?.cancelled ?? 0),
    oldestPendingAt: row?.oldest_pending_at ?? null,
  };
}

export function jobToApi(job: JobRow) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.max_attempts,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    availableAt: job.available_at,
    leaseExpiresAt: job.lease_expires_at,
    errorCode: job.error_code ?? (job.error ? "job_failed" : null),
    lastErrorAt: job.last_error_at,
    deadAt: job.dead_at,
    cancelledAt: job.cancelled_at,
  };
}

export function exportAuditJson(db: AppDb, limit = 5000, tenantId?: string) {
  assertTenantScope(tenantId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20_000) {
    throw new Error("audit_export_limit_invalid");
  }
  const rows = all(
    db,
    `SELECT * FROM audit_events
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  );
  return {
    exportedAt: new Date().toISOString(),
    count: rows.length,
    events: rows,
  };
}

export function exportAuditCsv(db: AppDb, limit = 5000, tenantId?: string): string {
  assertTenantScope(tenantId);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20_000) {
    throw new Error("audit_export_limit_invalid");
  }
  const rows = all(
    db,
    `SELECT id, tenant_id, actor, principal_id, api_key_id, request_id,
            action, resource_type, resource_id, created_at
     FROM audit_events
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  ) as Array<{
    id: string;
    tenant_id: string;
    actor: string;
    principal_id: string | null;
    api_key_id: string | null;
    request_id: string | null;
    action: string;
    resource_type: string;
    resource_id: string | null;
    created_at: string;
  }>;
  const header =
    "id,tenant_id,actor,principal_id,api_key_id,request_id,action,resource_type,resource_id,created_at";
  const lines = rows.map((r) =>
    [
      r.id,
      r.tenant_id,
      r.actor,
      r.principal_id ?? "",
      r.api_key_id ?? "",
      r.request_id ?? "",
      r.action,
      r.resource_type,
      r.resource_id ?? "",
      r.created_at,
    ]
      .map((c) => {
        const text = String(c);
        const formulaSafe = /^(?:[=+\-@\t\r\n]| +[=+\-@])/.test(text)
          ? `'${text}`
          : text;
        return `"${formulaSafe.replace(/"/g, '""')}"`;
      })
      .join(","),
  );
  return [header, ...lines].join("\n");
}

export type RepairSessionRow = {
  id: string;
  tenant_id: string;
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
    tenantId: string;
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
     (id, tenant_id, consumer_id, repo_path, status, attempts, edits_count, ok, report_md, result_json, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tenant_id = excluded.tenant_id,
       consumer_id = excluded.consumer_id,
       repo_path = excluded.repo_path,
       status = excluded.status,
       attempts = excluded.attempts,
       edits_count = excluded.edits_count,
       ok = excluded.ok,
       report_md = excluded.report_md,
       result_json = excluded.result_json,
       finished_at = excluded.finished_at
     WHERE repair_sessions.tenant_id = excluded.tenant_id`,
    [
      row.id,
      row.tenantId,
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

export function listRepairSessions(
  db: AppDb,
  limit = 30,
  tenantId?: string,
): RepairSessionRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM repair_sessions
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  );
}

export function getRepairSession(
  db: AppDb,
  id: string,
  tenantId?: string,
): RepairSessionRow | undefined {
  assertTenantScope(tenantId);
  return get(
    db,
    `SELECT * FROM repair_sessions
     WHERE id = ? ${tenantId ? "AND tenant_id = ?" : ""}`,
    tenantId ? [id, tenantId] : [id],
  );
}

export function repairSessionToApi(r: RepairSessionRow) {
  const rawResult = r.result_json
    ? (JSON.parse(r.result_json) as Record<string, unknown>)
    : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    consumerId: r.consumer_id,
    status: r.status,
    attempts: r.attempts,
    editsCount: r.edits_count,
    ok: Boolean(r.ok),
    reportMd: r.report_md,
    result: rawResult
      ? {
          jobId: typeof rawResult.jobId === "string" ? rawResult.jobId : null,
          stopReason:
            typeof rawResult.stopReason === "string" ? rawResult.stopReason : null,
          simulated: rawResult.simulated === true,
          planCount: Array.isArray(rawResult.plans) ? rawResult.plans.length : 0,
          failureCount: Array.isArray(rawResult.failureFingerprints)
            ? rawResult.failureFingerprints.length
            : 0,
          actionCount: Array.isArray(rawResult.actionFingerprints)
            ? rawResult.actionFingerprints.length
            : 0,
        }
      : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export type AgentRunRow = {
  id: string;
  tenant_id: string;
  job_id: string | null;
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
    tenantId: string;
    jobId?: string | null;
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
  const written = db.raw.prepare(
    `INSERT INTO agent_runs
     (id, tenant_id, job_id, goal, repo_path, status, ok, steps, files_changed_json, report_md, result_json, created_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       job_id = excluded.job_id,
       status = excluded.status,
       ok = excluded.ok,
       steps = excluded.steps,
       files_changed_json = excluded.files_changed_json,
       report_md = excluded.report_md,
       result_json = excluded.result_json,
       finished_at = excluded.finished_at
     WHERE agent_runs.tenant_id = excluded.tenant_id
       AND (
         (agent_runs.job_id IS NULL AND excluded.job_id IS NULL) OR
         agent_runs.job_id = excluded.job_id
       )`,
  ).run(
      row.id,
      row.tenantId,
      row.jobId ?? null,
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
  );
  if (Number(written.changes) !== 1) throw new Error("agent_run_tenant_conflict");
}

export function getAgentRunByJobId(
  db: AppDb,
  jobId: string,
  tenantId: string,
): AgentRunRow | undefined {
  return get(
    db,
    `SELECT * FROM agent_runs WHERE job_id = ? AND tenant_id = ?`,
    [jobId, tenantId],
  );
}

export function listAgentRuns(
  db: AppDb,
  limit = 30,
  tenantId?: string,
): AgentRunRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM agent_runs
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY created_at DESC LIMIT ?`,
    tenantId ? [tenantId, limit] : [limit],
  );
}

export function getAgentRun(
  db: AppDb,
  id: string,
  tenantId?: string,
): AgentRunRow | undefined {
  assertTenantScope(tenantId);
  return get(
    db,
    `SELECT * FROM agent_runs
     WHERE id = ? ${tenantId ? "AND tenant_id = ?" : ""}`,
    tenantId ? [id, tenantId] : [id],
  );
}

export function agentRunToApi(r: AgentRunRow) {
  const rawResult = r.result_json
    ? (JSON.parse(r.result_json) as Record<string, unknown>)
    : null;
  const rawVerifier =
    rawResult?.verifier && typeof rawResult.verifier === "object"
      ? (rawResult.verifier as Record<string, unknown>)
      : null;
  const rawRollback =
    rawResult?.rollback && typeof rawResult.rollback === "object"
      ? (rawResult.rollback as Record<string, unknown>)
      : null;
  const rawSource =
    rawResult?.source && typeof rawResult.source === "object"
      ? (rawResult.source as Record<string, unknown>)
      : null;
  const rawArtifacts =
    rawResult?.artifacts && typeof rawResult.artifacts === "object"
      ? (rawResult.artifacts as Record<string, unknown>)
      : null;
  const rawRetention =
    rawResult?.retention && typeof rawResult.retention === "object"
      ? (rawResult.retention as Record<string, unknown>)
      : null;
  const rawAgent =
    rawResult?.agent && typeof rawResult.agent === "object"
      ? (rawResult.agent as Record<string, unknown>)
      : null;
  const rawReview =
    rawResult?.review && typeof rawResult.review === "object"
      ? (rawResult.review as Record<string, unknown>)
      : null;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    goal: r.goal,
    status: r.status,
    ok: Boolean(r.ok),
    steps: r.steps,
    filesChanged: r.files_changed_json ? JSON.parse(r.files_changed_json) : [],
    reportMd: r.report_md,
    result: rawResult
      ? {
          jobId: typeof rawResult.jobId === "string" ? rawResult.jobId : null,
          stoppedReason:
            typeof rawResult.stoppedReason === "string"
              ? rawResult.stoppedReason
              : null,
          product:
            typeof rawResult.product === "string" ? rawResult.product : null,
          verifier: rawVerifier
            ? {
                command:
                  typeof rawVerifier.command === "string"
                    ? rawVerifier.command
                    : null,
                source:
                  typeof rawVerifier.source === "string" ? rawVerifier.source : null,
                status:
                  typeof rawVerifier.status === "string" ? rawVerifier.status : null,
              }
            : null,
          rollback: rawRollback
            ? {
                performed: rawRollback.performed === true,
                restoredCount: Array.isArray(rawRollback.restoredFiles)
                  ? rawRollback.restoredFiles.length
                  : 0,
                failedCount: Array.isArray(rawRollback.failedFiles)
                  ? rawRollback.failedFiles.length
                  : 0,
              }
            : null,
          candidate:
            rawResult.attemptStatus === "succeeded" || rawResult.attemptStatus === "rejected"
              ? {
                  attemptStatus: rawResult.attemptStatus,
                  code: typeof rawResult.code === "string" ? rawResult.code : null,
                  summary: typeof rawResult.summary === "string" ? rawResult.summary : null,
                  changedPaths: Array.isArray(rawResult.changedPaths)
                    ? rawResult.changedPaths.filter((path): path is string => typeof path === "string")
                    : [],
                  source: rawSource
                    ? {
                        repositoryId: typeof rawSource.repositoryId === "string" ? rawSource.repositoryId : null,
                        snapshotId: typeof rawSource.snapshotId === "string" ? rawSource.snapshotId : null,
                        revision: typeof rawSource.revision === "string" ? rawSource.revision : null,
                        manifestSha256: typeof rawSource.manifestSha256 === "string"
                          ? rawSource.manifestSha256
                          : null,
                      }
                    : null,
                  sourceDigest: typeof rawArtifacts?.sourceDigest === "string"
                    ? rawArtifacts.sourceDigest
                    : null,
                  candidateDigest: typeof rawArtifacts?.candidateDigest === "string"
                    ? rawArtifacts.candidateDigest
                    : null,
                  expiresAt: typeof rawRetention?.expiresAt === "string"
                    ? rawRetention.expiresAt
                    : null,
                  grounding: rawAgent
                    ? {
                        modelCalls: typeof rawAgent.modelCalls === "number" ? rawAgent.modelCalls : 0,
                        groundedMutations: typeof rawAgent.groundedMutations === "number"
                          ? rawAgent.groundedMutations
                          : 0,
                        blockedMutations: typeof rawAgent.blockedMutations === "number"
                          ? rawAgent.blockedMutations
                          : 0,
                      }
                    : null,
                }
              : null,
          review: rawReview
            ? {
                decision: typeof rawReview.decision === "string" ? rawReview.decision : null,
                rationale: typeof rawReview.rationale === "string" ? rawReview.rationale : null,
                reviewedAt: typeof rawReview.reviewedAt === "string" ? rawReview.reviewedAt : null,
                reviewerPrincipalId: typeof rawReview.reviewerPrincipalId === "string"
                  ? rawReview.reviewerPrincipalId
                  : null,
                supersedingRunId: typeof rawReview.supersedingRunId === "string"
                  ? rawReview.supersedingRunId
                  : null,
              }
            : null,
          lineage: {
            supersedesRunId: typeof rawResult.supersedesRunId === "string"
              ? rawResult.supersedesRunId
              : null,
            supersededByRunId: typeof rawResult.supersededByRunId === "string"
              ? rawResult.supersededByRunId
              : null,
          },
        }
      : null,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  };
}

export {
  listConsumersForProvider,
  listConsumersImpactedByChange,
  listTenantMonitoredProviders,
  registrySummaryMarkdown,
  type RegistryHit,
  type TenantMonitoredProvider,
} from "./registry.js";

export function computeDesignPartnerMetrics(db: AppDb, tenantId?: string) {
  assertTenantScope(tenantId);
  const base = computeProductMetrics(db, tenantId);
  const suppressed = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM suppressed_patterns
         ${tenantId ? "WHERE tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;
  const consumers = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM consumers
         ${tenantId ? "WHERE tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;
  const monitored = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM monitored_apis m
         JOIN consumers c ON c.id = m.consumer_id
         ${tenantId ? "WHERE c.tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;
  const changes = (
    db.raw
      .prepare(
        `SELECT COUNT(DISTINCT ch.id) as c
         FROM api_changes ch
         LEFT JOIN impact_findings f ON f.change_id = ch.id
         LEFT JOIN consumers c ON c.id = f.consumer_id
         ${tenantId ? "WHERE c.tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
  ).c;
  const notifications = (
    db.raw
      .prepare(
        `SELECT COUNT(*) as c FROM audit_events
         WHERE (action = 'pr.notification_only' OR action = 'pipeline.notification_only')
         ${tenantId ? "AND tenant_id = ?" : ""}`,
      )
      .get(...(tenantId ? [tenantId] : [])) as { c: number }
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
    githubDeliveryMode: c.github_delivery_mode,
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
    accountId?: string | null;
    accountLogin: string;
    accountType?: string;
    tenantId?: string | null;
    permissions?: unknown;
    repositories?: unknown;
    repositorySelection?: "selected" | "all";
    suspendedAt?: string | null;
    deletedAt?: string | null;
    createdAt: string;
    updatedAt: string;
  },
) {
  const accountId = row.accountId ?? null;
  if (accountId !== null && !/^[1-9][0-9]{0,19}$/.test(accountId)) {
    throw new Error("github_installation_account_id_invalid");
  }
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = get<GitHubInstallationRow>(
      db,
      `SELECT * FROM github_installations WHERE installation_id = ?`,
      [row.installationId],
    );
    if (existing) {
      if (existing.account_id && accountId && existing.account_id !== accountId) {
        throw new Error("github_installation_account_mismatch");
      }
      const updated = db.raw.prepare(
        `UPDATE github_installations
         SET account_id = COALESCE(account_id, ?), account_login = ?,
             account_type = ?, tenant_id = COALESCE(tenant_id, ?),
             permissions_json = ?, repositories_json = ?, repository_selection = ?,
             suspended_at = ?, deleted_at = ?, updated_at = ?
         WHERE installation_id = ?
           AND (? IS NULL OR tenant_id IS NULL OR tenant_id = ?)`,
      ).run(
        accountId,
        row.accountLogin,
        row.accountType ?? "Organization",
        row.tenantId ?? null,
        row.permissions ? JSON.stringify(row.permissions) : existing.permissions_json,
        row.repositories ? JSON.stringify(row.repositories) : existing.repositories_json,
        row.repositorySelection ?? existing.repository_selection,
        row.suspendedAt === undefined ? existing.suspended_at : row.suspendedAt,
        row.deletedAt === undefined ? existing.deleted_at : row.deletedAt,
        row.updatedAt,
        row.installationId,
        row.tenantId ?? null,
        row.tenantId ?? null,
      );
      if (Number(updated.changes) !== 1) {
        throw new Error("github_installation_tenant_mismatch");
      }
      if (ownsTransaction) db.raw.exec("COMMIT");
      return existing.id;
    }
    run(
      db,
      `INSERT INTO github_installations
       (id, installation_id, account_id, account_login, account_type, tenant_id, permissions_json,
         repositories_json, repository_selection, suspended_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.installationId,
        accountId,
        row.accountLogin,
        row.accountType ?? "Organization",
        row.tenantId ?? null,
        row.permissions ? JSON.stringify(row.permissions) : null,
        row.repositories ? JSON.stringify(row.repositories) : null,
        row.repositorySelection ?? "selected",
        row.suspendedAt ?? null,
        row.deletedAt ?? null,
        row.createdAt,
        row.updatedAt,
      ],
    );
    if (ownsTransaction) db.raw.exec("COMMIT");
    return row.id;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function listGitHubInstallations(
  db: AppDb,
  tenantId?: string,
): GitHubInstallationRow[] {
  assertTenantScope(tenantId);
  return all(
    db,
    `SELECT * FROM github_installations
     ${tenantId ? "WHERE tenant_id = ?" : ""}
     ORDER BY updated_at DESC`,
    tenantId ? [tenantId] : [],
  );
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
    accountId: r.account_id,
    accountLogin: r.account_login,
    accountType: r.account_type,
    tenantId: r.tenant_id,
    permissions: r.permissions_json ? JSON.parse(r.permissions_json) : null,
    repositories: r.repositories_json ? JSON.parse(r.repositories_json) : null,
    repositorySelection: r.repository_selection,
    suspendedAt: r.suspended_at,
    deletedAt: r.deleted_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function linkConsumersToInstallation(
  db: AppDb,
  accountLogin: string,
  installationId: string,
  repositories: Array<{ owner: string; name: string }>,
  tenantId?: string | null,
): number {
  const repositoryNames = [
    ...new Set(
      repositories
        .filter(
          (repository) =>
            repository.owner.toLowerCase() === accountLogin.toLowerCase() &&
            repository.name.trim(),
        )
        .map((repository) => repository.name.toLowerCase()),
    ),
  ];
  if (!repositoryNames.length) return 0;
  const repositoryPlaceholders = repositoryNames.map(() => "?").join(", ");
  const result = db.raw
    .prepare(
      `UPDATE consumers
       SET installation_id = ?, github_delivery_mode = 'app', tenant_id = COALESCE(tenant_id, ?)
       WHERE lower(github_owner) = lower(?)
         AND lower(github_repo) IN (${repositoryPlaceholders})
         AND (? IS NULL OR tenant_id IS NULL OR tenant_id = ?)`,
    )
    .run(
      installationId,
      tenantId ?? null,
      accountLogin,
      ...repositoryNames,
      tenantId ?? null,
      tenantId ?? null,
    );
  return Number(result.changes);
}

export function getGitHubInstallationByInstallationId(
  db: AppDb,
  installationId: string,
): GitHubInstallationRow | undefined {
  return get(
    db,
    `SELECT * FROM github_installations WHERE installation_id = ?`,
    [installationId],
  );
}

export function listTenantIdsForGitHubOwner(
  db: AppDb,
  owner: string,
): string[] {
  return all<{ tenant_id: string }>(
    db,
    `SELECT DISTINCT tenant_id
     FROM consumers
     WHERE lower(github_owner) = lower(?)
       AND tenant_id IS NOT NULL`,
    [owner],
  ).map((row) => row.tenant_id);
}

function hashInstallState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

export function createGitHubInstallState(
  db: AppDb,
  input: {
    state: string;
    tenantId: string;
    principalId: string;
    expectedAccountId?: string | null;
    createdAt: string;
    expiresAt: string;
  },
): void {
  const expectedAccountId = input.expectedAccountId ?? null;
  if (
    expectedAccountId !== null &&
    !/^[1-9][0-9]{0,19}$/.test(expectedAccountId)
  ) {
    throw new Error("github_install_state_account_id_invalid");
  }
  run(
    db,
    `INSERT INTO github_install_states
     (state_hash, tenant_id, created_by_principal_id, expected_account_id, created_at, expires_at,
      consumed_at, completed_at, completed_installation_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
    [
      hashInstallState(input.state),
      input.tenantId,
      input.principalId,
      expectedAccountId,
      input.createdAt,
      input.expiresAt,
    ],
  );
}

export function consumeGitHubInstallState(
  db: AppDb,
  state: string,
  tenantId: string,
  principalId: string,
  now: string,
): boolean {
  const result = db.raw
    .prepare(
      `UPDATE github_install_states
       SET consumed_at = ?
       WHERE state_hash = ?
         AND tenant_id = ?
         AND created_by_principal_id = ?
         AND consumed_at IS NULL
         AND expires_at > ?`,
    )
    .run(now, hashInstallState(state), tenantId, principalId, now);
  return Number(result.changes) === 1;
}

function installationRepositories(
  installation: GitHubInstallationRow,
): Array<{ id?: number; owner: string; name: string }> {
  try {
    const repositories = JSON.parse(installation.repositories_json ?? "null") as unknown;
    if (!Array.isArray(repositories)) return [];
    return repositories.filter(
      (repository): repository is { id?: number; owner: string; name: string } =>
        Boolean(
          repository &&
          typeof repository === "object" &&
          typeof repository.owner === "string" &&
          typeof repository.name === "string",
        ),
    );
  } catch {
    return [];
  }
}

function installationAuthorizesRepository(
  installation: GitHubInstallationRow,
  owner: string,
  repository: string,
): boolean {
  if (
    !installation.account_id ||
    installation.suspended_at ||
    installation.deleted_at ||
    !hasRequiredGitHubInstallPermissions(installation.permissions_json) ||
    (installation.repository_selection !== "selected" &&
      installation.repository_selection !== "all")
  ) {
    return false;
  }
  return installationRepositories(installation).some(
    (candidate) =>
      Number.isSafeInteger(candidate.id) &&
      candidate.owner.toLowerCase() === owner.toLowerCase() &&
      candidate.name.toLowerCase() === repository.toLowerCase(),
  );
}

export function findAuthorizedGitHubInstallationForRepository(
  db: AppDb,
  tenantId: string,
  owner: string,
  repository: string,
): GitHubInstallationRow | undefined {
  return listGitHubInstallations(db, tenantId).find((installation) =>
    installationAuthorizesRepository(installation, owner, repository),
  );
}

export type GitHubInstallCompletion =
  | { status: "completed" | "replayed"; installation: GitHubInstallationRow }
  | {
      status:
        | "pending"
        | "invalid"
        | "account_identity_mismatch"
        | "permissions_incomplete"
        | "repository_scope_incomplete";
    };

const REQUIRED_GITHUB_INSTALL_PERMISSIONS: Record<string, string> = {
  metadata: "read",
  contents: "write",
  pull_requests: "write",
  checks: "read",
};

function hasRequiredGitHubInstallPermissions(value: string | null): boolean {
  if (!value) return false;
  try {
    const permissions = JSON.parse(value) as Record<string, string>;
    return Object.entries(REQUIRED_GITHUB_INSTALL_PERMISSIONS).every(
      ([name, access]) => permissions[name] === access || permissions[name] === "write",
    );
  } catch {
    return false;
  }
}

/**
 * Finalize a browser install return only after a signed webhook independently
 * assigned the installation to the same tenant. The state transition, consumer
 * linking, and audit record are one idempotent transaction.
 */
export function completeGitHubInstallState(
  db: AppDb,
  input: {
    state: string;
    tenantId: string;
    principalId: string;
    installationId: string;
    setupAction: "install" | "update";
    now: string;
    requestId?: string | null;
  },
): GitHubInstallCompletion {
  const stateHash = hashInstallState(input.state);
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const state = get<GitHubInstallStateRow>(
      db,
      `SELECT * FROM github_install_states WHERE state_hash = ?`,
      [stateHash],
    );
    if (
      !state ||
      state.tenant_id !== input.tenantId ||
      state.created_by_principal_id !== input.principalId
    ) {
      db.raw.exec("ROLLBACK");
      return { status: "invalid" };
    }
    const installation = getGitHubInstallationByInstallationId(
      db,
      input.installationId,
    );
    if (state.consumed_at) {
      if (
        state.completed_installation_id === input.installationId &&
        installation?.tenant_id === input.tenantId &&
        Boolean(state.expected_account_id) &&
        installation.account_id === state.expected_account_id
      ) {
        db.raw.exec("COMMIT");
        return { status: "replayed", installation };
      }
      db.raw.exec("ROLLBACK");
      return { status: "invalid" };
    }
    if (state.expires_at <= input.now) {
      db.raw.exec("ROLLBACK");
      return { status: "invalid" };
    }
    if (!installation) {
      db.raw.exec("ROLLBACK");
      return { status: "pending" };
    }
    if (
      !installation.account_id ||
      !state.expected_account_id ||
      installation.account_id !== state.expected_account_id
    ) {
      db.raw.exec("ROLLBACK");
      return { status: "account_identity_mismatch" };
    }
    if (!installation.tenant_id || installation.tenant_id !== input.tenantId) {
      db.raw.exec("ROLLBACK");
      return { status: "pending" };
    }
    if (installation.suspended_at) {
      db.raw.exec("ROLLBACK");
      return { status: "pending" };
    }
    if (installation.deleted_at) {
      db.raw.exec("ROLLBACK");
      return { status: "pending" };
    }
    if (!hasRequiredGitHubInstallPermissions(installation.permissions_json)) {
      db.raw.exec("ROLLBACK");
      return { status: "permissions_incomplete" };
    }

    const verifiedRepositories = installationRepositories(installation)
      .filter(
          (repository) =>
            Number.isSafeInteger(repository.id) &&
            repository.owner.toLowerCase() === installation.account_login.toLowerCase(),
      );
    if (verifiedRepositories.length === 0) {
      db.raw.exec("ROLLBACK");
      return { status: "repository_scope_incomplete" };
    }
    const linked = linkConsumersToInstallation(
      db,
      installation.account_login,
      installation.installation_id,
      verifiedRepositories,
      input.tenantId,
    );
    const configured = get<{ count: number }>(
      db,
      `SELECT COUNT(*) AS count
       FROM consumers
       WHERE tenant_id = ? AND lower(github_owner) = lower(?)`,
      [input.tenantId, installation.account_login],
    );
    if (Number(configured?.count ?? 0) > 0 && linked === 0) {
      db.raw.exec("ROLLBACK");
      return { status: "repository_scope_incomplete" };
    }
    const consumed = db.raw
      .prepare(
        `UPDATE github_install_states
         SET consumed_at = ?, completed_at = ?, completed_installation_id = ?
         WHERE state_hash = ? AND consumed_at IS NULL`,
      )
      .run(
        input.now,
        input.now,
        input.installationId,
        stateHash,
      );
    if (Number(consumed.changes) !== 1) throw new Error("github_install_state_race");
    recordAudit(db, {
      id: `github_install_${stateHash}`,
      tenantId: input.tenantId,
      actor: "github_app",
      principalId: input.principalId,
      requestId: input.requestId ?? null,
      action: "installation.completed",
      resourceType: "github_installation",
      resourceId: installation.id,
      metadata: {
        installationId: installation.installation_id,
        accountLogin: installation.account_login,
        setupAction: input.setupAction,
      },
    });
    db.raw.exec("COMMIT");
    return { status: "completed", installation };
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function recordGitHubWebhookDelivery(
  db: AppDb,
  deliveryId: string,
  event: string,
  receivedAt: string,
): boolean {
  const staleBefore = new Date(Date.parse(receivedAt) - 5 * 60_000).toISOString();
  const result = db.raw
    .prepare(
      `INSERT INTO github_webhook_deliveries
         (delivery_id, event, received_at, status, updated_at, attempts, last_error)
       VALUES (?, ?, ?, 'processing', ?, 1, NULL)
       ON CONFLICT(delivery_id) DO UPDATE SET
         event = excluded.event,
         status = 'processing',
         updated_at = excluded.updated_at,
         attempts = github_webhook_deliveries.attempts + 1,
         last_error = NULL
       WHERE github_webhook_deliveries.status = 'failed'
          OR (
            github_webhook_deliveries.status = 'processing'
            AND COALESCE(github_webhook_deliveries.updated_at, github_webhook_deliveries.received_at) <= ?
          )`,
    )
    .run(deliveryId, event, receivedAt, receivedAt, staleBefore);
  return Number(result.changes) === 1;
}

export function completeGitHubWebhookDelivery(
  db: AppDb,
  deliveryId: string,
  completedAt: string,
): boolean {
  const result = db.raw
    .prepare(
      `UPDATE github_webhook_deliveries
       SET status = 'completed', updated_at = ?, last_error = NULL
       WHERE delivery_id = ? AND status = 'processing'`,
    )
    .run(completedAt, deliveryId);
  return Number(result.changes) === 1;
}

export function failGitHubWebhookDelivery(
  db: AppDb,
  deliveryId: string,
  failedAt: string,
  error: string,
): boolean {
  const result = db.raw
    .prepare(
      `UPDATE github_webhook_deliveries
       SET status = 'failed', updated_at = ?, last_error = ?
       WHERE delivery_id = ? AND status = 'processing'`,
    )
    .run(failedAt, error.slice(0, 1000), deliveryId);
  return Number(result.changes) === 1;
}

export type FettlerPrReviewOutcome =
  | "enqueued"
  | "duplicate"
  | "ignored"
  | "refused"
  | "failed";

export type FettlerPrReviewEventRow = {
  delivery_id: string;
  tenant_id: string | null;
  installation_id: string | null;
  remote_repository_id: string | null;
  pull_request_number: number | null;
  head_sha: string | null;
  action: string | null;
  outcome: FettlerPrReviewOutcome;
  reason: string | null;
  dispatch_job_id: string | null;
  created_at: string;
};

/**
 * Records how a single inbound customer pull_request webhook delivery was
 * handled. Keyed on the GitHub delivery id and written INSERT OR IGNORE so a
 * literal redelivery of the same delivery id never overwrites the first
 * verdict. Returns whether this call wrote the row (false means the delivery id
 * was already recorded). The outcome is what keeps enqueued / ignored / refused
 * / duplicate / failed distinguishable in the durable record.
 */
export function recordFettlerPrReviewEvent(
  db: AppDb,
  input: {
    deliveryId: string;
    tenantId?: string | null;
    installationId?: string | null;
    remoteRepositoryId?: string | null;
    pullRequestNumber?: number | null;
    headSha?: string | null;
    action?: string | null;
    outcome: FettlerPrReviewOutcome;
    reason?: string | null;
    dispatchJobId?: string | null;
    createdAt: string;
  },
): boolean {
  const result = db.raw
    .prepare(
      `INSERT OR IGNORE INTO fettler_pr_review_events
         (delivery_id, tenant_id, installation_id, remote_repository_id,
          pull_request_number, head_sha, action, outcome, reason, dispatch_job_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deliveryId,
      input.tenantId ?? null,
      input.installationId ?? null,
      input.remoteRepositoryId ?? null,
      input.pullRequestNumber ?? null,
      input.headSha ?? null,
      input.action ?? null,
      input.outcome,
      input.reason ?? null,
      input.dispatchJobId ?? null,
      input.createdAt,
    );
  return Number(result.changes) === 1;
}

export function getFettlerPrReviewEvent(
  db: AppDb,
  deliveryId: string,
): FettlerPrReviewEventRow | undefined {
  return get(
    db,
    `SELECT * FROM fettler_pr_review_events WHERE delivery_id = ?`,
    [deliveryId],
  );
}

/**
 * Resolves the tenant-owned connected repository for a GitHub remote repository
 * id, but only through the same non-revoked installation the webhook arrived on.
 * Never widens beyond granted access: the join to scm_connections on
 * external_account_id is what binds the repository to the installation. Returns
 * undefined when the tenant has not connected this repository through this
 * installation.
 */
export function getConnectedRepositoryIdByRemote(
  db: AppDb,
  input: { tenantId: string; remoteId: string; installationId: string },
): string | undefined {
  const row = get<{ id: string }>(
    db,
    `SELECT cr.id AS id
       FROM connected_repositories cr
       JOIN scm_connections sc ON sc.id = cr.connection_id
      WHERE cr.tenant_id = ? AND cr.remote_id = ? AND cr.status != 'revoked'
        AND sc.provider = 'github' AND sc.external_account_id = ? AND sc.revoked_at IS NULL
      LIMIT 1`,
    [input.tenantId, input.remoteId, input.installationId],
  );
  return row?.id;
}

/**
 * Resolves the consumer that monitors a tenant-owned connected repository, or
 * undefined when no consumer is wired to it. Used to bind the enqueued review
 * run to a consumer for tenant scoping and budget accounting.
 */
export function getMonitoringConsumerIdForRepository(
  db: AppDb,
  input: { tenantId: string; connectedRepositoryId: string },
): string | undefined {
  const row = get<{ id: string }>(
    db,
    `SELECT cons.id AS id
       FROM consumer_repos crp
       JOIN consumers cons ON cons.id = crp.consumer_id
      WHERE cons.tenant_id = ? AND crp.connected_repository_id = ?
      ORDER BY crp.created_at, crp.id
      LIMIT 1`,
    [input.tenantId, input.connectedRepositoryId],
  );
  return row?.id;
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
    // Coverage/basis of the analysis behind this PR, parsed for the console so a
    // reviewer can see whether an empty findings list is "complete evidence of
    // no impact" or merely "analysis was incomplete". Null when not recorded.
    coverage: parseCoverageJson(p.coverage_json),
  };
}

function parseCoverageJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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
    // FET-016 provider->code path. null (not computed) is projected as-is so the
    // console can distinguish "not computed" from a present path.
    graphPath: parseGraphPathJson(f.graph_path_json),
  };
}

/** Parse a stored GraphPath, tolerating legacy/absent/corrupt values as null. */
function parseGraphPathJson(value: string | null): GraphPath | null {
  if (!value) return null;
  try {
    const parsed = GraphPathSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function auditToApi(a: AuditEvent) {
  return {
    id: a.id,
    tenantId: a.tenant_id,
    actor: a.actor,
    principalId: a.principal_id,
    apiKeyId: a.api_key_id,
    requestId: a.request_id,
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

// --- Durable policy-routing ledger + executor circuit-breaker health ---

export type RoutingBreakerConfig = Readonly<{
  failureThreshold: number;
  openDurationMs: number;
}>;

export const DEFAULT_ROUTING_BREAKER: RoutingBreakerConfig = Object.freeze({
  failureThreshold: 3,
  openDurationMs: 30_000,
});

export type RoutingBreakerSnapshotEntry = Readonly<{
  scope: "executor" | "provider";
  executorId: string;
  providerId: string;
  consecutiveFailures: number;
  openedAt: string | null;
  open: boolean;
}>;

/** Availability boundary consumed by the policy router (structural match). */
export type RoutingAvailability = Readonly<{
  snapshot: readonly RoutingBreakerSnapshotEntry[];
  allows(executorId: string, providerId: string): boolean;
}>;

function breakerOpen(
  consecutiveFailures: number,
  openedAt: string | null,
  atMs: number,
  config: RoutingBreakerConfig,
): boolean {
  if (consecutiveFailures < config.failureThreshold || !openedAt) return false;
  const openedAtMs = Date.parse(openedAt);
  if (!Number.isFinite(openedAtMs)) return false;
  return atMs < openedAtMs + config.openDurationMs;
}

/** Snapshot of every failing executor/provider for a tenant, evaluated at `at`. */
export function loadRoutingBreakerSnapshot(
  db: AppDb,
  tenantId: string,
  at: Date = new Date(),
  config: RoutingBreakerConfig = DEFAULT_ROUTING_BREAKER,
): RoutingBreakerSnapshotEntry[] {
  const atMs = at.getTime();
  const rows = all<RoutingExecutorHealthRow>(
    db,
    `SELECT * FROM routing_executor_health WHERE tenant_id = ?`,
    [tenantId],
  );
  return rows.map((row) =>
    Object.freeze({
      scope: row.scope,
      executorId: row.executor_id,
      providerId: row.provider_id,
      consecutiveFailures: row.consecutive_failures,
      openedAt: row.opened_at,
      open: breakerOpen(row.consecutive_failures, row.opened_at, atMs, config),
    }),
  );
}

/** Build an availability boundary from a tenant's persisted breaker state. */
export function loadRoutingAvailability(
  db: AppDb,
  tenantId: string,
  at: Date = new Date(),
  config: RoutingBreakerConfig = DEFAULT_ROUTING_BREAKER,
): RoutingAvailability {
  const snapshot = loadRoutingBreakerSnapshot(db, tenantId, at, config);
  const openExecutors = new Set(
    snapshot
      .filter((entry) => entry.scope === "executor" && entry.open)
      .map((entry) => `${entry.executorId}\u0000${entry.providerId}`),
  );
  const openProviders = new Set(
    snapshot
      .filter((entry) => entry.scope === "provider" && entry.open)
      .map((entry) => entry.providerId),
  );
  return Object.freeze({
    snapshot: Object.freeze(snapshot),
    allows(executorId: string, providerId: string): boolean {
      return (
        !openExecutors.has(`${executorId}\u0000${providerId}`) &&
        !openProviders.has(providerId)
      );
    },
  });
}

function recordBreakerScope(
  db: AppDb,
  tenantId: string,
  scope: "executor" | "provider",
  executorId: string,
  providerId: string,
  success: boolean,
  observedAt: string,
  config: RoutingBreakerConfig,
): void {
  if (success) {
    run(
      db,
      `DELETE FROM routing_executor_health
       WHERE tenant_id = ? AND scope = ? AND executor_id = ? AND provider_id = ?`,
      [tenantId, scope, executorId, providerId],
    );
    return;
  }
  const existing = get<RoutingExecutorHealthRow>(
    db,
    `SELECT * FROM routing_executor_health
     WHERE tenant_id = ? AND scope = ? AND executor_id = ? AND provider_id = ?`,
    [tenantId, scope, executorId, providerId],
  );
  const consecutive = (existing?.consecutive_failures ?? 0) + 1;
  // Advance the open window on every failure at or past threshold. Pinning it to
  // the first trip would leave the breaker reporting available after a failed
  // half-open probe, so a sustained outage would never re-open it.
  const openedAt = consecutive >= config.failureThreshold ? observedAt : null;
  run(
    db,
    `INSERT INTO routing_executor_health
       (tenant_id, scope, executor_id, provider_id, consecutive_failures, opened_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, scope, executor_id, provider_id) DO UPDATE SET
       consecutive_failures = excluded.consecutive_failures,
       opened_at = excluded.opened_at,
       updated_at = excluded.updated_at`,
    [tenantId, scope, executorId, providerId, consecutive, openedAt, observedAt],
  );
}

/**
 * Feed a single execution outcome back into the durable breaker state. A
 * success clears both the executor and provider rows (bounded growth); a
 * failure increments consecutive failures and opens the breaker at threshold.
 */
export function recordRoutingExecutorOutcome(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    executorId: string;
    providerId: string;
    success: boolean;
    observedAt?: string;
    config?: RoutingBreakerConfig;
  }>,
): void {
  const observedAt = input.observedAt ?? nowIso();
  const config = input.config ?? DEFAULT_ROUTING_BREAKER;
  recordBreakerScope(
    db,
    input.tenantId,
    "executor",
    input.executorId,
    input.providerId,
    input.success,
    observedAt,
    config,
  );
  recordBreakerScope(
    db,
    input.tenantId,
    "provider",
    "",
    input.providerId,
    input.success,
    observedAt,
    config,
  );
}

/**
 * Persist a routing decision. Idempotent per (tenant, job, envelope) so a
 * replayed job re-records the same deterministic decision without duplicating.
 */
export function recordRoutingDecision(
  db: AppDb,
  input: Readonly<{
    id?: string;
    tenantId: string;
    jobId: string;
    runId?: string | null;
    taskKind: string;
    envelopeId: string;
    policySnapshotId: string;
    taskSnapshotId: string;
    action: string;
    selectedExecutorId?: string | null;
    providerId?: string | null;
    eliminated: unknown;
    fallback: unknown;
    breaker: unknown;
    handoffRequired: boolean;
    handoffReason?: string | null;
    decision: unknown;
    createdAt?: string;
  }>,
): string {
  const id = input.id ?? newId();
  const now = input.createdAt ?? nowIso();
  run(
    db,
    `INSERT INTO routing_ledger
       (id, tenant_id, job_id, run_id, task_kind, envelope_id, policy_snapshot_id,
        task_snapshot_id, action, selected_executor_id, provider_id, eliminated_json,
        fallback_json, breaker_json, handoff_required, handoff_reason, decision_json,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, job_id, envelope_id) DO UPDATE SET
       run_id = excluded.run_id,
       action = excluded.action,
       selected_executor_id = excluded.selected_executor_id,
       provider_id = excluded.provider_id,
       eliminated_json = excluded.eliminated_json,
       fallback_json = excluded.fallback_json,
       breaker_json = excluded.breaker_json,
       handoff_required = excluded.handoff_required,
       handoff_reason = excluded.handoff_reason,
       decision_json = excluded.decision_json,
       updated_at = excluded.updated_at`,
    [
      id,
      input.tenantId,
      input.jobId,
      input.runId ?? null,
      input.taskKind,
      input.envelopeId,
      input.policySnapshotId,
      input.taskSnapshotId,
      input.action,
      input.selectedExecutorId ?? null,
      input.providerId ?? null,
      JSON.stringify(input.eliminated ?? []),
      JSON.stringify(input.fallback ?? []),
      JSON.stringify(input.breaker ?? []),
      input.handoffRequired ? 1 : 0,
      input.handoffReason ?? null,
      JSON.stringify(input.decision ?? {}),
      now,
      now,
    ],
  );
  const row = get<{ id: string }>(
    db,
    `SELECT id FROM routing_ledger
     WHERE tenant_id = ? AND job_id = ? AND envelope_id = ?`,
    [input.tenantId, input.jobId, input.envelopeId],
  );
  return row?.id ?? id;
}

/** Record the final outcome + cost attribution for a routing decision. */
export function recordRoutingOutcome(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    jobId: string;
    envelopeId: string;
    action: string;
    outcome: string;
    // The executor that actually ran. Absent when the caller did not observe it;
    // stays NULL rather than defaulting to selected_executor_id (a copy would make
    // "did the executed executor differ from the selected one" tautologically false).
    executorId?: string | null;
    errorCode?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    observedAt?: string;
  }>,
): boolean {
  const observedAt = input.observedAt ?? nowIso();
  const result = db.raw
    .prepare(
      `UPDATE routing_ledger SET
         action = ?, outcome = ?, executed_executor_id = ?, error_code = ?,
         input_tokens = ?, output_tokens = ?,
         total_tokens = ?, cost_usd = ?, started_at = ?, completed_at = ?, updated_at = ?
       WHERE tenant_id = ? AND job_id = ? AND envelope_id = ?`,
    )
    .run(
      input.action,
      input.outcome,
      input.executorId ?? null,
      input.errorCode ?? null,
      input.inputTokens ?? null,
      input.outputTokens ?? null,
      input.totalTokens ?? null,
      input.costUsd ?? null,
      input.startedAt ?? null,
      input.completedAt ?? null,
      observedAt,
      input.tenantId,
      input.jobId,
      input.envelopeId,
    );
  return Number(result.changes) === 1;
}

type RoutingOutcomeApplicationRow = Readonly<{
  envelope_id: string;
  payload_digest: string;
}>;

export type RoutingBreakerFeedback =
  | "success"
  | "availability_failure"
  | "none";

function canonicalRoutingOutcomeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRoutingOutcomeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalRoutingOutcomeValue(child)]),
    );
  }
  return value;
}

/**
 * Apply one execution outcome, its ledger fields, and both breaker scopes in a
 * single transaction. An identical idempotency replay is a no-op; reusing the
 * key or decision envelope for different evidence fails closed.
 */
export function recordRoutingOutcomeExactlyOnce(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    jobId: string;
    envelopeId: string;
    idempotencyKey: string;
    idempotencyPayload: unknown;
    executorId: string;
    providerId: string;
    breakerFeedback: RoutingBreakerFeedback;
    action: string;
    outcome: string;
    errorCode?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    totalTokens?: number | null;
    costUsd?: number | null;
    startedAt?: string | null;
    completedAt?: string | null;
    observedAt?: string;
    config?: RoutingBreakerConfig;
  }>,
): boolean {
  const idempotencyKey = input.idempotencyKey.trim();
  if (!idempotencyKey) throw new Error("routing_outcome_idempotency_key_required");
  const observedAt = input.observedAt ?? nowIso();
  const payloadDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalRoutingOutcomeValue(input.idempotencyPayload)), "utf8")
    .digest("hex")}`;
  const config = input.config ?? DEFAULT_ROUTING_BREAKER;

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const byKey = db.raw
      .prepare(
        `SELECT envelope_id, payload_digest FROM routing_outcome_applications
         WHERE tenant_id = ? AND job_id = ? AND idempotency_key = ?`,
      )
      .get(input.tenantId, input.jobId, idempotencyKey) as
        | RoutingOutcomeApplicationRow
        | undefined;
    if (byKey) {
      if (byKey.envelope_id !== input.envelopeId || byKey.payload_digest !== payloadDigest) {
        throw new Error("routing_outcome_idempotency_conflict");
      }
      if (ownsTransaction) db.raw.exec("COMMIT");
      return false;
    }
    const byEnvelope = db.raw
      .prepare(
        `SELECT envelope_id, payload_digest FROM routing_outcome_applications
         WHERE tenant_id = ? AND job_id = ? AND envelope_id = ?`,
      )
      .get(input.tenantId, input.jobId, input.envelopeId) as
        | RoutingOutcomeApplicationRow
        | undefined;
    if (byEnvelope) throw new Error("routing_outcome_idempotency_conflict");

    const applied = recordRoutingOutcome(db, {
      tenantId: input.tenantId,
      jobId: input.jobId,
      envelopeId: input.envelopeId,
      action: input.action,
      outcome: input.outcome,
      executorId: input.executorId,
      errorCode: input.errorCode ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      totalTokens: input.totalTokens ?? null,
      costUsd: input.costUsd ?? null,
      startedAt: input.startedAt ?? null,
      completedAt: input.completedAt ?? null,
      observedAt,
    });
    if (!applied) throw new Error("routing_outcome_decision_missing");

    db.raw
      .prepare(
        `INSERT INTO routing_outcome_applications
          (tenant_id, job_id, envelope_id, idempotency_key, payload_digest, applied_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.tenantId,
        input.jobId,
        input.envelopeId,
        idempotencyKey,
        payloadDigest,
        observedAt,
      );
    if (input.breakerFeedback !== "none") {
      const success = input.breakerFeedback === "success";
      recordBreakerScope(
        db,
        input.tenantId,
        "executor",
        input.executorId,
        input.providerId,
        success,
        observedAt,
        config,
      );
      recordBreakerScope(
        db,
        input.tenantId,
        "provider",
        "",
        input.providerId,
        success,
        observedAt,
        config,
      );
    }
    if (ownsTransaction) db.raw.exec("COMMIT");
    return true;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function getRoutingLedgerForJob(
  db: AppDb,
  jobId: string,
  tenantId: string,
): RoutingLedgerRow[] {
  return all(
    db,
    `SELECT * FROM routing_ledger
     WHERE tenant_id = ? AND job_id = ?
     ORDER BY created_at, id`,
    [tenantId, jobId],
  );
}

export function listRoutingLedgerForRun(
  db: AppDb,
  runId: string,
  tenantId: string,
): RoutingLedgerRow[] {
  return all(
    db,
    `SELECT * FROM routing_ledger
     WHERE tenant_id = ? AND run_id = ?
     ORDER BY created_at, id`,
    [tenantId, runId],
  );
}
