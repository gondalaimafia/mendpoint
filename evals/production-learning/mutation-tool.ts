import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { FixtureManifest } from "./fixture.js";

export interface MutationApplication {
  caseId: string;
  repositoryPath: string;
  baseCommit: string;
  pristineSnapshotSha256: string;
  patchSha256: string;
  changedPaths: string[];
  rollbackRequired: true;
}

function git(repoPath: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git_${args[0]}_failed:${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function gitBuffer(repoPath: string, args: string[]): Buffer {
  const result = spawnSync("git", ["-C", repoPath, ...args], { encoding: "buffer", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git_${args[0]}_failed:${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeInside(root: string, candidate: string): string {
  const realRoot = realpathSync(root);
  const resolved = resolve(candidate);
  const rel = relative(realRoot, resolved);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return resolved;
  throw new Error(`path_outside_authorized_root:${candidate}`);
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let expression = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (char === "*") expression += "[^/]*";
    else expression += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`);
}

function pathAllowed(path: string, boundaries: readonly string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  return boundaries.some((boundary) => globPattern(boundary).test(normalized));
}

export function computeTrackedSnapshotSha256(repoPath: string): string {
  const root = realpathSync(repoPath);
  const tracked = git(root, ["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const trackedPath of tracked) {
    const absolute = safeInside(root, resolve(root, trackedPath));
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`tracked_symlink_not_allowed:${trackedPath}`);
    if (!stat.isFile()) throw new Error(`tracked_entry_not_regular_file:${trackedPath}`);
    hash.update(trackedPath.replace(/\\/g, "/"));
    hash.update("\0");
    // Hash the index blob, not the checked-out bytes. Windows core.autocrlf can
    // rewrite line endings in the worktree, while provenance binds immutable Git
    // objects. The clean-repository precondition guarantees index and HEAD agree.
    hash.update(gitBuffer(root, ["show", `:${trackedPath}`]));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function applyFixtureMutation(input: {
  benchmarkRoot: string;
  repositoryPath: string;
  patchRoot: string;
  manifest: FixtureManifest;
}): MutationApplication {
  const repositoryPath = safeInside(input.benchmarkRoot, input.repositoryPath);
  const patchPath = safeInside(input.patchRoot, resolve(input.patchRoot, input.manifest.mutation.patchPath));
  const head = git(repositoryPath, ["rev-parse", "HEAD"]).trim();
  if (head !== input.manifest.repository.immutableCommit) throw new Error("repository_commit_mismatch");
  if (git(repositoryPath, ["status", "--porcelain=v1"]).trim().length > 0) {
    throw new Error("repository_must_be_pristine_before_mutation");
  }
  const pristine = computeTrackedSnapshotSha256(repositoryPath);
  if (pristine !== input.manifest.repository.pristineSnapshotSha256) {
    throw new Error("repository_snapshot_digest_mismatch");
  }
  const patch = readFileSync(patchPath);
  const patchDigest = sha256(patch);
  if (patchDigest !== input.manifest.mutation.patchSha256) throw new Error("mutation_patch_digest_mismatch");
  git(repositoryPath, ["apply", "--check", "--whitespace=error-all", patchPath]);
  git(repositoryPath, ["apply", "--whitespace=error-all", patchPath]);
  const changedPaths = git(repositoryPath, ["diff", "--name-only", "--diff-filter=ACMRTUXB"])
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
  if (changedPaths.length === 0) throw new Error("mutation_changed_no_tracked_paths");
  const escaped = changedPaths.filter((path) => !pathAllowed(path, input.manifest.allowedEditPaths));
  if (escaped.length > 0) {
    git(repositoryPath, ["apply", "--reverse", patchPath]);
    throw new Error(`mutation_edit_boundary_violation:${escaped.join(",")}`);
  }
  const diffProblems = git(repositoryPath, ["diff", "--check"]).trim();
  if (diffProblems.length > 0) {
    git(repositoryPath, ["apply", "--reverse", patchPath]);
    throw new Error(`mutation_diff_integrity_failed:${diffProblems}`);
  }
  return {
    caseId: input.manifest.caseId,
    repositoryPath,
    baseCommit: head,
    pristineSnapshotSha256: pristine,
    patchSha256: patchDigest,
    changedPaths,
    rollbackRequired: true,
  };
}

export function rollbackFixtureMutation(input: {
  benchmarkRoot: string;
  repositoryPath: string;
  patchRoot: string;
  manifest: FixtureManifest;
}): { rolledBack: true; pristineSnapshotSha256: string } {
  const repositoryPath = safeInside(input.benchmarkRoot, input.repositoryPath);
  const patchPath = safeInside(input.patchRoot, resolve(input.patchRoot, input.manifest.mutation.patchPath));
  const patch = readFileSync(patchPath);
  if (sha256(patch) !== input.manifest.rollback.reversePatchSha256) {
    throw new Error("rollback_patch_digest_mismatch");
  }
  git(repositoryPath, ["apply", "--reverse", "--check", patchPath]);
  git(repositoryPath, ["apply", "--reverse", patchPath]);
  if (git(repositoryPath, ["status", "--porcelain=v1"]).trim().length > 0) {
    throw new Error("rollback_did_not_restore_clean_repository");
  }
  const pristineSnapshotSha256 = computeTrackedSnapshotSha256(repositoryPath);
  if (pristineSnapshotSha256 !== input.manifest.cleanup.pristineTreeSha256) {
    throw new Error("rollback_pristine_snapshot_mismatch");
  }
  return { rolledBack: true, pristineSnapshotSha256 };
}
