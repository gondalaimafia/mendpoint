import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildComparison, isAncestor, runRefresh } from "./refresh-live-evidence.js";
import {
  detectStaleClaims,
  type PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";

const root = resolve(import.meta.dirname, "..");
const REAL_REGISTRY = readFileSync(resolve(root, "docs/PUBLIC_CLAIMS.json"), "utf8");
const REAL_REQUIREMENTS = readFileSync(resolve(root, "docs/PRODUCT_REQUIREMENTS.json"), "utf8");

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rle-io-"));
  git(repo, ["-c", "init.defaultBranch=main", "init"]);
  return repo;
}

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]);
}

describe("buildComparison (IO, real temp repo)", () => {
  it("diffs old..deployed, NOT old..HEAD, so a surface changed only after deploy is not stale", () => {
    const repo = initRepo();
    const SURFACE = "apps/web/app/access/page.tsx";
    mkdirSync(join(repo, "apps/web/app/access"), { recursive: true });
    mkdirSync(join(repo, "docs"), { recursive: true });
    writeFileSync(
      join(repo, "docs/PUBLIC_CLAIMS.json"),
      JSON.stringify({ claims: [{ id: "CLM-013", surfacePaths: [SURFACE] }] }),
    );
    writeFileSync(join(repo, SURFACE), "v1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const old = head(repo);

    writeFileSync(join(repo, "README.md"), "deployed\n"); // C2: unrelated file
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c2"]);
    const deployed = head(repo);

    writeFileSync(join(repo, SURFACE), "v3\n"); // C3 (HEAD): change the surface
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c3"]);

    const comparison = buildComparison(repo, old, deployed);
    expect(comparison.status).toBe("comparable");
    if (comparison.status !== "comparable") return;
    expect(comparison.changedPaths).toContain("README.md");
    expect(comparison.changedPaths).not.toContain(SURFACE);

    const current: Pick<PublicClaimRegistry, "auditedRevision" | "claims"> = {
      auditedRevision: old,
      claims: [{ id: "CLM-013", surfacePaths: [SURFACE] } as PublicClaimRegistry["claims"][number]],
    };
    // A diff of old..HEAD (the mutation) would include SURFACE and flag
    // CLAIM_SURFACE_STALE here, so this assertion dies under that mutation.
    expect(detectStaleClaims(current, comparison)).toEqual([]);
  });
});

describe("isAncestor (IO, real temp repo)", () => {
  it("is true for an ancestor and false for a divergent side commit", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const c1 = head(repo);
    writeFileSync(join(repo, "a.txt"), "2\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c2"]);
    const mainTip = head(repo);
    git(repo, ["checkout", "-b", "side", c1]);
    writeFileSync(join(repo, "b.txt"), "s\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "side"]);
    const sideTip = head(repo);

    expect(isAncestor(repo, c1, mainTip)).toBe("ancestor");
    expect(isAncestor(repo, sideTip, mainTip)).toBe("not-ancestor");
  });

  it("returns undetermined for a git error, never a definitive not-ancestor", () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const real = head(repo);
    // A bad object makes `git merge-base --is-ancestor` exit 128 (not 1). That is
    // undetermined, not a definitive "not an ancestor" — the exact third-state
    // the fix closes.
    const missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    expect(isAncestor(repo, missing, real)).toBe("undetermined");
    expect(isAncestor(repo, real, missing)).toBe("undetermined");
  });
});

/** A stub fetch: /version returns `revision`, /healthz returns {ok:true}, else {}. */
function fakeFetch(revision: string) {
  const body = (obj: unknown) => ({
    ok: true,
    status: 200,
    json: async () => obj,
    clone: () => ({ json: async () => obj }),
  });
  return async (input: string) => {
    // A few ms of "latency" so successive observedAt instants differ (the core
    // correctly refuses two observations sharing one millisecond). Real network
    // requests space themselves out; an instant stub would not.
    await new Promise((r) => setTimeout(r, 3));
    if (input.endsWith("/version")) return body({ revision });
    if (input.endsWith("/healthz")) return body({ ok: true });
    return body({});
  };
}

