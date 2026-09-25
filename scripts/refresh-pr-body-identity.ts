/**
 * One-time operator command: refresh OPEN draft PR bodies delivered before #713
 * that still carry the tenant id or the server checkout path (#724).
 *
 *   tsx scripts/refresh-pr-body-identity.ts --dry-run             # count, write nothing
 *   tsx scripts/refresh-pr-body-identity.ts --dry-run --tenant <id>
 *   tsx scripts/refresh-pr-body-identity.ts --apply               # re-render + update PRs
 *
 * (No npm script is added; package.json is a pinned closure-authority file.)
 *
 * Run inside the deployment boundary (it reads the configured DB and, for --apply,
 * the same GitHub App credentials the worker uses). It never closes, recreates or
 * force-pushes a PR: each affected draft is re-rendered to public identity and
 * updated through the existing adoptive update path. Idempotent, and the
 * fail-closed guard blocks any re-render that would still leak. Not wired into
 * boot or any schedule — an operator runs --dry-run first and decides.
 */
import { createDb, type AppDb } from "@mendpoint/db";
import {
  createPipelineDeliveryResolver,
  refreshOpenDraftBodies,
  type PipelineInput,
} from "@mendpoint/pipeline";
import { classifyDependencyOutage } from "@mendpoint/ops";

const apply = process.argv.includes("--apply");
const dryRun = !apply || process.argv.includes("--dry-run");
const tenantArgIndex = process.argv.indexOf("--tenant");
const tenantId = tenantArgIndex >= 0 ? process.argv[tenantArgIndex + 1] : undefined;

async function main(): Promise<void> {
  const db = createDb();
  const reposDir = process.env.MENDPOINT_REPOS_DIR?.trim() || null;

  // Per-tenant delivery resolver, built exactly as the worker builds it, so a real
  // run updates PRs through the same adoptive App/PAT/mock transport (and its guard).
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
    ...(dryRun ? {} : { deliveryFor }),
  });

  console.log(dryRun ? "[refresh:pr-body-identity] DRY RUN (no writes)" : "[refresh:pr-body-identity] APPLY");
  for (const t of result.tenants) {
    if (t.affected === 0 && dryRun) continue;
    console.log(
      dryRun
        ? `  tenant=${t.tenantSlug} (${t.tenantId}) affected=${t.affected}`
        : `  tenant=${t.tenantSlug} (${t.tenantId}) affected=${t.affected} updated=${t.updated} skipped=${t.skipped} blocked=${t.blocked}`,
    );
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
