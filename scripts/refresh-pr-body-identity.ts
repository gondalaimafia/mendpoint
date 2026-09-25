/**
 * One-time operator command: refresh OPEN draft PR bodies delivered before #713
 * that still carry the tenant id or the server checkout path (#724).
 *
 * Run inside the deployment boundary, from /app in the production image (the
 * image has no `tsx` on PATH, so invoke it through node's --import loader):
 *
 *   node --import tsx scripts/refresh-pr-body-identity.ts --dry-run             # count, write nothing
 *   node --import tsx scripts/refresh-pr-body-identity.ts --dry-run --tenant <id>
 *   node --import tsx scripts/refresh-pr-body-identity.ts --apply               # re-render + update PRs
 *
 * On Fly: `flyctl ssh console -a <app>`, then
 *   `cd /app && node --import tsx scripts/refresh-pr-body-identity.ts --dry-run`.
 * (No npm script is added; package.json is a pinned closure-authority file.)
 *
 * Both modes read the LIVE GitHub body through the same App/PAT transport the
 * worker uses, so detection reflects what is actually on GitHub. --dry-run makes
 * only reads. A real run never closes, recreates or force-pushes a PR: each
 * affected draft is re-rendered to public identity and updated through the
 * existing adoptive update path, and the DB row body is written only once GitHub
 * confirms the update. Idempotent, and the fail-closed guard blocks any re-render
 * that would still leak. Not wired into boot or any schedule.
 */
import { createDb, type AppDb } from "@mendpoint/db";
import {
  createPipelineDeliveryResolver,
  refreshOpenDraftBodies,
  type PipelineInput,
  type RefreshTenantResult,
} from "@mendpoint/pipeline";
import { classifyDependencyOutage } from "@mendpoint/ops";

const apply = process.argv.includes("--apply");
const dryRun = !apply || process.argv.includes("--dry-run");
const tenantArgIndex = process.argv.indexOf("--tenant");
const tenantId = tenantArgIndex >= 0 ? process.argv[tenantArgIndex + 1] : undefined;

function reportList(label: string, urls: ReadonlyArray<string>): void {
  if (urls.length === 0) return;
  console.log(`    ${label} (${urls.length}): ${urls.filter(Boolean).join(", ")}`);
}

function reportTenant(t: RefreshTenantResult): void {
  console.log(`  tenant=${t.tenantSlug} (${t.tenantId}) affected=${t.affected} updated=${t.updated}`);
  reportList("needs a human (foreign head)", t.skippedForeignHead);
  reportList("human-edited (left untouched)", t.skippedHumanEdited);
  reportList("closed/merged", t.skippedClosed);
  reportList("no write-ahead artifact", t.skippedNoArtifact);
  reportList("blocked by guard (still leaked)", t.blocked);
  reportList("failed", t.failed);
}

async function main(): Promise<void> {
  const db = createDb();
  const reposDir = process.env.MENDPOINT_REPOS_DIR?.trim() || null;

  // Per-tenant delivery resolver, built exactly as the worker builds it, so the
  // live-body read and any update go through the same adoptive App/PAT transport
  // (and its fail-closed guard).
  const resolvers = new Map<string, ReturnType<typeof createPipelineDeliveryResolver>>();
  const deliveryFor = (
    tid: string,
    consumer: Parameters<ReturnType<typeof createPipelineDeliveryResolver>>[0],
    repo: Parameters<ReturnType<typeof createPipelineDeliveryResolver>>[1],
  ) => {
    let resolver = resolvers.get(tid);
    if (!resolver) {
      resolver = createPipelineDeliveryResolver(
        { tenantId: tid, providerSlug: "", db, dependencyOutagePolicy: classifyDependencyOutage } as PipelineInput,
        db as AppDb,
      );
      resolvers.set(tid, resolver);
    }
    return resolver(consumer, repo);
  };

  const result = await refreshOpenDraftBodies({
    db,
    reposDir,
    tenantId: tenantId ?? null,
    dryRun,
    deliveryFor,
  });

  console.log(dryRun ? "[refresh:pr-body-identity] DRY RUN (reads only, no writes)" : "[refresh:pr-body-identity] APPLY");
  for (const t of result.tenants) {
    if (t.affected === 0) continue;
    reportTenant(t);
  }
  console.log(
    dryRun
      ? `[refresh:pr-body-identity] total affected open drafts: ${result.totalAffected}`
      : `[refresh:pr-body-identity] total updated: ${result.totalUpdated} of ${result.totalAffected} affected`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
