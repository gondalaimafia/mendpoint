/** Table name constants + row types (node:sqlite, no ORM). */

export type Provider = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  openapi_url?: string | null;
  changelog_url?: string | null;
  /**
   * Tenant-private ownership (S1.1). NULL = shared, system-admin-owned catalog provider
   * visible to every tenant (the default, unchanged behavior). A non-null value marks a
   * self-serve tenant-private provider that only its owning tenant may see or run.
   */
  tenant_id?: string | null;
  created_at: string;
};

export type ApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  tenant_id: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

export type FeedPollRow = {
  id: string;
  tenant_id: string;
  provider_slug: string;
  openapi_url: string;
  content_hash: string | null;
  version_label: string | null;
  status: string;
  error: string | null;
  version_id: string | null;
  pipeline_change_id: string | null;
  polled_at: string;
  validation_evidence_id?: string | null;
  validation_source?: "catalog" | "provider" | "unknown" | null;
  validation_format?: "json" | "unknown" | null;
  validation_format_status?: "accepted" | "rejected" | "not_observed" | null;
  validation_schema_version?: string | null;
  validation_schema_status?: "accepted" | "rejected" | "not_observed" | null;
  validation_size_bytes?: number | null;
  validation_content_sha256?: string | null;
  validation_status?: "accepted" | "rejected" | "skipped" | null;
  validation_error?: string | null;
  validation_http_status?: number | null;
  validation_observed_at?: string | null;
};

export type FeedValidationEvidenceInput = {
  id: string;
  source: "catalog" | "provider" | "unknown";
  format: "json" | "unknown";
  formatStatus: "accepted" | "rejected" | "not_observed";
  schemaVersion?: string | null;
  schemaStatus: "accepted" | "rejected" | "not_observed";
  sizeBytes: number;
  contentSha256?: string | null;
  status: "accepted" | "rejected" | "skipped";
  error?: string | null;
  httpStatus?: number | null;
  observedAt: string;
};

