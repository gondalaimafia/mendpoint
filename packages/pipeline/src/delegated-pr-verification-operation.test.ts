import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb, insertAgentRun, insertPrincipal, type AppDb } from "@mendpoint/db";
import {
  promoteDelegatedPrCandidate,
  type DelegatedPrCandidateAuthority,
} from "./delegated-pr-candidate-operation.js";
import {
  delegatedPrVerificationResultDigest,
  runDelegatedPrVerification,
  type DelegatedPrVerificationExchange,
  type DelegatedPrVerificationResolution,
  type DelegatedPrVerifier,
} from "./delegated-pr-verification-operation.js";

const databases: AppDb[] = [];
const roots: string[] = [];
const hex = (value: string) => value.repeat(64);
const revision = (value: string) => value.repeat(40);

afterEach(() => {
  for (const db of databases.splice(0)) db.raw.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delegated-verification-"));
  roots.push(root);
  const db = createDb(join(root, "test.sqlite"));
  databases.push(db);
  const candidateCreatedAt = "2026-08-19T12:01:00.000Z";
  for (const principal of ["trial-service", "verifier-a"]) {
    insertPrincipal(db, {
      id: principal, tenantId: "tenant-a", kind: "service", subject: principal,
      displayName: principal, createdAt: "2026-08-19T12:00:00.000Z",
    });
  }
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection-a', 'tenant-a', 'github', 'secret://github/app', 'account-a', 'GitHub', ?, ?)`)
    .run(candidateCreatedAt, candidateCreatedAt);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'connection-a', '101', 'acme', 'service', 'main', 'main',
      'test', 30, 'ready', ?, ?)`).run(candidateCreatedAt, candidateCreatedAt);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-a', 'tenant-a', 'repo-a', 'main', ?, ?, 'snapshots/a', 'reject', 'reject',
      '[]', 1, ?, '2026-08-20T12:00:00.000Z')`)
    .run(revision("a"), hex("b"), candidateCreatedAt);
  const candidate = Object.freeze({
    tenantId: "tenant-a", runId: "run-a", jobId: "job-a", repositoryId: "repo-a",
    snapshotId: "snapshot-a", revision: revision("a"), sourceManifestSha256: hex("b"),
    sourceTreeDigest: `sha256:${hex("c")}`, candidateTreeDigest: `sha256:${hex("d")}`,
    candidateManifestSha256: `sha256:${hex("e")}`,
    changedPaths: Object.freeze(["src/client.ts"]), createdAt: candidateCreatedAt,
  });
  insertAgentRun(db, {
    id: candidate.runId, tenantId: candidate.tenantId, jobId: candidate.jobId,
    goal: "repair", repoPath: "repo", status: "candidate_ready", ok: true, steps: 2,
    filesChanged: [...candidate.changedPaths],
    resultJson: JSON.stringify({
      source: { repositoryId: candidate.repositoryId, snapshotId: candidate.snapshotId,
        revision: candidate.revision, manifestSha256: candidate.sourceManifestSha256 },
      artifacts: { sourceDigest: candidate.sourceTreeDigest, candidateDigest: candidate.candidateTreeDigest,
        candidateManifestSha256: candidate.candidateManifestSha256 },
    }),
    createdAt: candidateCreatedAt, finishedAt: candidateCreatedAt,
  });
  const candidateAuthority: DelegatedPrCandidateAuthority = Object.freeze({
    loadExactCandidate: vi.fn(async () => candidate),
  });
  const promoted = await promoteDelegatedPrCandidate(db, {
    tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
    idempotencyKey: "candidate-a", observedAt: "2026-08-19T12:02:00.000Z",
  }, {
    enabled: true, authority: candidateAuthority, producerPrincipalId: "trial-service",
    producerVersion: revision("f"),
  });
  const input = Object.freeze({
    tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
    candidateArtifactId: promoted.artifact.artifactId, idempotencyKey: "verify-a",
    requestedAt: "2026-08-19T12:03:00.000Z",
  });
  const policy = Object.freeze({
    failToPassCommandDigest: `sha256:${hex("1")}`,
    passToPassCommandDigest: `sha256:${hex("2")}`,
    failToPassIdentities: Object.freeze(["test:target"]),
    sandboxBackend: "fly_machines",
  });
  const completed = (request: Readonly<{
    requestDigest: string; leaseGeneration: number;
  }>): Extract<DelegatedPrVerificationResolution, { status: "completed" }> => Object.freeze({
    status: "completed",
    executionAuthorityId: "sandbox-a",
    failToPass: Object.freeze({
      authorityId: "verifier-a", authorityDigest: `sha256:${hex("3")}`,
      commandDigest: policy.failToPassCommandDigest, sourceDigest: candidate.sourceTreeDigest,
      candidateDigest: candidate.candidateTreeDigest, baselineExitCode: 1, candidateExitCode: 0,
      baselineVerdict: "test_failure", failingCheckIdentities: Object.freeze({
        status: "not_observed", reason: "check_identities_not_parsed_from_runner_output" }),
      sandboxBackend: policy.sandboxBackend, logsDigest: `sha256:${hex("4")}`,
    }),
    passToPass: Object.freeze({
      authorityId: "verifier-a", authorityDigest: `sha256:${hex("3")}`,
      commandDigest: policy.passToPassCommandDigest, sourceDigest: candidate.sourceTreeDigest,
      candidateDigest: candidate.candidateTreeDigest, baselineExitCode: 0, candidateExitCode: 0,
      baselineVerdict: "passed", failingCheckIdentities: Object.freeze({
        status: "not_observed", reason: "check_identities_not_parsed_from_runner_output" }),
      sandboxBackend: policy.sandboxBackend, logsDigest: `sha256:${hex("5")}`,
    }),
    completedAt: "2026-08-19T12:04:00.000Z",
  });
  const exchange = (request: Readonly<{
    requestDigest: string; leaseGeneration: number;
  }>, result: DelegatedPrVerificationResolution = completed(request)): DelegatedPrVerificationExchange => Object.freeze({
    result,
    receipt: Object.freeze({
      tenantId: "tenant-a", runId: "run-a", candidateArtifactId: promoted.artifact.artifactId,
      requestDigest: request.requestDigest, leaseGeneration: request.leaseGeneration,
      authorityId: "verifier-a", outcome: result.status,
      resultDigest: delegatedPrVerificationResultDigest(result),
      observedAt: result.status === "completed" || result.status === "failed"
        ? result.completedAt : "2026-08-19T12:03:30.000Z",
      signature: "signed",
    }),
  });
  const verifier: DelegatedPrVerifier = Object.freeze({
    verify: vi.fn(async (request) => exchange(request)),
    reconcile: vi.fn(async (request) => exchange(request)),
  });
  const dependencies = Object.freeze({
    enabled: true, workerId: "worker-a", timeoutMs: 1_000, leaseMs: 5_000,
    candidateProducerPrincipalId: "trial-service", candidateProducerVersion: revision("f"),
    authorityId: "verifier-a", authorityDigest: `sha256:${hex("3")}`,
    executionAuthorityId: "sandbox-a", mendpointRevision: revision("f"), policy,
    verifier, verifyReceipt: (receipt: Readonly<{ signature: string }>) => receipt.signature === "signed",
  });
  return { db, candidate, promoted, input, policy, completed, exchange, verifier, dependencies };
}

