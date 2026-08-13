/**
 * Consumer registry — which consumers monitor which providers.
 * Uses raw SQL to avoid circular imports with index.ts.
 */
import type { AppDb } from "./index.js";

export type RegistryHit = {
  consumerId: string;
  consumerName: string;
  githubOwner: string;
  githubRepo: string;
  providerId: string;
  providerSlug: string;
  providerName: string;
  localPath?: string;
  detectionSource?: string;
};

export function listConsumersForProvider(
  db: AppDb,
  providerSlug: string,
  tenantId?: string,
): RegistryHit[] {
  const rows = db.raw
    .prepare(
      `SELECT c.id as consumer_id, c.name as consumer_name, c.github_owner, c.github_repo,
              p.id as provider_id, p.slug as provider_slug, p.name as provider_name,
              cr.local_path, m.detection_source
       FROM monitored_apis m
       JOIN consumers c ON c.id = m.consumer_id
       JOIN providers p ON p.id = m.provider_id
       LEFT JOIN consumer_repos cr ON cr.consumer_id = c.id
       WHERE p.slug = ?
         AND (? IS NULL OR c.tenant_id = ?)
       ORDER BY c.name`,
    )
    .all(providerSlug, tenantId ?? null, tenantId ?? null) as Array<{
    consumer_id: string;
    consumer_name: string;
    github_owner: string;
    github_repo: string;
    provider_id: string;
    provider_slug: string;
    provider_name: string;
    local_path: string | null;
    detection_source: string | null;
  }>;

  return rows.map((r) => ({
    consumerId: r.consumer_id,
    consumerName: r.consumer_name,
    githubOwner: r.github_owner,
    githubRepo: r.github_repo,
    providerId: r.provider_id,
    providerSlug: r.provider_slug,
    providerName: r.provider_name,
    localPath: r.local_path ?? undefined,
    detectionSource: r.detection_source ?? undefined,
  }));
}

export type TenantMonitoredProvider = {
  providerSlug: string;
  providerName: string;
  latestChangeAt: string | null;
};

/**
 * Providers monitored by a tenant's own consumers, ordered so the provider with
 * the most recent api_change comes first (providers with no change yet sort
 * last). Used by the self-serve scan trigger to auto-pick the tenant's latest
 * provider change without ever seeing another tenant's providers.
 */
export function listTenantMonitoredProviders(
  db: AppDb,
  tenantId: string,
): TenantMonitoredProvider[] {
  const rows = db.raw
    .prepare(
      `SELECT p.slug AS provider_slug, p.name AS provider_name,
              MAX(ch.created_at) AS latest_change_at
       FROM monitored_apis m
       JOIN consumers c ON c.id = m.consumer_id
       JOIN providers p ON p.id = m.provider_id
       LEFT JOIN api_changes ch ON ch.provider_id = p.id
       WHERE c.tenant_id = ?
       GROUP BY p.id
       ORDER BY (latest_change_at IS NULL), latest_change_at DESC, p.slug`,
    )
    .all(tenantId) as Array<{
    provider_slug: string;
    provider_name: string;
    latest_change_at: string | null;
  }>;

  return rows.map((r) => ({
    providerSlug: r.provider_slug,
    providerName: r.provider_name,
    latestChangeAt: r.latest_change_at ?? null,
  }));
}

export function listConsumersImpactedByChange(
  db: AppDb,
  changeId: string,
  tenantId?: string,
): Array<{ consumerId: string; consumerName: string; findings: number }> {
  return db.raw
    .prepare(
      `SELECT c.id as consumerId, c.name as consumerName, COUNT(f.id) as findings
       FROM impact_findings f
       JOIN consumers c ON c.id = f.consumer_id
       WHERE f.change_id = ?
         AND (? IS NULL OR c.tenant_id = ?)
       GROUP BY c.id
       ORDER BY findings DESC`,
    )
    .all(changeId, tenantId ?? null, tenantId ?? null) as Array<{
    consumerId: string;
    consumerName: string;
    findings: number;
  }>;
}

export function registrySummaryMarkdown(
  hits: RegistryHit[],
  providerSlug: string,
): string {
  if (!hits.length) {
    return `### Consumer registry\n\nNo consumers monitor **${providerSlug}**.`;
  }
  return [
    "### Consumer registry",
    "",
    `Provider **${providerSlug}** is monitored by **${hits.length}** consumer(s):`,
    "",
    ...hits.map(
      (h) =>
        `- **${h.consumerName}** (\`${h.githubOwner}/${h.githubRepo}\`)${
          h.localPath ? ` — \`${h.localPath}\`` : ""
        }`,
    ),
    "",
    "_Query this registry before proposing breaking OpenAPI changes (Warden P0)._",
  ].join("\n");
}
