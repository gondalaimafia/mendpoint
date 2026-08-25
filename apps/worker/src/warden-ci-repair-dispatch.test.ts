import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimNextJob,
  createDb,
  enqueueJob,
  enqueueWardenCiCycle,
  getJob,
  getWardenCiCycle,
  insertAgentRun,
  listJobs,
  recordWardenCiObservation,
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

  it("copies a claimed Mission id from the source agent.run onto the repair run", async () => {
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
    expect(JSON.parse(repairJob.payload_json)).toMatchObject({
      consumerId: "consumer-a",
      missionId: "mission-claimed-a",
    });
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
