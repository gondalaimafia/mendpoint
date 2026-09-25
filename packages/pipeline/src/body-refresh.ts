/**
 * One-time, idempotent refresh of OPEN draft PR bodies delivered before #713
 * (#724). Main-era code rendered the tenant id and the server checkout path into
 * PR bodies; #713 fixed NEW deliveries but left already-open drafts carrying the
 * id. This re-projects each affected draft's body to public identity and updates
 * the PR through the EXISTING adoptive update path (ADOPT converges the body only
 * when the branch head is still ours). It never closes, recreates or force-pushes
 * a PR, and it is not wired into boot or any schedule — it is an operator command.
 *
 * Correctness (blocker 2, FAILURE_MODES §1 third-state): detection reads the LIVE
 * GitHub body, never only the DB row, and a draft is counted `updated` ONLY when
 * GitHub confirms the body converged clean. A foreign (human-pushed) head, a
 * closed PR, a human-edited description, a missing write-ahead artifact and a
 * guard block are each reported as their own outcome with the PR URLs, and the DB
 * row body is written only on a confirmed update — so an unfixed draft is never
 * hidden from a later `--dry-run`.
 */
import {
  containsTenantIdentity,
  TENANT_IDENTITY_DELIVERY_ERROR,
  type GitHubDelivery,
} from "@mendpoint/github";
import {
  listTenants,
  listOpenDraftPrs,
  getConsumer,
  getConsumerRepo,
  getLatestDeliveryArtifact,
  persistDeliveryArtifact,
  hasDeliveryArtifactByContent,
  updateMigrationPrDelivery,
  type AppDb,
  type TenantRow,
  type MigrationPrRow,
} from "@mendpoint/db";
import { deliveryArtifactDigest, type DeliveryResolution } from "./delivery.js";
import { renderPublicPrIdentity } from "./public-pr-identity.js";

/** The disposition of one open draft the refresh examined. */
export type RefreshDraftOutcome =
  | "updated"
  | "skipped_foreign_head"
  | "skipped_closed"
  | "skipped_human_edited"
  | "skipped_no_artifact"
  | "blocked"
  | "failed";

export type RefreshTenantResult = Readonly<{
  tenantId: string;
  tenantSlug: string;
  /** Open drafts whose LIVE GitHub body carries the tenant id or a server checkout path. */
  affected: number;
  updated: number;
  /** A human pushed onto the head, so ADOPT will not converge — needs a human. */
  skippedForeignHead: ReadonlyArray<string>;
  /** The PR is closed/merged on GitHub. */
  skippedClosed: ReadonlyArray<string>;
  /** A human edited the description (beyond the leaked tokens); left untouched. */
  skippedHumanEdited: ReadonlyArray<string>;
  /** No replayable write-ahead artifact, so the commit cannot be rebuilt. */
  skippedNoArtifact: ReadonlyArray<string>;
  /** A re-render still leaked and was refused by the fail-closed guard. */
  blocked: ReadonlyArray<string>;
  /** Delivery failed for another reason. */
  failed: ReadonlyArray<string>;
}>;

export type RefreshOpenDraftBodiesResult = Readonly<{
  dryRun: boolean;
  tenants: ReadonlyArray<RefreshTenantResult>;
  totalAffected: number;
  totalUpdated: number;
}>;

export type RefreshDeliveryFor = (
  tenantId: string,
  consumer: Readonly<{
    installation_id: string | null;
    github_delivery_mode: "app" | "legacy_pat" | "revoked";
    github_owner: string;
    github_repo: string;
  }>,
  repo?: Readonly<{ scm_connection_id: string | null; connected_repository_id: string | null }>,
) => DeliveryResolution;

export type RefreshOpenDraftBodiesInput = Readonly<{
  db: AppDb;
  /** Configured repositories root; a body embedding `<reposDir>/<tenantId>` is a server-path leak. */
  reposDir?: string | null;
  /** Limit the sweep to one tenant; omit to sweep every tenant. */
  tenantId?: string | null;
  /** true reads live bodies and reports affected counts, but writes NOTHING. */
  dryRun: boolean;
  /** Resolve the delivery transport for a tenant's consumer (required — the live
   * body is read through it, both in dry-run and on a real run). */
  deliveryFor: RefreshDeliveryFor;
}>;

/** Does this LIVE body carry the tenant id or the server checkout path? */
function leaksText(text: string, tenantId: string, reposDir?: string | null): boolean {
  if (containsTenantIdentity(tenantId, text)) return true;
  return Boolean(reposDir && text.includes(`${reposDir}/${tenantId}`));
}

