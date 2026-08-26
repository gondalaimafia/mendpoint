import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  createMissionMutationAuthority,
  createMissionTask,
  createWardenCampaign,
  getMissionTask,
  getMission,
  bindMissionScope,
  claimNextJob,
  enqueueJob,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listActualExecutionCosts,
  missionTaskIdForJob,
  openTaskHandoff,
  recordRoutingDecision,
  recordRoutingOutcome,
  resolveTaskHandoff,
  transitionMissionTask,
  type AppDb,
} from "@mendpoint/db";
import {
  bridgeClaimedJobToMissionTask,
  handoffCompletedJobToMissionReview,
  recordBoundMissionExecutionCost,
  resolveBoundMissionForJob,
} from "./mission-task-job-bridge.js";

const at = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mtask-job-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?),('t2','two','Two','team','active',10,?)`).run(at, at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: at });
  createMission(db, {
    id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate", ownerPrincipalId: "p1", eventId: "e-m1", idempotencyKey: "c-m1",
    correlationId: "corr", createdAt: at,
  });
  return db;
}

function job(
  payload: Record<string, unknown>,
  extra: { id?: string; type?: string; tenantId?: string } = {},
) {
  return {
    id: extra.id ?? "job-1",
    tenant_id: extra.tenantId ?? "t1",
    type: extra.type ?? "agent.run",
    payload_json: JSON.stringify(payload),
  };
}

function seedRouting(db: AppDb, runId: string, jobId: string) {
  const envelopeId = `envelope-${runId}`;
  recordRoutingDecision(db, {
    tenantId: "t1",
    jobId,
    runId,
    taskKind: "agent.run",
    envelopeId,
    policySnapshotId: `policy-${runId}`,
    taskSnapshotId: `task-${runId}`,
    action: "route",
    selectedExecutorId: "executor-frontier",
    providerId: "provider-frontier",
    eliminated: [],
    fallback: [],
    breaker: [],
    handoffRequired: false,
    decision: {},
    createdAt: at,
  });
  recordRoutingOutcome(db, {
    tenantId: "t1",
    jobId,
    envelopeId,
    action: "route",
    outcome: "succeeded",
    inputTokens: 100,
    outputTokens: 40,
    totalTokens: 140,
    costUsd: 0.05,
    observedAt: at,
  });
}

describe("mission-task job bridge", () => {
  it("is a no-op when the job has no bound mission", () => {
    const db = fixture();
    const unbound = job({ goal: "repair", consumerId: "c1" });
    expect(resolveBoundMissionForJob(db, unbound)).toBeUndefined();
    expect(bridgeClaimedJobToMissionTask(db, unbound, at)).toBeUndefined();
    expect(recordBoundMissionExecutionCost(db, { job: unbound, sourceRunId: "run-1", createdAt: at })).toBeUndefined();
    expect(getMissionTask(db, "t1", missionTaskIdForJob("job-1"))).toBeUndefined();
  });

  it("fails closed when missionId is claimed but the mission is missing", () => {
    const db = fixture();
    expect(() => resolveBoundMissionForJob(db, job({ missionId: "does-not-exist" })))
      .toThrow("mission_task_job_mission_not_found");
  });

  it("creates an agent_working MissionTask for a bound agent.run and records MCU against the mission", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    const task = bridgeClaimedJobToMissionTask(db, claimed, at);
    expect(task).toMatchObject({
      id: missionTaskIdForJob("job-1"),
      missionId: "m1",
      status: "agent_working",
      ownerType: "agent",
      taskType: "agent.run",
    });
    expect(bridgeClaimedJobToMissionTask(db, claimed, at)?.revision).toBe(task!.revision);

    seedRouting(db, "session-1", "job-1");
    const cost = recordBoundMissionExecutionCost(db, {
      job: claimed,
      sourceRunId: "session-1",
      createdAt: at,
    });
    expect(cost).toMatchObject({
      missionId: "m1",
      taskId: missionTaskIdForJob("job-1"),
      executionId: "job-1",
      route: "fettler",
      taskClass: "agent.run",
      modelCostMeasured: true,
      modelCostMoneyMicros: 50_000,
    });
    expect(recordBoundMissionExecutionCost(db, {
      job: claimed,
      sourceRunId: "session-1",
      createdAt: at,
    })?.id).toBe(cost!.id);
    expect(listActualExecutionCosts(db, "t1")).toHaveLength(1);
  });

  it("resolves a Fettler campaignId to the linked mission and skips an unlinked campaign", () => {
    const db = fixture();
    createWardenCampaign(db, {
      id: "campaign", tenantId: "t1", name: "Payments", ownerPrincipalId: "p1",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "wc-1", idempotencyKey: "wc-1",
      correlationId: "corr", createdAt: at,
    });
    expect(resolveBoundMissionForJob(db, job({ campaignId: "campaign" }))).toBeUndefined();
    linkFettlerCampaignToMission(db, {
      tenantId: "t1", campaignId: "campaign", missionId: "m1", actorPrincipalId: "p1",
      eventId: "link-f", idempotencyKey: "link-f", correlationId: "corr", createdAt: at,
    });
    const execute = job(
      { campaignId: "campaign", runId: "run-camp" },
      { id: "job-execute", type: "warden.campaign.execute-target" },
    );
    expect(resolveBoundMissionForJob(db, execute)?.id).toBe("m1");
    const task = bridgeClaimedJobToMissionTask(db, execute, at);
    expect(task).toMatchObject({
      missionId: "m1",
      status: "agent_working",
      taskType: "warden.campaign.execute-target",
    });
  });

  it("returns an agent_resume job task to agent_working on the next claim", () => {
    const db = fixture();
    const claimed = job({ missionId: "m1", goal: "repair", consumerId: "c1" });
    const working = bridgeClaimedJobToMissionTask(db, claimed, at)!;
    const exception = openTaskHandoff(db, {
      tenantId: "t1",
      missionId: "m1",
      taskId: working.id,
      reason: "architecture_decision_required",
      question: "Proceed?",
      context: "Advisory verification passed.",
      ownerPrincipalId: "p1",
      correlationId: "job-1",
      createdAt: at,
    });
    resolveTaskHandoff(db, {
      tenantId: "t1",
      priorExceptionId: exception.id,
      taskId: working.id,
      resolutionNote: "Yes.",
      decision: "Proceed",
      scope: "handoff_resolution:job-1",
      authorPrincipalId: "p1",
      correlationId: "job-1",
      createdAt: at,
    });
    expect(getMissionTask(db, "t1", working.id)?.status).toBe("agent_resume");
    const resumed = bridgeClaimedJobToMissionTask(db, claimed, at);
    expect(resumed).toMatchObject({ status: "agent_working", ownerType: "agent" });
  });

  it("drives the exact reviewed enrollment task through two real queued successor claims", () => {
    const db = fixture();
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('scm-1', 't1', 'github', 'app://1', '1', 'GitHub', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-1', 't1', 'scm-1', '1', 'acme', 'sdk', 'main', 'main',
       'production', 30, 'ready', ?, ?)`)
      .run(at, at);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-1', 't1', 'repo-1', 'main', ?, ?, 'C:\\snapshot',
       'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
      .run("a".repeat(40), `sha256:${"b".repeat(64)}`, at);
    bindMissionScope(db, {
      tenantId: "t1", missionId: "m1", repositoryId: "repo-1", snapshotId: "snapshot-1",
      actorPrincipalId: "p1", eventId: "e-scope", idempotencyKey: "c-scope",
      correlationId: "corr", createdAt: at,
    });
    let task = createMissionTask(db, {
      id: "mt-reviewed", tenantId: "t1", missionId: "m1", taskType: "code_migration",
      acceptanceCriteria: "Tests pass", risk: "medium", actorPrincipalId: "p1",
      eventId: "e-reviewed-create", idempotencyKey: "c-reviewed-create", correlationId: "corr", createdAt: at,
    });
    task = transitionMissionTask(db, {
      tenantId: "t1", taskId: task.id, expectedRevision: task.revision, to: "agent_assigned",
      actorPrincipalId: "p1", eventId: "e-reviewed-assign", idempotencyKey: "c-reviewed-assign",
      correlationId: "corr", createdAt: at,
    });
    task = transitionMissionTask(db, {
      tenantId: "t1", taskId: task.id, expectedRevision: task.revision, to: "agent_working",
      actorPrincipalId: "p1", eventId: "e-reviewed-work", idempotencyKey: "c-reviewed-work",
      correlationId: "corr", createdAt: at,
    });
    const firstBlocker = openTaskHandoff(db, {
      tenantId: "t1", missionId: "m1", taskId: task.id, reason: "architecture_decision_required",
      question: "Regenerate?", context: "First candidate needs review.", ownerPrincipalId: "p1",
      correlationId: "review-1", createdAt: at,
    });
    resolveTaskHandoff(db, {
      tenantId: "t1", priorExceptionId: firstBlocker.id, taskId: task.id,
      resolutionNote: "Regenerate", decision: "Regenerate", scope: "handoff_resolution:first",
      authorPrincipalId: "p1", correlationId: "review-1", createdAt: at,
    });

    for (const cycle of [1, 2]) {
      const currentTask = getMissionTask(db, "t1", task.id)!;
      const authority = createMissionMutationAuthority({
        mission: getMission(db, "t1", "m1")!, task: currentTask, repositoryId: "repo-1",
        snapshotId: "snapshot-1", resolvedSha: "a".repeat(40),
      });
      enqueueJob(db, {
        id: `successor-${cycle}`, tenantId: "t1", type: "agent.run", createdAt: at,
        payload: { missionId: "m1", missionAuthority: authority, sessionId: `run-${cycle}`,
          goal: "Regenerate the reviewed candidate", consumerId: "consumer-1" },
      });
      const claimed = claimNextJob(db, ["agent.run"], {
        tenantId: "t1", workerId: `worker-${cycle}`, leaseMs: 60_000, now: at,
      })!;
      expect(bridgeClaimedJobToMissionTask(db, claimed, at)).toMatchObject({
        id: task.id, status: "agent_working",
      });
      const handed = handoffCompletedJobToMissionReview(db, claimed, at)!;
      expect(handed).toMatchObject({ id: task.id, status: "human_review_required" });
      if (cycle === 1) {
        const blocker = db.raw.prepare(`SELECT id FROM mission_exceptions
          WHERE tenant_id = 't1' AND mission_id = 'm1' AND task_id = ? AND status = 'open'
            AND NOT EXISTS (SELECT 1 FROM mission_exceptions successor
              WHERE successor.tenant_id = mission_exceptions.tenant_id
                AND successor.supersedes_id = mission_exceptions.id)
          ORDER BY created_at DESC, id DESC LIMIT 1`).get(task.id) as { id: string };
        resolveTaskHandoff(db, {
          tenantId: "t1", priorExceptionId: blocker.id, taskId: task.id,
          resolutionNote: "Regenerate again", decision: "Regenerate again",
          scope: "handoff_resolution:second", authorPrincipalId: "p1",
          correlationId: "review-2", createdAt: at,
        });
      }
    }
  });
});
