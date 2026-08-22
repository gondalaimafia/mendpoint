import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimNextJob, createDb, enqueueJob, getJob, insertPrincipal, insertTenant } from "@mendpoint/db";
import { delegatedPrCleanupRuntimeConfigFromEnv, runDelegatedPrCleanupJob } from "./delegated-pr-cleanup-job.js";

const opened: Array<{ db: ReturnType<typeof createDb>; root: string }> = [];
afterEach(() => { for (const value of opened.splice(0)) { value.db.raw.close(); rmSync(value.root, { recursive: true, force: true }); } });
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "delegated-cleanup-job-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: "2026-08-22T12:00:00.000Z" });
  insertPrincipal(db, { id: "cleanup-service", tenantId: "tenant-a", kind: "service", subject: "cleanup",
    displayName: "Cleanup", createdAt: "2026-08-22T12:00:00.000Z" });
  enqueueJob(db, { id: "cleanup-job-a", tenantId: "tenant-a", type: "warden.candidate.cleanup",
    payload: { schemaVersion: 1 }, maxAttempts: 3, createdAt: "2026-08-22T12:01:00.000Z" });
  const job = claimNextJob(db, ["warden.candidate.cleanup"], { tenantId: "tenant-a", workerId: "worker-a",
    leaseMs: 120_000, now: "2026-08-22T12:02:00.000Z" })!;
  const keys = generateKeyPairSync("ed25519");
  const authority = Object.freeze({
    tenantId: "tenant-a", runId: "run-a", correlationId: "source-job-a",
    actorPrincipalId: "cleanup-service", repositoryId: "repo-a", deliveryRecordId: "delivery-a",
    cycleId: "cycle-a", observationId: "observation-a", observationArtifactId: "observation-artifact-a",
    candidateArtifactId: "candidate-artifact-a", verificationArtifactIds: ["fail-artifact-a", "pass-artifact-a"] as const,
    snapshotId: "snapshot-a", resolvedAt: "2026-08-22T12:03:00.000Z",
    cleanup: Object.freeze({ owner: "acme", repo: "service", installationId: 1, expectedRepositoryId: 2,
      pullRequestNumber: 3, baseBranch: "main", expectedBaseSha: sha("a"), headBranch: "mendpoint/change",
      expectedHeadSha: sha("b"), headDisposition: "retain_exact" as const, operationId: digest("c") }),
  });
  const recorded = Object.freeze({
    cleanupId: "cleanup-a", cleanupArtifactId: "cleanup-artifact-a", evidenceId: "cleanup-evidence-a",
    cleanup: Object.freeze({ operationId: digest("c"), pullRequestState: "closed" as const,
      branchState: "retained_exact" as const, pullRequestNumber: 3, pullRequestUrl: "https://github.com/acme/service/pull/3",
      headSha: sha("b"), baseSha: sha("a"), openPullRequestsForHead: 0, observedAt: "2026-08-22T12:03:00.000Z" }),
    observedAt: "2026-08-22T12:03:00.000Z",
    attestation: Object.freeze({ attestationId: "attestation-a", artifactId: "attestation-artifact-a",
      scope: {}, statement: {}, envelope: {} }),
  });
  return { db, job, authority, recorded, signer: { keyId: "key-a", algorithm: "ed25519" as const,
    sign: (bytes: Uint8Array) => new Uint8Array(sign(null, bytes, keys.privateKey)) } };
}

