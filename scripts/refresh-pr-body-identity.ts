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
  refreshHadFailures,
  type PipelineInput,
} from "@mendpoint/pipeline";
import { classifyDependencyOutage } from "@mendpoint/ops";
import { reportRefresh } from "./refresh-pr-body-identity-report.js";

const apply = process.argv.includes("--apply");
const dryRun = !apply || process.argv.includes("--dry-run");
const tenantArgIndex = process.argv.indexOf("--tenant");
const tenantId = tenantArgIndex >= 0 ? process.argv[tenantArgIndex + 1] : undefined;

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

  const failedCount = reportRefresh(result, { dryRun });

  // A revoked installation or a 403 reading one PR is isolated per draft and
  // recorded as `failed` (#730); the sweep still processes the rest, but the
  // command exits non-zero so an operator notices the failed drafts. The report
  // above prints every tenant that has failures even when none was affected.
  if (refreshHadFailures(result)) {
    console.error(`[refresh:pr-body-identity] ${failedCount} draft(s) failed; see 'failed' above`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