export type FeedScheduleRow = {
  id: string;
  tenant_id: string;
  provider_slug: string;
  interval_ms: number;
  stale_after_ms: number;
  enabled: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  consecutive_failures: number;
  alert_state: "healthy" | "stale" | "failed";
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

export type FeedScheduleWindowRow = {
  id: string;
  schedule_id: string;
  window_started_at: string;
  window_ends_at: string;
  status: "running" | "succeeded" | "failed";
  error: string | null;
  attempted_at: string;
  completed_at: string | null;
};

export type ApiVersion = {
  id: string;
  provider_id: string;
  content_hash: string | null;
  version_label: string;
  openapi_json: string;
  changelog_md: string | null;
  published_at: string;
};

export type ApiChange = {
  id: string;
  provider_id: string;
  /** required | recommended | optional */
  severity?: string | null;
  from_version_id: string;
  to_version_id: string;
  risk: string;
  summary: string;
  diff_json: string;
  created_at: string;
};

export type Consumer = {
  id: string;
  name: string;
  github_owner: string;
  github_repo: string;
  installation_id: string | null;
  github_delivery_mode: "app" | "legacy_pat" | "revoked";
  tenant_id: string;
  created_at: string;
};

export type TenantRow = {
  id: string;
  slug: string;
  name: string;
  plan: string;
  billing_status: string;
  seat_limit: number;
  created_at: string;
};

export type TenantMembershipRow = {
  tenant_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string;
  role: "owner" | "admin" | "engineer" | "viewer" | "fde";
  status: "active" | "offboarded";
  created_at: string;
  updated_at: string;
  offboarded_at: string | null;
};

export type MemberScopeType = "repository" | "environment";

export type MemberScopeRow = {
  id: string;
  tenant_id: string;
  issuer: string;
  subject: string;
  scope_type: MemberScopeType;
  scope_value: string;
  created_at: string;
  created_by: string;
};

export type GitHubInstallationRow = {
  id: string;
  installation_id: string;
  account_id: string | null;
  account_login: string;
  account_type: string;
  tenant_id: string | null;
  permissions_json: string | null;
  repositories_json: string | null;
  repository_selection: "selected" | "all";
  suspended_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GitHubInstallStateRow = {
  state_hash: string;
  tenant_id: string;
  created_by_principal_id: string | null;
  expected_account_id: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  completed_at: string | null;
  completed_installation_id: string | null;
};

export type ConsumerRepo = {
  id: string;
  consumer_id: string;
  local_path: string;
  default_branch: string;
  scm_connection_id: string | null;
  connected_repository_id: string | null;
  snapshot_id: string | null;
  exact_commit: string | null;
  created_at: string;
};

export type ScmConnectionRow = {
  id: string;
  tenant_id: string;
  provider: "github" | "gitlab" | "local_git";
  credential_ref: string;
  external_account_id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type ConnectedRepositoryRow = {
  id: string;
  tenant_id: string;
  connection_id: string;
  remote_id: string;
  owner: string;
  name: string;
  default_branch: string;
  selected_branch: string;
  environment: string;
  retention_days: number;
  status: "pending" | "ready" | "degraded" | "revoked";
  created_at: string;
  updated_at: string;
};

export type RepositorySnapshotRow = {
  id: string;
  tenant_id: string;
  repository_id: string;
  requested_ref: string;
  resolved_sha: string;
  manifest_sha256: string;
  storage_path: string;
  submodules_policy: "reject" | "pinned";
  lfs_policy: "reject" | "pointer_only" | "fetch";
  sparse_paths_json: string;
  file_manifest_version: 0 | 1;
  created_at: string;
  expires_at: string;
};

export type RepositorySnapshotFileRow = {
  snapshot_id: string;
  tenant_id: string;
  path: string;
  mode: "100644" | "100755" | "120000";
  kind: "file" | "symlink";
  size: number;
  sha256: string;
};

export type RepositorySnapshotPolicyRow = {
  id: string;
  tenant_id: string;
  snapshot_id: string;
  codeowners_json: string;
  ci_files_json: string;
  verification_commands_json: string;
  protected_branch_json: string;
  created_at: string;
};

export type ConnectorRow = {
  id: string;
  tenant_id: string;
  kind: "ci" | "ticketing" | "docs";
  provider: string;
  display_name: string;
  mode: "mock" | "real";
  credential_envelope: string | null;
  config_json: string;
  health_status: "unverified" | "verified" | "failed" | "revoked";
  verified: number;
  error_code: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
};

export type ScmConnectionHealthRow = {
  connection_id: string;
  tenant_id: string;
  configured: number;
  authenticated: number;
  read_access: number;
  write_access: number;
  webhook_ok: number;
  ci_visible: number;
  last_sync_at: string | null;
  last_delivery_at: string | null;
  revoked: number;
  error_code: string | null;
  checked_at: string;
};

export type RepositorySnapshotDeletionRow = {
  id: string;
  tenant_id: string;
  snapshot_id: string;
  status: "planned" | "deleted" | "failed";
  actor_principal_id: string;
  error_code: string | null;
  created_at: string;
};

export type MonitoredApi = {
  id: string;
  consumer_id: string;
  provider_id: string;
  detection_source: string;
};

export type ImpactFindingRow = {
  id: string;
  change_id: string;
  consumer_id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  symbol: string;
  confidence: string;
  evidence_json: string;
};

export type MigrationPrRow = {
  id: string;
  change_id: string;
  consumer_id: string;
  title: string;
  body: string;
  branch_name: string;
  status: string;
  risk: string;
  patch_unified: string;
  github_pr_number: number | null;
  github_pr_url: string | null;
  github_repository_id: string | null;
  github_installation_id: string | null;
  github_account_id: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type AuditEvent = {
  id: string;
  tenant_id: string;
  event_sequence: number;
  schema_version: number;
  prev_hash: string | null;
  event_hash: string;
  metadata_sha256: string;
  actor: string;
  principal_id: string | null;
  api_key_id: string | null;
  request_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type PrincipalRow = {
  id: string;
  tenant_id: string;
  kind: "human" | "service" | "api_key" | "webhook";
  subject: string;
  display_name: string;
  audience: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
};

export type ArtifactManifestRow = {
  id: string;
  tenant_id: string;
  kind: string;
  schema_version: number;
  sha256: string;
  media_type: string;
  size_bytes: number;
  storage_ref: string;
  content_text: string | null;
  producer_principal_id: string | null;
  created_at: string;
};

export type EvidenceRecordRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  artifact_id: string;
  input_artifact_id: string | null;
  producer_principal_id: string | null;
  tool: string;
  command: string | null;
  tool_version: string | null;
  commit_sha: string | null;
  verdict: "passed" | "failed" | "unknown" | "waived";
  created_at: string;
};

export type ReviewDecisionRow = {
  id: string;
  tenant_id: string;
  subject_type: string;
  subject_id: string;
  candidate_artifact_id: string;
  reviewer_principal_id: string;
  decision: "approve" | "reject" | "request_changes" | "regenerate" | "waive";
  rationale: string;
  waiver_expires_at: string | null;
  supersedes_id: string | null;
  created_at: string;
};

export type DomainEventRow = {
  id: string;
  tenant_id: string;
  event_sequence: number;
  schema_version: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  actor_principal_id: string;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string;
  payload_json: string;
  payload_sha256: string;
  prev_hash: string | null;
  event_hash: string;
  created_at: string;
};

export type Policy = {
  id: string;
  consumer_id: string;
  key: string;
  value_json: string;
};

export type RoutingLedgerRow = {
  id: string;
  tenant_id: string;
  job_id: string;
  run_id: string | null;
  task_kind: string;
  envelope_id: string;
  policy_snapshot_id: string;
  task_snapshot_id: string;
  action: string;
  selected_executor_id: string | null;
  provider_id: string | null;
  eliminated_json: string;
  fallback_json: string;
  breaker_json: string;
  handoff_required: number;
  handoff_reason: string | null;
  outcome: string | null;
  error_code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  started_at: string | null;
  completed_at: string | null;
  decision_json: string;
  created_at: string;
  updated_at: string;
};

export type RoutingExecutorHealthRow = {
  tenant_id: string;
  scope: "executor" | "provider";
  executor_id: string;
  provider_id: string;
  consecutive_failures: number;
  opened_at: string | null;
  updated_at: string;
};
