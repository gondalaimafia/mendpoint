import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { applyFixtureMutation, computeTrackedSnapshotSha256, rollbackFixtureMutation } from "./mutation-tool.js";
import { admitFixture, type AdmittedFixture, type FixtureManifest } from "./fixture.js";
import type { LearningCase, RepositoryProvenance } from "./schema.js";

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
  writeFileSync(join(repo, "source.ts"), "export const value = 'new';\n");
  const patch = command(repo, ["diff", "--", "source.ts"]);
  writeFileSync(join(patchRoot, "mutation.patch"), patch);
  command(repo, ["checkout", "--", "source.ts"]);
  const pristine = computeTrackedSnapshotSha256(repo);
  const patchSha256 = createHash("sha256").update(readFileSync(join(patchRoot, "mutation.patch"))).digest("hex");
  const manifest: FixtureManifest = {
    schemaVersion: "mendpoint.fixture-manifest.v1", manifestId: "fixture-fet-c001-manifest-v1", caseId: "FET-C001",
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

function bindPatch(value: ReturnType<typeof setup>, patch: string): void {
  const patchPath = join(value.patchRoot, value.manifest.mutation.patchPath);
  writeFileSync(patchPath, patch);
  const digest = createHash("sha256").update(readFileSync(patchPath)).digest("hex");
  value.manifest.mutation.patchSha256 = digest;
  value.manifest.rollback.reversePatchSha256 = digest;
}

function admitted(value: ReturnType<typeof setup>): AdmittedFixture {
  const learningCase: LearningCase = {
    schemaVersion: "mendpoint.learning-case.v1",
    id: value.manifest.caseId,
    product: "fettler",
    cohort: "common",
    datasetSplit: "development",
    title: "Mutation fixture",
    importance: { statement: "Deterministic mutation control.", frequencyClaim: "not_claimed", sourceIds: ["source-a"] },
    sources: [{ id: "source-a", kind: "official_documentation", title: "Fixture", publisher: "Mendpoint", url: "https://example.invalid/fixture", retrievedAt: "2026-08-28T23:00:00.000Z" }],
    repository: { provenanceId: "repo-a", languages: ["typescript"], frameworks: ["node"], binding: { mode: "native", originalResearchCandidate: "repo-a", rationale: "The fixture directly targets this repository." } },
    pattern: { family: "mutation", seededFailure: value.manifest.mutation.seededFailure, expectedImpactGraph: [...value.manifest.expectedImpactGraph.nodes], evidenceState: value.manifest.expectedImpactGraph.evidenceState },
    expected: { diagnosis: "Detect mutation.", repairOrMigration: value.manifest.expectedFixOrMigration, oracleIds: [value.manifest.failingOracle.id], productionAcceptance: ["Fixture remains isolated."] },
    fixture: { manifestId: value.manifest.manifestId, mutationId: value.manifest.mutation.id, allowedEditPaths: ["source.ts", "test/**", "escape.ts", "link.ts"], rollbackId: value.manifest.rollback.id, cleanupId: value.manifest.cleanup.id },
    security: { tenantRisk: "bounded", risks: [], requiresDedicatedBenchmarkTenant: true },
    planning: { requirementIds: ["REQ-EVAL-FIXTURE"] },
  };
  const repository: RepositoryProvenance = {
    schemaVersion: "mendpoint.repository-provenance.v1",
    id: "repo-a",
    repositoryUrl: "https://github.com/example/a.git",
    immutableCommit: value.manifest.repository.immutableCommit,
    license: { spdxId: "MIT", sourceUrl: "https://example.invalid/license", textSha256: "a".repeat(64), decision: "approved", decidedAt: "2026-08-28T23:00:00.000Z", intendedUses: ["evaluation", "governed_learning"] },
    languages: ["typescript"],
    frameworks: ["node"],
    dependencyLockfiles: [],
    provenanceRetrievedAt: "2026-08-28T23:00:00.000Z",
    dataClassification: "public_source_code",
    contentScreening: { secrets: "not_detected", personalData: "not_detected", generatedCredentials: "not_detected", customerData: "not_present" },
  };
  const result = admitFixture(value.manifest, learningCase, repository);
  if (!result.admitted) throw new Error(`fixture_not_admitted:${result.errors.join(",")}`);
  return result.admission;
}

afterEach(() => {
  // The mutation tooling itself never deletes repositories. Test scratch cleanup
  // is left to the operating system to keep the production boundary observable.
  roots.length = 0;
});

describe("filesystem mutation application and rollback", () => {
  it("applies a content addressed patch inside its edit boundary and restores pristine state", () => {
    const value = setup();
    const admission = admitted(value);
    const applied = applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission });
    expect(applied.changedPaths).toEqual(["source.ts"]);
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("new");
    expect(rollbackFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission })).toEqual({ rolledBack: true, pristineSnapshotSha256: value.manifest.repository.pristineSnapshotSha256 });
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 45_000);

  it("fails before mutation when the patch digest is not bound", () => {
    const value = setup();
    value.manifest.mutation.patchSha256 = "f".repeat(64);
    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("mutation_patch_digest_mismatch");
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 45_000);

  it("reverses an edit that escapes the declared boundary before returning failure", () => {
    const value = setup();
    value.manifest.allowedEditPaths = ["test/**"];
    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("mutation_edit_boundary_violation:source.ts");
    expect(command(value.repo, ["status", "--porcelain=v1"]).trim()).toBe("");
  }, 45_000);

  it("collects a new untracked file and rolls it back when it escapes the edit boundary", () => {
    const value = setup();
    bindPatch(value, [
      "diff --git a/escape.ts b/escape.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/escape.ts",
      "@@ -0,0 +1 @@",
      "+export const escaped = true;",
      "",
    ].join("\n"));

    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("mutation_edit_boundary_violation:escape.ts");
    expect(existsSync(join(value.repo, "escape.ts"))).toBe(false);
    expect(command(value.repo, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("");
  }, 45_000);

  it("rejects a pristine candidate that contains ignored worktree content", () => {
    const value = setup();
    writeFileSync(join(value.repo, ".git", "info", "exclude"), "ignored.txt\n");
    writeFileSync(join(value.repo, "ignored.txt"), "must not be admitted\n");

    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("repository_must_be_pristine_before_mutation");
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 45_000);

  it("rejects non-default index flags before applying a patch", () => {
    const value = setup();
    command(value.repo, ["update-index", "--assume-unchanged", "source.ts"]);

    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("tracked_entry_index_flag_not_allowed:source.ts");
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 45_000);

  it("rejects a lexically contained repository path whose canonical target escapes the root", () => {
    const value = setup();
    const authorizedRoot = join(value.root, "authorized");
    const linkedRepository = join(authorizedRoot, "repo");
    mkdirSync(authorizedRoot);
    try {
      symlinkSync(value.repo, linkedRepository, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
      throw error;
    }

    expect(() => applyFixtureMutation({ benchmarkRoot: authorizedRoot, repositoryPath: linkedRepository, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow("path_outside_authorized_root");
    expect(readFileSync(join(value.repo, "source.ts"), "utf8")).toContain("old");
  }, 45_000);

  it("rejects an allowed-path patch that creates an escaping symlink", () => {
    const value = setup();
    value.manifest.allowedEditPaths = ["link.ts"];
    bindPatch(value, [
      "diff --git a/link.ts b/link.ts",
      "new file mode 120000",
      "index 0000000..7d1e6bc",
      "--- /dev/null",
      "+++ b/link.ts",
      "@@ -0,0 +1 @@",
      "+../../outside",
      "\\ No newline at end of file",
      "",
    ].join("\n"));

    expect(() => applyFixtureMutation({ benchmarkRoot: value.root, repositoryPath: value.repo, patchRoot: value.patchRoot, admission: admitted(value) })).toThrow(/symlink_target_outside_authorized_root/);
    expect(command(value.repo, ["status", "--porcelain=v1", "--untracked-files=all"]).trim()).toBe("");
  }, 45_000);
});
