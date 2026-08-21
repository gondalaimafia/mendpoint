import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendDomainEvent,
  claimNextJob,
  createDb,
  getJob,
  insertAgentRun,
  insertPrincipal,
  type AppDb,
} from "@mendpoint/db";
import {
  delegatedPrVerificationResultDigest,
  promoteDelegatedPrCandidate,
  runDelegatedPrVerification,
  type DelegatedPrCandidateOperationDependencies,
  type DelegatedPrVerificationDependencies,
  type DelegatedPrVerificationResolution,
  type PromotedDelegatedPrCandidate,
} from "@mendpoint/pipeline";
import {
  enqueueDelegatedPrVerificationJob,
  assertDelegatedPrVerificationApprovalAuthority,
  requestDelegatedPrVerificationJob,
  runDelegatedPrVerificationJob,
} from "./delegated-pr-verification-job.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const NOW = "2026-08-19T13:00:00.000Z";
const hex = (value: string) => value.repeat(64);

function fixture(payload: Record<string, unknown> = { runId: "run-a", correlationId: "corr-a" }) {
  const root = mkdtempSync(join(tmpdir(), "delegated-verification-job-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(NOW);
  db.raw.prepare(
    `INSERT INTO jobs (id, tenant_id, type, payload_json, status, attempts, max_attempts,
       result_json, created_at, finished_at, lease_generation)
     VALUES ('corr-a', 'tenant-a', 'agent.run', '{}', 'done', 1, 3, ?, ?, ?, 1)`,
  ).run(JSON.stringify({ sessionId: "run-a", status: "candidate_ready" }), NOW, NOW);
  const jobId = enqueueDelegatedPrVerificationJob(db, {
    tenantId: "tenant-a",
    runId: String(payload.runId ?? "run-a"),
    correlationId: String(payload.correlationId ?? "corr-a"),
    createdAt: NOW,
  });
  if (Object.keys(payload).length !== 2) {
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?")
      .run(JSON.stringify(payload), jobId, "tenant-a");
  }
  const job = claimNextJob(db, ["warden.candidate.verify"], {
    tenantId: "tenant-a", workerId: "worker-a", leaseMs: 60_000, now: NOW,
  })!;
  const promoted: PromotedDelegatedPrCandidate = Object.freeze({
    tenantId: "tenant-a", runId: "run-a", jobId: "source-job-a", repositoryId: "repo-a",
    snapshotId: "snapshot-a", revision: "a".repeat(40), sourceManifestSha256: hex("b"),
    sourceTreeDigest: `sha256:${hex("c")}`, candidateTreeDigest: `sha256:${hex("d")}`,
    candidateManifestSha256: `sha256:${hex("e")}`, changedPaths: Object.freeze(["src/a.ts"]),
    createdAt: "2026-08-19T12:59:00.000Z",
    artifact: Object.freeze({ artifactId: "candidate-a", sha256: hex("f") }),
    evidenceId: "candidate-evidence-a",
  });
  const promoteCandidate = vi.fn(async () => promoted);
  const verifyCandidate = vi.fn(async () => Object.freeze({
    status: "completed" as const,
    tenantId: "tenant-a",
    runId: "run-a",
    candidateArtifact: promoted.artifact,
    candidateDigest: promoted.candidateTreeDigest,
    failToPass: { artifact: { artifactId: "f2p-a", sha256: hex("1") }, evidenceId: "f2p-evidence-a" },
    passToPass: { artifact: { artifactId: "p2p-a", sha256: hex("2") }, evidenceId: "p2p-evidence-a" },
    completedAt: NOW,
  })) as unknown as Parameters<typeof runDelegatedPrVerificationJob>[1]["verifyCandidate"];
  const candidateDependencies = {
    enabled: true,
    authority: { loadExactCandidate: vi.fn() },
    producerPrincipalId: "candidate-authority",
    producerVersion: "f".repeat(40),
  } as unknown as DelegatedPrCandidateOperationDependencies;
  const verificationDependencies = {
    enabled: true,
    workerId: "worker-a",
    timeoutMs: 1_000,
    leaseMs: 5_000,
    candidateProducerPrincipalId: "candidate-authority",
    candidateProducerVersion: "f".repeat(40),
    authorityId: "verifier-a",
    authorityDigest: `sha256:${hex("3")}`,
    executionAuthorityId: "sandbox-a",
    mendpointRevision: "f".repeat(40),
    policy: {
      failToPassCommandDigest: `sha256:${hex("1")}`,
      passToPassCommandDigest: `sha256:${hex("2")}`,
      sandboxBackend: "fly_machines",
    },
    verifier: {},
    verifyReceipt: vi.fn(),
  } as unknown as DelegatedPrVerificationDependencies;
  db.raw.prepare("UPDATE jobs SET result_json = json_set(result_json, '$.delegatedVerification', json(?)) WHERE id = ?")
    .run(JSON.stringify({ schemaVersion: 1, jobId, authority: {
      candidateProducerPrincipalId: verificationDependencies.candidateProducerPrincipalId,
      candidateProducerVersion: verificationDependencies.candidateProducerVersion,
      authorityId: verificationDependencies.authorityId,
      authorityDigest: verificationDependencies.authorityDigest,
      executionAuthorityId: verificationDependencies.executionAuthorityId,
      mendpointRevision: verificationDependencies.mendpointRevision,
      policy: verificationDependencies.policy,
    } }), "corr-a");
  return { db, job, jobId, promoted, promoteCandidate, verifyCandidate,
    candidateDependencies, verificationDependencies };
}

afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.db.raw.close();
    rmSync(entry.root, { recursive: true, force: true });
  }
});

