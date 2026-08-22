import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueWardenCiCycle,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertTenant,
  type AppDb,
} from "@mendpoint/db";
import type { ExactDraftObservation } from "@mendpoint/github";
import { resolveDelegatedPrCleanupAuthority } from "./delegated-pr-cleanup-authority.js";
import { assertDelegatedPrVerificationApprovalAuthority } from "./delegated-pr-verification-job.js";
import { runWardenCandidateObservation } from "./warden-candidate-observation.js";

vi.mock("./delegated-pr-verification-job.js", () => ({
  assertDelegatedPrVerificationApprovalAuthority: vi.fn(),
}));

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const authority = Object.freeze({
  required: true as const,
  verificationJobId: "verification-job-a",
  candidateArtifactId: "candidate-artifact-a",
  failToPassArtifactId: "fail-artifact-a",
  passToPassArtifactId: "pass-artifact-a",
  completedAt: "2026-08-13T12:00:30.000Z",
  candidateProducerPrincipalId: "candidate-authority",
  candidateProducerVersion: sha("f"),
});
afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReset();
  vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReturnValue(authority);
});

function exactObservation(): ExactDraftObservation {
  return Object.freeze({
    state: "draft", baseRevision: sha("a"), headRevision: sha("d"), checks: "success",
    checkRevision: sha("d"), approvals: 1, approvalRevision: sha("d"),
    conversationsResolved: true, checkIdentities: Object.freeze(["check:77:unit"]),
    checkResults: Object.freeze([Object.freeze({ identity: "check:77:unit", state: "success" })]),
    reviewFeedback: Object.freeze({ verdict: "none" as const,
      changeRequests: Object.freeze([]), comments: Object.freeze([]) }),
    repositoryId: 101, installationId: 202, matchingOpenDrafts: 1,
    changedPaths: Object.freeze(["src/a.ts"]), remoteTreeSha: sha("e"),
    failures: Object.freeze([]), evidenceRefs: Object.freeze([`github:head:${sha("d")}`]),
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-cleanup-authority-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A",
    createdAt: "2026-08-13T11:58:00.000Z" });
  for (const [id, subject] of [["candidate-authority", "candidate"], ["cleanup-service", "cleanup"]] as const) {
    insertPrincipal(db, { id, tenantId: "tenant-a", kind: "service", subject,
      displayName: subject, createdAt: "2026-08-13T11:58:00.000Z" });
  }
  const candidateContent = JSON.stringify({ candidate: "a" });
  insertArtifactManifest(db, { id: "candidate-artifact-a", tenantId: "tenant-a",
    kind: "delegated_pr_candidate", schemaVersion: 1,
    sha256: createHash("sha256").update(candidateContent).digest("hex"),
    mediaType: "application/json", sizeBytes: Buffer.byteLength(candidateContent),
    storageRef: "sqlite://candidate-artifact-a", content: candidateContent,
    producerPrincipalId: "candidate-authority", createdAt: "2026-08-13T12:00:00.000Z" });
  db.raw.prepare(`INSERT INTO agent_runs
    (id, tenant_id, job_id, goal, repo_path, status, ok, steps, result_json, created_at, finished_at)
    VALUES ('run-a', 'tenant-a', 'source-job-a', 'repair', 'repo', 'candidate_approved', 1, 1, ?, ?, ?)`)
    .run(JSON.stringify({ status: "candidate_ready", artifacts: { candidateDigest: digest("7") } }),
      "2026-08-13T11:59:00.000Z", "2026-08-13T12:00:00.000Z");
  db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
    (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
     expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
     intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
     draft_pr_url, requested_at, delivered_at, updated_at)
    VALUES ('delivery-a', 'tenant-a', 'run-a', 'delivery-job-a', 'delivered', 'repo-a', 'snapshot-a',
     'main', ?, 'sealed', ?, 'principal-a', 'approved', ?, 'mendpoint/warden-a', ?, ?, 1, 17,
     'https://github.com/acme/service/pull/17', ?, ?, ?)`)
    .run(sha("a"), digest("b"), digest("c"), sha("a"), sha("d"),
      "2026-08-13T12:00:00.000Z", "2026-08-13T12:01:00.000Z", "2026-08-13T12:01:00.000Z");
  const cycle = enqueueWardenCiCycle(db, { tenantId: "tenant-a", deliveryId: "delivery-a",
    repositoryId: "repo-a", remoteRepositoryId: 101, installationId: 202,
    requiredChecks: ["check:77:unit"], allowedChangedPaths: ["src/a.ts"], maxCycles: 3,
    maxModelCalls: 4, maximumCostUsd: 1.5, observedAt: "2026-08-13T12:01:00.000Z" });
  const observeJob = claimNextJob(db, ["warden.candidate.observe"], {
    tenantId: "tenant-a", workerId: "worker-a", leaseMs: 60_000,
    now: "2026-08-13T12:01:30.000Z",
  })!;
  await runWardenCandidateObservation({ db, job: observeJob,
    observe: async () => exactObservation(),
    persistEvidence: async (bytes) => ({ artifactId: "artifact-success-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` }),
    resolveRepository: () => ({ owner: "acme", repo: "service" }),
    now: () => "2026-08-13T12:02:00.000Z" });
  const cleanupJob = claimNextJob(db, ["warden.candidate.cleanup"], {
    tenantId: "tenant-a", workerId: "cleanup-worker", leaseMs: 60_000,
    now: "2026-08-13T12:02:30.000Z",
  })!;
  return { db, cycle, cleanupJob };
}

