import { describe, expect, it } from "vitest";
import { evaluateExecutableTarget, type CiRunEvidence } from "./execution-evidence.js";
import type { ImmutableRepositorySnapshot, RepositoryDiscovery } from "./repository-source.js";

const sha = "a".repeat(40);
const snapshot: ImmutableRepositorySnapshot = {
  provider: "github", repositoryId: "org/repo", requestedRef: "main", sha, root: "C:/snapshot",
  manifestSha256: "b".repeat(64), files: [{ path: "src/payments.ts", mode: "100644", kind: "file", size: 1, sha256: "c".repeat(64) }],
  submodules: [], lfsPointers: [], sparsePaths: [],
};
const discovery: RepositoryDiscovery = {
  codeowners: [{ path: ".github/CODEOWNERS", content: "src/* @payments-team\n" }],
  ci: [{ provider: "github_actions", path: ".github/workflows/ci.yml" }],
  verificationCommands: [{ command: "npm run test", source: "package.json", kind: "test" }],
};
const ciRun: CiRunEvidence = {
  provider: "github_actions", workflowPath: ".github/workflows/ci.yml", runId: "42", exactCommit: sha,
  conclusion: "success", observedAt: "2026-08-02T12:05:00.000Z", verificationCommands: ["npm run test"],
};

describe("executable target evidence", () => {
  it("requires snapshot-bound owners and successful discovered CI verification", () => {
    const result = evaluateExecutableTarget({ tenantId: "tenant-a", snapshot, discovery, targetPaths: ["src/payments.ts"], ciRun, evaluatedAt: "2026-08-02T12:06:00.000Z" });
    expect(result).toMatchObject({ executable: true, reasons: [], exactCommit: sha, ownersByPath: { "src/payments.ts": ["@payments-team"] } });
    expect(result.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluateExecutableTarget({ tenantId: "tenant-a", snapshot, discovery, targetPaths: ["src/payments.ts"], ciRun, evaluatedAt: "2026-08-02T12:06:00.000Z" })).toEqual(result);
  });

  it("fails closed for missing ownership, mismatched CI, and untracked targets", () => {
    const result = evaluateExecutableTarget({
      tenantId: "tenant-a", snapshot, targetPaths: ["src/unowned.ts"], evaluatedAt: "2026-08-02T12:06:00.000Z",
      discovery: { codeowners: [{ path: "CODEOWNERS", content: "docs/* @docs-team\n" }], ci: discovery.ci, verificationCommands: [] },
      ciRun: { ...ciRun, exactCommit: "d".repeat(40), conclusion: "failure", workflowPath: ".github/workflows/other.yml" },
    });
    expect(result.executable).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["target_not_in_snapshot", "owner_evidence_missing", "verification_command_missing", "ci_commit_mismatch", "ci_not_successful", "ci_workflow_not_discovered", "ci_verification_evidence_mismatch"]));
  });

  it("does not accept discovery alone as proof that CI passed", () => {
    const result = evaluateExecutableTarget({ tenantId: "tenant-a", snapshot, discovery, targetPaths: ["src/payments.ts"], evaluatedAt: "2026-08-02T12:06:00.000Z" });
    expect(result).toMatchObject({ executable: false, reasons: ["successful_ci_evidence_missing"] });
  });

  it("rejects synthetic snapshot and CI identifiers before granting execution", () => {
    expect(() => evaluateExecutableTarget({
      tenantId: "tenant-a",
      snapshot: { ...snapshot, sha: "main" },
      discovery,
      targetPaths: ["src/payments.ts"],
      ciRun,
      evaluatedAt: "2026-08-02T12:06:00.000Z",
    })).toThrow("execution_exact_commit_invalid");
    expect(() => evaluateExecutableTarget({
      tenantId: "tenant-a",
      snapshot: { ...snapshot, manifestSha256: "manifest" },
      discovery,
      targetPaths: ["src/payments.ts"],
      ciRun,
      evaluatedAt: "2026-08-02T12:06:00.000Z",
    })).toThrow("execution_snapshot_sha256_invalid");
    expect(() => evaluateExecutableTarget({
      tenantId: "tenant-a",
      snapshot,
      discovery,
      targetPaths: ["src/payments.ts"],
      ciRun: { ...ciRun, exactCommit: "head" },
      evaluatedAt: "2026-08-02T12:06:00.000Z",
    })).toThrow("execution_ci_exact_commit_invalid");
  });
});
