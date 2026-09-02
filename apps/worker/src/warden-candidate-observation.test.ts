import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginWardenCiRepair,
  bindWardenCiUpdateIntent,
  claimNextJob,
  bindMissionScope,
  completeWardenCiUpdate,
  createDb,
  createMission,
  createMissionMutationAuthority,
  createMissionTask,
  enqueueWardenCiCycle,
  enqueueWardenCiUpdate,
  getJob,
  getMission,
  getMissionTask,
  getWardenCandidateDelivery,
  getWardenCiCycle,
  insertArtifactManifest,
  insertPrincipal,
  insertTenant,
  listArtifactManifests,
  listWardenCiObservations,
  listJobs,
  openTaskHandoff,
  raiseMissionException,
  recordWardenCandidateDeliveryOutcome,
  refreshMissionMutationAuthority,
  replayPendingWardenCandidateDeliveryMergedOutcomes,
  resolveMissionException,
  resolveTaskHandoff,
  transitionMission,
  transitionMissionTask,
  wakeWardenCiReviewObservation,
  type AppDb,
} from "@mendpoint/db";
import type { ExactDraftObservation } from "@mendpoint/github";
import { runWardenCandidateObservation } from "./warden-candidate-observation.js";
import { maintainWardenArtifactsOnce } from "./cli.js";
import { assertDelegatedPrVerificationApprovalAuthority } from "./delegated-pr-verification-job.js";
import { bridgeClaimedJobToMissionTask } from "./mission-task-job-bridge.js";

vi.mock("./delegated-pr-verification-job.js", () => ({
  assertDelegatedPrVerificationApprovalAuthority: vi.fn(),
}));