describe("delegated PR cleanup job", () => {
  it("materializes exact task and retain-only policy authority, records cleanup, and completes the lease", async () => {
    const { db, job, authority, recorded, signer } = fixture();
    const recordCleanup = vi.fn(async () => recorded as never);
    const result = await runDelegatedPrCleanupJob(db, job, {
      actorPrincipalId: "cleanup-service", signer, producerVersion: sha("f"),
      cleanupExactDraft: vi.fn(), resolveRepository: vi.fn(),
      resolveAuthority: vi.fn(async () => authority), recordCleanup,
      now: () => "2026-08-22T12:03:10.000Z",
    });
    expect(result).toBe(recorded);
    expect(recordCleanup).toHaveBeenCalledWith(db, expect.objectContaining({
      artifacts: expect.objectContaining({ sourceIds: [expect.stringMatching(/^delegated_cleanup_task_/)],
        policyId: expect.stringMatching(/^delegated_cleanup_policy_/), deliveryId: "observation-artifact-a" }),
    }), expect.objectContaining({ enabled: true }));
    const artifacts = db.raw.prepare("SELECT kind, content_text FROM artifact_manifests ORDER BY kind").all() as Array<{ kind: string; content_text: string }>;
    expect(artifacts.map(({ kind }) => kind)).toEqual(["delegated_pr_cleanup_policy", "delegated_pr_task"]);
    expect(artifacts[0]?.content_text).toContain('"deleteAuthority":false');
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({ status: "done" });
  });

  it("refuses non-running jobs before authority resolution", async () => {
    const { db, job, signer } = fixture();
    const pending = { ...job, status: "pending" as const };
    const resolveAuthority = vi.fn();
    await expect(runDelegatedPrCleanupJob(db, pending, { actorPrincipalId: "cleanup-service", signer,
      producerVersion: sha("f"), cleanupExactDraft: vi.fn(), resolveRepository: vi.fn(), resolveAuthority }))
      .rejects.toThrow("delegated_pr_cleanup_job_invalid");
    expect(resolveAuthority).not.toHaveBeenCalled();
  });

  it("reuses exact task and policy artifacts when a later lease retries after recording failed", async () => {
    const { db, job, authority, recorded, signer } = fixture();
    const base = { actorPrincipalId: "cleanup-service", signer, producerVersion: sha("f"),
      cleanupExactDraft: vi.fn(), resolveRepository: vi.fn() };
    await expect(runDelegatedPrCleanupJob(db, job, { ...base,
      resolveAuthority: vi.fn(async () => authority), recordCleanup: vi.fn(async () => { throw new Error("temporary"); }) }))
      .rejects.toThrow("temporary");
    db.raw.prepare("UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL WHERE id = ?")
      .run(job.id);
    const retry = claimNextJob(db, ["warden.candidate.cleanup"], { tenantId: "tenant-a", workerId: "worker-b",
      leaseMs: 120_000, now: "2026-08-22T12:03:30.000Z" })!;
    await expect(runDelegatedPrCleanupJob(db, retry, { ...base,
      resolveAuthority: vi.fn(async () => ({ ...authority, resolvedAt: "2026-08-22T12:04:00.000Z" })),
      recordCleanup: vi.fn(async () => recorded as never),
      now: () => "2026-08-22T12:04:10.000Z" })).resolves.toBe(recorded);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM artifact_manifests").get()).toEqual({ count: 2 });
  });

  it("refuses to sign when the attestation key expires before authority resolution completes", async () => {
    const { db, job, authority, signer } = fixture();
    const recordCleanup = vi.fn();
    await expect(runDelegatedPrCleanupJob(db, job, {
      actorPrincipalId: "cleanup-service", signer, producerVersion: sha("f"),
      keyValidFrom: "2026-08-22T00:00:00.000Z", keyValidUntil: "2026-08-22T12:03:00.000Z",
      cleanupExactDraft: vi.fn(), resolveRepository: vi.fn(),
      resolveAuthority: vi.fn(async () => authority), recordCleanup,
    })).rejects.toThrow("delegated_pr_cleanup_runtime_key_invalid");
    expect(recordCleanup).not.toHaveBeenCalled();
  });

  it("does not complete with a lease that expired during the remote cleanup", async () => {
    const { db, job, authority, recorded, signer } = fixture();
    await expect(runDelegatedPrCleanupJob(db, job, {
      actorPrincipalId: "cleanup-service", signer, producerVersion: sha("f"),
      cleanupExactDraft: vi.fn(), resolveRepository: vi.fn(),
      resolveAuthority: vi.fn(async () => authority), recordCleanup: vi.fn(async () => recorded as never),
      now: () => "2026-08-22T12:05:00.000Z",
    })).rejects.toThrow("delegated_pr_cleanup_job_lease_lost");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({ status: "running" });
  });

  it("builds runtime signing authority only from a current matching key pair", () => {
    const keys = generateKeyPairSync("ed25519");
    const env = {
      MENDPOINT_DELEGATED_PR_CLEANUP_ENABLED: "1",
      MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_ID: "cleanup-key",
      MENDPOINT_DELEGATED_PR_ATTESTATION_PRIVATE_KEY_PKCS8_BASE64:
        keys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      MENDPOINT_DELEGATED_PR_ATTESTATION_PUBLIC_KEY_SPKI_BASE64:
        keys.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      MENDPOINT_DELEGATED_PR_ATTESTATION_PRINCIPAL_ID: "cleanup-service",
      MENDPOINT_DELEGATED_PR_ATTESTATION_SERVICE: "mendpoint-delegated-cleanup",
      MENDPOINT_DELEGATED_PR_ATTESTATION_TENANT_IDS: "tenant-b,tenant-a",
      MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_VALID_FROM: "2026-08-22T00:00:00.000Z",
      MENDPOINT_DELEGATED_PR_ATTESTATION_KEY_VALID_UNTIL: "2026-08-23T00:00:00.000Z",
      MENDPOINT_RELEASE_REVISION: sha("f"),
    };
    expect(delegatedPrCleanupRuntimeConfigFromEnv({}, () => Date.parse("2026-08-22T12:00:00.000Z")))
      .toBeUndefined();
    let signingAt = Date.parse("2026-08-22T12:00:00.000Z");
    const config = delegatedPrCleanupRuntimeConfigFromEnv(env, () => signingAt);
    expect(config).toMatchObject({ actorPrincipalId: "cleanup-service", allowedTenantIds: ["tenant-a", "tenant-b"],
      keyValidFrom: "2026-08-22T00:00:00.000Z", keyValidUntil: "2026-08-23T00:00:00.000Z" });
    expect(() => config!.signer.sign(new Uint8Array([1]))).not.toThrow();
    signingAt = Date.parse("2026-08-23T00:00:00.000Z");
    expect(() => config!.signer.sign(new Uint8Array([1])))
      .toThrow("delegated_pr_cleanup_runtime_key_invalid");
    const wrong = generateKeyPairSync("ed25519");
    expect(() => delegatedPrCleanupRuntimeConfigFromEnv({ ...env,
      MENDPOINT_DELEGATED_PR_ATTESTATION_PUBLIC_KEY_SPKI_BASE64:
        wrong.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    }, () => Date.parse("2026-08-22T12:00:00.000Z"))).toThrow("delegated_pr_cleanup_runtime_key_invalid");
  });
});