describe("delegated PR verification operation", () => {
  it("persists two independent executions atomically and replays without another effect", async () => {
    const { db, input, verifier, dependencies, candidate } = await fixture();
    const first = await runDelegatedPrVerification(db, input, dependencies);
    const replay = await runDelegatedPrVerification(db, input, dependencies);
    expect(replay).toEqual(first);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.reconcile).not.toHaveBeenCalled();
    expect(first).toMatchObject({ status: "completed", candidateDigest: candidate.candidateTreeDigest,
      failToPass: { artifact: { artifactId: expect.stringMatching(/^delegated_verification_[a-f0-9]{40}$/) } },
      passToPass: { artifact: { artifactId: expect.stringMatching(/^delegated_verification_[a-f0-9]{40}$/) } } });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM artifact_manifests WHERE kind = 'delegated_pr_verification_execution'",
    ).get()).toEqual({ count: 2 });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM evidence_records WHERE subject_type = 'delegated_pr_verification'",
    ).get()).toEqual({ count: 2 });
    const artifacts = db.raw.prepare(
      "SELECT content_text FROM artifact_manifests WHERE kind = 'delegated_pr_verification_execution' ORDER BY id",
    ).all() as Array<{ content_text: string }>;
    expect(artifacts.map((row) => JSON.parse(row.content_text).executionAuthorityId))
      .toEqual(["sandbox-a", "sandbox-a"]);

    db.raw.prepare(
      "UPDATE agent_runs SET status = 'candidate_approved', finished_at = ? WHERE tenant_id = ? AND id = ?",
    ).run("2026-08-19T12:05:00.000Z", input.tenantId, input.runId);
    await expect(runDelegatedPrVerification(db, input, dependencies)).resolves.toEqual(first);
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost response and never repeats the verifier effect", async () => {
    const { db, input, verifier, dependencies, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) => {
      exchange(request);
      throw new Error("transport_lost");
    });
    await expect(runDelegatedPrVerification(db, input, dependencies)).rejects.toThrow("transport_lost");
    const recovered = await runDelegatedPrVerification(db, input, dependencies);
    expect(recovered.status).toBe("completed");
    expect(verifier.verify).toHaveBeenCalledTimes(1);
    expect(verifier.reconcile).toHaveBeenCalledTimes(1);
  });

  it("fails closed without independently promoted candidate authority", async () => {
    const { db, input, verifier, dependencies } = await fixture();
    await expect(runDelegatedPrVerification(
      db, { ...input, candidateArtifactId: "missing-candidate" }, dependencies,
    )).rejects.toThrow(/delegated_pr_verification_candidate/);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects verification requested before the candidate authority exists", async () => {
    const { db, input, verifier, dependencies } = await fixture();
    await expect(runDelegatedPrVerification(db, {
      ...input,
      requestedAt: "2026-08-19T12:00:30.000Z",
    }, dependencies)).rejects.toThrow("delegated_pr_verification_candidate_state_invalid");
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects malformed verifier success and publishes no passed evidence", async () => {
    const { db, input, verifier, dependencies, completed, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) => exchange(request, {
      ...completed(request),
      failToPass: { ...completed(request).failToPass, candidateExitCode: 1 },
    }));
    await expect(runDelegatedPrVerification(db, input, dependencies))
      .rejects.toThrow("delegated_pr_verification_result_invalid");
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM artifact_manifests WHERE kind = 'delegated_pr_verification_execution'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects an execution that fabricates observed check identities as a list", async () => {
    const { db, input, verifier, dependencies, completed, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) => {
      const base = completed(request);
      return exchange(request, {
        ...base,
        failToPass: { ...base.failToPass, failingCheckIdentities: ["test:target"] },
      } as unknown as DelegatedPrVerificationResolution);
    });
    await expect(runDelegatedPrVerification(db, input, dependencies))
      .rejects.toThrow("delegated_pr_verification_result_invalid");
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM artifact_manifests WHERE kind = 'delegated_pr_verification_execution'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects an execution whose reported sandbox backend disagrees with the policy", async () => {
    const { db, input, verifier, dependencies, completed, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) => {
      const base = completed(request);
      return exchange(request, {
        ...base,
        failToPass: { ...base.failToPass, sandboxBackend: "local" },
      });
    });
    await expect(runDelegatedPrVerification(db, input, dependencies))
      .rejects.toThrow("delegated_pr_verification_result_invalid");
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM evidence_records WHERE subject_type = 'delegated_pr_verification'",
    ).get()).toEqual({ count: 0 });
  });

  it("rejects a conflicting same-run request before another verifier call", async () => {
    const { db, input, verifier, dependencies } = await fixture();
    await runDelegatedPrVerification(db, input, dependencies);
    await expect(runDelegatedPrVerification(
      db, { ...input, idempotencyKey: "verify-b" }, dependencies,
    )).rejects.toThrow("delegated_pr_verification_idempotency_conflict");
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("permits takeover only after lease expiry and only through signed safe-to-run reconciliation", async () => {
    const { db, input, verifier, dependencies, exchange } = await fixture();
    vi.mocked(verifier.verify).mockRejectedValueOnce(new Error("worker_crashed"));
    await expect(runDelegatedPrVerification(db, input, dependencies)).rejects.toThrow("worker_crashed");
    db.raw.prepare(
      "UPDATE delegated_pr_verification_effects SET lease_expires_at_ms = 0 WHERE tenant_id = ? AND run_id = ?",
    ).run(input.tenantId, input.runId);
    vi.mocked(verifier.reconcile).mockImplementationOnce(async (request) =>
      exchange(request, Object.freeze({ status: "safe_to_run" })));
    const recovered = await runDelegatedPrVerification(
      db, input, { ...dependencies, workerId: "worker-b" },
    );
    expect(recovered.status).toBe("completed");
    expect(verifier.reconcile).toHaveBeenCalledTimes(1);
    expect(verifier.verify).toHaveBeenCalledTimes(2);
  });

  it("does not let another worker cross a current lease", async () => {
    const { db, input, verifier, dependencies, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) =>
      exchange(request, Object.freeze({ status: "pending" })));
    await expect(runDelegatedPrVerification(db, input, dependencies))
      .rejects.toThrow("delegated_pr_verification_outcome_unknown");
    await expect(runDelegatedPrVerification(
      db, input, { ...dependencies, workerId: "worker-b" },
    )).rejects.toThrow("delegated_pr_verification_lease_held");
    expect(verifier.reconcile).not.toHaveBeenCalled();
  });

  it("settles a signed failed result without publishing passed evidence", async () => {
    const { db, input, verifier, dependencies, exchange } = await fixture();
    vi.mocked(verifier.verify).mockImplementationOnce(async (request) => exchange(request, Object.freeze({
      status: "failed", code: "baseline_not_reproducible", completedAt: "2026-08-19T12:04:00.000Z",
    })));
    const first = await runDelegatedPrVerification(db, input, dependencies);
    const replay = await runDelegatedPrVerification(db, input, dependencies);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "failed", code: "baseline_not_reproducible" });
    expect(db.raw.prepare(
      "SELECT COUNT(*) AS count FROM evidence_records WHERE subject_type = 'delegated_pr_verification'",
    ).get()).toEqual({ count: 0 });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });

  it("rejects an unauthenticated receipt and leaves the effect reconcilable", async () => {
    const { db, input, dependencies, verifier } = await fixture();
    await expect(runDelegatedPrVerification(
      db, input, { ...dependencies, verifyReceipt: () => false },
    )).rejects.toThrow("delegated_pr_verification_receipt_invalid");
    expect(db.raw.prepare(
      "SELECT phase FROM delegated_pr_verification_effects WHERE tenant_id = ? AND run_id = ?",
    ).get(input.tenantId, input.runId)).toEqual({ phase: "dispatched" });
    expect(verifier.verify).toHaveBeenCalledTimes(1);
  });
});
