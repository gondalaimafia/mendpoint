import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  bindMissionScope,
  createMission,
  createMissionTask,
  enqueueJob,
  evaluateMissionExceptions,
  fettlerCampaignMissionTaskId,
  getActiveMissionDecisions,
  getAgentRun,
  getJob,
  getMission,
  getMissionTask,
  getWardenCiCycle,
  getWardenCandidateDeliveryByRun,
  getWardenCiUpdateByRun,
  insertAgentRun,
  insertPrincipal,
  missionTaskIdForJob,
  openTaskHandoff,
  raiseMissionException,
  recordWardenCandidateDeliveryOutcome,
  regaugeLaunchMissionTaskId,
  recordAudit,
  transitionMission,
  transitionMissionTask,
  verifyAuditIntegrity,
  type AppDb,
  type MissionTask,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import {
  registerWardenCandidateReviewRoutes,
  tryResolveBoundReviewHandoff,
} from "./warden-candidate-review.js";
import { enqueueDelegatedPrVerificationJob } from "@mendpoint/worker/delegated-pr-verification-job";
import { processJobsOnce } from "@mendpoint/worker/job-runner";
import type {
  ExactDraftDeliveryInput,
  ExactDraftUpdateInput,
  GitHubDelivery,
} from "@mendpoint/github";

const NOW = "2026-08-06T12:00:00.000Z";
// Production bridges a claimed agent.run onto missionTaskIdForJob(job.id)
// (ADR D3). The reviewed fixture run is source-job-1 / warden-run-1.
const REVIEW_JOB_ID = "source-job-1";
const REVIEW_TASK_ID = missionTaskIdForJob(REVIEW_JOB_ID);
// Same-repo enrollment task — a different work primitive. Review must not
// resolve this when the reviewed run's job task is what is (or is not) blocking.
const ENROLLMENT_TASK_ID = fettlerCampaignMissionTaskId("m1", "repo-1");
const CANDIDATE_DIGEST = "c".repeat(64);
const CANDIDATE_MANIFEST_SHA256 = "f".repeat(64);
const VERIFICATION_AUTHORITY = Object.freeze({
  candidateProducerPrincipalId: "candidate-authority",
  candidateProducerVersion: "f".repeat(40),
  authorityId: "verifier-a",
  authorityDigest: `sha256:${"3".repeat(64)}`,
  executionAuthorityId: "sandbox-a",
  mendpointRevision: "f".repeat(40),
  policy: Object.freeze({
    failToPassCommandDigest: `sha256:${"1".repeat(64)}`,
    passToPassCommandDigest: `sha256:${"2".repeat(64)}`,
    sandboxBackend: "fly_machines",
  }),
});
const MEMBERSHIP_EVIDENCE_ID = `membership:${createHash("sha256")
  .update("tenant-a\nhttps://identity.example.com\nreviewer-a", "utf8")
  .digest("hex")}`;
const opened: Array<{ db: AppDb; directory: string }> = [];

function markDelegatedVerificationRequest(db: AppDb, jobId: string): void {
  db.raw.prepare("UPDATE jobs SET result_json = ? WHERE id = ? AND tenant_id = ?")
    .run(JSON.stringify({ sessionId: "warden-run-1", status: "candidate_ready",
      delegatedVerification: { schemaVersion: 1, jobId, authority: VERIFICATION_AUTHORITY } }),
    "source-job-1", "tenant-a");
}