describe("delegated PR verification worker job", () => {
  it("atomically marks the source job when protected verification is requested", () => {
    const value = fixture();
    value.db.raw.prepare("UPDATE jobs SET result_json = json_remove(result_json, '$.delegatedVerification') WHERE id = ?")
      .run("corr-a");
    value.db.raw.exec("BEGIN IMMEDIATE");
    try {
      expect(requestDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
        correlationId: "corr-a", createdAt: NOW,
        authority: value.verificationDependencies })).toBe(value.jobId);
      value.db.raw.exec("COMMIT");
    } catch (error) {
      value.db.raw.exec("ROLLBACK");
      throw error;
    }
    expect(JSON.parse(getJob(value.db, "corr-a", "tenant-a")!.result_json!))
      .toMatchObject({ delegatedVerification: { schemaVersion: 1, jobId: value.jobId,
        authority: { authorityId: "verifier-a", executionAuthorityId: "sandbox-a" } } });
  });

  it("refuses to split the verification request and source marker across transactions", () => {
    const value = fixture();
    expect(() => requestDelegatedPrVerificationJob(value.db, { tenantId: "tenant-a", runId: "run-a",
      correlationId: "corr-a", createdAt: NOW, authority: value.verificationDependencies }))
      .toThrow("delegated_pr_verification_request_transaction_required");
  });

  function seedCompletedApprovalAuthority(value: ReturnType<typeof fixture>) {
    insertPrincipal(value.db, { id: "verifier-a", tenantId: "tenant-a", kind: "service",
      subject: "verifier-a", displayName: "Verifier A", createdAt: "2026-08-19T12:00:00.000Z" });
    const result = {
      status: "verified", runId: "run-a", candidateArtifactId: "candidate-a",
      candidateDigest: `sha256:${hex("d")}`, failToPassArtifactId: "f2p-a",
      passToPassArtifactId: "p2p-a", completedAt: NOW,
    };
    appendDomainEvent(value.db, {
      id: "verification-completed-a", tenantId: "tenant-a", schemaVersion: 1,
      eventType: "fettler_delegated_verification.completed",
      aggregateType: "fettler_delegated_verification", aggregateId: "run-a",
      actorPrincipalId: "verifier-a", correlationId: "corr-a", causationId: null,
      idempotencyKey: "verification-completed-a", payload: {
        requestDigest: `sha256:${hex("9")}`,
        candidateArtifact: { artifactId: "candidate-a", sha256: hex("f") },
        candidateDigest: result.candidateDigest, executionAuthorityId: "sandbox-a",
        failToPassArtifactId: result.failToPassArtifactId, failToPassEvidenceId: "f2p-evidence-a",
        passToPassArtifactId: result.passToPassArtifactId, passToPassEvidenceId: "p2p-evidence-a",
        completedAt: NOW,
      }, createdAt: NOW,
    });
    value.db.raw.prepare("UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify(result), NOW, value.jobId);
    return result;
  }

  it("rejects a completed event without authoritative execution artifacts and evidence", () => {
    const value = fixture();
    seedCompletedApprovalAuthority(value);
    expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: `sha256:${hex("d")}`,
    })).toThrow("delegated_pr_verification_authority_invalid");
  });

  it("accepts a completed job only when the configured authority persisted both exact executions", async () => {
    const value = fixture();
    for (const id of ["candidate-authority", "verifier-a"]) {
      insertPrincipal(value.db, { id, tenantId: "tenant-a", kind: "service", subject: id,
        displayName: id, createdAt: "2026-08-19T12:00:00.000Z" });
    }
    value.db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('connection-a', 'tenant-a', 'github', 'secret://github/app', 'account-a', 'GitHub', ?, ?)`)
      .run(NOW, NOW);
    value.db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-a', 'tenant-a', 'connection-a', '101', 'acme', 'service', 'main', 'main',
       'test', 30, 'ready', ?, ?)`).run(NOW, NOW);
    value.db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-a', 'tenant-a', 'repo-a', 'main', ?, ?, 'snapshots/a', 'reject', 'reject',
       '[]', 1, ?, '2026-08-20T12:00:00.000Z')`)
      .run("a".repeat(40), hex("b"), NOW);
    const candidateCreatedAt = "2026-08-19T12:01:00.000Z";
    const candidate = Object.freeze({
      tenantId: "tenant-a", runId: "run-a", jobId: "corr-a", repositoryId: "repo-a",
      snapshotId: "snapshot-a", revision: "a".repeat(40), sourceManifestSha256: hex("b"),
      sourceTreeDigest: `sha256:${hex("c")}`, candidateTreeDigest: `sha256:${hex("d")}`,
      candidateManifestSha256: `sha256:${hex("e")}`,
      changedPaths: Object.freeze(["src/client.ts"]), createdAt: candidateCreatedAt,
    });
    insertAgentRun(value.db, {
      id: candidate.runId, tenantId: candidate.tenantId, jobId: candidate.jobId,
      goal: "repair", repoPath: "repo", status: "candidate_ready", ok: true, steps: 2,
      filesChanged: [...candidate.changedPaths], resultJson: JSON.stringify({
        source: { repositoryId: candidate.repositoryId, snapshotId: candidate.snapshotId,
          revision: candidate.revision, manifestSha256: candidate.sourceManifestSha256 },
        artifacts: { sourceDigest: candidate.sourceTreeDigest, candidateDigest: candidate.candidateTreeDigest,
          candidateManifestSha256: candidate.candidateManifestSha256 },
      }), createdAt: candidateCreatedAt, finishedAt: candidateCreatedAt,
    });
    const promoted = await promoteDelegatedPrCandidate(value.db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      idempotencyKey: `${value.jobId}:candidate`, observedAt: "2026-08-19T12:02:00.000Z",
    }, { enabled: true, authority: { loadExactCandidate: async () => candidate },
      producerPrincipalId: "candidate-authority", producerVersion: "f".repeat(40) });
    const completedAt = "2026-08-19T12:04:00.000Z";
    const verificationDependencies = {
      ...value.verificationDependencies,
      verifier: {
        verify: async (request: { requestDigest: string; leaseGeneration: number }) => {
          const result: DelegatedPrVerificationResolution = Object.freeze({
            status: "completed", executionAuthorityId: "sandbox-a",
            failToPass: Object.freeze({ authorityId: "verifier-a", authorityDigest: `sha256:${hex("3")}`,
              commandDigest: `sha256:${hex("1")}`, sourceDigest: candidate.sourceTreeDigest,
              candidateDigest: candidate.candidateTreeDigest, baselineExitCode: 1, candidateExitCode: 0,
              baselineVerdict: "test_failure", failingCheckIdentities: Object.freeze({
                status: "not_observed", reason: "check_identities_not_parsed_from_runner_output" }),
              sandboxBackend: "fly_machines", logsDigest: `sha256:${hex("4")}` }),
            passToPass: Object.freeze({ authorityId: "verifier-a", authorityDigest: `sha256:${hex("3")}`,
              commandDigest: `sha256:${hex("2")}`, sourceDigest: candidate.sourceTreeDigest,
              candidateDigest: candidate.candidateTreeDigest, baselineExitCode: 0, candidateExitCode: 0,
              baselineVerdict: "passed", failingCheckIdentities: Object.freeze({
                status: "not_observed", reason: "check_identities_not_parsed_from_runner_output" }),
              sandboxBackend: "fly_machines", logsDigest: `sha256:${hex("5")}` }),
            completedAt,
          });
          return { result, receipt: { tenantId: "tenant-a", runId: "run-a",
            candidateArtifactId: promoted.artifact.artifactId, requestDigest: request.requestDigest,
            leaseGeneration: request.leaseGeneration, authorityId: "verifier-a", outcome: "completed",
            resultDigest: delegatedPrVerificationResultDigest(result), observedAt: completedAt,
            signature: "signed" } };
        },
        reconcile: async () => { throw new Error("unexpected reconcile"); },
      },
      verifyReceipt: (receipt: { signature: string }) => receipt.signature === "signed",
    } as DelegatedPrVerificationDependencies;
    const verified = await runDelegatedPrVerification(value.db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      candidateArtifactId: promoted.artifact.artifactId,
      idempotencyKey: `${value.jobId}:verification`, requestedAt: "2026-08-19T12:03:00.000Z",
    }, verificationDependencies);
    if (verified.status !== "completed") throw new Error("expected completed verification");
    value.db.raw.prepare("UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify({ status: "verified", runId: "run-a",
        candidateArtifactId: promoted.artifact.artifactId, candidateDigest: verified.candidateDigest,
        failToPassArtifactId: verified.failToPass.artifact.artifactId,
        passToPassArtifactId: verified.passToPass.artifact.artifactId, completedAt }), completedAt, value.jobId);

    expect(assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: candidate.candidateTreeDigest,
    })).toMatchObject({ required: true, verificationJobId: value.jobId,
      candidateArtifactId: promoted.artifact.artifactId, completedAt });

    const sourceResult = JSON.parse(getJob(value.db, "corr-a", "tenant-a")!.result_json!);
    value.db.raw.prepare("UPDATE jobs SET result_json = json_remove(result_json, '$.delegatedVerification') WHERE id = ?")
      .run("corr-a");
    expect(assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: candidate.candidateTreeDigest,
    })).toMatchObject({ required: true, verificationJobId: value.jobId,
      candidateArtifactId: promoted.artifact.artifactId, completedAt });

    sourceResult.delegatedVerification.authority.executionAuthorityId = "other-sandbox";
    value.db.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ?")
      .run(JSON.stringify(sourceResult), "corr-a");
    expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: candidate.candidateTreeDigest,
    })).toThrow("delegated_pr_verification_authority_invalid");
  });

  it("rejects a source marker whose verification job is missing", () => {
    const value = fixture();
    value.db.raw.prepare("DELETE FROM jobs WHERE id = ? AND tenant_id = ?")
      .run(value.jobId, "tenant-a");
    expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: `sha256:${hex("d")}`,
    })).toThrow("delegated_pr_verification_authority_invalid");
  });

  it("rejects a completed job whose candidate binding was changed", () => {
    const value = fixture();
    seedCompletedApprovalAuthority(value);
    const result = JSON.parse(getJob(value.db, value.jobId, "tenant-a")!.result_json!);
    result.candidateDigest = `sha256:${hex("8")}`;
    value.db.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ? AND tenant_id = ?")
      .run(JSON.stringify(result), value.jobId, "tenant-a");
    expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: `sha256:${hex("d")}`,
    })).toThrow("delegated_pr_verification_authority_invalid");
  });

  it.each(["pending", "running", "dead_letter", "failed", "cancelled"])(
    "blocks approval while the requested job is %s",
    (status) => {
      const value = fixture();
      value.db.raw.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, value.jobId);
      expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
        tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
        candidateDigest: `sha256:${hex("d")}`,
      })).toThrow(status === "pending" || status === "running"
        ? "delegated_pr_verification_pending" : "delegated_pr_verification_failed");
    },
  );

  it("rejects a done job without its matching durable event", () => {
    const value = fixture();
    value.db.raw.prepare("UPDATE jobs SET status = 'done', result_json = ?, finished_at = ? WHERE id = ?")
      .run(JSON.stringify({ status: "verified", runId: "run-a", candidateArtifactId: "candidate-a",
        candidateDigest: `sha256:${hex("d")}`, failToPassArtifactId: "f2p-a",
        passToPassArtifactId: "p2p-a", completedAt: NOW }), NOW, value.jobId);
    expect(() => assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: `sha256:${hex("d")}`,
    })).toThrow("delegated_pr_verification_authority_invalid");
  });

  it("does not require delegated authority when no verification was requested", () => {
    const value = fixture();
    value.db.raw.prepare("DELETE FROM jobs WHERE id = ?").run(value.jobId);
    value.db.raw.prepare("UPDATE jobs SET result_json = json_remove(result_json, '$.delegatedVerification') WHERE id = ?")
      .run("corr-a");
    expect(assertDelegatedPrVerificationApprovalAuthority(value.db, {
      tenantId: "tenant-a", runId: "run-a", sourceJobId: "corr-a",
      candidateDigest: `sha256:${hex("d")}`,
    })).toEqual({ required: false });
  });

  it("derives all authority from worker dependencies and completes the exact job", async () => {
    const value = fixture();
    const result = await runDelegatedPrVerificationJob(value.db, {
      job: value.job,
      candidateDependencies: value.candidateDependencies,
      verificationDependencies: value.verificationDependencies,
      promoteCandidate: value.promoteCandidate,
      verifyCandidate: value.verifyCandidate,
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "verified", runId: "run-a", candidateArtifactId: "candidate-a" });
    expect(value.promoteCandidate).toHaveBeenCalledWith(value.db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      idempotencyKey: `${value.jobId}:candidate`, observedAt: NOW,
    }, value.candidateDependencies);
    expect(value.verifyCandidate).toHaveBeenCalledWith(value.db, {
      tenantId: "tenant-a", runId: "run-a", correlationId: "corr-a",
      candidateArtifactId: "candidate-a", idempotencyKey: `${value.jobId}:verification`, requestedAt: NOW,
    }, value.verificationDependencies);
    expect(getJob(value.db, value.jobId, "tenant-a")?.status).toBe("done");
  });

  it("rejects caller supplied authority before either operation", async () => {
    const value = fixture({ runId: "run-a", correlationId: "corr-a", authorityId: "caller-verifier" });
    await expect(runDelegatedPrVerificationJob(value.db, {
      job: value.job,
      candidateDependencies: value.candidateDependencies,
      verificationDependencies: value.verificationDependencies,
      promoteCandidate: value.promoteCandidate,
      verifyCandidate: value.verifyCandidate,
      now: () => NOW,
    })).rejects.toThrow("delegated_pr_verification_job_payload_invalid");
    expect(value.promoteCandidate).not.toHaveBeenCalled();
    expect(value.verifyCandidate).not.toHaveBeenCalled();
  });

  it("settles a signed verifier failure as terminal without retrying", async () => {
    const value = fixture();
    const verifyCandidate = vi.fn(async () => Object.freeze({
      status: "failed" as const,
      tenantId: "tenant-a",
      runId: "run-a",
      candidateArtifact: value.promoted.artifact,
      candidateDigest: value.promoted.candidateTreeDigest,
      code: "target_still_failing",
      completedAt: NOW,
    })) as unknown as Parameters<typeof runDelegatedPrVerificationJob>[1]["verifyCandidate"];
    const result = await runDelegatedPrVerificationJob(value.db, {
      job: value.job,
      candidateDependencies: value.candidateDependencies,
      verificationDependencies: value.verificationDependencies,
      promoteCandidate: value.promoteCandidate,
      verifyCandidate,
      now: () => NOW,
    });
    expect(result).toMatchObject({ status: "failed", code: "target_still_failing" });
    expect(getJob(value.db, value.jobId, "tenant-a")?.status).toBe("dead_letter");
  });

  it("retries an unknown verifier outcome without changing the durable request", async () => {
    const value = fixture();
    const verifyCandidate = vi.fn(async () => {
      throw new Error("delegated_pr_verification_outcome_unknown");
    }) as unknown as Parameters<typeof runDelegatedPrVerificationJob>[1]["verifyCandidate"];
    const result = await runDelegatedPrVerificationJob(value.db, {
      job: value.job,
      candidateDependencies: value.candidateDependencies,
      verificationDependencies: value.verificationDependencies,
      promoteCandidate: value.promoteCandidate,
      verifyCandidate,
      now: () => NOW,
    });
    expect(result.status).toBe("retry_scheduled");
    expect(getJob(value.db, value.jobId, "tenant-a")?.status).toBe("pending");
  });
});