describe("delegated PR cleanup authority", () => {
  it("resolves an exact retain-only cleanup plan from durable authority", async () => {
    const { db, cleanupJob } = await fixture();
    const resolved = await resolveDelegatedPrCleanupAuthority(db, {
      job: cleanupJob,
      actorPrincipalId: "cleanup-service",
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:03:00.000Z",
    });

    expect(resolved).toMatchObject({
      tenantId: "tenant-a", runId: "run-a", correlationId: "source-job-a",
      actorPrincipalId: "cleanup-service", deliveryRecordId: "delivery-a",
      cycleId: expect.any(String), observationId: expect.any(String),
      observationArtifactId: "artifact-success-a", candidateArtifactId: "candidate-artifact-a",
      verificationArtifactIds: ["fail-artifact-a", "pass-artifact-a"],
      cleanup: { owner: "acme", repo: "service", installationId: 202,
        expectedRepositoryId: 101, pullRequestNumber: 17, baseBranch: "main",
        expectedBaseSha: sha("a"), headBranch: "mendpoint/warden-a",
        expectedHeadSha: sha("d"), headDisposition: "retain_exact",
        operationId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/) },
    });
  });

  it.each([
    ["observation digest", (db: AppDb) => db.raw.prepare(
      "UPDATE fettler_ci_observations SET observation_digest = ? WHERE tenant_id = ?",
    ).run(digest("9"), "tenant-a")],
    ["head", (db: AppDb) => db.raw.prepare(
      "UPDATE fettler_ci_cycles SET current_head_sha = ? WHERE tenant_id = ?",
    ).run(sha("9"), "tenant-a")],
    ["installation", (db: AppDb) => db.raw.prepare(
      "UPDATE fettler_ci_cycles SET installation_id = 999 WHERE tenant_id = ?",
    ).run("tenant-a")],
    ["candidate evidence", (db: AppDb) => {
      const content = JSON.stringify({ kind: "conflicting-candidate" });
      insertArtifactManifest(db, {
        id: "candidate-artifact-b", tenantId: "tenant-a", kind: "delegated_pr_candidate",
        schemaVersion: 1, sha256: createHash("sha256").update(content).digest("hex"),
        mediaType: "application/json", sizeBytes: Buffer.byteLength(content),
        storageRef: "sqlite://candidate-artifact-b", content,
        producerPrincipalId: "candidate-authority", createdAt: "2026-08-13T12:01:59.000Z",
      });
      insertEvidenceRecord(db, {
        id: "evidence-conflicting-observation",
        tenantId: "tenant-a",
        subjectType: "delegated_pr_github_observation",
        subjectId: (db.raw.prepare(
          "SELECT id FROM fettler_ci_observations WHERE tenant_id = ? LIMIT 1",
        ).get("tenant-a") as { id: string }).id,
        artifactId: "artifact-success-a",
        inputArtifactId: "candidate-artifact-b",
        producerPrincipalId: "candidate-authority",
        tool: "mendpoint-exact-github-observer",
        toolVersion: sha("f"),
        commitSha: sha("f"),
        verdict: "passed",
        createdAt: "2026-08-13T12:02:00.000Z",
      });
    }],
  ])("rejects altered %s before repository resolution", async (_label, mutate) => {
    const { db, cleanupJob } = await fixture();
    mutate(db);
    const resolveRepository = vi.fn(() => ({ owner: "acme", repo: "service" }));
    await expect(resolveDelegatedPrCleanupAuthority(db, { job: cleanupJob,
      actorPrincipalId: "cleanup-service", resolveRepository,
      now: () => "2026-08-13T12:03:00.000Z" }))
      .rejects.toThrow(/delegated_pr_cleanup_authority_/);
    expect(resolveRepository).not.toHaveBeenCalled();
  });

  it("rejects a revoked cleanup principal and a verifier that is no longer authoritative", async () => {
    const { db, cleanupJob } = await fixture();
    db.raw.prepare("UPDATE principals SET revoked_at = ? WHERE tenant_id = ? AND id = ?")
      .run("2026-08-13T12:02:59.000Z", "tenant-a", "cleanup-service");
    await expect(resolveDelegatedPrCleanupAuthority(db, { job: cleanupJob,
      actorPrincipalId: "cleanup-service", resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:03:00.000Z" }))
      .rejects.toThrow("delegated_pr_cleanup_authority_principal_invalid");

    db.raw.prepare("UPDATE principals SET revoked_at = NULL WHERE tenant_id = ? AND id = ?")
      .run("tenant-a", "cleanup-service");
    vi.mocked(assertDelegatedPrVerificationApprovalAuthority)
      .mockImplementation(() => { throw new Error("delegated_pr_verification_authority_invalid"); });
    await expect(resolveDelegatedPrCleanupAuthority(db, { job: cleanupJob,
      actorPrincipalId: "cleanup-service", resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:03:00.000Z" }))
      .rejects.toThrow("delegated_pr_verification_authority_invalid");
  });
});
