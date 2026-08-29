import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { applyFixtureMutation, computeTrackedSnapshotSha256, rollbackFixtureMutation } from "./mutation-tool.js";
import type { FixtureManifest } from "./fixture.js";

const roots: string[] = [];

function command(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

function setup(): { root: string; repo: string; patchRoot: string; manifest: FixtureManifest } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-production-learning-"));
  roots.push(root);
  const repo = join(root, "repo");
  const patchRoot = join(root, "patches");
  mkdirSync(repo);
  mkdirSync(patchRoot);
  command(repo, ["init"]);
  command(repo, ["config", "user.name", "Mendpoint Benchmark"]);
  command(repo, ["config", "user.email", "benchmark@example.invalid"]);
  writeFileSync(join(repo, "source.ts"), "export const value = 'old';\n");
  command(repo, ["add", "source.ts"]);
  command(repo, ["commit", "-m", "seed fixture"]);
  const commit = command(repo, ["rev-parse", "HEAD"]).trim();
  const pristine = computeTrackedSnapshotSha256(repo);
  writeFileSync(join(repo, "source.ts"), "export const value = 'new';\n");
  const patch = command(repo, ["diff", "--", "source.ts"]);
  writeFileSync(join(patchRoot, "mutation.patch"), patch);
  command(repo, ["checkout", "--", "source.ts"]);
  const patchSha256 = createHash("sha256").update(readFileSync(join(patchRoot, "mutation.patch"))).digest("hex");
  const manifest: FixtureManifest = {
    schemaVersion: "mendpoint.fixture-manifest.v1", caseId: "FET-C001",
    repository: { provenanceId: "repo-a", immutableCommit: commit, pristineSnapshotSha256: pristine },
    mutation: { id: "mutation-a", kind: "patch", patchPath: "mutation.patch", patchSha256, seededFailure: "old value" },
    expectedImpactGraph: { nodes: ["source.ts"], edges: [], evidenceState: "verified" },
    failingOracle: { id: "oracle-a", argv: ["node", "test.js"], expectedExitCode: 1, expectedOutputPattern: "old" },
    allowedEditPaths: ["source.ts"], expectedFixOrMigration: "restore new value",
    rollback: { id: "rollback-a", reversePatchSha256: patchSha256, oracleId: "oracle-a" },
    cleanup: { id: "cleanup-a", removePaths: [], pristineTreeSha256: pristine },
  };
  return { root, repo, patchRoot, manifest };
}

afterEach(() => {
  // The mutation tooling itself never deletes repositories. Test scratch cleanup
  // is left to the operating system to keep the production boundary observable.
  roots.length = 0;
});

describe("filesystem mutation application and rollback", () => {
  it("applies a content addressed patch inside its edit boundary and restores pristine state", () => {
    const value = setup();
    const applied = applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, manifest: value.manifest });
    expect(applied.changedPaths).toEqual(["source.ts"]);
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("new");
    expect(rollbackFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, manifest: value.manifest })).toEqual({ rolledBack: true, pristineSnapshotSha256: value.manifest.repository.pristineSnapshotSha256 });
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 15_000);

  it("fails before mutation when the patch digest is not bound", () => {
    const value = setup();
    value.manifest.mutation.patchSha256 = "f".repeat(64);
    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, manifest: value.manifest })).toThrow("mutation_patch_digest_mismatch");
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 15_000);

  it("reverses an edit that escapes the declared boundary before returning failure", () => {
    const value = setup();
    value.manifest.allowedEditPaths = ["test/**"];
    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, manifest: value.manifest })).toThrow("mutation_edit_boundary_violation:source.ts");
    expect(command(value.repo, ["status", "--porcelain=v1"]).trim()).toBe("");
  }, 15_000);
});