const opened: Array<{ db: AppDb; root: string }> = [];
const sha = (value: string) => value.repeat(40);
const digest = (value: string) => `sha256:${value.repeat(64)}`;
const verifiedAuthority = Object.freeze({
  required: true as const,
  verificationJobId: "verification-job-a",
  candidateArtifactId: "candidate-artifact-a",
  failToPassArtifactId: "fail-artifact-a",
  passToPassArtifactId: "pass-artifact-a",
  completedAt: "2026-08-13T12:00:30.000Z",
  candidateProducerPrincipalId: "candidate-authority",
  candidateProducerVersion: sha("f"),
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-warden-observe-"));
  const db = createDb(join(root, "worker.sqlite"));
  opened.push({ db, root });
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A",
    createdAt: "2026-08-13T11:58:00.000Z" });
  insertPrincipal(db, { id: "candidate-authority", tenantId: "tenant-a", kind: "service",
    subject: "delegated-trial-controller", displayName: "Delegated trial controller",
    createdAt: "2026-08-13T11:58:00.000Z" });
  const candidateContent = JSON.stringify({ candidate: "a" });
  insertArtifactManifest(db, { id: "candidate-artifact-a", tenantId: "tenant-a", kind: "delegated_pr_candidate",
    schemaVersion: 1, sha256: createHash("sha256").update(candidateContent).digest("hex"),
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
  const cycle = enqueueWardenCiCycle(db, {
    tenantId: "tenant-a", deliveryId: "delivery-a", repositoryId: "repo-a",
    remoteRepositoryId: 101, installationId: 202, requiredChecks: ["check:77:unit"],
    allowedChangedPaths: ["src/a.ts"], maxCycles: 3, maxModelCalls: 4, maximumCostUsd: 1.5,
    observedAt: "2026-08-13T12:01:00.000Z",
  });
  const job = claimNextJob(db, ["warden.candidate.observe"], {
    tenantId: "tenant-a", workerId: "worker-a", leaseMs: 60_000,
    now: "2026-08-13T12:01:30.000Z",
  })!;
  return { db, root, cycle, job };
}

function bindMissionAuthority(value: ReturnType<typeof fixture>) {
  const { db } = value;
  insertPrincipal(db, { id: "principal-owner", tenantId: "tenant-a", kind: "human",
    subject: "owner@example.com", displayName: "Owner", createdAt: "2026-08-13T11:58:00.000Z" });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('scm-mission','tenant-a','github','app://1','1','GitHub',?,?)`)
    .run("2026-08-13T11:58:00.000Z", "2026-08-13T11:58:00.000Z");
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-a','tenant-a','scm-mission','101','acme','service','main','main','production',30,'ready',?,?)`)
    .run("2026-08-13T11:58:00.000Z", "2026-08-13T11:58:00.000Z");
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-a','tenant-a','repo-a','main',?,?, 'C:\\snapshot','reject','reject','[]',1,?,?)`)
    .run(sha("a"), digest("b"), "2026-08-13T11:58:00.000Z", "2099-01-01T00:00:00.000Z");
  createMission(db, { id: "mission-a", tenantId: "tenant-a", product: "fettler",
    triggerKind: "provider_change", objective: "Repair CI", ownerPrincipalId: "principal-owner",
    eventId: "mission-a", idempotencyKey: "mission-a", correlationId: "corr",
    createdAt: "2026-08-13T11:58:00.000Z" });
  bindMissionScope(db, { tenantId: "tenant-a", missionId: "mission-a", repositoryId: "repo-a",
    snapshotId: "snapshot-a", actorPrincipalId: "principal-owner", eventId: "scope-a",
    idempotencyKey: "scope-a", correlationId: "corr", createdAt: "2026-08-13T11:58:00.000Z" });
  let task = createMissionTask(db, { id: "task-a", tenantId: "tenant-a", missionId: "mission-a",
    taskType: "code_migration", acceptanceCriteria: "CI passes", risk: "medium",
    actorPrincipalId: "principal-owner", eventId: "task-a", idempotencyKey: "task-a",
    correlationId: "corr", createdAt: "2026-08-13T11:58:00.000Z" });
  for (const to of ["agent_assigned", "agent_working"] as const) {
    task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id,
      expectedRevision: task.revision, to, actorPrincipalId: "principal-owner",
      assignedPrincipalId: "principal-owner",
      eventId: `task-a-${to}`, idempotencyKey: `task-a-${to}`, correlationId: "corr",
      createdAt: "2026-08-13T11:58:00.000Z" });
  }
  const authority = createMissionMutationAuthority({ mission: getMission(db, "tenant-a", "mission-a")!,
    task, repositoryId: "repo-a", snapshotId: "snapshot-a", resolvedSha: sha("a") });
  db.raw.prepare(`UPDATE fettler_candidate_deliveries SET mission_authority_json = ?
    WHERE id = 'delivery-a' AND tenant_id = 'tenant-a'`).run(JSON.stringify(authority));
  db.raw.prepare(`UPDATE fettler_ci_cycles SET mission_authority_json = ?
    WHERE id = ? AND tenant_id = 'tenant-a'`).run(JSON.stringify(authority), value.cycle.id);
  db.raw.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = 'tenant-a'`)
    .run(JSON.stringify({ cycleId: value.cycle.id, deliveryId: "delivery-a",
      missionId: "mission-a", missionAuthority: authority }), value.job.id);
  return { ...value, authority, task, job: getJob(db, value.job.id, "tenant-a")! };
}

afterEach(() => {
  for (const value of opened.splice(0)) {
    value.db.raw.close();
    rmSync(value.root, { recursive: true, force: true });
  }
});

beforeEach(() => {
  vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReset();
  vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReturnValue({ required: false });
});

function observation(state: "success" | "failure" | "running"): ExactDraftObservation {
  return Object.freeze({
    state: "draft", baseRevision: sha("a"), headRevision: sha("d"), checks: state,
    checkRevision: sha("d"), approvals: 1, approvalRevision: sha("d"),
    conversationsResolved: true, checkIdentities: Object.freeze(["check:77:unit"]),
    checkResults: Object.freeze([Object.freeze({ identity: "check:77:unit", state })]),
    reviewFeedback: Object.freeze({
      verdict: "none" as const,
      changeRequests: Object.freeze([]),
      comments: Object.freeze([]),
    }),
    repositoryId: 101, installationId: 202, matchingOpenDrafts: 1,
    changedPaths: Object.freeze(["src/a.ts"]), remoteTreeSha: sha("e"),
    failures: state === "failure" ? Object.freeze([Object.freeze({
      kind: "check_run" as const, id: "9", publisherId: 77, name: "unit", state: "failure" as const,
      title: "Unit failed", summary: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
      text: "expected 1 received 2", detailsUrl: "https://github.com/acme/service/actions/runs/9",
    })]) : Object.freeze([]),
    evidenceRefs: Object.freeze(["github:head:" + sha("d")]),
  });
}

describe("Warden candidate CI observation", () => {
  it("atomically refuses green completion when evidence persistence introduces a Mission blocker", async () => {
    vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReturnValue(verifiedAuthority);
    const value = bindMissionAuthority(fixture());
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => {
      raiseMissionException(value.db, { tenantId: "tenant-a", missionId: "mission-a", taskId: "task-a",
        reason: "late_policy_conflict", impact: "Completion is not authorized.",
        ownerPrincipalId: "principal-owner", resolutionPath: "Resolve the policy conflict.", blocking: true,
        correlationId: "corr", createdAt: "2026-08-13T12:01:59.000Z" });
      return { artifactId: "artifact-blocked-a",
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
    });
    await expect(runWardenCandidateObservation({ db: value.db, job: value.job,
      observe: async () => observation("success"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z" }))
      .rejects.toThrow("mission_mutation_authority_blocked");
    expect(listWardenCiObservations(value.db, "tenant-a", value.cycle.id)).toHaveLength(0);
    expect(getJob(value.db, value.job.id, "tenant-a")?.status).toBe("running");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("observation_pending");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
  });

  it("atomically enqueues one exact cleanup handoff after successful checks", async () => {
    vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReturnValue(verifiedAuthority);
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-success-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    const result = await runWardenCandidateObservation({
      db, job, observe: async () => observation("success"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    });
    expect(result).toMatchObject({ status: "checks_passed", cycleId: cycle.id });
    if (result.status !== "checks_passed") throw new Error("expected checks_passed result");

    const cleanupJobs = listJobs(db, 20, "tenant-a")
      .filter((candidate) => candidate.type === "warden.candidate.cleanup");
    expect(cleanupJobs).toHaveLength(1);
    const cleanupJobId = `wardencicleanupjob_${createHash("sha256")
      .update(["tenant-a", cycle.id, sha("d"), result.observationDigest].join("\0"), "utf8")
      .digest("hex").slice(0, 32)}`;
    const savedObservation = listWardenCiObservations(db, "tenant-a", cycle.id)[0]!;
    expect(cleanupJobs[0]).toMatchObject({
      id: cleanupJobId,
      tenant_id: "tenant-a",
      status: "pending",
      max_attempts: 20,
    });
    expect(JSON.parse(cleanupJobs[0]!.payload_json)).toEqual({
      schemaVersion: 1,
      cycleId: cycle.id,
      deliveryId: "delivery-a",
      observationId: savedObservation.id,
      headSha: sha("d"),
      observationDigest: result.observationDigest,
    });
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("awaiting_review");
    expect(assertDelegatedPrVerificationApprovalAuthority).toHaveBeenCalledWith(db, {
      tenantId: "tenant-a",
      runId: "run-a",
      sourceJobId: "source-job-a",
      candidateDigest: digest("7"),
    });
    const canonicalArtifacts = listArtifactManifests(db, "tenant-a", "delegated_pr_github_observation");
    expect(canonicalArtifacts).toHaveLength(1);
    expect(canonicalArtifacts[0]).toMatchObject({ id: "artifact-success-a",
      sha256: result.observationDigest.slice("sha256:".length),
      media_type: "application/vnd.mendpoint.github-exact-draft-observation+json",
      producer_principal_id: "candidate-authority" });
    expect(JSON.parse(canonicalArtifacts[0]!.content_text!)).toMatchObject({
      schemaVersion: "2026-08-18.github-exact-draft-observation.v1", tenantId: "tenant-a",
      cycleId: cycle.id, deliveryId: "delivery-a", remoteRepositoryId: 101, installationId: 202,
      matchingOpenDrafts: 1, changedPaths: ["src/a.ts"], remoteTreeSha: sha("e"),
      verdict: "success", trigger: "checks_passed",
    });
    expect(db.raw.prepare(`SELECT subject_type, subject_id, artifact_id, input_artifact_id,
      producer_principal_id, tool, tool_version, commit_sha, verdict FROM evidence_records
      WHERE tenant_id = 'tenant-a' AND subject_type = 'delegated_pr_github_observation'`).all())
      .toEqual([expect.objectContaining({ subject_id: savedObservation.id, artifact_id: "artifact-success-a",
        input_artifact_id: "candidate-artifact-a", producer_principal_id: "candidate-authority",
        tool: "mendpoint-exact-github-observer", tool_version: sha("f"), commit_sha: sha("f"), verdict: "passed" })]);
  });

  it("keeps a Mission task resumable while green CI awaits the PR's accepted outcome", async () => {
    const value = bindMissionAuthority(fixture());
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-mission-green-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db: value.db,
      job: value.job,
      observe: async () => observation("success"),
      persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "checks_passed", cycleId: value.cycle.id });

    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("awaiting_review");
    expect(getMissionTask(value.db, "tenant-a", "task-a")).toMatchObject({
      status: "agent_working",
      revision: value.task.revision,
    });
  });

  it("settles a persisted merged outcome when its racing CI observation becomes green", async () => {
    const value = bindMissionAuthority(fixture());
    const merged = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:01:45.000Z",
    });
    expect(merged.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("observation_pending");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");

    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-racing-merge-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));
    await runWardenCandidateObservation({
      db: value.db, job: value.job, observe: async () => observation("success"),
      persistEvidence, resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    });

    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
  });

  it("completes the exact Mission task only when a merged PR has verified green CI awaiting review", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);

    const outcome = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });

    expect(outcome.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    const completed = getMissionTask(value.db, "tenant-a", "task-a")!;
    expect(completed.status).toBe("complete");

    const duplicate = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:07:00.000Z",
    });
    expect(duplicate.outcomeAt).toBe(outcome.outcomeAt);
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.revision).toBe(completed.revision);
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
  });

  it("completes a Mission task for a merged delivery that has no CI cycle", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`DELETE FROM fettler_ci_cycles
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);

    const outcome = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });

    expect(outcome.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)).toBeUndefined();
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
    expect(replayPendingWardenCandidateDeliveryMergedOutcomes(value.db, {
      tenantId: "tenant-a", observedAt: "2026-08-13T12:07:00.000Z",
    })).toEqual({ examined: 1, settled: 0, deferred: 0, notApplicable: 1, failed: 0, malformed: 0 });
  });

  it.each([
    "observation_pending", "checks_running", "checks_failed", "repair_pending",
    "candidate_ready", "update_pending", "paused", "exhausted",
  ] as const)("records a merged PR without completing its Mission task while CI is %s", (status) => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = ?
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(status, value.cycle.id);

    const outcome = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });

    expect(outcome.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe(status);
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
  });

  it("settles an idempotently replayed merged outcome once its exact CI cycle is awaiting review", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'checks_failed'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    const input = {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged" as const,
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    };

    const first = recordWardenCandidateDeliveryOutcome(value.db, input);
    expect(first.outcomeAt).toBe(input.observedAt);
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);

    const replayed = recordWardenCandidateDeliveryOutcome(value.db, {
      ...input, observedAt: "2026-08-13T12:07:00.000Z",
    });
    expect(replayed.outcomeAt).toBe(input.observedAt);
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
  });

  it("retains a factual merged outcome when a late Mission blocker prevents settlement", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    raiseMissionException(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", reason: "Late production hold",
      impact: "Acceptance must wait", ownerPrincipalId: "principal-owner",
      resolutionPath: "Resolve the production hold", blocking: true,
      correlationId: "late-blocker", createdAt: "2026-08-13T12:05:00.000Z",
    });

    const outcome = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });

    expect(outcome.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("awaiting_review");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
  });

  it("replays a late-blocked merged outcome after restart and blocker recovery", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    const blocker = raiseMissionException(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", reason: "Late production hold",
      impact: "Acceptance must wait", ownerPrincipalId: "principal-owner",
      resolutionPath: "Resolve the production hold", blocking: true,
      correlationId: "restart-blocker", createdAt: "2026-08-13T12:05:00.000Z",
    });
    recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });
    expect(getWardenCandidateDelivery(value.db, "tenant-a", "delivery-a")?.outcome).toBe("merged");
    value.db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
      (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
       expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
       mission_authority_json, intent_digest, branch_name, base_revision, commit_sha, draft_pr,
       draft_pr_number, draft_pr_url, requested_at, delivered_at, outcome, outcome_at,
       outcome_source, updated_at)
      VALUES ('delivery-corrupt', 'tenant-a', 'run-corrupt', 'job-corrupt', 'delivered',
       'repo-a', 'snapshot-a', 'main', ?, 'sealed-corrupt', ?, 'principal-owner',
       'approved', '{', ?, 'mendpoint/corrupt', ?, ?, 1, 18,
       'https://github.com/acme/service/pull/18', ?, ?, 'merged', ?, 'github_webhook', ?)`)
      .run(sha("a"), digest("b"), digest("c"), sha("a"), sha("d"),
        "2026-08-13T12:00:00.000Z", "2026-08-13T12:01:00.000Z",
        "2026-08-13T12:06:00.000Z", "2026-08-13T12:06:00.000Z");
    value.db.raw.prepare(`UPDATE agent_runs SET result_json = ?
      WHERE id = 'run-a' AND tenant_id = 'tenant-a'`).run(JSON.stringify({
        status: "candidate_ready", artifacts: { candidateDigest: digest("7"), candidateWorkspace: null },
      }));

    const tracked = opened.findIndex((entry) => entry.db === value.db);
    value.db.raw.close();
    opened.splice(tracked, 1);
    const reopened = createDb(join(value.root, "worker.sqlite"));
    opened.push({ db: reopened, root: value.root });
    expect(getWardenCandidateDelivery(reopened, "tenant-a", "delivery-a")?.outcome).toBe("merged");
    resolveMissionException(reopened, {
      tenantId: "tenant-a", priorExceptionId: blocker.id, resolutionNote: "Hold cleared",
      actorPrincipalId: "principal-owner", correlationId: "restart-blocker",
      createdAt: "2026-08-13T12:07:00.000Z",
    });

    const maintenanceError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    maintainWardenArtifactsOnce(reopened, { MENDPOINT_DATA_DIR: value.root },
      "2026-08-13T12:07:10.000Z");
    expect(maintenanceError).toHaveBeenCalledWith(
      expect.stringContaining("Fettler merged-outcome replay failed tenant=tenant-a count=1"),
    );
    maintenanceError.mockRestore();
    expect(getWardenCiCycle(reopened, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    expect(getMissionTask(reopened, "tenant-a", "task-a")?.status).toBe("complete");
    expect(replayPendingWardenCandidateDeliveryMergedOutcomes(reopened, {
      tenantId: "tenant-a", observedAt: "2026-08-13T12:07:20.000Z",
    })).toEqual({ examined: 1, settled: 0, deferred: 0, notApplicable: 0, failed: 1, malformed: 1 });
  });

  it("replays a durable merged outcome before artifact storage maintenance can fail", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    const blocker = raiseMissionException(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", reason: "Late production hold",
      impact: "Acceptance must wait", ownerPrincipalId: "principal-owner",
      resolutionPath: "Resolve the production hold", blocking: true,
      correlationId: "artifact-blocker", createdAt: "2026-08-13T12:05:00.000Z",
    });
    recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });
    resolveMissionException(value.db, {
      tenantId: "tenant-a", priorExceptionId: blocker.id, resolutionNote: "Hold cleared",
      actorPrincipalId: "principal-owner", correlationId: "artifact-blocker",
      createdAt: "2026-08-13T12:07:00.000Z",
    });
    const notDirectory = join(value.root, "not-a-directory");
    writeFileSync(notDirectory, "artifact storage unavailable");
    const maintenanceError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(maintainWardenArtifactsOnce(value.db, { MENDPOINT_DATA_DIR: notDirectory },
      "2026-08-13T12:07:10.000Z")).toMatchObject({ cleanupPending: 1 });

    maintenanceError.mockRestore();
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
  });

  it("classifies malformed authorities in one globally bounded replay order", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`DELETE FROM fettler_ci_cycles
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    value.db.raw.prepare(`UPDATE fettler_candidate_deliveries
      SET outcome = 'merged', outcome_at = ?, outcome_source = 'github_webhook', updated_at = ?
      WHERE id = 'delivery-a' AND tenant_id = 'tenant-a'`)
      .run("2026-08-13T12:03:00.000Z", "2026-08-13T12:03:00.000Z");
    const insertCorrupt = value.db.raw.prepare(`INSERT INTO fettler_candidate_deliveries
      (id, tenant_id, run_id, job_id, status, repository_id, snapshot_id, base_branch,
       expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
       mission_authority_json, intent_digest, branch_name, base_revision, commit_sha, draft_pr,
       draft_pr_number, draft_pr_url, requested_at, delivered_at, outcome, outcome_at,
       outcome_source, updated_at)
      SELECT ?, tenant_id, ?, ?, status, repository_id, snapshot_id, base_branch,
       expected_base_revision, sealed_path, sealed_sha256, requester_principal_id, rationale,
       ?, intent_digest, ?, base_revision, commit_sha, draft_pr, ?, ?, requested_at, delivered_at,
       'merged', ?, 'github_webhook', ?
      FROM fettler_candidate_deliveries WHERE id = 'delivery-a' AND tenant_id = 'tenant-a'`);
    insertCorrupt.run("delivery-invalid-json", "run-invalid-json", "job-invalid-json", "{",
      "mendpoint/invalid-json", 18, "https://github.com/acme/service/pull/18",
      "2026-08-13T12:01:00.000Z", "2026-08-13T12:01:00.000Z");
    insertCorrupt.run("delivery-invalid-shape", "run-invalid-shape", "job-invalid-shape", "{}",
      "mendpoint/invalid-shape", 19, "https://github.com/acme/service/pull/19",
      "2026-08-13T12:02:00.000Z", "2026-08-13T12:02:00.000Z");

    expect(replayPendingWardenCandidateDeliveryMergedOutcomes(value.db, {
      tenantId: "tenant-a", observedAt: "2026-08-13T12:10:00.000Z", limit: 2,
    })).toEqual({ examined: 2, settled: 0, deferred: 0, notApplicable: 0, failed: 2, malformed: 2 });
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");

    expect(replayPendingWardenCandidateDeliveryMergedOutcomes(value.db, {
      tenantId: "tenant-a", observedAt: "2026-08-13T12:11:00.000Z", limit: 2,
    })).toEqual({ examined: 2, settled: 1, deferred: 0, notApplicable: 0, failed: 1, malformed: 1 });
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
  });

  // DEFERRED-set membership for mission_mutation_dispatch_in_flight was
  // unfalsified: every `deferred:` assertion in this file asserts 0, so removing
  // the code from DEFERRED_MISSION_OUTCOME_SETTLEMENT_ERRORS changed nothing.
  // A fence collision is transient - another writer holds the Mission mid-flight -
  // so the replay must DEFER it, not count it as a settlement failure, which
  // reads as data loss for an outcome GitHub already applied.
  it("defers, not fails, a merged outcome whose Mission task is fenced mid-dispatch", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    // A remote mutation bound to the SAME task is mid-flight BEFORE the webhook
    // lands, so the first settlement attempt defers and the row stays pending.
    value.db.raw.prepare(`INSERT INTO mission_mutation_dispatches
      (id, tenant_id, mission_id, job_id, mutation_kind, aggregate_id, authority_json,
       intent_digest, state, lease_owner, lease_generation, authorized_at, dispatching_at, updated_at)
      VALUES ('d-fenced', 'tenant-a', 'mission-a', 'job-fenced', 'fettler_candidate_delivery',
        'agg-fenced', ?, ?, 'dispatching', 'worker-a', 1, ?, ?, ?)`)
      .run(JSON.stringify(value.authority), `sha256:${"c".repeat(64)}`,
        "2026-08-13T12:06:00.000Z", "2026-08-13T12:06:00.000Z", "2026-08-13T12:06:00.000Z");
    recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:30.000Z",
    });

    expect(replayPendingWardenCandidateDeliveryMergedOutcomes(value.db, {
      tenantId: "tenant-a", observedAt: "2026-08-13T12:10:00.000Z", limit: 5,
    })).toMatchObject({ deferred: 1, failed: 0, malformed: 0 });
    // The merged fact and the task both survive untouched for the next attempt.
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
    expect(value.db.raw.prepare("SELECT state FROM mission_mutation_dispatches WHERE id = 'd-fenced'")
      .get()).toEqual({ state: "dispatching" });
  });

  it("retains a factual merged outcome when Mission authority is stale before settlement", () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE fettler_ci_cycles SET status = 'awaiting_review'
      WHERE id = ? AND tenant_id = 'tenant-a'`).run(value.cycle.id);
    transitionMission(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", expectedRevision: value.authority.missionRevision,
      to: "discovering", actorPrincipalId: "principal-owner", eventId: "mission-discovering",
      idempotencyKey: "mission-discovering", correlationId: "stale-authority",
      createdAt: "2026-08-13T12:05:00.000Z",
    });

    const outcome = recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });

    expect(outcome.outcome).toBe("merged");
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("awaiting_review");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");
  });

  it("resumes green CI through review repair and completes the Mission task only after acceptance", async () => {
    const value = bindMissionAuthority(fixture());
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: `artifact-lifecycle-${persistEvidence.mock.calls.length}`,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));
    const repository = () => ({ owner: "acme", repo: "service" });

    await runWardenCandidateObservation({
      db: value.db, job: value.job, observe: async () => observation("success"),
      persistEvidence, resolveRepository: repository, now: () => "2026-08-13T12:02:00.000Z",
    });
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("awaiting_review");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");

    const woken = wakeWardenCiReviewObservation(value.db, {
      tenantId: "tenant-a", remoteRepositoryId: 101, installationId: 202,
      pullRequestNumber: 17, headSha: sha("d"), wakeId: "review-request-a",
      observedAt: "2026-08-13T12:03:00.000Z",
    });
    expect(woken.status).toBe("woken");
    const reviewJob = claimNextJob(value.db, ["warden.candidate.observe"], {
      tenantId: "tenant-a", workerId: "worker-review", leaseMs: 60_000,
      now: "2026-08-13T12:03:01.000Z",
    })!;
    await runWardenCandidateObservation({
      db: value.db,
      job: reviewJob,
      observe: async () => ({
        ...observation("success"),
        conversationsResolved: false,
        reviewFeedback: {
          verdict: "changes_requested" as const,
          changeRequests: [{ id: "review-a", reviewer: "reviewer", commitRevision: sha("d"),
            body: "Handle the nil response.", submittedAt: "2026-08-13T12:03:02.000Z" }],
          comments: [],
        },
      }),
      persistEvidence,
      resolveRepository: repository,
      now: () => "2026-08-13T12:03:03.000Z",
    });
    const failedCycle = getWardenCiCycle(value.db, "tenant-a", value.cycle.id)!;
    expect(failedCycle.status).toBe("checks_failed");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");

    const handoff = openTaskHandoff(value.db, {
      tenantId: "tenant-a", missionId: "mission-a", taskId: "task-a",
      reason: "architecture_decision_required", question: "Apply the requested review repair?",
      context: "The exact draft needs a bounded reviewer-requested repair.",
      ownerPrincipalId: "principal-owner", correlationId: "review-repair-handoff",
      createdAt: "2026-08-13T12:03:30.000Z",
    });
    resolveTaskHandoff(value.db, {
      tenantId: "tenant-a", priorExceptionId: handoff.id, taskId: "task-a",
      resolutionNote: "Apply the bounded repair.", decision: "Approve repair",
      scope: "handoff_resolution:review-repair", authorPrincipalId: "principal-owner",
      correlationId: "review-repair-handoff", createdAt: "2026-08-13T12:03:40.000Z",
    });
    const resumedAuthority = createMissionMutationAuthority({
      mission: getMission(value.db, "tenant-a", "mission-a")!,
      task: getMissionTask(value.db, "tenant-a", "task-a")!,
      repositoryId: "repo-a", snapshotId: "snapshot-a", resolvedSha: sha("a"),
    });

    beginWardenCiRepair(value.db, {
      tenantId: "tenant-a", cycleId: value.cycle.id,
      observationDigest: failedCycle.currentObservationDigest!, repairRunId: "repair-run-a",
      repairJobId: "repair-agent-job-a", observedAt: "2026-08-13T12:04:00.000Z",
    });
    const update = enqueueWardenCiUpdate(value.db, {
      tenantId: "tenant-a", cycleId: value.cycle.id, repairRunId: "repair-run-a",
      expectedHeadSha: sha("d"), sealedPath: "sealed/repair-approval.json",
      sealedSha256: digest("f"), reviewerPrincipalId: "principal-owner",
      rationale: "Approve exact review repair", missionAuthority: resumedAuthority,
      observedAt: "2026-08-13T12:04:10.000Z",
    });
    const updateJob = claimNextJob(value.db, ["warden.candidate.update"], {
      tenantId: "tenant-a", workerId: "worker-update", leaseMs: 60_000,
      now: "2026-08-13T12:04:20.000Z",
    })!;
    expect(bridgeClaimedJobToMissionTask(value.db, updateJob, "2026-08-13T12:04:20.000Z"))
      .toMatchObject({ id: "task-a", status: "agent_working" });
    const workingAuthority = refreshMissionMutationAuthority(value.db, "tenant-a", resumedAuthority, {
      allowClaimedTask: true, requireNoBlocking: true,
    });
    bindWardenCiUpdateIntent(value.db, {
      tenantId: "tenant-a", updateId: update.id, intentDigest: digest("1"),
      workerId: "worker-update", leaseGeneration: updateJob.lease_generation,
      observedAt: "2026-08-13T12:04:30.000Z",
    });
    completeWardenCiUpdate(value.db, {
      tenantId: "tenant-a", updateId: update.id, expectedHeadSha: sha("d"),
      commitSha: sha("f"), missionAuthority: workingAuthority,
      observedAt: "2026-08-13T12:04:40.000Z",
    });
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.missionAuthority)
      .toMatchObject({ taskId: "task-a", taskRevision: workingAuthority.taskRevision,
        taskStatus: "agent_working" });

    const finalObservationJob = claimNextJob(value.db, ["warden.candidate.observe"], {
      tenantId: "tenant-a", workerId: "worker-final", leaseMs: 60_000,
      now: "2026-08-13T12:05:00.000Z",
    })!;
    await runWardenCandidateObservation({
      db: value.db,
      job: finalObservationJob,
      observe: async () => ({
        ...observation("success"), headRevision: sha("f"), checkRevision: sha("f"),
        approvalRevision: sha("f"), remoteTreeSha: sha("9"),
      }),
      persistEvidence,
      resolveRepository: repository,
      now: () => "2026-08-13T12:05:10.000Z",
    });
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("awaiting_review");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("agent_working");

    recordWardenCandidateDeliveryOutcome(value.db, {
      tenantId: "tenant-a", deliveryId: "delivery-a", outcome: "merged",
      source: "github_webhook", observedAt: "2026-08-13T12:06:00.000Z",
    });
    expect(getWardenCiCycle(value.db, "tenant-a", value.cycle.id)?.status).toBe("succeeded");
    expect(getMissionTask(value.db, "tenant-a", "task-a")?.status).toBe("complete");
    expect(getWardenCandidateDelivery(value.db, "tenant-a", "delivery-a")?.missionAuthority)
      .toMatchObject({ taskRevision: workingAuthority.taskRevision, taskStatus: "agent_working" });
  });

  it("does not create a cleanup handoff for an ordinary non-delegated draft", async () => {
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-ordinary-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db, job, observe: async () => observation("success"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "checks_passed", cycleId: cycle.id });

    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("awaiting_review");
    expect(assertDelegatedPrVerificationApprovalAuthority).toHaveBeenCalledTimes(1);
  });

  it("persists redacted failed-check evidence and terminalizes the exact observation job", async () => {
    const { db, cycle, job } = fixture();
    const observe = vi.fn(async () => observation("failure"));
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-failure-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db, job, observe, persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "failed_checks", cycleId: cycle.id });

    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      pullRequestNumber: 17, expectedHeadSha: sha("d"), expectedRepositoryId: 101,
      requireExactDraft: true,
    }));
    const persisted = Buffer.from(persistEvidence.mock.calls[0]![0]).toString("utf8");
    expect(persisted).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(persisted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("checks_failed");
    expect(listArtifactManifests(db, "tenant-a", "delegated_pr_github_observation")).toHaveLength(0);
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(1);
    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(assertDelegatedPrVerificationApprovalAuthority).not.toHaveBeenCalled();
  });

  it("reschedules running checks without persisting repair evidence", async () => {
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn();
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => observation("running"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "retry_scheduled" });
    expect(persistEvidence).not.toHaveBeenCalled();
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("pending");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("observation_pending");
    expect(listArtifactManifests(db, "tenant-a", "delegated_pr_github_observation")).toHaveLength(0);
    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(assertDelegatedPrVerificationApprovalAuthority).not.toHaveBeenCalled();
  });

  it("durably pauses after the bounded required-check polling budget", async () => {
    const { db, cycle, job } = fixture();
    const exhaustedJob = { ...job, attempts: job.max_attempts };
    await expect(runWardenCandidateObservation({
      db, job: exhaustedJob, observe: async () => observation("running"), persistEvidence: vi.fn(),
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "poll_exhausted", cycleId: cycle.id });
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({
      status: "paused", pausedBy: "warden-ci-system", pauseReason: "required_checks_poll_exhausted",
    });
  });

  it("fails closed on missing required checks before recording an observation", async () => {
    const { db, cycle, job } = fixture();
    const invalid = { ...observation("failure"), checkIdentities: [], checkResults: [] };
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => invalid, persistEvidence: vi.fn(),
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("warden_ci_required_checks_missing");
    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(0);
  });

  it("turns current-head review feedback into redacted bounded repair evidence after checks pass", async () => {
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-review-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));
    const reviewed: ExactDraftObservation = Object.freeze({
      ...observation("success"),
      conversationsResolved: false,
      reviewFeedback: Object.freeze({
        verdict: "changes_requested" as const,
        changeRequests: Object.freeze([Object.freeze({
          id: "7", reviewer: "reviewer", commitRevision: sha("d"),
          body: "Please remove token=ghp_abcdefghijklmnopqrstuvwxyz123456 and handle the nil response.",
          submittedAt: "2026-08-13T12:01:40.000Z",
        })]),
        comments: Object.freeze([Object.freeze({
          id: "comment-1", threadId: "thread-1", reviewer: "reviewer",
          commitRevision: sha("d"), body: "Keep this change inside src/a.ts.",
          path: "src/a.ts", line: 12, createdAt: "2026-08-13T12:01:41.000Z",
          updatedAt: "2026-08-13T12:01:42.000Z",
        })]),
      }),
    });

    await expect(runWardenCandidateObservation({
      db, job, observe: async () => reviewed, persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).resolves.toMatchObject({ status: "review_feedback", cycleId: cycle.id });

    const persisted = JSON.parse(Buffer.from(persistEvidence.mock.calls[0]![0]).toString("utf8")) as {
      trigger: string;
      reviewFeedbackDigest: string;
      reviewFeedback: { changeRequests: Array<{ body: string }>; comments: Array<{ path: string }> };
    };
    expect(persisted.trigger).toBe("review_feedback");
    expect(persisted.reviewFeedbackDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(persisted.reviewFeedback.changeRequests[0]!.body).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(persisted.reviewFeedback.changeRequests[0]!.body).not.toContain("ghp_");
    expect(persisted.reviewFeedback.comments[0]!.path).toBe("src/a.ts");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("checks_failed");
    expect(listJobs(db, 20, "tenant-a")).toContainEqual(expect.objectContaining({
      type: "warden.candidate.repair", status: "pending",
    }));
    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(assertDelegatedPrVerificationApprovalAuthority).not.toHaveBeenCalled();
  });

  it("rolls back the cleanup handoff and observation if the worker loses its lease", async () => {
    vi.mocked(assertDelegatedPrVerificationApprovalAuthority).mockReturnValue(verifiedAuthority);
    const { db, cycle, job } = fixture();
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-stale-lease-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db,
      job: { ...job, lease_generation: job.lease_generation + 1 },
      observe: async () => observation("success"),
      persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("warden_ci_observation_lease_lost");

    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(0);
    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("running");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("observation_pending");
    expect(listArtifactManifests(db, "tenant-a", "delegated_pr_github_observation")).toHaveLength(0);
  });

  it("rolls back the successful observation when delegated authority is invalid", async () => {
    const { db, cycle, job } = fixture();
    vi.mocked(assertDelegatedPrVerificationApprovalAuthority)
      .mockImplementation(() => { throw new Error("delegated_pr_verification_authority_invalid"); });
    const persistEvidence = vi.fn(async (bytes: Uint8Array) => ({
      artifactId: "artifact-invalid-authority-a",
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    }));

    await expect(runWardenCandidateObservation({
      db, job, observe: async () => observation("success"), persistEvidence,
      resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("delegated_pr_verification_authority_invalid");

    expect(listWardenCiObservations(db, "tenant-a", cycle.id)).toHaveLength(0);
    expect(listJobs(db, 20, "tenant-a").filter((candidate) =>
      candidate.type === "warden.candidate.cleanup")).toHaveLength(0);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("running");
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)?.status).toBe("observation_pending");
  });

  it.each([
    { verdict: "unexpected", changeRequests: [], comments: [] },
    { verdict: "changes_requested", changeRequests: [{ id: "7", reviewer: "reviewer",
      commitRevision: sha("d"), body: "fix", submittedAt: "2026-08-13 12:01:40Z" }], comments: [] },
  ])("fails closed on malformed review feedback %#", async (reviewFeedback) => {
    const { db, job } = fixture();
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => ({ ...observation("success"), reviewFeedback } as ExactDraftObservation),
      persistEvidence: vi.fn(), resolveRepository: () => ({ owner: "acme", repo: "service" }),
      now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("warden_ci_review_feedback_invalid");
  });

  it("rejects aggregate feedback above the evidence budget before persistence", async () => {
    const { db, job } = fixture();
    const changeRequests = Array.from({ length: 40 }, (_, index) => Object.freeze({
      id: `review-${index}`, reviewer: `reviewer-${index}`, commitRevision: sha("d"),
      body: "x".repeat(2_000), submittedAt: "2026-08-13T12:01:40.000Z",
    }));
    await expect(runWardenCandidateObservation({
      db, job, observe: async () => ({ ...observation("success"), reviewFeedback: {
        verdict: "changes_requested", changeRequests, comments: [],
      } } as ExactDraftObservation), persistEvidence: vi.fn(),
      resolveRepository: () => ({ owner: "acme", repo: "service" }), now: () => "2026-08-13T12:02:00.000Z",
    })).rejects.toThrow("warden_ci_review_feedback_limit");
  });
});