/** Real registry with live locators pointed at a fake host and audited pinned. */
function registryFor(auditedRevision: string): string {
  return REAL_REGISTRY.replaceAll(
    "https://mendpoint-fettler-production.fly.dev",
    "https://prod.example.invalid",
  ).replace(/("auditedRevision"\s*:\s*")[a-f0-9]{40}(")/, `$1${auditedRevision}$2`);
}

function seedRepo(repo: string, auditedRevision: string): void {
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs/PRODUCT_REQUIREMENTS.json"), REAL_REQUIREMENTS);
  writeFileSync(join(repo, "docs/PUBLIC_CLAIMS.json"), registryFor(auditedRevision));
}

describe("runRefresh (IO wiring, real temp repo + stub fetch)", () => {
  it("refuses when the deployed revision is not an ancestor of origin/main", async () => {
    const repo = initRepo();
    seedRepo(repo, "0".repeat(40));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const c1 = head(repo);
    writeFileSync(join(repo, "docs/PUBLIC_CLAIMS.json"), registryFor(c1)); // C2 pins audited=C1
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c2"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", head(repo)]);
    git(repo, ["checkout", "-b", "side", c1]); // a commit NOT on main
    writeFileSync(join(repo, "side.txt"), "s\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "side"]);
    const sideTip = head(repo);
    git(repo, ["checkout", "main"]);

    const { exitCode, summary } = await runRefresh({
      cwd: repo,
      argv: ["--dry-run", "--force"],
      fetchImpl: fakeFetch(sideTip),
    });
    expect(exitCode).toBe(1);
    expect(summary.outcome).toBe("refused");
    expect(String(summary.refusalReason)).toContain("not an ancestor of origin/main");
    expect(summary.wrote).toBe(false);
  });

  it("dry-run refreshes using old..deployed, so a surface changed only after deploy is not stale", async () => {
    const repo = initRepo();
    const SURFACE = "apps/web/app/access/page.tsx"; // a CLM-013 surface in the real registry
    mkdirSync(join(repo, "apps/web/app/access"), { recursive: true });
    seedRepo(repo, "0".repeat(40));
    writeFileSync(join(repo, SURFACE), "v1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const c1 = head(repo);
    writeFileSync(join(repo, "docs/PUBLIC_CLAIMS.json"), registryFor(c1)); // C2 (deployed)
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c2"]);
    const deployed = head(repo);
    writeFileSync(join(repo, SURFACE), "v3\n"); // C3 (HEAD): surface changes AFTER deploy
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c3"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", head(repo)]);

    const { exitCode, summary } = await runRefresh({
      cwd: repo,
      argv: ["--dry-run", "--force"],
      fetchImpl: fakeFetch(deployed),
    });
    // old..deployed (c1..c2) touched only the registry, so no surface is stale.
    // The mutation to old..HEAD (c1..c3) would include the surface and refuse.
    expect(exitCode).toBe(0);
    expect(summary.outcome).toBe("dry_run");
    expect(summary.newRevision).toBe(deployed);
    expect(summary.oldRevision).toBe(c1);
    expect(summary.wrote).toBe(false);
  });

  it("refuses when the deployed revision would move auditedRevision backward", async () => {
    // Deployed revision is an ANCESTOR of the current auditedRevision (a
    // rollback), so advancing auditedRevision to it would move it backward.
    const repo = initRepo();
    seedRepo(repo, "0".repeat(40));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c1"]);
    const c1 = head(repo);
    writeFileSync(join(repo, "extra.txt"), "x\n"); // C2
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c2"]);
    const c2 = head(repo);
    // Pin auditedRevision to C2 (newer) while production serves C1 (older).
    writeFileSync(join(repo, "docs/PUBLIC_CLAIMS.json"), registryFor(c2));
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-m", "c3"]);
    git(repo, ["update-ref", "refs/remotes/origin/main", head(repo)]);

    const { exitCode, summary } = await runRefresh({
      cwd: repo,
      argv: ["--dry-run", "--force"],
      fetchImpl: fakeFetch(c1), // deployed = C1, older than audited C2
    });
    expect(exitCode).toBe(1);
    expect(summary.outcome).toBe("refused");
    expect(String(summary.refusalReason)).toContain("would move auditedRevision backward");
  });
});
