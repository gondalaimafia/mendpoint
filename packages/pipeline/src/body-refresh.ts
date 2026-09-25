/**
 * One-time, idempotent refresh of OPEN draft PR bodies delivered before #713
 * (#724). Main-era code rendered the tenant id and the server checkout path into
 * PR bodies; #713 fixed NEW deliveries but left already-open drafts carrying the
 * id. This re-projects each affected draft's body to public identity and updates
 * the PR through the EXISTING adoptive update path (ADOPT converges the body when
 * the branch head is still ours). It never closes, recreates or force-pushes a
 * PR, and it is not wired into boot or any schedule — it is an operator command.
 *
 * `--dry-run` reports the affected count per tenant and writes nothing. A real run
 * is idempotent: ADOPT issues no update once a body is already converged, and the
 * fail-closed guard on the adoptive transport blocks the update if a re-render
 * would still leak (so a persistent leak surfaces as delivery_blocked, never a
 * leaking write).
 */
import {
  containsTenantIdentity,
  TENANT_IDENTITY_DELIVERY_ERROR,
} from "@mendpoint/github";
import {
  listTenants,
  listOpenDraftPrs,
  getConsumer,
  getConsumerRepo,
  getLatestDeliveryArtifact,
  type AppDb,
  type TenantRow,
  type MigrationPrRow,
} from "@mendpoint/db";
import { deliverConsumerDraft, type DeliveryResolution } from "./delivery.js";
import { renderPublicPrIdentity } from "./public-pr-identity.js";

export type RefreshTenantResult = Readonly<{
  tenantId: string;
  tenantSlug: string;
  /** Open drafts whose stored body carries the tenant id or a server checkout path. */
  affected: number;
  /** Affected drafts whose body was re-rendered and delivered clean (0 in dry-run). */
  updated: number;
  /** Affected drafts with no replayable write-ahead artifact (cannot re-deliver). */
  skipped: number;
  /** Affected drafts whose re-render still leaked and was blocked by the guard. */
  blocked: number;
}>;

export type RefreshOpenDraftBodiesResult = Readonly<{
  dryRun: boolean;
  tenants: ReadonlyArray<RefreshTenantResult>;
  totalAffected: number;
  totalUpdated: number;
}>;

export type RefreshOpenDraftBodiesInput = Readonly<{
  db: AppDb;
  /** Configured repositories root; a body embedding it is a server-path leak. */
  reposDir?: string | null;
  /** Limit the sweep to one tenant; omit to sweep every tenant. */
  tenantId?: string | null;
  /** true reports affected counts and writes NOTHING. */
  dryRun: boolean;
  /** Resolve the delivery transport for a tenant's consumer (required for a real run). */
  deliveryFor?: (
    tenantId: string,
    consumer: Readonly<{
      installation_id: string | null;
      github_delivery_mode: "app" | "legacy_pat" | "revoked";
      github_owner: string;
      github_repo: string;
    }>,
    repo?: Readonly<{ scm_connection_id: string | null; connected_repository_id: string | null }>,
  ) => DeliveryResolution;
}>;

/**
 * Does this stored body/title carry the tenant id or the server checkout path? A
 * production checkout path is `<reposDir>/<tenantId>/<repoKey>`, so it always
 * embeds the tenant id — detecting the id covers it, and the explicit checkout
 * prefix is a belt-and-suspenders signal. Both go false once the id is removed, so
 * the refresh is idempotent (a re-rendered row is no longer affected).
 */
function leaks(row: MigrationPrRow, tenantId: string, reposDir?: string | null): boolean {
  const text = `${row.title}\n${row.body}`;
  if (containsTenantIdentity(tenantId, text)) return true;
  return Boolean(reposDir && text.includes(`${reposDir}/${tenantId}`));
}

export async function refreshOpenDraftBodies(
  input: RefreshOpenDraftBodiesInput,
): Promise<RefreshOpenDraftBodiesResult> {
  const { db, dryRun } = input;
  const tenants: TenantRow[] = input.tenantId
    ? listTenants(db).filter((t) => t.id === input.tenantId)
    : listTenants(db);

  const results: RefreshTenantResult[] = [];
  for (const tenant of tenants) {
    const drafts = listOpenDraftPrs(db, tenant.id).filter((row) =>
      leaks(row, tenant.id, input.reposDir),
    );
    let updated = 0;
    let skipped = 0;
    let blocked = 0;
    if (!dryRun) {
      for (const row of drafts) {
        const outcome = await refreshOneDraft(input, tenant.id, row);
        if (outcome === "updated") updated += 1;
        else if (outcome === "blocked") blocked += 1;
        else skipped += 1;
      }
    }
    results.push({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      affected: drafts.length,
      updated,
      skipped,
      blocked,
    });
  }

  return Object.freeze({
    dryRun,
    tenants: results,
    totalAffected: results.reduce((sum, r) => sum + r.affected, 0),
    totalUpdated: results.reduce((sum, r) => sum + r.updated, 0),
  });
}

async function refreshOneDraft(
  input: RefreshOpenDraftBodiesInput,
  tenantId: string,
  row: MigrationPrRow,
): Promise<"updated" | "skipped" | "blocked"> {
  if (!input.deliveryFor) throw new Error("refresh_open_draft_bodies_delivery_resolver_required");
  const consumer = getConsumer(input.db, row.consumer_id, tenantId);
  const repo = consumer ? getConsumerRepo(input.db, consumer.id, tenantId) : undefined;
  if (!consumer || !repo) return "skipped";
  const deliveryKey = `${row.change_id}:${row.consumer_id}`;
  const artifact = getLatestDeliveryArtifact(input.db, tenantId, deliveryKey);
  // No write-ahead artifact (e.g. a content-manifest repo or a pre-artifact row):
  // the adoptive update path cannot rebuild the commit, so leave the PR untouched.
  if (!artifact || !artifact.filesJson) return "skipped";
  const files = JSON.parse(artifact.filesJson) as Array<{ path: string; content: string }>;
  const outcome = await deliverConsumerDraft({
    db: input.db,
    tenantId,
    prId: row.id,
    changeId: row.change_id,
    isRetry: true,
    consumer: { id: consumer.id, github_owner: consumer.github_owner, github_repo: consumer.github_repo },
    defaultBranch: (repo as { default_branch?: string }).default_branch ?? "main",
    deliveryKey,
    branchName: row.branch_name,
    // Re-project the stored title/body to public identity; ADOPT converges the PR
    // body when the head is still ours. The guard blocks if a re-render still leaks.
    title: renderPublicPrIdentity(artifact.title, tenantId),
    risk: row.risk,
    patch: row.patch_unified,
    body: renderPublicPrIdentity(artifact.body, tenantId),
    files,
    baseSha: artifact.parentSha,
    commitDate: row.created_at,
    revisionKind: "git_commit",
    shouldDeliver: true,
    terminalStatus: row.status,
    coverageJson: null,
    createdAt: row.created_at,
    existingPrNumber: row.github_pr_number ?? null,
    existingPrUrl: row.github_pr_url ?? null,
    resolveDelivery: () => input.deliveryFor!(tenantId, consumer, repo),
    assertActive: () => {},
  });
  if (outcome.deliveryError === TENANT_IDENTITY_DELIVERY_ERROR) return "blocked";
  return "updated";
}
