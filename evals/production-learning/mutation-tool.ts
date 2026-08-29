import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import type { AdmittedFixture } from "./fixture.js";

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

function assertDefaultIndexFlags(repoPath: string): void {
  for (const record of git(repoPath, ["ls-files", "-v", "-z"]).split("\0").filter(Boolean)) {
    if (record.length < 3 || record[1] !== " ") throw new Error("git_index_flag_record_invalid");
    const tag = record[0]!;
    const trackedPath = record.slice(2);
    if (tag !== "H") throw new Error(`tracked_entry_index_flag_not_allowed:${trackedPath}:${tag}`);
  }
}

function assertSymlinkTargetInside(root: string, linkPath: string, target: string): void {
  if (isAbsolute(target)) throw new Error(`symlink_target_outside_authorized_root:${linkPath}`);
  const absoluteTarget = resolve(dirname(linkPath), target);
  const lexical = relative(root, absoluteTarget);
  if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`symlink_target_outside_authorized_root:${linkPath}`);
  }
  if (existsSync(absoluteTarget)) safeInside(root, absoluteTarget);
}

function trackedIndexEntries(repoPath: string): Array<{ mode: string; objectId: string; path: string }> {
  return git(repoPath, ["ls-files", "-s", "-z"])
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((record) => {
      const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/.exec(record);
      if (match === null) throw new Error("git_index_record_invalid");
      const mode = match[1]!;
      const objectId = match[2]!;
      const stage = match[3]!;
      const path = match[4]!;
      if (stage !== "0") throw new Error(`tracked_entry_unmerged:${path}`);
      if (!(mode === "100644" || mode === "100755" || mode === "120000")) {
        throw new Error(`tracked_entry_mode_not_allowed:${path}:${mode}`);
      }
      return { mode, objectId, path };
    });
}

function assertTrackedWorktreeMatchesIndex(repoPath: string): void {
  const root = realpathSync(repoPath);
  assertDefaultIndexFlags(root);
  const refresh = spawnSync("git", ["-C", root, "update-index", "--really-refresh", "-q"], { encoding: "utf8", windowsHide: true });
  if (refresh.status !== 0 && refresh.status !== 1) throw new Error(`git_update-index_failed:${refresh.stderr.trim()}`);
  const diff = spawnSync("git", ["-C", root, "diff-files", "--quiet", "--ignore-submodules", "--"], { encoding: "utf8", windowsHide: true });
  if (diff.status === 1) throw new Error("tracked_worktree_content_mismatch");
  if (diff.status !== 0) throw new Error(`git_diff-files_failed:${diff.stderr.trim()}`);
  for (const entry of trackedIndexEntries(root)) {
    const worktreePath = resolve(root, entry.path);
    if (!existsSync(worktreePath)) throw new Error(`tracked_entry_missing:${entry.path}`);
    const stat = lstatSync(worktreePath);
    if (entry.mode === "120000") {
      const expected = gitBuffer(root, ["show", `:${entry.path}`]);
      let actual: Buffer;
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(worktreePath);
        assertSymlinkTargetInside(root, worktreePath, target);
        actual = Buffer.from(target, "utf8");
      } else if (process.platform === "win32" && stat.isFile()) {
        actual = readFileSync(worktreePath);
        assertSymlinkTargetInside(root, worktreePath, actual.toString("utf8"));
      } else {
        throw new Error(`tracked_entry_type_mismatch:${entry.path}`);
      }
    } else {
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`tracked_entry_type_mismatch:${entry.path}`);
      if (process.platform !== "win32") {
        const executable = (stat.mode & 0o111) !== 0;
        if ((entry.mode === "100755") !== executable) throw new Error(`tracked_entry_mode_mismatch:${entry.path}`);
      }
    }
  }
}

function declaredSymlinkPaths(patchSummary: string): Set<string> {
  const paths = new Set<string>();
  for (const line of patchSummary.split(/\r?\n/)) {
    const match = /^\s*(?:create|mode change \d+ =>) mode 120000 (.+)$/.exec(line);
    if (match?.[1]) paths.add(match[1].trim());
  }
  return paths;
}

function assertChangedPathsSafe(repoPath: string, paths: readonly string[], patchSymlinkPaths: ReadonlySet<string>): void {
  const root = realpathSync(repoPath);
  for (const changedPath of paths) {
    const absolutePath = resolve(root, changedPath);
    const lexical = relative(root, absolutePath);
    if (lexical === ".." || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
      throw new Error(`changed_path_outside_repository:${changedPath}`);
    }
    if (!existsSync(absolutePath)) continue;
    const stat = lstatSync(absolutePath);
    const indexEntry = trackedIndexEntries(root).find((entry) => entry.path === changedPath);
    const intendedSymlink = stat.isSymbolicLink() || indexEntry?.mode === "120000" || patchSymlinkPaths.has(changedPath);
    if (intendedSymlink) {
      if (!stat.isSymbolicLink() && !(process.platform === "win32" && stat.isFile())) {
        throw new Error(`changed_path_type_not_allowed:${changedPath}`);
      }
      const target = stat.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath, "utf8");
      assertSymlinkTargetInside(root, absolutePath, target);
    } else if (stat.isSymbolicLink()) {
      assertSymlinkTargetInside(root, absolutePath, readlinkSync(absolutePath));
    } else if (!stat.isFile()) {
      throw new Error(`changed_path_type_not_allowed:${changedPath}`);
    }
  }
}

