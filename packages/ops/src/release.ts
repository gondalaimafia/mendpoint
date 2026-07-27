/**
 * Production GA release metadata — single source for version / channel.
 */
export const RELEASE = {
  product: "Warden",
  platform: "Mendpoint",
  /** Semver of the GA surface */
  version: "1.0.0",
  channel: "ga" as "ga" | "beta" | "internal",
  codename: "graph-pr",
  releasedAt: "2026-07-27",
  /** Features included in GA (customer-facing) */
  gaFeatures: [
    "openapi_diff_to_impact",
    "migration_pr_review_first",
    "consumer_registry",
    "warden_agent_debug_loop",
    "contract_gates_and_api_critic",
    "spec_first_plans",
    "github_delivery_mock_or_real",
    "audit_log",
    "api_key_auth",
    "feed_poll",
    "graph_rag_and_outcome_labels",
    "multi_language_impact_harnesses",
  ],
  /** Explicitly not GA — available but labeled experimental */
  experimentalFeatures: [
    "transformer_bsg_campaigns",
    "firecracker_vm_backend",
    "kuzu_native_store",
    "gnn_training",
    "auto_merge_low_risk",
    "llm_whole_repo_scan",
  ],
} as const;

export type ReleaseInfo = typeof RELEASE;

export function releaseBanner(): string {
  return `${RELEASE.platform} / ${RELEASE.product} ${RELEASE.version} (${RELEASE.channel})`;
}
