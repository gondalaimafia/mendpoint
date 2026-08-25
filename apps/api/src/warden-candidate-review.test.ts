import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createMission,
  createMissionTask,
  enqueueJob,
  evaluateMissionExceptions,
  getActiveMissionDecisions,
  getAgentRun,
  getJob,
  getMissionTask,
  getWardenCiCycle,
  getWardenCiUpdateByRun,
  insertAgentRun,
  insertPrincipal,
  openTaskHandoff,
  recordAudit,
  transitionMissionTask,
  verifyAuditIntegrity,
  type AppDb,
  type MissionTask,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { registerWardenCandidateReviewRoutes } from "./warden-candidate-review.js";
import { enqueueDelegatedPrVerificationJob } from "@mendpoint/worker/delegated-pr-verification-job";

const NOW = "2026-08-06T12:00:00.000Z";
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

function fixture(options: {
  audit?: Parameters<typeof registerWardenCandidateReviewRoutes>[2];
  sealApproval?: NonNullable<Parameters<typeof registerWardenCandidateReviewRoutes>[3]>["sealApproval"];
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
    now: () => NOW,
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

  function bindMission(db: AppDb): void {
    createMission(db, {
      id: "m1", tenantId: "tenant-a", product: "fettler", triggerKind: "migration_objective",
      objective: "Migrate the SDK", ownerPrincipalId: "trust-human-a",
      eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: NOW,
    });
    const src = getJob(db, "source-job-1", "tenant-a")!;
    db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = 'source-job-1'")
      .run(JSON.stringify({ ...JSON.parse(src.payload_json), missionId: "m1" }));
  }

  function workingTask(db: AppDb): MissionTask {
    let task = createMissionTask(db, {
      id: "task-review-1", tenantId: "tenant-a", missionId: "m1", taskType: "code_migration",
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

  // CONTROL: deleting tryResolveBoundReviewHandoff on regenerate leaves the
  // exception blocking and the MissionTask in human_review_required.
  it("resolves an open handoff on mission-bound regenerate and moves the task to agent_resume", async () => {
    const { app, db } = fixture();
    bindMission(db);
    workingTask(db);
    const openedHandoff = openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: "task-review-1",
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
    expect(getMissionTask(db, "tenant-a", "task-review-1")).toMatchObject({
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
    openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: "task-review-1",
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
    expect(getMissionTask(db, "tenant-a", "task-review-1")?.status).toBe("human_review_required");
  });

  it("resolves an open handoff on mission-bound approve", async () => {
    const { app, db } = fixture({
      sealApproval: async () => ({ path: "C:\\sealed-handoff-approval.json", sha256: `sha256:${"b".repeat(64)}`, created: true }),
    });
    bindMission(db);
    workingTask(db);
    seedCiRepairCandidate(db);
    openTaskHandoff(db, {
      tenantId: "tenant-a",
      missionId: "m1",
      taskId: "task-review-1",
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
    expect(getMissionTask(db, "tenant-a", "task-review-1")?.status).toBe("agent_resume");
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
});
