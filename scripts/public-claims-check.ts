import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  detectStaleClaims,
  validatePublicClaimRegistry,
  type ClaimStalenessComparison,
  type PublicClaimIssue,
  type PublicClaimRegistry,
} from "../packages/contract/src/public-claims.js";
import type { ProductRequirementManifest } from "../packages/contract/src/product-requirements.js";

function repositoryPath(repoRoot: string, locator: string) {
  const path = locator.split("#", 1)[0];
  const resolved = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`claim evidence escapes repository: ${locator}`);
  }
  return resolved;
}

const REVISION = /^[a-f0-9]{40}$/;

/**
 * Live evidence asserts that someone probed a URL at a specific instant and
 * pins the `revision` the deployment was serving. The contract validator checks
 * that the revision is well-formed and equals the registry auditedRevision, but
 * it is a pure function with no repository access, so it cannot tell a real
 * commit from a fabricated forty-hex string. This does: every well-formed live
 * revision must resolve to an actual commit object in this repository. A batch
 * of PRs stamped `observedAt` while pinning a revision that was never committed
 * here; that is exactly what this catches. Malformed or mismatched revisions
 * are left to the contract validator so we do not double-report them.
 */
export function revisionReachabilityIssues(
  registry: PublicClaimRegistry,
  revisionExists: (revision: string) => boolean,
): PublicClaimIssue[] {
  const issues: PublicClaimIssue[] = [];
  for (const claim of registry.claims ?? []) {
    for (const evidence of claim.evidence ?? []) {
      if (evidence.type !== "live") continue;
      if (typeof evidence.revision !== "string" || !REVISION.test(evidence.revision)) continue;
      if (!revisionExists(evidence.revision)) {
        issues.push({
          code: "LIVE_EVIDENCE_REVISION_UNREACHABLE",
          subject: evidence.id,
          message: `revision ${evidence.revision} is not a commit in this repository`,
        });
      }
    }
  }
  return issues;
}

function gitRevisionExists(repoRoot: string, revision: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision}^{commit}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/**
 * Compares the audited revision against the shipped HEAD so {@link
 * detectStaleClaims} can tell which claims describe code that moved since the
 * audit. Every branch that cannot yield a trustworthy comparison returns
 * `indeterminate`, which fails the gate instead of passing silently. CI often
 * checks out shallow, so a missing audited object is reported explicitly.
 */
function compareSurfaces(
  repoRoot: string,
  auditedRevision: string,
): ClaimStalenessComparison {
  let insideWorkTree: string;
  try {
    insideWorkTree = git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  } catch {
    return { status: "indeterminate", reason: "not a Git work tree" };
  }
  if (insideWorkTree !== "true") {
    return { status: "indeterminate", reason: "not a Git work tree" };
  }

  let headRevision: string;
  try {
    headRevision = git(repoRoot, ["rev-parse", "HEAD"]);
  } catch {
    return { status: "indeterminate", reason: "HEAD could not be resolved" };
  }

  let shallow = "false";
  try {
    shallow = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  } catch {
    // Older Git versions lack this flag; fall through and let cat-file decide.
  }

  try {
    git(repoRoot, ["cat-file", "-e", `${auditedRevision}^{commit}`]);
  } catch {
    return {
      status: "indeterminate",
      reason:
        shallow === "true"
          ? `auditedRevision is absent from this shallow clone; fetch full history (git fetch --unshallow) to audit`
          : `auditedRevision is not a known commit object in this repository`,
    };
  }

  try {
    execFileSync("git", ["merge-base", "--is-ancestor", auditedRevision, headRevision], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return {
        status: "indeterminate",
        reason: `auditedRevision is not an ancestor of HEAD ${headRevision}`,
      };
    }
    return {
      status: "indeterminate",
      reason: `ancestry check between auditedRevision and HEAD ${headRevision} failed`,
    };
  }

  let changedPaths: string[];
  try {
    changedPaths = git(repoRoot, ["diff", "--name-only", auditedRevision, headRevision])
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return {
      status: "indeterminate",
      reason: `diff between auditedRevision and HEAD ${headRevision} failed`,
    };
  }

  return { status: "comparable", headRevision, changedPaths };
}

function main() {
  const repoRoot = resolve(process.cwd());
  const registryPath = resolve(repoRoot, "docs", "PUBLIC_CLAIMS.json");
  const requirementsPath = resolve(repoRoot, "docs", "PRODUCT_REQUIREMENTS.json");
  if (!existsSync(registryPath)) throw new Error("docs/PUBLIC_CLAIMS.json is missing");
  if (!existsSync(requirementsPath)) throw new Error("docs/PRODUCT_REQUIREMENTS.json is missing");

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as PublicClaimRegistry;
  const requirements = JSON.parse(
    readFileSync(requirementsPath, "utf8"),
  ) as ProductRequirementManifest;
  const issues = validatePublicClaimRegistry(registry, {
    requirements: requirements.requirements ?? [],
    asOf: new Date(),
  });
  issues.push(
    ...detectStaleClaims(registry, compareSurfaces(repoRoot, registry.auditedRevision)),
  );
  for (const claim of registry.claims ?? []) {
    let boundSurface = false;
    for (const surfacePath of claim.surfacePaths ?? []) {
      const resolvedSurface = repositoryPath(repoRoot, surfacePath);
      if (!existsSync(resolvedSurface)) {
        issues.push({
          code: "SURFACE_PATH_MISSING",
          subject: claim.id,
          message: `${surfacePath} does not exist`,
        });
      } else if (readFileSync(resolvedSurface, "utf8").includes(claim.id)) {
        boundSurface = true;
      }
    }
    if (!boundSurface) {
      issues.push({
        code: "CLAIM_SURFACE_BINDING_MISSING",
        subject: claim.id,
        message: "at least one mapped surface must bind the claim by ID",
      });
    }
    for (const evidence of claim.evidence ?? []) {
      if (["live", "external"].includes(evidence.type)) continue;
      if (!existsSync(repositoryPath(repoRoot, evidence.locator))) {
        issues.push({
          code: "EVIDENCE_MISSING",
          subject: evidence.id,
          message: `${evidence.locator} does not exist`,
        });
      }
    }
  }
  issues.push(
    ...revisionReachabilityIssues(registry, (revision) => gitRevisionExists(repoRoot, revision)),
  );

  if (issues.length > 0) {
    for (const issue of issues.sort((left, right) => left.code.localeCompare(right.code))) {
      console.error(`${issue.code} ${issue.subject}: ${issue.message}`);
    }
    throw new Error(`public claim registry has ${issues.length} issue${issues.length === 1 ? "" : "s"}`);
  }

  console.log(`PUBLIC CLAIMS PASS: ${registry.claims.length} claims, ${registry.destinations.length} destinations`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
