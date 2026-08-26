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
  enqueueWardenCiCycle,
  getJob,
  getMission,
  getWardenCiCycle,
  insertAgentRun,
  insertPrincipal,
  listJobs,
  recordWardenCiObservation,
  transitionMissionTask,
  type AppDb,
} from "@mendpoint/db";
import { runWardenCiRepairDispatch } from "./warden-ci-repair-dispatch.js";

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function fixture(
  evidenceDocument: Readonly<Record<string, unknown>> = {
    failures: [{ name: "unit", text: "expected 1 received 2" }],
  },
  sourcePayload: Readonly<Record<string, unknown>> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-ci-repair-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  enqueueJob(db, { id: "initial-agent-job", tenantId: "tenant-a", type: "agent.run", payload: {
    goal: "Initial change", consumerId: "consumer-a", allowedChangedPaths: ["src/a.ts"], useLlm: true,
    ...sourcePayload,
  }, createdAt: "2026-08-13T12:00:00.000Z" });
  insertAgentRun(db, { id: "run-a", tenantId: "tenant-a", jobId: "initial-agent-job", goal: "Initial change",
    repoPath: root, status: "candidate_approved", ok: true, steps: 2, filesChanged: ["src/a.ts"],
    reportMd: null, resultJson: "{}", createdAt: "2026-08-13T12:00:00.000Z",
    finishedAt: "2026-08-13T12:01:00.000Z" });
  db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
    (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
     expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
     intent_digest, branch_name, base_revision, commit_sha, draft_pr, draft_pr_number,
     draft_pr_url, requested_at, delivered_at, updated_at)
    VALUES ('delivery-a', 'tenant-a', 'run-a', 'delivery-job-a', 'delivered', 'repo-a', 'snapshot-a',
     'main', ?, 'sealed', ?, 'principal-a', 'approved', ?, 'mendpoint/warden-a', ?, ?, 1, 17,
     'https://github.com/acme/service/pull/17', ?, ?, ?)`)
    .run(sha("a"), `sha256:${"b".repeat(64)}`, `sha256:${"c".repeat(64)}`, sha("a"), sha("d"),
      "2026-08-13T12:00:00.000Z", "2026-08-13T12:01:00.000Z", "2026-08-13T12:01:00.000Z");
  const cycle = enqueueWardenCiCycle(db, { tenantId: "tenant-a", deliveryId: "delivery-a",
    repositoryId: "repo-a", remoteRepositoryId: 101, installationId: 202,
    requiredChecks: ["check:77:unit"], allowedChangedPaths: ["src/a.ts"], maxCycles: 2,
    maxModelCalls: 4, maximumCostUsd: 2, observedAt: "2026-08-13T12:01:00.000Z" });
  const evidence = Buffer.from(JSON.stringify(evidenceDocument));
  const evidenceDigest = digest(evidence);
  recordWardenCiObservation(db, { tenantId: "tenant-a", cycleId: cycle.id, headSha: sha("d"),
    verdict: "failure", observationDigest: evidenceDigest, evidenceArtifactId: "artifact-failure-a",
    evidenceDigest, observedAt: "2026-08-13T12:02:00.000Z" });
  const job = claimNextJob(db, ["warden.candidate.repair"], { tenantId: "tenant-a", workerId: "worker-a",
    leaseMs: 60_000, now: "2026-08-13T12:02:30.000Z" })!;
  return { db, cycle, evidence, job, root };
}

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

describe("Warden CI repair dispatch", () => {
  it("propagates the CI cycle's fresh Mission authority instead of the original source job", async () => {
    const value = fixture(
      { failures: [{ name: "unit", text: "expected 1 received 2" }] },
      { missionId: "stale-original-mission" },
    );
    const { db, evidence, job, root } = value;
    const at = "2026-08-13T12:00:00.000Z";
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`).run(at);
    insertPrincipal(db, { id: "mission-owner", tenantId: "tenant-a", kind: "human",
      subject: "owner@example.com", displayName: "Owner", createdAt: at });
    db.raw.prepare(`INSERT INTO scm_connections
      (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
      VALUES ('scm-a', 'tenant-a', 'github', 'app://1', '202', 'GitHub', ?, ?)`).run(at, at);
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
       environment, retention_days, status, created_at, updated_at)
      VALUES ('repo-a', 'tenant-a', 'scm-a', '101', 'acme', 'service', 'main', 'main',
       'production', 30, 'ready', ?, ?)`).run(at, at);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
      VALUES ('snapshot-a', 'tenant-a', 'repo-a', 'main', ?, ?, 'C:\\snapshot',
       'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
      .run(sha("a"), `sha256:${"b".repeat(64)}`, at);
    createMission(db, { id: "mission-current", tenantId: "tenant-a", product: "fettler",
      triggerKind: "provider_change", objective: "Repair the current draft", ownerPrincipalId: "mission-owner",
      eventId: "e-mission", idempotencyKey: "c-mission", correlationId: "corr", createdAt: at });
    bindMissionScope(db, { tenantId: "tenant-a", missionId: "mission-current", repositoryId: "repo-a",
      snapshotId: "snapshot-a", actorPrincipalId: "mission-owner", eventId: "e-scope",
      idempotencyKey: "c-scope", correlationId: "corr", createdAt: at });
    let task = createMissionTask(db, { id: "task-current", tenantId: "tenant-a", missionId: "mission-current",
      taskType: "code_migration", acceptanceCriteria: "CI passes", risk: "medium",
      actorPrincipalId: "mission-owner", eventId: "e-task", idempotencyKey: "c-task",
      correlationId: "corr", createdAt: at });
    task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
      to: "agent_assigned", actorPrincipalId: "mission-owner", eventId: "e-assign",
      idempotencyKey: "c-assign", correlationId: "corr", createdAt: at });
    task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
      to: "agent_working", actorPrincipalId: "mission-owner", eventId: "e-work",
      idempotencyKey: "c-work", correlationId: "corr", createdAt: at });
    const authority = createMissionMutationAuthority({
      mission: getMission(db, "tenant-a", "mission-current")!,
      task, repositoryId: "repo-a", snapshotId: "snapshot-a", resolvedSha: sha("a"),
    });
    db.raw.prepare(`UPDATE fettler_ci_cycles SET mission_authority_json = ? WHERE id = ? AND tenant_id = ?`)
      .run(JSON.stringify(authority), value.cycle.id, "tenant-a");
    db.raw.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?`).run(
      JSON.stringify({ ...JSON.parse(job.payload_json), missionId: authority.missionId, missionAuthority: authority }),
      job.id, "tenant-a",
    );

    await runWardenCiRepairDispatch({ db, job: getJob(db, job.id, "tenant-a")!,
      materializeHead: async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
        revision: sha("d"), manifestSha256: "e".repeat(64), root }),
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z" });
    const repairJob = listJobs(db, 50, "tenant-a").find((candidate) => candidate.type === "agent.run" &&
      candidate.id !== "initial-agent-job")!;
    expect(JSON.parse(repairJob.payload_json)).toMatchObject({
      missionId: "mission-current",
      missionAuthority: { missionId: "mission-current", taskId: "task-current", taskStatus: "agent_working" },
    });
  });

  it("enqueues one standard checkpointable agent run bound to the failed head snapshot", async () => {
    const { db, cycle, evidence, job, root } = fixture();
    const materializeHead = vi.fn(async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
      revision: sha("d"), manifestSha256: "e".repeat(64), root }));

    await expect(runWardenCiRepairDispatch({ db, job, materializeHead,
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z" }))
      .resolves.toMatchObject({ status: "repair_enqueued", cycleId: cycle.id });

    expect(materializeHead).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: "repo-a", remoteRepositoryId: 101, installationId: 202, headSha: sha("d"),
    }));
    const repairJob = listJobs(db, 50, "tenant-a").find((candidate) => candidate.type === "agent.run" &&
      candidate.id !== "initial-agent-job")!;
    expect(JSON.parse(repairJob.payload_json)).toMatchObject({
      consumerId: "consumer-a",
      allowedChangedPaths: ["src/a.ts"],
      maxModelCalls: 2,
      maximumCostUsd: 1,
      snapshotBinding: { repositoryId: "repo-a", snapshotId: "snapshot-repair-a", revision: sha("d") },
      ciFailure: { cycleId: cycle.id, deliveryId: "delivery-a", failedHeadSha: sha("d") },
    });
    expect(JSON.parse(repairJob.payload_json)).not.toHaveProperty("missionId");
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({ status: "repair_pending", usedCycles: 1 });
  });

  it("rejects corrupt evidence before reserving repair budget", async () => {
    const { db, cycle, job, root } = fixture();
    await expect(runWardenCiRepairDispatch({ db, job,
      materializeHead: async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
        revision: sha("d"), manifestSha256: "e".repeat(64), root }),
      readEvidence: async () => Buffer.from("different"),
      now: () => "2026-08-13T12:03:00.000Z" })).rejects.toThrow("warden_ci_evidence_digest_mismatch");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({ status: "checks_failed", usedCycles: 0 });
  });

  it("preserves review-feedback authority while reusing the standard bounded repair run", async () => {
    const { db, cycle, evidence, job, root } = fixture({
      schemaVersion: "2026-08-13.warden-ci-observation.v1",
      trigger: "review_feedback",
      reviewFeedbackDigest: `sha256:${"9".repeat(64)}`,
      reviewFeedback: {
        verdict: "changes_requested",
        changeRequests: [{ id: "7", reviewer: "reviewer", body: "Handle the nil response." }],
        comments: [{ id: "comment-1", path: "src/a.ts", body: "Keep this mapping stable." }],
      },
    });

    await runWardenCiRepairDispatch({ db, job,
      materializeHead: async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
        revision: sha("d"), manifestSha256: "e".repeat(64), root }),
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z" });

    const repairJob = listJobs(db, 50, "tenant-a").find((candidate) => candidate.type === "agent.run" &&
      candidate.id !== "initial-agent-job")!;
    expect(JSON.parse(repairJob.payload_json)).toMatchObject({
      goal: expect.stringContaining("Address the authoritative review feedback"),
      allowedChangedPaths: ["src/a.ts"],
      ciFailure: { cycleId: cycle.id, trigger: "review_feedback", reviewFeedbackDigest: `sha256:${"9".repeat(64)}` },
    });
  });

  it("durably exhausts the cycle and completes the dispatch job without creating another agent run", async () => {
    const { db, cycle, job, evidence } = fixture();
    db.raw.prepare("UPDATE fettler_ci_cycles SET used_cycles = max_cycles WHERE id = ? AND tenant_id = ?")
      .run(cycle.id, "tenant-a");
    const materializeHead = vi.fn();

    await expect(runWardenCiRepairDispatch({ db, job, materializeHead,
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z" }))
      .resolves.toMatchObject({ status: "budget_exhausted", cycleId: cycle.id });

    expect(materializeHead).not.toHaveBeenCalled();
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({ status: "exhausted", usedCycles: 2 });
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(listJobs(db, 50, "tenant-a").filter((candidate) => candidate.type === "agent.run"))
      .toHaveLength(1);
  });

  it("does not revive stale Mission authority from the original source job", async () => {
    const { db, evidence, job, root } = fixture(
      { failures: [{ name: "unit", text: "expected 1 received 2" }] },
      { missionId: "mission-claimed-a" },
    );
    await runWardenCiRepairDispatch({
      db, job,
      materializeHead: async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
        revision: sha("d"), manifestSha256: "e".repeat(64), root }),
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z",
    });
    const repairJob = listJobs(db, 50, "tenant-a").find((candidate) => candidate.type === "agent.run" &&
      candidate.id !== "initial-agent-job")!;
    expect(JSON.parse(repairJob.payload_json)).toMatchObject({ consumerId: "consumer-a" });
    expect(JSON.parse(repairJob.payload_json)).not.toHaveProperty("missionId");
  });

  it("omits padded or empty missionId rather than inventing a Mission", async () => {
    const { db, evidence, job, root } = fixture(
      { failures: [{ name: "unit", text: "expected 1 received 2" }] },
      { missionId: "  mission-padded-a  " },
    );
    await runWardenCiRepairDispatch({
      db, job,
      materializeHead: async () => ({ repositoryId: "repo-a", snapshotId: "snapshot-repair-a",
        revision: sha("d"), manifestSha256: "e".repeat(64), root }),
      readEvidence: async () => evidence, now: () => "2026-08-13T12:03:00.000Z",
    });
    const repairJob = listJobs(db, 50, "tenant-a").find((candidate) => candidate.type === "agent.run" &&
      candidate.id !== "initial-agent-job")!;
    expect(JSON.parse(repairJob.payload_json)).not.toHaveProperty("missionId");
  });
});
