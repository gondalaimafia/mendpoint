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

export const REGAUGE_RELEASE = {
  ...RELEASE,
  product: "Regauge",
  codename: "legacy-engineer",
  gaFeatures: [
    ...RELEASE.gaFeatures,
    "transformer_bsg_campaigns",
  ],
  experimentalFeatures: RELEASE.experimentalFeatures.filter(
    (feature) => feature !== "transformer_bsg_campaigns",
  ),
} as const;

export type ReleaseInfo = typeof RELEASE | typeof REGAUGE_RELEASE;

export function resolveRelease(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReleaseInfo {
  return env.MENDPOINT_DEPLOYMENT_PROFILE?.trim() === "regauge_production"
    ? REGAUGE_RELEASE
    : RELEASE;
}

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

export function releaseBanner(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const release = resolveRelease(env);
  return `${release.platform} / ${release.product} ${release.version} (${release.channel})`;
}
