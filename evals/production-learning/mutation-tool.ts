import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
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
  const realCandidate = realpathSync(resolve(candidate));
  const rel = relative(realRoot, realCandidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) return realCandidate;
  throw new Error(`path_outside_authorized_root:${candidate}`);
}

function parsePorcelainPaths(output: string): string[] {
  const records = output.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("git_status_porcelain_invalid");
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    if (status.includes("R") || status.includes("C")) {
      const sourcePath = records[index + 1];
      if (!sourcePath) throw new Error("git_status_porcelain_rename_source_missing");
      paths.push(sourcePath);
      index += 1;
    }
  }
  return paths;
}

function collectWorktreeChanges(repoPath: string): string[] {
  const paths = new Set(
    parsePorcelainPaths(git(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])),
  );
  for (const ignoredPath of git(repoPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)) {
    paths.add(ignoredPath);
  }
  return [...paths].sort();
}

function reverseAppliedPatch(repoPath: string, patchPath: string): void {
  try {
    git(repoPath, ["apply", "--reverse", "--check", patchPath]);
    git(repoPath, ["apply", "--reverse", patchPath]);
    // A successful forward check proves the reverse operation restored the
    // patch preimage even when Git status is hidden by assume-unchanged bits.
    git(repoPath, ["apply", "--check", "--whitespace=error-all", patchPath]);
  } catch (error) {
    throw new Error(`mutation_rollback_failed:${error instanceof Error ? error.message : String(error)}`);
  }
  const residualPaths = collectWorktreeChanges(repoPath);
  if (residualPaths.length > 0) {
    throw new Error(`mutation_rollback_failed:repository_not_pristine:${residualPaths.join(",")}`);
  }
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
  const tracked = git(root, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort();
  const hash = createHash("sha256");
  for (const record of tracked) {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/.exec(record);
    if (match === null) throw new Error("git_index_record_invalid");
    const [, mode, objectId, stage, trackedPath] = match;
    if (stage !== "0") throw new Error(`tracked_entry_unmerged:${trackedPath}`);
    if (!(mode === "100644" || mode === "100755" || mode === "120000")) {
      throw new Error(`tracked_entry_mode_not_allowed:${trackedPath}:${mode}`);
    }
    if (mode === "120000") {
      const target = gitBuffer(root, ["show", `:${trackedPath}`]).toString("utf8");
      safeInside(root, resolve(dirname(resolve(root, trackedPath)), target));
    }
    hash.update(trackedPath.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(mode);
    hash.update("\0");
    hash.update(objectId);
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
  if (collectWorktreeChanges(repositoryPath).length > 0) {
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
  const changedPaths = collectWorktreeChanges(repositoryPath);
  if (changedPaths.length === 0) {
    reverseAppliedPatch(repositoryPath, patchPath);
    throw new Error("mutation_changed_no_paths");
  }
  const escaped = changedPaths.filter((path) => !pathAllowed(path, input.manifest.allowedEditPaths));
  if (escaped.length > 0) {
    reverseAppliedPatch(repositoryPath, patchPath);
    throw new Error(`mutation_edit_boundary_violation:${escaped.join(",")}`);
  }
  const diffProblems = git(repositoryPath, ["diff", "--check"]).trim();
  if (diffProblems.length > 0) {
    reverseAppliedPatch(repositoryPath, patchPath);
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
  reverseAppliedPatch(repositoryPath, patchPath);
  const pristineSnapshotSha256 = computeTrackedSnapshotSha256(repositoryPath);
  if (pristineSnapshotSha256 !== input.manifest.cleanup.pristineTreeSha256) {
    throw new Error("rollback_pristine_snapshot_mismatch");
  }
  return { rolledBack: true, pristineSnapshotSha256 };
}
