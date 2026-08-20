import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimNextJob, createDb, getJob, type AppDb } from "@mendpoint/db";
import type {
  DelegatedPrCandidateOperationDependencies,
  DelegatedPrVerificationDependencies,
  PromotedDelegatedPrCandidate,
} from "@mendpoint/pipeline";
import {
  enqueueDelegatedPrVerificationJob,
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
    policy: {},
    verifier: {},
    verifyReceipt: vi.fn(),
  } as unknown as DelegatedPrVerificationDependencies;
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