function emptyTenantResult(tenant: TenantRow): {
  -readonly [K in keyof RefreshTenantResult]: RefreshTenantResult[K];
} {
  return {
    tenantId: tenant.id,
    tenantSlug: tenant.slug,
    affected: 0,
    updated: 0,
    skippedForeignHead: [],
    skippedClosed: [],
    skippedHumanEdited: [],
    skippedNoArtifact: [],
    blocked: [],
    failed: [],
  };
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
    const acc = emptyTenantResult(tenant);
    for (const row of listOpenDraftPrs(db, tenant.id)) {
      const consumer = getConsumer(db, row.consumer_id, tenant.id);
      const repo = consumer ? getConsumerRepo(db, consumer.id, tenant.id) : undefined;
      if (!consumer || !repo || row.github_pr_number == null) continue;
      const resolution = input.deliveryFor(tenant.id, consumer, repo);
      const ownerRepo = `${consumer.github_owner}/${consumer.github_repo}`;
      const url = row.github_pr_url ?? "";

      // Detection reads the LIVE GitHub body, not the DB row (blocker 2). A PR that
      // is closed/merged or gone on GitHub is not an affected open draft.
      const live = resolution.delivery.getOpenPullRequest
        ? await resolution.delivery.getOpenPullRequest(consumer.github_owner, consumer.github_repo, row.github_pr_number)
        : undefined;
      if (!live || live.state !== "open") continue;
      if (!leaksText(live.body, tenant.id, input.reposDir)) continue;

      acc.affected += 1;
      if (dryRun) continue;

      const outcome = await refreshOneDraft(input, tenant.id, row, consumer, repo, resolution, ownerRepo, live.body);
      switch (outcome) {
        case "updated":
          acc.updated += 1;
          break;
        case "skipped_foreign_head":
          acc.skippedForeignHead = [...acc.skippedForeignHead, url];
          break;
        case "skipped_closed":
          acc.skippedClosed = [...acc.skippedClosed, url];
          break;
        case "skipped_human_edited":
          acc.skippedHumanEdited = [...acc.skippedHumanEdited, url];
          break;
        case "skipped_no_artifact":
          acc.skippedNoArtifact = [...acc.skippedNoArtifact, url];
          break;
        case "blocked":
          acc.blocked = [...acc.blocked, url];
          break;
        case "failed":
          acc.failed = [...acc.failed, url];
          break;
      }
    }
    results.push(acc);
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
  consumer: Readonly<{ id: string; github_owner: string; github_repo: string }>,
  repo: Readonly<{ default_branch?: string }>,
  resolution: DeliveryResolution,
  ownerRepo: string,
  liveBody: string,
): Promise<RefreshDraftOutcome> {
  const deliveryKey = `${row.change_id}:${row.consumer_id}`;
  const artifact = getLatestDeliveryArtifact(input.db, tenantId, deliveryKey);
  if (!artifact || !artifact.filesJson) return "skipped_no_artifact";
  const opts = { reposDir: input.reposDir, ownerRepo };
  // Respect a human's edits: only converge when the LIVE body, minus the leaked
  // identity tokens, matches our last-delivered body minus the same tokens. If the
  // human changed anything else, leave the PR for a person (should-fix).
  if (renderPublicPrIdentity(liveBody, tenantId, opts) !== renderPublicPrIdentity(row.body, tenantId, opts)) {
    return "skipped_human_edited";
  }
  const files = JSON.parse(artifact.filesJson) as Array<{ path: string; content: string }>;
  const reRenderedBody = renderPublicPrIdentity(artifact.body, tenantId, opts);
  const reRenderedTitle = renderPublicPrIdentity(artifact.title, tenantId, opts);

  const delivery: GitHubDelivery = resolution.delivery;
  if (typeof delivery.deliverAdoptiveDraft !== "function") return "failed";
  try {
    const result = await delivery.deliverAdoptiveDraft(
      {
        owner: consumer.github_owner,
        repo: consumer.github_repo,
        baseBranch: repo.default_branch ?? "main",
        expectedBaseSha: artifact.parentSha,
        branch: row.branch_name,
        deliveryKey,
        tenantId,
        title: reRenderedTitle,
        commitDate: row.created_at,
        files: files.map((f) => ({ path: f.path, content: f.content, mode: "100644" as const })),
      },
      {
        resolveBody: () => reRenderedBody,
        hooks: {
          persistArtifact: (a) =>
            persistDeliveryArtifact(input.db, {
              tenantId,
              artifactDigest: deliveryArtifactDigest(a.deliveryKey, a.treeSha, a.parentSha),
              deliveryKey: a.deliveryKey,
              title: a.title,
              body: a.body,
              treeSha: a.treeSha,
              parentSha: a.parentSha,
              filesJson: JSON.stringify(files),
              createdAt: row.created_at,
            }),
          isOursArtifact: (content) =>
            hasDeliveryArtifactByContent(input.db, tenantId, deliveryKey, content.treeSha, content.parentSha),
        },
      },
    );
    if (result.state !== "draft") return "skipped_closed";
    // Record `updated` ONLY when GitHub confirms the body converged clean: the head
    // is still ours (ADOPT returns our re-rendered body) and it no longer leaks. A
    // foreign head leaves the live body unchanged, so ADOPT returns the old body.
    if (leaksText(result.body, tenantId, input.reposDir)) return "skipped_foreign_head";
    // Persist the clean body to the DB row only now that GitHub holds it.
    updateMigrationPrDelivery(input.db, row.id, {
      status: "draft",
      githubPrNumber: row.github_pr_number ?? undefined,
      body: reRenderedBody,
    });
    return "updated";
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === TENANT_IDENTITY_DELIVERY_ERROR) return "blocked";
    return "failed";
  }
}