function approvalArtifact(input: Readonly<{
  directory: string; revision: string; rationale: string;
}>) {
  const dataRoot = join(input.directory, "data");
  const approvals = join(dataRoot, "warden-evidence", "tenant-a", "approvals");
  mkdirSync(approvals, { recursive: true });
  const before = Buffer.from("export const old = 1;\n");
  const after = Buffer.from("export const fixed = 1;\n");
  const beforeSha256 = `sha256:${createHash("sha256").update(before).digest("hex")}`;
  const afterSha256 = `sha256:${createHash("sha256").update(after).digest("hex")}`;
  const artifact = {
    schemaVersion: 3,
    tenantId: "tenant-a",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: input.revision,
    reviewerPrincipalId: "trust-human-a",
    rationale: input.rationale,
    reviewEvidence: {
      schemaVersion: 1,
      summary: "The exact candidate passed every configured check.",
      verification: { summary: "The target and regression checks passed.", commands: [{
        command: "npm test", ok: true, exitCode: 0, outputSha256: `sha256:${"e".repeat(64)}`,
      }] },
      edits: [{
        path: "src/client.ts", rationale: "Repair the bounded SDK call.", category: "api_repair",
        risk: "medium", confidence: 1, assessmentSource: "planner",
        verification: { summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"e".repeat(64)}`] },
      }],
    },
    changedPaths: ["src/client.ts"],
    sourceDigest: `sha256:${"c".repeat(64)}`,
    candidate: { digest: `sha256:${"d".repeat(64)}`, entries: [{
      path: "src/client.ts", size: after.byteLength, sha256: afterSha256, executable: false,
    }] },
    files: [{ path: "src/client.ts", before: before.toString("base64"), after: after.toString("base64"),
      beforeSha256, afterSha256 }],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const sha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const path = join(approvals, `${sha256.slice(7)}.json`);
  writeFileSync(path, bytes);
  return { artifact, dataRoot, path, sha256 };
}

function fixture(options: {
  audit?: Parameters<typeof registerWardenCandidateReviewRoutes>[2];
  sealApproval?: NonNullable<Parameters<typeof registerWardenCandidateReviewRoutes>[3]>["sealApproval"];
  now?: () => string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-review-api-"));
  const db = createDb(join(directory, "api.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(NOW);
  insertPrincipal(db, {
    id: "trust-human-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "https://identity.example.com|reviewer-a",
    displayName: "Reviewer",
    audience: "https://identity.example.com",
    createdAt: NOW,
  });
  db.raw.prepare(`INSERT INTO tenant_memberships
    (tenant_id, issuer, subject, email, display_name, role, status, created_at, updated_at)
    VALUES ('tenant-a', 'https://identity.example.com', 'reviewer-a', 'reviewer@example.com',
      'Reviewer', 'owner', 'active', ?, ?)`)
    .run(NOW, NOW);
  enqueueJob(db, {
    id: "source-job-1",
    tenantId: "tenant-a",
    type: "agent.run",
    payload: {
      goal: "Repair the SDK",
      consumerId: "consumer-1",
      allowedChangedPaths: ["src/client.ts"],
      verifyCommand: "npm test",
      sessionId: "warden-run-1",
    },
    createdAt: NOW,
  });
  insertAgentRun(db, {
    id: "warden-run-1",
    tenantId: "tenant-a",
    jobId: "source-job-1",
    goal: "Repair the SDK",
    repoPath: "C:\\snapshot",
    status: "candidate_ready",
    ok: true,
    steps: 3,
    filesChanged: ["src/client.ts"],
    resultJson: JSON.stringify({
      source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
      artifacts: {
        candidateDigest: CANDIDATE_DIGEST,
        candidateManifestSha256: CANDIDATE_MANIFEST_SHA256,
      },
    }),
    createdAt: NOW,
    finishedAt: NOW,
  });
  const audit = options.audit ?? vi.fn((c, event) => {
    const principal = c.get("principal")!;
    recordAudit(db, {
      id: `audit-${event.action}-${event.resourceId}`,
      ...event,
      tenantId: principal.tenantId,
      principalId: c.get("trustPrincipalId") ?? principal.id,
      apiKeyId: c.get("apiKeyId") ?? null,
      requestId: c.get("requestId") ?? null,
    });
  });
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "human:reviewer@example.com", tenantId: "tenant-a", role: "owner" });
    c.set("trustPrincipalId", "trust-human-a");
    c.set("authMethod", "oidc");
    c.set("membershipEvidenceId", MEMBERSHIP_EVIDENCE_ID);
    c.set("requestId", "request-1");
    return next();
  });
  registerWardenCandidateReviewRoutes(app, db, audit, {
    now: options.now ?? (() => NOW),
    ...(options.sealApproval ? { sealApproval: options.sealApproval } : {}),
  });
  return { app, db, audit, directory };
}

function seedCiRepairCandidate(db: AppDb, reviewFeedbackDigest: string | null = null) {
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection-ci', 'tenant-a', 'github', 'app://22', '22', 'GitHub', ?, ?)`)
    .run(NOW, NOW);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-1', 'tenant-a', 'connection-ci', '11', 'acme', 'sdk', 'main', 'main',
     'production', 30, 'ready', ?, ?)`)
    .run(NOW, NOW);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-1', 'tenant-a', 'repo-1', ?, ?, ?, 'C:\\snapshot',
     'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
    .run("d".repeat(40), "d".repeat(40), `sha256:${"c".repeat(64)}`, NOW);
  const current = JSON.parse(getAgentRun(db, "warden-run-1", "tenant-a")!.result_json!) as Record<string, unknown>;
  const ciFailure = { cycleId: "cycle-a", deliveryId: "delivery-a", pullRequestNumber: 17,
    failedHeadSha: "d".repeat(40), observationDigest: `sha256:${"e".repeat(64)}`,
    evidenceArtifactId: "artifact-failure-a", evidenceDigest: `sha256:${"f".repeat(64)}`,
    ...(reviewFeedbackDigest ? { trigger: "review_feedback", reviewFeedbackDigest } : { trigger: "ci_failure" }) };
  db.raw.prepare("UPDATE agent_runs SET result_json = ? WHERE id = 'warden-run-1'")
    .run(JSON.stringify({ ...current, source: { repositoryId: "repo-1", snapshotId: "snapshot-1",
      revision: "d".repeat(40) }, ciFailure }));
  db.raw.prepare(`INSERT INTO fettler_ci_cycles
    (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
     installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
     required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
     maximum_cost_usd, current_observation_digest, repair_run_id, repair_job_id, created_at, updated_at)
    VALUES ('cycle-a', 'tenant-a', 'delivery-a', 'observe-old', 'repair_pending', 'repo-1', 11,
     22, 17, 'main', 'mendpoint/warden-a', ?, ?, '["check:77:unit"]', '["src/client.ts"]',
     3, 1, 6, 3, ?, 'warden-run-1', 'source-job-1', ?, ?)`)
    .run("a".repeat(40), "d".repeat(40), `sha256:${"e".repeat(64)}`, NOW, NOW);
  db.raw.prepare(`INSERT INTO fettler_ci_observations
    (id, tenant_id, cycle_id, head_sha, verdict, observation_digest, evidence_artifact_id,
     evidence_digest, observed_at)
    VALUES ('observation-a', 'tenant-a', 'cycle-a', ?, 'failure', ?, 'artifact-failure-a', ?, ?)`)
    .run("d".repeat(40), `sha256:${"e".repeat(64)}`, `sha256:${"f".repeat(64)}`, NOW);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Warden candidate human review", () => {
  it("lets an authorized human inspect and durably pause an active CI cycle", async () => {
    const { app, db, audit } = fixture();
    db.raw.prepare(`INSERT INTO fettler_ci_cycles
      (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
       installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
       required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
       maximum_cost_usd, created_at, updated_at)
      VALUES ('cycle-control-a', 'tenant-a', 'delivery-control-a', 'observe-control-a',
       'checks_failed', 'repo-1', 11, 22, 17, 'main', 'mendpoint/warden-a', ?, ?,
       '["check:77:unit"]', '["src/client.ts"]', 3, 1, 6, 3, ?, ?)`)
      .run("a".repeat(40), "d".repeat(40), NOW, NOW);

    const read = await app.request("/agent/ci-cycles/cycle-control-a");
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ cycle: { id: "cycle-control-a", status: "checks_failed",
      usedCycles: 1, maxCycles: 3 }, observations: [] });

    const paused = await app.request("/agent/ci-cycles/cycle-control-a/pause", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "Pause while an engineer reviews the upstream CI failure." }),
    });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ cycle: { status: "paused",
      pausedBy: "human:reviewer@example.com" } });
    expect(getWardenCiCycle(db, "tenant-a", "cycle-control-a")).toMatchObject({
      status: "paused", pauseReason: "Pause while an engineer reviews the upstream CI failure.",
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.ci_cycle.paused", resourceId: "cycle-control-a",
    }));
  });

  it("uses a fresh human approval to update the existing CI draft instead of opening another pull request", async () => {
    const sealPath = "C:\\sealed-ci-approval.json";
    const sealSha = `sha256:${"b".repeat(64)}`;
    const { app, db, audit } = fixture({ sealApproval: async () => ({ path: sealPath, sha256: sealSha, created: true }) });
    seedCiRepairCandidate(db);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve the exact CI repair." }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "candidate_approved",
      update: { cycleId: "cycle-a", expectedHeadSha: "d".repeat(40) } });
    expect(getWardenCiUpdateByRun(db, "tenant-a", "warden-run-1")).toMatchObject({
      status: "pending", expectedHeadSha: "d".repeat(40), sealedSha256: sealSha,
      reviewerPrincipalId: "trust-human-a",
    });
    expect(JSON.parse(getAgentRun(db, "warden-run-1", "tenant-a")!.result_json!)).toMatchObject({
      review: {
        reviewerPrincipalId: "trust-human-a",
        trustPrincipalId: "trust-human-a",
        authMethod: "oidc",
        membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
        reviewedAt: NOW,
      },
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.candidate.approved",
      metadata: expect.objectContaining({
        reviewerPrincipalId: "trust-human-a",
        trustPrincipalId: "trust-human-a",
        authMethod: "oidc",
        membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
        reviewedAt: NOW,
        candidateDigest: CANDIDATE_DIGEST,
        candidateManifestSha256: CANDIDATE_MANIFEST_SHA256,
      }),
    }));
    const approvalAudit = db.raw.prepare(
      "SELECT principal_id, metadata_json FROM audit_events WHERE action = 'agent.candidate.approved'",
    ).get() as { principal_id: string | null; metadata_json: string };
    expect(approvalAudit.principal_id).toBe("trust-human-a");
    expect(JSON.parse(approvalAudit.metadata_json)).toMatchObject({
      trustPrincipalId: "trust-human-a",
      authMethod: "oidc",
      membershipEvidenceId: MEMBERSHIP_EVIDENCE_ID,
      reviewedAt: NOW,
      candidateDigest: CANDIDATE_DIGEST,
      candidateManifestSha256: CANDIDATE_MANIFEST_SHA256,
    });
    expect(verifyAuditIntegrity(db, "tenant-a").ok).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get())
      .toEqual({ count: 0 });
  });

  it.each([
    ["pending", "delegated_pr_verification_pending"],
    ["dead_letter", "delegated_pr_verification_failed"],
  ])("does not seal or approve while a requested delegated verification is %s", async (status, error) => {
    const sealApproval = vi.fn(async () => ({ path: "C:\\sealed.json",
      sha256: `sha256:${"b".repeat(64)}`, created: true }));
    const { app, db } = fixture({ sealApproval });
    seedCiRepairCandidate(db);
    const run = getAgentRun(db, "warden-run-1", "tenant-a")!;
    const result = JSON.parse(run.result_json!) as Record<string, unknown>;
    db.raw.prepare("UPDATE agent_runs SET result_json = ? WHERE id = ? AND tenant_id = ?")
      .run(JSON.stringify({ ...result, artifacts: {
        ...(result.artifacts as Record<string, unknown>), candidateDigest: `sha256:${CANDIDATE_DIGEST}`,
      } }), run.id, run.tenant_id);
    const verificationJobId = enqueueDelegatedPrVerificationJob(db, { tenantId: "tenant-a", runId: "warden-run-1",
      correlationId: "source-job-1", createdAt: NOW });
    markDelegatedVerificationRequest(db, verificationJobId);
    db.raw.prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, verificationJobId);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only after independent verification." }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error });
    expect(sealApproval).not.toHaveBeenCalled();
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(getWardenCiUpdateByRun(db, "tenant-a", "warden-run-1")).toBeUndefined();
  });

  it("rechecks delegated verification after sealing and blocks a late request", async () => {
    let database: AppDb | undefined;
    const sealApproval = vi.fn(async () => {
      const verificationJobId = enqueueDelegatedPrVerificationJob(database!, { tenantId: "tenant-a", runId: "warden-run-1",
        correlationId: "source-job-1", createdAt: NOW });
      markDelegatedVerificationRequest(database!, verificationJobId);
      return { path: "C:\\sealed-race.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
    });
    const value = fixture({ sealApproval });
    database = value.db;
    seedCiRepairCandidate(value.db);
    const run = getAgentRun(value.db, "warden-run-1", "tenant-a")!;
    const result = JSON.parse(run.result_json!) as Record<string, unknown>;
    value.db.raw.prepare("UPDATE agent_runs SET result_json = ? WHERE id = ? AND tenant_id = ?")
      .run(JSON.stringify({ ...result, artifacts: {
        ...(result.artifacts as Record<string, unknown>), candidateDigest: `sha256:${CANDIDATE_DIGEST}`,
      } }), run.id, run.tenant_id);

    const response = await value.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only if authority remains current." }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "delegated_pr_verification_pending" });
    expect(sealApproval).toHaveBeenCalledTimes(1);
    expect(getAgentRun(value.db, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(getWardenCiUpdateByRun(value.db, "tenant-a", "warden-run-1")).toBeUndefined();
  });

  it("does not grant delivery authority when membership is revoked while the approval is sealed", async () => {
    let database: AppDb | undefined;
    const fixtureResult = fixture({
      sealApproval: async () => {
        database!.raw.prepare(`UPDATE tenant_memberships
          SET status = 'offboarded', offboarded_at = ?, updated_at = ?
          WHERE tenant_id = 'tenant-a' AND issuer = 'https://identity.example.com' AND subject = 'reviewer-a'`)
          .run("2026-08-06T12:00:01.000Z", "2026-08-06T12:00:01.000Z");
        return { path: "C:\\sealed-revoked-approval.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
      },
    });
    database = fixtureResult.db;
    seedCiRepairCandidate(database);

    const response = await fixtureResult.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only while membership is active." }),
    });

    const responseBody = await response.json();
    expect({ status: response.status, body: responseBody }).toEqual({
      status: 403,
      body: { error: "human_review_required", requestId: "request-1" },
    });
    expect(getAgentRun(database, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(database.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get())
      .toEqual({ count: 0 });
  });

  it("binds an approved review repair update to the exact observed feedback digest", async () => {
    const reviewDigest = `sha256:${"9".repeat(64)}`;
    const { app, db } = fixture({ sealApproval: async () => ({ path: "C:\\sealed.json",
      sha256: `sha256:${"b".repeat(64)}`, created: true }) });
    seedCiRepairCandidate(db, reviewDigest);
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve the exact review repair." }) });
    expect(response.status).toBe(202);
    expect(getWardenCiUpdateByRun(db, "tenant-a", "warden-run-1"))
      .toMatchObject({ expectedFeedbackDigest: reviewDigest });
  });

  it("pauses the exact CI repair cycle when the human rejects its candidate", async () => {
    const { app, db } = fixture();
    seedCiRepairCandidate(db);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", rationale: "The repair changes the public contract." }),
    });

    expect(response.status).toBe(200);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "paused", pausedBy: "human:reviewer@example.com", pauseReason: "candidate_rejected",
      repairRunId: "warden-run-1", usedCycles: 1,
    });
  });

  it("rebinds the same failed head and cumulative budget to a regenerated CI run", async () => {
    const { app, db } = fixture();
    seedCiRepairCandidate(db);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Keep the fix but preserve the public signature." }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { supersedingRunId: string; supersedingJobId: string };
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "repair_pending", repairRunId: body.supersedingRunId,
      repairJobId: body.supersedingJobId, currentHeadSha: "d".repeat(40), usedCycles: 2,
    });
  });

  it("rejects regeneration when the cumulative cycle budget is exhausted", async () => {
    const { app, db } = fixture();
    seedCiRepairCandidate(db);
    db.raw.prepare("UPDATE fettler_ci_cycles SET used_cycles = max_cycles WHERE id = 'cycle-a'").run();
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Try another bounded repair." }) });
    expect(response.status).toBe(409);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({ usedCycles: 3,
      repairRunId: "warden-run-1" });
  });

  it.each([
    "provider returned github_pat_SENTINEL for secret-org/private-repo",
    "SQLITE_CONSTRAINT tenants.secret_column customer_acme",
    "ENOENT C:\\customers\\acme\\private-source.ts",
    "repository secret-org/private-repo exists but is inaccessible",
  ])("sanitizes an unmapped review failure: %s", async (sentinel) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app } = fixture({ audit: () => { throw new Error(sentinel); } });

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", rationale: "The candidate is not acceptable." }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal_error", requestId: "request-1" });
    expect(log.mock.calls.flat().join(" ")).not.toContain(sentinel);
  });

  it("requires a bounded human rationale", async () => {
    const { app } = fixture();
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", rationale: "   " }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "review rationale is required" });
  });

  it("creates one immutable superseding run with attributed regeneration feedback", async () => {
    const { app, db, audit } = fixture();
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "regenerate",
        rationale: "Keep the public signature and repair the internal request mapping.",
      }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { supersedingRunId: string; supersedingJobId: string };
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_superseded");
    expect(getAgentRun(db, body.supersedingRunId, "tenant-a")).toMatchObject({ status: "queued" });
    const job = getJob(db, body.supersedingJobId, "tenant-a");
    expect(JSON.parse(job!.payload_json)).toMatchObject({
      sessionId: body.supersedingRunId,
      reviewFeedback: "Keep the public signature and repair the internal request mapping.",
      supersedesRunId: "warden-run-1",
      reviewerPrincipalId: "human:reviewer@example.com",
    });
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "agent.candidate.regeneration_requested",
      metadata: expect.objectContaining({ reviewerPrincipalId: "human:reviewer@example.com" }),
    }));
  });

  // First real caller of the mission decision store (task brief §4). When the
  // regenerate is part of a formal mission, the reviewer's directive is recorded
  // as a durable ACTIVE decision so a later cycle inherits it through the
  // compiled envelope. Deleting the recordReviewerDirective call in the
  // regenerate branch makes this die.
  it("records the reviewer directive as a mission decision when the regenerate is mission-bound", async () => {
    const { app, db } = fixture();
    createMission(db, {
      id: "m1", tenantId: "tenant-a", product: "fettler", triggerKind: "migration_objective",
      objective: "Migrate the SDK", ownerPrincipalId: "trust-human-a",
      eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: NOW,
    });
    const src = getJob(db, "source-job-1", "tenant-a")!;
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = 'source-job-1'")
      .run(JSON.stringify({ ...JSON.parse(src.payload_json), missionId: "m1" }));

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "regenerate",
        rationale: "Do not use a raw OAuth flow: it violates the internal auth policy.",
      }),
    });
    expect(response.status).toBe(202);
    const body = await response.json() as { supersedingJobId: string };
    // The mission id is carried forward to the regenerated run.
    expect(JSON.parse(getJob(db, body.supersedingJobId, "tenant-a")!.payload_json)).toMatchObject({ missionId: "m1" });
    // The reviewer directive is now a durable active decision on the mission.
    const active = getActiveMissionDecisions(db, "tenant-a", "m1");
    expect(active).toHaveLength(1);
    expect(active[0]!.decision).toBe("Do not use a raw OAuth flow: it violates the internal auth policy.");
    expect(active[0]!.scope).toBe("reviewer_directive:warden-run-1");
    expect(active[0]!.decisionType).toBe("verification");
  });

  it("records the rejected approach as a path-scoped mission decision when reject is mission-bound", async () => {
    const { app, db } = fixture();
    createMission(db, {
      id: "m1", tenantId: "tenant-a", product: "fettler", triggerKind: "migration_objective",
      objective: "Migrate the SDK", ownerPrincipalId: "trust-human-a",
      eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: NOW,
    });
    const src = getJob(db, "source-job-1", "tenant-a")!;
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = 'source-job-1'")
      .run(JSON.stringify({ ...JSON.parse(src.payload_json), missionId: "m1" }));

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "reject",
        rationale: "Do not rewrite the public SDK surface.",
      }),
    });
    expect(response.status).toBe(200);
    const active = getActiveMissionDecisions(db, "tenant-a", "m1");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      decision: "Do not rewrite the public SDK surface.",
      scope: "src/client.ts",
      decisionType: "other",
    });
    expect(active[0]!.evidence).toEqual([
      "agent_run:warden-run-1",
      `candidate:${CANDIDATE_DIGEST}`,
    ]);
  });

  it("records no mission decision when the reject is not mission-bound (no fabrication)", async () => {
    const { app, db } = fixture();
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", rationale: "The candidate is not acceptable." }),
    });
    expect(response.status).toBe(200);
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM mission_decisions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  it("records no mission decision when the regenerate is not mission-bound (no fabrication)", async () => {
    const { app, db } = fixture();
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Repair the internal mapping." }),
    });
    expect(response.status).toBe(202);
    // No mission exists and none is fabricated: the decision store stays empty.
    const count = db.raw.prepare("SELECT COUNT(*) AS n FROM mission_decisions").get() as { n: number };
    expect(count.n).toBe(0);
  });

  function bindMission(db: AppDb, product: "fettler" | "regauge" = "fettler"): void {
    createMission(db, {
      id: "m1", tenantId: "tenant-a", product, triggerKind: "migration_objective",
      objective: "Migrate the SDK", ownerPrincipalId: "trust-human-a",
      eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: NOW,
    });
    const src = getJob(db, "source-job-1", "tenant-a")!;
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = 'source-job-1'")
      .run(JSON.stringify({ ...JSON.parse(src.payload_json), missionId: "m1" }));
  }

  function scopeMission(db: AppDb): void {
    bindMissionScope(db, {
      tenantId: "tenant-a", missionId: "m1", repositoryId: "repo-1", snapshotId: "snapshot-1",
      actorPrincipalId: "trust-human-a", eventId: "ev-m1-scope", idempotencyKey: "cm-m1-scope",
      correlationId: "corr", createdAt: NOW,
    });
  }

  function workingTask(db: AppDb): MissionTask {
    let task = createMissionTask(db, {
      id: REVIEW_TASK_ID, tenantId: "tenant-a", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "tests pass", risk: "medium", actorPrincipalId: "trust-human-a",
      eventId: "e-task-1", idempotencyKey: "c-task-1", correlationId: "corr", createdAt: NOW,
    });
    task = transitionMissionTask(db, {
      tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision, to: "agent_assigned",
      actorPrincipalId: "trust-human-a", eventId: "e-assign", idempotencyKey: "c-assign",
      correlationId: "corr", createdAt: NOW,
    });
    return transitionMissionTask(db, {
      tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision, to: "agent_working",
      actorPrincipalId: "trust-human-a", eventId: "e-work", idempotencyKey: "c-work",
      correlationId: "corr", createdAt: NOW,
    });
  }

  // Advance any MissionTask (by id) to agent_working so a handoff can be
  // opened on it. Event keys are namespaced by the task id.
  function advanceTaskToWorking(db: AppDb, taskId: string): MissionTask {
    let task = createMissionTask(db, {
      id: taskId, tenantId: "tenant-a", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "tests pass", risk: "medium", actorPrincipalId: "trust-human-a",
      eventId: `e-create-${taskId}`, idempotencyKey: `c-create-${taskId}`, correlationId: "corr", createdAt: NOW,
    });
    task = transitionMissionTask(db, {
      tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision, to: "agent_assigned",
      actorPrincipalId: "trust-human-a", eventId: `e-assign-${taskId}`, idempotencyKey: `c-assign-${taskId}`,
      correlationId: "corr", createdAt: NOW,
    });
    return transitionMissionTask(db, {
      tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision, to: "agent_working",
      actorPrincipalId: "trust-human-a", eventId: `e-work-${taskId}`, idempotencyKey: `c-work-${taskId}`,
      correlationId: "corr", createdAt: NOW,
    });
  }

  // A second candidate_ready run whose source job carries mission m1. The
  // resolver binds to missionTaskIdForJob(jobId), not the repo enrollment id.
  function seedReviewRunForRepo(db: AppDb, input: { runId: string; jobId: string; repositoryId: string }): void {
    enqueueJob(db, {
      id: input.jobId, tenantId: "tenant-a", type: "agent.run",
      payload: { goal: "Repair the SDK", sessionId: input.runId, missionId: "m1" }, createdAt: NOW,
    });
    insertAgentRun(db, {
      id: input.runId, tenantId: "tenant-a", jobId: input.jobId, goal: "Repair the SDK",
      repoPath: "C:\\snapshot", status: "candidate_ready", ok: true, steps: 3, filesChanged: ["src/client.ts"],
      resultJson: JSON.stringify({
        source: { repositoryId: input.repositoryId, snapshotId: "snapshot-1", revision: "a".repeat(40) },
        artifacts: { candidateDigest: CANDIDATE_DIGEST, candidateManifestSha256: CANDIDATE_MANIFEST_SHA256 },
      }),
      createdAt: NOW, finishedAt: NOW,
    });
  }

  // repo-1 / snapshot-1 at the exact resolved sha the default fixture run is on,
  // so a handoff can be observed against the reviewed run's CURRENT snapshot.
  function seedReviewedSnapshot(db: AppDb): void {
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('connection-review', 'tenant-a', 'github', 'app://33', '33', 'GitHub', ?, ?)`)
      .run(NOW, NOW);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-1', 'tenant-a', 'connection-review', '11', 'acme', 'sdk', 'main', 'main',
       'production', 30, 'ready', ?, ?)`)
      .run(NOW, NOW);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-1', 'tenant-a', 'repo-1', 'main', ?, ?, 'C:\\snapshot',
       'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
      .run("a".repeat(40), `sha256:${"c".repeat(64)}`, NOW);
  }

  // CONTROL (Defect B, task binding): on a multi-task mission the resolver must
  // resolve ONLY the blocker bound to the reviewed run's job task, never a
  // sibling job's. Reverting to enrollment-id binding or "any single blocker"
  // turns this RED: neither sibling is an enrollment id, so the job task stays
  // human_review_required.
  it("resolves only the reviewed run's job task on a multi-task mission, never a sibling's blocker", async () => {
    const { app, db } = fixture();
    bindMission(db);
    const taskA = missionTaskIdForJob("source-job-A");
    const taskB = missionTaskIdForJob("source-job-2");
    advanceTaskToWorking(db, taskA);
    advanceTaskToWorking(db, taskB);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    const openedA = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: taskA, reason: "architecture_decision_required",
      question: "Task A: keep the public signature?", context: "Task A candidate changed the mapping.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    const openedB = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: taskB, reason: "architecture_decision_required",
      question: "Task B: keep the public signature?", context: "Task B candidate changed the mapping.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    seedReviewRunForRepo(db, { runId: "warden-run-2", jobId: "source-job-2", repositoryId: "repo-B" });
    const response = await app.request("/agent/runs/warden-run-2/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Task B: keep the public signature." }),
    });
    expect(response.status).toBe(202);
    expect(getMissionTask(db, "tenant-a", taskB)?.status).toBe("agent_resume");
    expect(getMissionTask(db, "tenant-a", taskA)?.status).toBe("human_review_required");
    const resolvedSupersedes = evaluateMissionExceptions(db, "tenant-a", "m1").resolved.map((row) => row.supersedesId);
    expect(resolvedSupersedes).toContain(openedB.id);
    expect(resolvedSupersedes).not.toContain(openedA.id);
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").blocking.some((row) => row.taskId === taskA)).toBe(true);
  });

  // FAILURE / mutation: enrollment and job tasks both blocking on the same
  // (mission, repository). Live review must resolve ONLY the job task.
  // Rebinding expectedTaskId to fettlerCampaignMissionTaskId(mission, repo)
  // resumes the enrollment task and leaves the reviewed run's task blocked.
  it("resolves the reviewed run's job task and leaves the same-repo enrollment blocker open", async () => {
    const { app, db } = fixture();
    bindMission(db);
    workingTask(db);
    advanceTaskToWorking(db, ENROLLMENT_TASK_ID);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    const openedJob = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID, reason: "architecture_decision_required",
      question: "Job: keep the public signature?", context: "Reviewed run changed the mapping.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    const openedEnrollment = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: ENROLLMENT_TASK_ID, reason: "architecture_decision_required",
      question: "Enrollment: keep the campaign scope?", context: "Enrollment is still waiting.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Job: keep the public signature." }),
    });
    expect(response.status).toBe(202);
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)?.status).toBe("agent_resume");
    expect(getMissionTask(db, "tenant-a", ENROLLMENT_TASK_ID)?.status).toBe("human_review_required");
    const resolvedSupersedes = evaluateMissionExceptions(db, "tenant-a", "m1").resolved.map((row) => row.supersedesId);
    expect(resolvedSupersedes).toContain(openedJob.id);
    expect(resolvedSupersedes).not.toContain(openedEnrollment.id);
  });

  // Live-path: the only blocker is the enrollment task. Review of the job
  // must SKIP — unknown-to-this-run is not "close the one blocker we see."
  // Enrollment-id binding turns this RED by resolving that enrollment task.
  it("does not resolve a same-repo enrollment blocker when the reviewed job task is not blocking", async () => {
    const { app, db } = fixture();
    bindMission(db);
    advanceTaskToWorking(db, ENROLLMENT_TASK_ID);
    openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: ENROLLMENT_TASK_ID, reason: "architecture_decision_required",
      question: "Enrollment: keep the campaign scope?", context: "Only the enrollment task is waiting.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "This rationale belongs to the job, not enrollment." }),
    });
    expect(response.status).toBe(202);
    expect(getMissionTask(db, "tenant-a", ENROLLMENT_TASK_ID)?.status).toBe("human_review_required");
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(true);
  });

  // Edge: missing jobId is "not determined" — skip even when exactly one
  // blocker exists. Falling back to any-single-blocker turns this RED.
  it("skips handoff resolution when the reviewed run's job id is unknown", () => {
    const { db } = fixture();
    bindMission(db);
    workingTask(db);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID, reason: "architecture_decision_required",
      question: "Keep the public signature?", context: "Candidate changed the mapping.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });
    const resolved = tryResolveBoundReviewHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      jobId: null,
      runId: "warden-run-1",
      rationale: "Keep the public signature.",
      authorPrincipalId: "trust-human-a",
      correlationId: "corr",
      createdAt: NOW,
    });
    expect(resolved).toBeUndefined();
    const blankJob = tryResolveBoundReviewHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      jobId: "   ",
      runId: "warden-run-1",
      rationale: "Keep the public signature.",
      authorPrincipalId: "trust-human-a",
      correlationId: "corr",
      createdAt: NOW,
    });
    expect(blankJob).toBeUndefined();
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)?.status).toBe("human_review_required");
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(true);
  });

  // CONTROL (Defect B, current snapshot): the resolver passes the reviewed run's
  // snapshot to evaluateMissionExceptions so a blocker observed against that same
  // snapshot is current and resolves. Dropping the `current` argument turns this
  // RED: a context-bound exception with no current supplied is STALE, so it never
  // enters `blocking` and the handoff is never resolved.
  it("resolves a handoff observed against the reviewed run's current snapshot", async () => {
    const { app, db } = fixture();
    bindMission(db);
    workingTask(db);
    seedReviewedSnapshot(db);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    const opened = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID, reason: "architecture_decision_required",
      question: "Keep the public signature?", context: "Candidate changed the mapping.",
      ownerPrincipalId: "trust-human-a",
      observedAgainst: { snapshotId: "snapshot-1", resolvedSha: "a".repeat(40) },
      correlationId: "corr", createdAt: NOW,
    });
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Keep the public signature." }),
    });
    expect(response.status).toBe(202);
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)?.status).toBe("agent_resume");
    const current = { snapshotId: "snapshot-1", resolvedSha: "a".repeat(40) };
    expect(evaluateMissionExceptions(db, "tenant-a", "m1", current).resolved.map((row) => row.supersedesId))
      .toContain(opened.id);
  });

  // CONTROL: deleting tryResolveBoundReviewHandoff on regenerate leaves the
  // exception blocking and the MissionTask in human_review_required.
  it("resolves an open handoff on mission-bound regenerate and moves the task to agent_resume", async () => {
    const { app, db } = fixture();
    bindMission(db);
    workingTask(db);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    const openedHandoff = openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required",
      question: "Should the SDK keep the public signature?",
      context: "Candidate changed the request mapping.",
      ownerPrincipalId: "trust-human-a",
      correlationId: "corr",
      createdAt: NOW,
    });
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(true);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        decision: "regenerate",
        rationale: "Keep the public signature and repair the internal request mapping.",
      }),
    });
    expect(response.status).toBe(202);
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(false);
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").resolved.map((row) => row.supersedesId))
      .toContain(openedHandoff.id);
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)).toMatchObject({
      status: "agent_resume",
      ownerType: "agent",
    });
    const resolutions = getActiveMissionDecisions(db, "tenant-a", "m1")
      .filter((row) => row.decisionType === "exception_resolution");
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0]).toMatchObject({
      scope: "handoff_resolution:warden-run-1",
      decision: "Keep the public signature and repair the internal request mapping.",
    });
  });

  it("does not resolve an open handoff on reject (task stays human-owned)", async () => {
    const { app, db } = fixture();
    bindMission(db);
    workingTask(db);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required",
      question: "Should we abandon this approach?",
      context: "Reviewer is rejecting the candidate.",
      ownerPrincipalId: "trust-human-a",
      correlationId: "corr",
      createdAt: NOW,
    });
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject", rationale: "This approach is unsafe." }),
    });
    expect(response.status).toBe(200);
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(true);
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)?.status).toBe("human_review_required");
  });

  it("resolves an open handoff on mission-bound approve", async () => {
    const { app, db } = fixture({
      sealApproval: async () => ({ path: "C:\\sealed-handoff-approval.json", sha256: `sha256:${"b".repeat(64)}`, created: true }),
    });
    seedCiRepairCandidate(db);
    bindMission(db);
    scopeMission(db);
    workingTask(db);
    // Fixture-established precondition (not end-to-end): production mints this job-task handoff only via handoffCompletedJobToMissionReview.
    openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required",
      question: "Proceed to CI update after verification passed?",
      context: "Post-edit verification passed.",
      ownerPrincipalId: "trust-human-a",
      correlationId: "corr",
      createdAt: NOW,
    });
    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve the exact CI repair." }),
    });
    expect(response.status).toBe(202);
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(false);
    expect(getMissionTask(db, "tenant-a", REVIEW_TASK_ID)?.status).toBe("agent_resume");
  });

  it("keeps the committed winner seal through an orchestrated concurrent approval conflict", async () => {
    const { app: _unused, db, audit, directory } = fixture();
    db.raw.prepare(
      `INSERT INTO scm_connections
       (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
       VALUES ('connection-1', 'tenant-a', 'github', 'app://1', '1', 'GitHub', ?, ?)`,
    ).run(NOW, NOW);
    db.raw.prepare(
      `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
        environment, retention_days, status, created_at, updated_at)
       VALUES ('repo-1', 'tenant-a', 'connection-1', '11', 'acme', 'sdk', 'main', 'main',
        'production', 30, 'ready', ?, ?)`,
    ).run(NOW, NOW);
    db.raw.prepare(
      `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
        submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
       VALUES ('snapshot-1', 'tenant-a', 'repo-1', 'main', ?, ?, 'C:\\snapshot',
        'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`,
    ).run("a".repeat(40), `sha256:${"c".repeat(64)}`, NOW);
    const sealPath = join(directory, "winner.json");
    const sealSha = `sha256:${"b".repeat(64)}`;
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const sealApproval = vi.fn(async () => {
      writeFileSync(sealPath, "winner", { flag: existsSync(sealPath) ? "w" : "wx" });
      arrived++;
      if (arrived === 2) release();
      await gate;
      return { path: sealPath, sha256: sealSha, created: arrived === 1 };
    });
    const concurrent = new Hono<ApiEnv>();
    concurrent.use("*", async (c, next) => {
      c.set("principal", { id: "human:reviewer@example.com", tenantId: "tenant-a", role: "owner" });
      c.set("trustPrincipalId", "trust-human-a");
      c.set("authMethod", "oidc");
      c.set("membershipEvidenceId", MEMBERSHIP_EVIDENCE_ID);
      c.set("requestId", "request-concurrent");
      return next();
    });
    registerWardenCandidateReviewRoutes(concurrent, db, audit, { now: () => NOW, sealApproval });
    const request = () => concurrent.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "The target and regression checks pass." }),
    });
    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(existsSync(sealPath)).toBe(true);
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_approved");
  });

  it("does not grant review authority when the current membership role loses plan edit while sealing", async () => {
    let database: AppDb | undefined;
    const fixtureResult = fixture({
      sealApproval: async () => {
        database!.raw.prepare(`UPDATE tenant_memberships SET role = 'viewer', updated_at = ?
          WHERE tenant_id = 'tenant-a' AND issuer = 'https://identity.example.com' AND subject = 'reviewer-a'`)
          .run("2026-08-06T12:00:01.000Z");
        return { path: "C:\\sealed-downgraded-approval.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
      },
    });
    database = fixtureResult.db;
    seedCiRepairCandidate(database);

    const response = await fixtureResult.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only with current plan edit authority." }),
    });

    expect(response.status).toBe(403);
    expect(getAgentRun(database, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(getWardenCiUpdateByRun(database, "tenant-a", "warden-run-1")).toBeUndefined();
  });

  it("uses the post-seal commit time for trust expiry and persisted review authority", async () => {
    let sealed = false;
    const fixtureResult = fixture({
      now: () => sealed ? "2026-08-06T12:00:02.000Z" : NOW,
      sealApproval: async () => {
        sealed = true;
        return { path: "C:\\sealed-expired-approval.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
      },
    });
    seedCiRepairCandidate(fixtureResult.db);
    fixtureResult.db.raw.prepare("UPDATE principals SET expires_at = ? WHERE id = 'trust-human-a'")
      .run("2026-08-06T12:00:01.000Z");

    const response = await fixtureResult.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only before trust expiry." }),
    });

    expect(response.status).toBe(403);
    expect(getAgentRun(fixtureResult.db, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(getWardenCiUpdateByRun(fixtureResult.db, "tenant-a", "warden-run-1")).toBeUndefined();
  });

  it("re-resolves mutable CI authority under the review transaction", async () => {
    let database: AppDb | undefined;
    const fixtureResult = fixture({ sealApproval: async () => {
      database!.raw.prepare(`UPDATE fettler_ci_cycles SET current_head_sha = ?, updated_at = ?
        WHERE id = 'cycle-a' AND tenant_id = 'tenant-a'`)
        .run("9".repeat(40), "2026-08-06T12:00:01.000Z");
      return { path: "C:\\sealed-stale-ci.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
    } });
    database = fixtureResult.db;
    seedCiRepairCandidate(database);

    const response = await fixtureResult.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only the exact current CI authority." }),
    });

    expect(response.status).toBe(409);
    expect(getAgentRun(database, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(getWardenCiUpdateByRun(database, "tenant-a", "warden-run-1")).toBeUndefined();
  });

  it("never resolves a ReGauge MissionTask through the Fettler candidate review route", async () => {
    const { app, db } = fixture({ sealApproval: async () => ({ path: "C:\\sealed-regauge.json",
      sha256: `sha256:${"b".repeat(64)}`, created: true }) });
    seedReviewedSnapshot(db);
    bindMission(db, "regauge");
    const taskId = regaugeLaunchMissionTaskId("m1", "repo-1");
    advanceTaskToWorking(db, taskId);
    const blocker = openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId, reason: "architecture_decision_required",
      question: "Continue the ReGauge stage?", context: "This is ReGauge-owned work.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "This route must not cross product authority." }),
    });

    expect(response.status).toBe(409);
    expect(getMissionTask(db, "tenant-a", taskId)?.status).toBe("human_review_required");
    expect(db.raw.prepare(`SELECT status, supersedes_id FROM mission_exceptions
      WHERE tenant_id = 'tenant-a' AND id = ?`).get(blocker.id)).toEqual({
      status: "open", supersedes_id: null,
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get()).toEqual({ count: 0 });
  });

  // §12 UPGRADE PATH, at the route. A legacy run: POST /agent/runs wrote
  // `payload.missionId`, nothing opened a task-bound blocker, so review resolves
  // nothing and mints no authority. It must approve and enqueue its delivery
  // exactly as it does on main. Collapse the enqueue gate back to two-state and
  // this returns 409 warden_candidate_delivery_binding_mismatch.
  it("approves a legacy Mission-bound run that carries no authority", async () => {
    const { app, db } = fixture({ sealApproval: async () => ({ path: "C:\sealed-legacy.json",
      sha256: `sha256:${"b".repeat(64)}`, created: true }) });
    seedReviewedSnapshot(db);
    bindMission(db);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve the exact bounded repair." }),
    });

    expect(response.status).toBe(202);
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_approved");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get())
      .toEqual({ count: 1 });
    // Unbound, honestly: no authority is invented for a run that never had one.
    expect(db.raw.prepare("SELECT mission_authority_json AS a FROM fettler_candidate_deliveries").get())
      .toEqual({ a: null });
  });

  // §12, regenerate arm. The successor inherits `missionId` through
  // ...originalPayload and still has no authority; it must be creatable.
  it("regenerates a legacy Mission-bound run that carries no authority", async () => {
    const { app, db } = fixture();
    seedReviewedSnapshot(db);
    bindMission(db);

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "regenerate", rationale: "Repair the internal mapping." }),
    });

    expect(response.status).toBe(202);
    const body = await response.json() as { supersedingJobId: string };
    const successor = JSON.parse(getJob(db, body.supersedingJobId, "tenant-a")!.payload_json);
    expect(successor.missionId).toBe("m1");
    expect(successor).not.toHaveProperty("missionAuthority");
  });

  it("does not approve or enqueue delivery while any current Mission blocker remains", async () => {
    const { app, db } = fixture({ sealApproval: async () => ({ path: "C:\\sealed-global-blocker.json",
      sha256: `sha256:${"b".repeat(64)}`, created: true }) });
    seedReviewedSnapshot(db);
    bindMission(db);
    const siblingTaskId = "mission-sibling-global-blocker";
    advanceTaskToWorking(db, siblingTaskId);
    advanceTaskToWorking(db, REVIEW_TASK_ID);
    openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: siblingTaskId, reason: "policy_exception",
      question: "Resolve the sibling policy exception?", context: "Global Mission delivery is blocked.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr-sibling", createdAt: NOW,
    });
    openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID, reason: "architecture_decision_required",
      question: "Approve this candidate?", context: "The candidate itself is ready.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr-review", createdAt: NOW,
    });

    const response = await app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Resolve only the exact candidate question." }),
    });

    expect(response.status).toBe(409);
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(evaluateMissionExceptions(db, "tenant-a", "m1").missionBlocked).toBe(true);
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get()).toEqual({ count: 0 });
  });

  it("runs mission-bound approve through the real delivery claim and terminal task settlement", async () => {
    const rationale = "Approve the exact bounded repair.";
    let sealed!: ReturnType<typeof approvalArtifact>;
    const value = fixture({ sealApproval: async () => ({
      path: sealed.path, sha256: sealed.sha256, created: true,
    }) });
    sealed = approvalArtifact({ directory: value.directory, revision: "a".repeat(40), rationale });
    seedReviewedSnapshot(value.db);
    bindMission(value.db);
    scopeMission(value.db);
    workingTask(value.db);
    openTaskHandoff(value.db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required", question: "Deliver the approved repair?",
      context: "The exact candidate passed review.", ownerPrincipalId: "trust-human-a",
      correlationId: "corr-delivery-e2e", createdAt: NOW,
    });

    const response = await value.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale }),
    });
    expect(response.status).toBe(202);
    const delivery = getWardenCandidateDeliveryByRun(value.db, "tenant-a", "warden-run-1")!;
    expect(JSON.parse(getJob(value.db, delivery.jobId, "tenant-a")!.payload_json))
      .toMatchObject({ missionId: "m1", missionAuthority: { taskId: REVIEW_TASK_ID, taskStatus: "agent_resume" } });
    const deliverExactDraft = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      number: 17, url: "https://github.com/acme/sdk/pull/17", branch: input.branch,
      baseBranch: input.baseBranch, baseSha: input.expectedBaseSha, commitSha: "b".repeat(40), draft: true as const,
    }));

    await expect(processJobsOnce(value.db, {
      tenantId: "tenant-a", workerId: "review-delivery-worker", leaseMs: 60_000, maxJobs: 1,
      jobTypes: ["warden.candidate.deliver"], runWardenMaintenance: false,
      wardenEnv: { MENDPOINT_DATA_DIR: sealed.dataRoot },
      wardenCandidateGithub: { deliverExactDraft } as unknown as GitHubDelivery,
      wardenCandidateRepositoryResolver: () => ({ owner: "acme", repo: "sdk", baseBranch: "main",
        snapshotExpiresAt: "2035-08-06T12:00:00.000Z" }),
    })).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(deliverExactDraft).toHaveBeenCalledTimes(1);
    expect(getMissionTask(value.db, "tenant-a", REVIEW_TASK_ID)).toMatchObject({ status: "agent_working" });
    recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a",
      deliveryId: delivery.id,
      outcome: "merged",
      source: "github_webhook",
      observedAt: "2026-08-06T12:00:02.000Z",
    });
    expect(getMissionTask(value.db, "tenant-a", REVIEW_TASK_ID)).toMatchObject({ status: "complete" });
  });

  it("runs mission-bound CI approve through the real update claim and retains the next observation authority", async () => {
    const rationale = "Approve the exact CI repair.";
    let sealed!: ReturnType<typeof approvalArtifact>;
    const value = fixture({ sealApproval: async () => ({
      path: sealed.path, sha256: sealed.sha256, created: true,
    }) });
    sealed = approvalArtifact({ directory: value.directory, revision: "d".repeat(40), rationale });
    seedCiRepairCandidate(value.db);
    bindMission(value.db);
    scopeMission(value.db);
    workingTask(value.db);
    openTaskHandoff(value.db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required", question: "Update the existing draft?",
      context: "The repair candidate is ready.", ownerPrincipalId: "trust-human-a",
      correlationId: "corr-update-e2e", createdAt: NOW,
    });

    const response = await value.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale }),
    });
    expect(response.status).toBe(202);
    const update = getWardenCiUpdateByRun(value.db, "tenant-a", "warden-run-1")!;
    expect(JSON.parse(getJob(value.db, update.jobId, "tenant-a")!.payload_json))
      .toMatchObject({ missionId: "m1", missionAuthority: { taskId: REVIEW_TASK_ID, taskStatus: "agent_resume" } });
    const updateExactDraft = vi.fn(async (_input: ExactDraftUpdateInput) => ({
      number: 17, url: "https://github.com/acme/sdk/pull/17", branch: "mendpoint/warden-a",
      previousHeadSha: "d".repeat(40), commitSha: "f".repeat(40), draft: true as const,
    }));

    await expect(processJobsOnce(value.db, {
      tenantId: "tenant-a", workerId: "review-update-worker", leaseMs: 60_000, maxJobs: 1,
      jobTypes: ["warden.candidate.update"], runWardenMaintenance: false,
      wardenEnv: { MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "1",
        MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON: JSON.stringify({
          "repo-1": { requiredChecks: ["check:77:unit"], maxCycles: 3, maxModelCalls: 6, maximumCostUsd: 3 },
        }) },
      wardenCandidateUpdateRuntime: {
        updateExactDraft, reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => sealed.artifact,
        resolveRepository: () => ({ owner: "acme", repo: "sdk" }),
      },
    })).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(getMissionTask(value.db, "tenant-a", REVIEW_TASK_ID)).toMatchObject({ status: "agent_working" });
    const cycle = getWardenCiCycle(value.db, "tenant-a", "cycle-a")!;
    expect(cycle).toMatchObject({ status: "observation_pending",
      missionAuthority: { missionId: "m1", taskId: REVIEW_TASK_ID, taskStatus: "agent_working" } });
    expect(JSON.parse(getJob(value.db, cycle.observationJobId, "tenant-a")!.payload_json))
      .toMatchObject({ missionId: "m1", missionAuthority: { taskStatus: "agent_working" } });
  });

  it("conflicts when the Mission is cancelled while the approval seal is in flight", async () => {
    let db!: AppDb;
    const value = fixture({
      sealApproval: async () => {
        const mission = getMission(db, "tenant-a", "m1")!;
        transitionMission(db, {
          tenantId: "tenant-a", missionId: mission.id, expectedRevision: mission.revision,
          to: "cancelled", actorPrincipalId: "trust-human-a", eventId: "e-cancel-during-seal",
          idempotencyKey: "c-cancel-during-seal", correlationId: "corr", createdAt: NOW,
        });
        return { path: "C:\\sealed-cancelled.json", sha256: `sha256:${"b".repeat(64)}`, created: true };
      },
    });
    db = value.db;
    seedReviewedSnapshot(db);
    bindMission(db);
    workingTask(db);
    openTaskHandoff(db, {
      tenantId: "tenant-a", missionId: "m1", taskId: REVIEW_TASK_ID,
      reason: "architecture_decision_required", question: "Proceed?", context: "Awaiting review.",
      ownerPrincipalId: "trust-human-a", correlationId: "corr", createdAt: NOW,
    });

    const response = await value.app.request("/agent/runs/warden-run-1/candidate/review", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", rationale: "Approve only while the Mission remains active." }),
    });

    expect(response.status).toBe(409);
    expect(getMission(db, "tenant-a", "m1")?.state).toBe("cancelled");
    expect(getAgentRun(db, "warden-run-1", "tenant-a")?.status).toBe("candidate_ready");
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get()).toEqual({ count: 0 });
  });
});
