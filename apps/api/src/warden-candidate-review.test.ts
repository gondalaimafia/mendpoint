import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  enqueueJob,
  getAgentRun,
  getJob,
  getWardenCiCycle,
  getWardenCiUpdateByRun,
  insertAgentRun,
  insertPrincipal,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { registerWardenCandidateReviewRoutes } from "./warden-candidate-review.js";

const NOW = "2026-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

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
    subject: "reviewer@example.com",
    displayName: "Reviewer",
    createdAt: NOW,
  });
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
      artifacts: {},
    }),
    createdAt: NOW,
    finishedAt: NOW,
  });
  const audit = options.audit ?? vi.fn();
  const app = new Hono<ApiEnv>();
  app.use("*", async (c, next) => {
    c.set("principal", { id: "human:reviewer@example.com", tenantId: "tenant-a", role: "owner" });
    c.set("trustPrincipalId", "trust-human-a");
    c.set("requestId", "request-1");
    return next();
  });
  registerWardenCandidateReviewRoutes(app, db, audit, {
    now: () => NOW,
    ...(options.sealApproval ? { sealApproval: options.sealApproval } : {}),
  });
  return { app, db, audit, directory };
}

function seedCiRepairCandidate(db: AppDb) {
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
    evidenceArtifactId: "artifact-failure-a", evidenceDigest: `sha256:${"f".repeat(64)}` };
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
    const { app, db } = fixture({ sealApproval: async () => ({ path: sealPath, sha256: sealSha, created: true }) });
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
      reviewerPrincipalId: "human:reviewer@example.com",
    });
    expect(db.raw.prepare("SELECT COUNT(*) AS count FROM fettler_candidate_deliveries").get())
      .toEqual({ count: 0 });
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
      repairJobId: body.supersedingJobId, currentHeadSha: "d".repeat(40), usedCycles: 1,
    });
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
