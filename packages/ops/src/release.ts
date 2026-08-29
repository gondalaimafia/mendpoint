/**
 * Production GA release metadata — single source for version / channel.
 */
export const RELEASE = {
  product: "Fettler",
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

const IMMUTABLE_RELEASE_REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export function resolveReleaseRevision(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const revision = env.MENDPOINT_RELEASE_REVISION?.trim();
  if (!revision) return null;
  if (!IMMUTABLE_RELEASE_REVISION.test(revision)) {
    throw new Error("release_revision_invalid");
  }
  return revision;
}

/**
 * Customer-facing product identity for a deployment, derived from its
 * MENDPOINT_DEPLOYMENT_PROFILE rather than a hardcoded constant.
 *
 * "Transformer" is the legacy internal package name for ReGauge's core engine;
 * the customer-facing product is ReGauge. Both the transformer_pilot and
 * regauge_production deployment profiles run that engine, so both report
 * ReGauge. Every other profile -- customer, demo, pilot -- and any unknown or
 * unset profile reports the default platform product (RELEASE.product,
 * "Fettler"): an indeterminate deployment must never silently claim the ReGauge
 * identity, so it falls back to the established default rather than guessing.
 *
 * This mirrors resolveReleaseRevision above: a frozen RELEASE object for every
 * static field, with the environment-dependent field resolved through a
 * function that reads the same env it is given.
 */
const PRODUCT_BY_DEPLOYMENT_PROFILE: Readonly<Record<string, string>> = {
  regauge_production: "ReGauge",
  transformer_pilot: "ReGauge",
};

export function resolveReleaseProduct(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const profile = env.MENDPOINT_DEPLOYMENT_PROFILE?.trim();
  return (profile && PRODUCT_BY_DEPLOYMENT_PROFILE[profile]) || RELEASE.product;
}

export function releaseBanner(env: NodeJS.ProcessEnv = process.env): string {
  return `${RELEASE.platform} / ${resolveReleaseProduct(env)} ${RELEASE.version} (${RELEASE.channel})`;
}
