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
  tenant_id?: string | null;
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
  actor: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_json: string | null;
  created_at: string;
};

export type Policy = {
  id: string;
  consumer_id: string;
  key: string;
  value_json: string;
};
