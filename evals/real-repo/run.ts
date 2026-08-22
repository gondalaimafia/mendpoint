/**
 * Real-repository harness — CLI driver.
 *
 *   tsx evals/real-repo/run.ts                 # clone if needed, run, write report
 *   tsx evals/real-repo/run.ts --no-clone      # fail if the clone is absent
 *
 * Clones the pinned commit into CLONE_ROOT (outside this git repo), runs the
 * repository through Fettler, grades against the sealed answer key, and writes:
 *   evals/real-repo/reports/<scenario>.md    the evidence scorecard
 *   evals/real-repo/reports/<scenario>.json  the raw run result
 *
 * NOTHING is ever written back to the upstream repository: this only clones and
 * reads. The clone is a detached checkout at the pinned commit.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSealedAnswerKey } from "./inject.js";
import { runRealRepoFettler } from "./harness.js";
import { renderRealRepoReport } from "./report.js";
import {
  CLONE_ROOT,
  clonePathFor,
  OPENAI_QUICKSTART,
  REPO_ROOT,
  type RealRepoManifest,
} from "./manifest.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function evalRepoCommit(): string {
  try {
    return git(["rev-parse", "--short", "HEAD"], REPO_ROOT);
  } catch {
    return "unknown";
  }
}

function productVersion(commit: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
    return `mendpoint@${pkg.version}+${commit}`;
  } catch {
    return `mendpoint@unknown+${commit}`;
  }
}

/**
 * Ensure the manifest's repository is cloned at exactly its pinned commit. A
 * detached checkout at the commit; no branch, no writes to upstream. Idempotent:
 * an existing clone already at the commit is left untouched.
 */
function ensureClone(manifest: RealRepoManifest): void {
  const clonePath = clonePathFor(manifest);
  if (existsSync(join(clonePath, ".git"))) {
    const head = git(["rev-parse", "HEAD"], clonePath);
    if (head === manifest.commit) return;
    // Fetch and check out the pinned commit into the existing clone.
    git(["fetch", "--quiet", "origin", manifest.commit], clonePath);
    git(["checkout", "--quiet", "--detach", manifest.commit], clonePath);
    return;
  }
  mkdirSync(CLONE_ROOT, { recursive: true });
  git(["clone", "--quiet", manifest.repoUrl, clonePath]);
  git(["checkout", "--quiet", "--detach", manifest.commit], clonePath);
}

async function main(): Promise<void> {
  const noClone = process.argv.includes("--no-clone");
  const manifest = OPENAI_QUICKSTART;

  if (!noClone) ensureClone(manifest);

  const commit = evalRepoCommit();
  const ctx = { gitCommit: commit, productVersion: productVersion(commit) };

  const result = await runRealRepoFettler(manifest, ctx);
  const key = loadSealedAnswerKey(manifest);
  const report = renderRealRepoReport(result, key);

  const reportsDir = join(HERE, "reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, `${manifest.scenarioId}.md`), report + "\n", "utf8");
  writeFileSync(
    join(reportsDir, `${manifest.scenarioId}.json`),
    JSON.stringify(result, null, 2) + "\n",
    "utf8",
  );

  console.log(report);
  console.log("");
  console.log(
    `wrote evals/real-repo/reports/${manifest.scenarioId}.md and .json`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
