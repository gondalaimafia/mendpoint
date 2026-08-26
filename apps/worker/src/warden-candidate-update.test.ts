import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  bindMissionScope,
  createDb,
  createMission,
  createMissionMutationAuthority,
  createMissionTask,
  enqueueJob,
  enqueueWardenCiUpdate,
  getJob,
  getMission,
  getMissionTask,
  getWardenCiCycle,
  insertAgentRun,
  insertPrincipal,
  openTaskHandoff,
  raiseMissionException,
  resolveTaskHandoff,
  transitionMission,
  transitionMissionTask,
  pauseWardenCiCycle,
  type AppDb,
} from "@mendpoint/db";
import { runWardenCandidateUpdate } from "./warden-candidate-update.js";
import { processJobsOnce } from "./cli.js";
import { wardenReviewFeedbackDigest } from "./warden-candidate-observation.js";
import type { ExactDraftObservation, ExactDraftUpdateInput } from "@mendpoint/github";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;

function fixture(expectedFeedbackDigest: string | null = null, deleted = false) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-update-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  db.raw.prepare(`INSERT INTO fettler_ci_cycles
    (id, tenant_id, delivery_id, observation_job_id, status, repository_id, remote_repository_id,
     installation_id, pull_request_number, base_branch, branch_name, base_revision, current_head_sha,
     required_checks_json, allowed_changed_paths_json, max_cycles, used_cycles, max_model_calls,
     maximum_cost_usd, current_observation_digest, repair_run_id, repair_job_id, created_at, updated_at)
    VALUES ('cycle-a', 'tenant-a', 'delivery-a', 'observe-old', 'repair_pending', 'repo-a', 101,
     202, 17, 'main', 'mendpoint/warden-a', ?, ?, '["check:77:unit"]', '["src/a.ts"]',
     3, 1, 6, 3, ?, 'repair-run-a', 'repair-agent-job-a', ?, ?)`)
    .run(sha("a"), sha("d"), digest("e"), "2026-08-13T12:00:00.000Z", "2026-08-13T12:03:00.000Z");
  const update = enqueueWardenCiUpdate(db, { tenantId: "tenant-a", cycleId: "cycle-a",
    repairRunId: "repair-run-a", expectedHeadSha: sha("d"), sealedPath: "sealed/approval.json",
    expectedFeedbackDigest,
    sealedSha256: digest("f"), reviewerPrincipalId: "principal-a", rationale: "Approve CI repair",
    observedAt: "2026-08-13T12:04:00.000Z" });
  insertAgentRun(db, { id: "repair-run-a", tenantId: "tenant-a", goal: "Repair CI", repoPath: root,
    status: "candidate_approved", ok: true, steps: 2, filesChanged: ["src/a.ts"], reportMd: null,
    resultJson: JSON.stringify({ source: { repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
      revision: sha("d"), manifestSha256: "e".repeat(64) } }),
    createdAt: "2026-08-13T12:03:00.000Z", finishedAt: "2026-08-13T12:04:00.000Z" });
  const job = claimNextJob(db, ["warden.candidate.update"], { tenantId: "tenant-a", workerId: "worker-a",
    leaseMs: 60_000, now: "2026-08-13T12:04:30.000Z" })!;
  const afterSha256 = `sha256:${createHash("sha256").update("x").digest("hex")}`;
  const artifact = { tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
    baseBranch: "main", expectedBaseRevision: sha("d"), reviewerPrincipalId: "principal-a",
    rationale: "Approve CI repair", candidate: { entries: deleted ? [] : [{ path: "src/a.ts", sha256: afterSha256,
      executable: false, size: 1 }] }, files: [{ path: "src/a.ts", after: deleted
        ? null
        : Buffer.from("x").toString("base64"), afterSha256: deleted ? null : afterSha256,
      ...(deleted ? {
        before: Buffer.from("old").toString("base64"),
        beforeSha256: `sha256:${createHash("sha256").update("old").digest("hex")}`,
      } : {}) }] };
  return { db, root, update, job, artifact };
}

