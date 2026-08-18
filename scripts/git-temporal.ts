/**
 * Backfill git history into graph-learn (12mo default).
 * Usage: npm run graph:temporal -- [repoPath] [--months=12] [--max=2000]
 */
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getGraphLearnDb,
  backfillGitTemporal,
  runGraphQuery,
} from "@mendpoint/graph-learn";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split("=").slice(1).join("=");
  return fallback;
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const repoPath = resolve(positional[0] ?? root);
  const months = Number(arg("months", "12"));
  const maxCommits = Number(arg("max", "2000"));
  const repoId = arg("repo-id");

  console.log(`=== Git temporal backfill ===`);
  console.log(`repo: ${repoPath}`);
  console.log(`months: ${months} maxCommits: ${maxCommits}`);

  const db = getGraphLearnDb();
  const result = backfillGitTemporal(db, {
    repoPath,
    months,
    maxCommits,
    repoId,
  });
  console.log(JSON.stringify(result, null, 2));

  // Scope the read-back to the repo we just backfilled: every ingested node
  // carries repo_id === result.repoId, so this tenant view counts exactly the
  // history written above rather than the global cross-tenant graph.
  const scope = { tenantId: result.repoId };

  const stats = runGraphQuery(db, { op: "stats" }, scope);
  console.log("graph:", stats.summary);

  const now = new Date().toISOString();
  const tt = runGraphQuery(db, {
    op: "time_travel_modifies",
    at: now,
    repoId: result.repoId,
  }, scope);
  console.log("time_travel_modifies now:", tt.summary);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
