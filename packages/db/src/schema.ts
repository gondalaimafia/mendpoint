/** Table name constants + row types (node:sqlite, no ORM). */

export type Provider = {
  id: string;
  slug: string;
  name: string;
  website: string | null;
  openapi_url?: string | null;
  changelog_url?: string | null;
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
  provider_slug: string;
  openapi_url: string;
  content_hash: string | null;
  version_label: string | null;
  status: string;
  error: string | null;
  version_id: string | null;
  pipeline_change_id: string | null;
  polled_at: string;
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

export type GitHubInstallationRow = {
  id: string;
  installation_id: string;
  account_login: string;
  account_type: string;
  tenant_id: string | null;
  permissions_json: string | null;
  repositories_json: string | null;
  created_at: string;
  updated_at: string;
};

export type ConsumerRepo = {
  id: string;
  consumer_id: string;
  local_path: string;
  default_branch: string;
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