function reverseAppliedPatch(repoPath: string, patchPath: string, expectedSnapshotSha256: string): void {
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
  const restored = computeTrackedSnapshotSha256(repoPath);
  if (restored !== expectedSnapshotSha256) {
    throw new Error("mutation_rollback_failed:repository_snapshot_mismatch");
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
  assertTrackedWorktreeMatchesIndex(root);
  const tracked = trackedIndexEntries(root);
  const hash = createHash("sha256");
  for (const entry of tracked) {
    const bytes = entry.mode === "120000" && lstatSync(resolve(root, entry.path)).isSymbolicLink()
      ? Buffer.from(readlinkSync(resolve(root, entry.path)), "utf8")
      : readFileSync(resolve(root, entry.path));
    hash.update(entry.path.replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(entry.mode);
    hash.update("\0");
    hash.update(sha256(bytes));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function applyFixtureMutation(input: {
  benchmarkRoot: string;
  repositoryPath: string;
  patchRoot: string;
  admission: AdmittedFixture;
}): MutationApplication {
  const manifest = input.admission.manifest;
  const repositoryPath = safeInside(input.benchmarkRoot, input.repositoryPath);
  const patchPath = safeInside(input.patchRoot, resolve(input.patchRoot, manifest.mutation.patchPath));
  const head = git(repositoryPath, ["rev-parse", "HEAD"]).trim();
  if (head !== manifest.repository.immutableCommit) throw new Error("repository_commit_mismatch");
  if (collectWorktreeChanges(repositoryPath).length > 0) {
    throw new Error("repository_must_be_pristine_before_mutation");
  }
  const pristine = computeTrackedSnapshotSha256(repositoryPath);
  if (pristine !== manifest.repository.pristineSnapshotSha256) {
    throw new Error("repository_snapshot_digest_mismatch");
  }
  const patch = readFileSync(patchPath);
  const patchDigest = sha256(patch);
  if (patchDigest !== manifest.mutation.patchSha256) throw new Error("mutation_patch_digest_mismatch");
  const patchSymlinks = declaredSymlinkPaths(git(repositoryPath, ["apply", "--summary", patchPath]));
  git(repositoryPath, ["apply", "--check", "--whitespace=error-all", patchPath]);
  git(repositoryPath, ["apply", "--whitespace=error-all", patchPath]);
  const changedPaths = collectWorktreeChanges(repositoryPath);
  if (changedPaths.length === 0) {
    reverseAppliedPatch(repositoryPath, patchPath, pristine);
    throw new Error("mutation_changed_no_paths");
  }
  const escaped = changedPaths.filter((path) => !pathAllowed(path, manifest.allowedEditPaths));
  if (escaped.length > 0) {
    reverseAppliedPatch(repositoryPath, patchPath, pristine);
    throw new Error(`mutation_edit_boundary_violation:${escaped.join(",")}`);
  }
  try {
    assertChangedPathsSafe(repositoryPath, changedPaths, patchSymlinks);
  } catch (error) {
    reverseAppliedPatch(repositoryPath, patchPath, pristine);
    throw error;
  }
  const diffProblems = git(repositoryPath, ["diff", "--check"]).trim();
  if (diffProblems.length > 0) {
    reverseAppliedPatch(repositoryPath, patchPath, pristine);
    throw new Error(`mutation_diff_integrity_failed:${diffProblems}`);
  }
  return {
    caseId: manifest.caseId,
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
  admission: AdmittedFixture;
}): { rolledBack: true; pristineSnapshotSha256: string } {
  const manifest = input.admission.manifest;
  const repositoryPath = safeInside(input.benchmarkRoot, input.repositoryPath);
  const patchPath = safeInside(input.patchRoot, resolve(input.patchRoot, manifest.mutation.patchPath));
  const patch = readFileSync(patchPath);
  if (sha256(patch) !== manifest.rollback.reversePatchSha256) {
    throw new Error("rollback_patch_digest_mismatch");
  }
  reverseAppliedPatch(repositoryPath, patchPath, manifest.cleanup.pristineTreeSha256);
  const pristineSnapshotSha256 = computeTrackedSnapshotSha256(repositoryPath);
  if (pristineSnapshotSha256 !== manifest.cleanup.pristineTreeSha256) {
    throw new Error("rollback_pristine_snapshot_mismatch");
  }
  return { rolledBack: true, pristineSnapshotSha256 };
}