function bindMissionAuthority(value: ReturnType<typeof fixture>) {
  const { db } = value;
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`)
    .run("2026-08-13T12:00:00.000Z");
  insertPrincipal(db, { id: "principal-owner", tenantId: "tenant-a", kind: "human",
    subject: "owner@example.com", displayName: "Owner", createdAt: "2026-08-13T12:00:00.000Z" });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('scm-mission', 'tenant-a', 'github', 'app://1', '1', 'GitHub', ?, ?)`)
    .run("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'scm-mission', '101', 'acme', 'service', 'main', 'main',
     'production', 30, 'ready', ?, ?)`).run("2026-08-13T12:00:00.000Z", "2026-08-13T12:00:00.000Z");
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-repair-a', 'tenant-a', 'repo-a', 'main', ?, ?, 'C:\\snapshot',
     'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
    .run(sha("d"), digest("a"), "2026-08-13T12:00:00.000Z");
  createMission(db, { id: "mission-1", tenantId: "tenant-a", product: "fettler",
    triggerKind: "provider_change", objective: "Repair CI", ownerPrincipalId: "principal-owner",
    eventId: "e-mission", idempotencyKey: "c-mission", correlationId: "corr",
    createdAt: "2026-08-13T12:00:00.000Z" });
  bindMissionScope(db, { tenantId: "tenant-a", missionId: "mission-1", repositoryId: "repo-a",
    snapshotId: "snapshot-repair-a", actorPrincipalId: "principal-owner", eventId: "e-scope",
    idempotencyKey: "c-scope", correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  let task = createMissionTask(db, { id: "task-1", tenantId: "tenant-a", missionId: "mission-1",
    taskType: "code_migration", acceptanceCriteria: "CI passes", risk: "medium",
    actorPrincipalId: "principal-owner", eventId: "e-task", idempotencyKey: "c-task",
    correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
    to: "agent_assigned", actorPrincipalId: "principal-owner", eventId: "e-assign",
    idempotencyKey: "c-assign", correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
    to: "agent_working", actorPrincipalId: "principal-owner", eventId: "e-work",
    idempotencyKey: "c-work", correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  const blocker = openTaskHandoff(db, { tenantId: "tenant-a", missionId: "mission-1", taskId: task.id,
    reason: "architecture_decision_required", question: "Update?", context: "CI repair passed.",
    ownerPrincipalId: "principal-owner", correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  resolveTaskHandoff(db, { tenantId: "tenant-a", priorExceptionId: blocker.id, taskId: task.id,
    resolutionNote: "Approve", decision: "Approve", scope: "handoff_resolution:update",
    authorPrincipalId: "principal-owner", correlationId: "corr", createdAt: "2026-08-13T12:00:00.000Z" });
  enqueueJob(db, { id: "repair-agent-job-a", tenantId: "tenant-a", type: "agent.run",
    createdAt: "2026-08-13T12:00:00.000Z",
    payload: { missionId: "mission-1", consumerId: "consumer-1", sessionId: "repair-run-a" } });
  db.raw.prepare("UPDATE agent_runs SET job_id = ? WHERE id = ? AND tenant_id = ?")
    .run("repair-agent-job-a", "repair-run-a", "tenant-a");
  const authority = createMissionMutationAuthority({ mission: getMission(db, "tenant-a", "mission-1")!,
    task: getMissionTask(db, "tenant-a", "task-1")!, repositoryId: "repo-a",
    snapshotId: "snapshot-repair-a", resolvedSha: sha("d") });
  db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?")
    .run(JSON.stringify({ cycleId: "cycle-a", updateId: value.update.id,
      missionId: "mission-1", missionAuthority: authority }),
      value.job.id, "tenant-a");
  db.raw.prepare(`UPDATE fettler_ci_updates SET mission_authority_json = ?
    WHERE id = ? AND tenant_id = ?`).run(JSON.stringify(authority), value.update.id, "tenant-a");
  db.raw.prepare(`UPDATE fettler_ci_cycles SET mission_authority_json = ?
    WHERE id = 'cycle-a' AND tenant_id = 'tenant-a'`).run(JSON.stringify(authority));
  return { ...value, authority, job: getJob(db, value.job.id, "tenant-a")! };
}

function observedFeedback(body: string): ExactDraftObservation {
  return Object.freeze({ state: "draft", baseRevision: sha("a"), headRevision: sha("d"), checks: "success",
    checkRevision: sha("d"), approvals: 0, approvalRevision: null, conversationsResolved: false,
    failures: Object.freeze([]), checkIdentities: Object.freeze(["check:77:unit"]),
    checkResults: Object.freeze([{ identity: "check:77:unit", state: "success" as const }]),
    evidenceRefs: Object.freeze([]), reviewFeedback: Object.freeze({ verdict: "changes_requested" as const,
      changeRequests: Object.freeze([{ id: "7", reviewer: "reviewer", commitRevision: sha("d"), body,
        submittedAt: "2026-08-13T12:01:40.000Z" }]), comments: Object.freeze([]) }) });
}

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe("Warden candidate exact draft update", () => {
  it("quarantines a legacy mission-bound update without retained authority before GitHub", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET payload_json = ?, status = 'pending', lease_owner = NULL,
      lease_expires_at = NULL WHERE id = ? AND tenant_id = ?`)
      .run(JSON.stringify({ cycleId: "cycle-a", updateId: value.update.id, missionId: "mission-1" }),
        value.job.id, "tenant-a");
    const updateExactDraft = vi.fn();
    await expect(processJobsOnce(value.db, { tenantId: "tenant-a", workerId: "worker-upgrade",
      leaseMs: 60_000, maxJobs: 1, jobTypes: ["warden.candidate.update"], runWardenMaintenance: false,
      wardenEnv: { MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "1",
        MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON: JSON.stringify({
          "repo-a": { requiredChecks: ["check:77:unit"], maxCycles: 3, maxModelCalls: 6, maximumCostUsd: 3 },
        }) },
      wardenCandidateUpdateRuntime: { updateExactDraft, reconcileExactDraftUpdate: vi.fn(),
        readApprovalArtifact: () => value.artifact,
        resolveRepository: () => ({ owner: "acme", repo: "service" }),
        now: () => "2026-08-13T12:05:00.000Z" } }))
      .resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 0, inconclusive: 0 });
    expect(updateExactDraft).not.toHaveBeenCalled();
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({ status: "dead_letter",
      error_code: "warden_ci_update_mission_authority_upgrade_required" });
    expect(getWardenCiCycle(value.db, "tenant-a", "cycle-a")?.status).toBe("paused");
  });

  it("claims an approved CI update through the real job loop and retains fresh Mission authority", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    const updateExactDraft = vi.fn(async (_input: ExactDraftUpdateInput) => ({
      number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
      previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const,
    }));

    const outcome = await processJobsOnce(value.db, {
      tenantId: "tenant-a", workerId: "worker-real-update", leaseMs: 60_000,
      maxJobs: 1, jobTypes: ["warden.candidate.update"], runWardenMaintenance: false,
      wardenEnv: {
        MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "1",
        MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON: JSON.stringify({
          "repo-a": { requiredChecks: ["check:77:unit"], maxCycles: 3, maxModelCalls: 6, maximumCostUsd: 3 },
        }),
      },
      wardenCandidateUpdateRuntime: {
        updateExactDraft, reconcileExactDraftUpdate: vi.fn(),
        readApprovalArtifact: () => value.artifact,
        resolveRepository: () => ({ owner: "acme", repo: "service" }),
        now: () => "2026-08-13T12:05:00.000Z",
      },
    });

    expect(outcome).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(getMissionTask(value.db, "tenant-a", "task-1")).toMatchObject({
      status: "agent_working", revision: value.authority.taskRevision! + 1,
    });
    expect(getWardenCiCycle(value.db, "tenant-a", "cycle-a")?.missionAuthority)
      .toMatchObject({ taskId: "task-1", taskStatus: "agent_working" });
    expect(JSON.parse(getJob(value.db,
      getWardenCiCycle(value.db, "tenant-a", "cycle-a")!.observationJobId, "tenant-a")!.payload_json))
      .toMatchObject({ missionId: "mission-1", missionAuthority: { taskStatus: "agent_working" } });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous remote result read only past the ordinary job attempt cap", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET status = 'pending', attempts = 2, max_attempts = 3,
      available_at = '2026-08-13T12:04:00.000Z', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    const updateExactDraft = vi.fn(async () => ({
      number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
      previousHeadSha: sha("d"), commitSha: "invalid", draft: true as const,
    }));
    const reconcileExactDraftUpdate = vi.fn()
      .mockResolvedValueOnce({ status: "unknown" as const })
      .mockResolvedValueOnce({ status: "applied" as const, result: {
        number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
        previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const,
      } });
    const workerOptions = {
      tenantId: "tenant-a", workerId: "worker-uncertain-update", leaseMs: 60_000,
      maxJobs: 1, jobTypes: ["warden.candidate.update"], runWardenMaintenance: false,
      wardenEnv: {
        MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "1",
        MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON: JSON.stringify({
          "repo-a": { requiredChecks: ["check:77:unit"], maxCycles: 3, maxModelCalls: 6,
            maximumCostUsd: 3 },
        }),
      },
      wardenCandidateUpdateRuntime: {
        updateExactDraft, reconcileExactDraftUpdate,
        readApprovalArtifact: () => value.artifact,
        resolveRepository: () => ({ owner: "acme", repo: "service" }),
        now: () => "2026-08-13T12:05:00.000Z",
      },
    } as const;

    await expect(processJobsOnce(value.db, workerOptions))
      .resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 1, inconclusive: 0 });
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({
      status: "pending", attempts: 3, error_code: "warden_ci_update_result_invalid",
    });
    expect(value.db.raw.prepare(`SELECT status FROM fettler_ci_updates
      WHERE tenant_id = 'tenant-a' AND id = ?`).get(value.update.id)).toEqual({ status: "uncertain" });
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "uncertain" });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);

    value.db.raw.prepare(`UPDATE jobs SET available_at = '2026-08-13T12:04:00.000Z'
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    await expect(processJobsOnce(value.db, workerOptions))
      .resolves.toEqual({ claimed: 1, succeeded: 0, failed: 1, retried: 1, inconclusive: 0 });
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({
      status: "pending", attempts: 4, error_code: "warden_ci_update_outcome_uncertain",
    });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);

    value.db.raw.prepare(`UPDATE jobs SET available_at = '2026-08-13T12:04:00.000Z'
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    await expect(processJobsOnce(value.db, workerOptions))
      .resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({ status: "done", attempts: 5 });
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "settled" });
    expect(reconcileExactDraftUpdate).toHaveBeenCalledTimes(2);
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
  });

  it("updates the same draft once and atomically schedules the next CI observation", async () => {
    const { db, update, job, artifact } = fixture();
    const updateExactDraft = vi.fn(async () => ({ number: 17, url: "https://github.com/acme/service/pull/17",
      branch: "mendpoint/warden-a", previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const }));

    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact,
      resolveRepository: async () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({
        status: "updated", updateId: update.id, commitSha: sha("f"),
      });

    expect(updateExactDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedRepositoryId: 101, pullRequestNumber: 17, baseBranch: "main",
      branch: "mendpoint/warden-a", expectedHeadSha: sha("d"),
      files: [{ path: "src/a.ts", content: "x", mode: "100644" }],
    }));
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "observation_pending", currentHeadSha: sha("f"),
    });
  });

  it("stops before GitHub when the cycle is paused after approval", async () => {
    const { db, job, artifact } = fixture();
    db.raw.prepare("UPDATE fettler_ci_cycles SET status = 'paused' WHERE id = 'cycle-a'").run();
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact,
      resolveRepository: async () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("warden_ci_update_not_authorized");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("does not update GitHub when the Mission is cancelled after the update is claimed", async () => {
    const value = bindMissionAuthority(fixture());
    const mission = getMission(value.db, "tenant-a", "mission-1")!;
    transitionMission(value.db, { tenantId: "tenant-a", missionId: mission.id,
      expectedRevision: mission.revision, to: "cancelled", actorPrincipalId: "principal-owner",
      eventId: "e-cancel-update", idempotencyKey: "c-cancel-update", correlationId: "corr",
      createdAt: "2026-08-13T12:04:31.000Z" });
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db: value.db, job: value.job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => value.artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("mission_mutation_authority_stale");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("does not update GitHub when a blocker appears after claim but before dispatch", async () => {
    const value = bindMissionAuthority(fixture());
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db: value.db, job: value.job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => value.artifact,
      resolveRepository: () => {
        raiseMissionException(value.db, { tenantId: "tenant-a", missionId: "mission-1",
          reason: "policy_exception", impact: "A current policy blocker forbids remote mutation.",
          resolutionPath: "Resolve the policy exception before updating the draft.", blocking: true,
          ownerPrincipalId: "principal-owner", correlationId: "corr",
          createdAt: "2026-08-13T12:04:31.000Z" });
        return { owner: "acme", repo: "service" };
      }, now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("mission_mutation_authority_blocked");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("revokes an armed update when a blocker lands after intent binding but before remote dispatch", async () => {
    const value = bindMissionAuthority(fixture());
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db: value.db, job: value.job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => value.artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      beforeRemoteDispatch: () => raiseMissionException(value.db, {
        tenantId: "tenant-a", missionId: "mission-1", reason: "policy_exception",
        impact: "A late policy decision revokes the armed update.",
        resolutionPath: "Resolve the policy exception before updating.", blocking: true,
        ownerPrincipalId: "principal-owner", correlationId: "late-blocker",
        createdAt: "2026-08-13T12:04:59.000Z",
      }), now: () => "2026-08-13T12:05:00.000Z" }))
      .rejects.toThrow("mission_mutation_authority_blocked");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("does not update GitHub when the update lease transfers after intent binding", async () => {
    const value = bindMissionAuthority(fixture());
    const updateExactDraft = vi.fn();
    await expect(runWardenCandidateUpdate({ db: value.db, job: value.job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => value.artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      beforeRemoteDispatch: () => value.db.raw.prepare(`UPDATE jobs SET lease_owner = 'worker-b',
        lease_generation = lease_generation + 1 WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a"),
      now: () => "2026-08-13T12:05:00.000Z" }))
      .rejects.toThrow("mission_mutation_dispatch_lease_lost");
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("keeps an uncertain Mission mutation non-cancellable and settles it by read-only crash replay", async () => {
    const value = bindMissionAuthority(fixture());
    const updateExactDraft = vi.fn().mockRejectedValueOnce(Object.assign(new Error("socket closed"), {
      remoteSideEffectUncertain: true,
    }));
    const args = {
      db: value.db, job: value.job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(async () => ({ status: "applied" as const, result: {
        number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
        previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const,
      } })),
      readApprovalArtifact: () => value.artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z",
    };

    await expect(runWardenCandidateUpdate(args)).rejects.toThrow("socket closed");
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "uncertain" });
    const mission = getMission(value.db, "tenant-a", "mission-1")!;
    expect(() => transitionMission(value.db, { tenantId: "tenant-a", missionId: mission.id,
      expectedRevision: mission.revision, to: "cancelled", actorPrincipalId: "principal-owner",
      eventId: "e-cancel-uncertain", idempotencyKey: "c-cancel-uncertain", correlationId: "corr",
      createdAt: "2026-08-13T12:05:01.000Z" })).toThrow("mission_mutation_dispatch_in_flight");

    await expect(runWardenCandidateUpdate(args)).resolves.toMatchObject({ status: "updated" });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "settled" });
  });

  it("updates the same draft with an exact approved file deletion", async () => {
    const { db, job, artifact } = fixture(null, true);
    const updateExactDraft = vi.fn(async () => ({ number: 17, url: "https://github.com/acme/service/pull/17",
      branch: "mendpoint/warden-a", previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const }));

    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => artifact,
      resolveRepository: async () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({ status: "updated" });
    expect(updateExactDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadSha: sha("d"), files: [{ path: "src/a.ts", delete: true }],
    }));
  });

  it("reobserves and rejects edited or dismissed review feedback before the branch mutation", async () => {
    const approved = observedFeedback("Fix the nil response.");
    const expected = wardenReviewFeedbackDigest(approved)!;
    const { db, job, artifact } = fixture(expected);
    const updateExactDraft = vi.fn();
    const observeExactDraft = vi.fn(async () => observedFeedback("The request changed."));
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft, observeExactDraft,
      reconcileExactDraftUpdate: vi.fn(), readApprovalArtifact: () => artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).rejects.toThrow("warden_ci_review_feedback_drift");
    expect(observeExactDraft).toHaveBeenCalledWith(expect.objectContaining({
      expectedHeadSha: sha("d"), expectedRepositoryId: 101, requireExactDraft: true,
    }));
    expect(updateExactDraft).not.toHaveBeenCalled();
  });

  it("updates once when the exact approved review feedback remains current", async () => {
    const approved = observedFeedback("Fix the nil response.");
    const { db, job, artifact } = fixture(wardenReviewFeedbackDigest(approved)!);
    const updateExactDraft = vi.fn(async () => ({ number: 17, url: "https://github.com/acme/service/pull/17",
      branch: "mendpoint/warden-a", previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const }));
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      observeExactDraft: async () => approved, reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({ status: "updated" });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
  });

  it("serializes a one-use remote mutation permit against a later human pause", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn(async () => {
      expect(() => pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a",
        actorPrincipalId: "principal-b", reason: "pause after dispatch", observedAt: "2026-08-13T12:05:01.000Z" }))
        .toThrow("warden_ci_mutation_in_flight");
      return { number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
        previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const };
    });
    await expect(runWardenCandidateUpdate({ db, job, updateExactDraft,
      reconcileExactDraftUpdate: vi.fn(),
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" })).resolves.toMatchObject({ status: "updated" });
  });

  it("releases an ambiguous mutation permit for pause and performs only read-only reconciliation", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn()
      .mockRejectedValueOnce(new Error("socket closed"));
    const reconcileExactDraftUpdate = vi.fn(async () => ({ status: "not_applied" as const }));
    const args = { db, job, updateExactDraft, reconcileExactDraftUpdate,
      readApprovalArtifact: () => artifact, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" };

    await expect(runWardenCandidateUpdate(args)).rejects.toThrow("socket closed");
    expect(db.raw.prepare("SELECT status FROM fettler_ci_updates WHERE cycle_id = 'cycle-a'").get())
      .toEqual({ status: "uncertain" });
    expect(() => pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a",
      actorPrincipalId: "principal-b", reason: "pause during retry backoff",
      observedAt: "2026-08-13T12:05:01.000Z" })).not.toThrow();

    await expect(runWardenCandidateUpdate(args)).rejects.toThrow("warden_ci_update_not_authorized");
    expect(reconcileExactDraftUpdate).toHaveBeenCalledTimes(1);
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")?.status).toBe("paused");
  });

  it("records an exact applied result discovered read-only after a human pause", async () => {
    const { db, job, artifact } = fixture();
    const updateExactDraft = vi.fn().mockRejectedValueOnce(new Error("response lost"));
    const base = { db, job, updateExactDraft, readApprovalArtifact: () => artifact,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:05:00.000Z" };
    await expect(runWardenCandidateUpdate({ ...base, reconcileExactDraftUpdate: vi.fn() }))
      .rejects.toThrow("response lost");
    pauseWardenCiCycle(db, { tenantId: "tenant-a", cycleId: "cycle-a", actorPrincipalId: "principal-b",
      reason: "pause during response recovery", observedAt: "2026-08-13T12:05:01.000Z" });
    const reconcileExactDraftUpdate = vi.fn(async () => ({ status: "applied" as const, result: {
      number: 17, url: "https://github.com/acme/service/pull/17", branch: "mendpoint/warden-a",
      previousHeadSha: sha("d"), commitSha: sha("f"), draft: true as const,
    } }));

    await expect(runWardenCandidateUpdate({ ...base, reconcileExactDraftUpdate }))
      .resolves.toMatchObject({ status: "updated", commitSha: sha("f") });
    expect(updateExactDraft).toHaveBeenCalledTimes(1);
    expect(getWardenCiCycle(db, "tenant-a", "cycle-a")).toMatchObject({
      status: "paused", currentHeadSha: sha("f"), pauseReason: "pause during response recovery",
    });
  });
});
