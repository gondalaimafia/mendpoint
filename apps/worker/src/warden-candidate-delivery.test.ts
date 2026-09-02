import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  createWardenCampaign,
  enqueueJob,
  enqueueWardenCandidateDelivery,
  getJob,
  getWardenCandidateDeliveryByRun,
  getWardenCiCycle,
  insertAgentRun,
  insertPrincipal,
  linkFettlerCampaignToMission,
  getMission,
  getMissionTask,
  openTaskHandoff,
  raiseMissionException,
  resolveTaskHandoff,
  transitionMission,
  transitionMissionTask,
  recoverExpiredJobs,
  type AppDb,
} from "@mendpoint/db";
import type { ExactDraftDeliveryInput, GitHubDelivery } from "@mendpoint/github";
import { runWardenCandidateDelivery } from "./warden-candidate-delivery.js";
import { processJobsOnce } from "./cli.js";

const NOW = "2026-08-06T12:00:00.000Z";
const SNAPSHOT_EXPIRES_AT = "2035-08-06T12:00:00.000Z";
const opened: Array<{ db: AppDb; directory: string }> = [];

function fixture(preciseEvidence = false, deleted = false, providerChange = false) {
  const directory = mkdtempSync(join(tmpdir(), "mendpoint-warden-delivery-worker-"));
  const dataRoot = join(directory, "data");
  const approvalRoot = join(dataRoot, "warden-evidence", "tenant-a", "approvals");
  mkdirSync(approvalRoot, { recursive: true });
  const db = createDb(join(directory, "worker.sqlite"));
  opened.push({ db, directory });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`,
  ).run(NOW);
    const before = Buffer.from("export const old = 1;\n");
    const beforeSha = `sha256:${createHash("sha256").update(before).digest("hex")}`;
    const after = Buffer.from("export const fixed = 1;\n");
    const afterSha = `sha256:${createHash("sha256").update(after).digest("hex")}`;
    const artifact = {
    schemaVersion: providerChange ? (preciseEvidence ? 6 : 5) : preciseEvidence ? 4 : 3,
    tenantId: "tenant-a",
    repositoryId: "repo-1",
    snapshotId: "snapshot-1",
    baseBranch: "main",
    expectedBaseRevision: "a".repeat(40),
    reviewerPrincipalId: "human:reviewer@example.com",
    rationale: "The target and regression checks pass.",
    reviewEvidence: {
      schemaVersion: preciseEvidence ? 2 : 1,
      summary: "The exact candidate passed every configured check.",
      verification: {
        summary: "The target and regression checks passed.",
        commands: [{
          command: "npm test",
          ok: true,
          exitCode: 0,
          outputSha256: `sha256:${"e".repeat(64)}`,
        }],
      },
      edits: [{
        path: "src/client.ts",
        ...(preciseEvidence ? {
          hypothesis: "The observed legacy SDK call causes the failing request.",
          targetSymbol: "createCharge",
          sourceEvidence: [{ path: "src/client.ts", digest: `sha256:${"c".repeat(64)}` }],
          precondition: "The exact legacy SDK call is still present.",
          expectedObservation: "The call changes exactly once.",
          postcondition: "The approved SDK request and regression checks pass.",
          rollback: "Restore the exact observed source bytes.",
          stopCondition: "Stop if the source evidence digest changes.",
        } : {
          rationale: "This source change repairs the bounded SDK call.",
          category: "api_repair",
        }),
        risk: "medium",
        confidence: 1,
        assessmentSource: "planner",
        verification: {
          summary: "The target and regression checks passed.",
          commandOutputSha256: [`sha256:${"e".repeat(64)}`],
        },
      }],
    },
    ...(providerChange ? {
      fettlerProviderChange: {
        schemaVersion: 1,
        providerSlug: "stripe",
        changeId: "change-stripe-2026-08-31",
        pipelineJobId: "pipeline-job-1",
        contentHash: "0123456789abcdef",
        fromVersionId: "version-stripe-2025-01",
        fromVersionLabel: "2025-01",
        toVersionId: "version-stripe-2026-08",
        toVersionLabel: "2026-08",
        repositoryId: "repo-1",
        snapshotId: "snapshot-1",
        revision: "a".repeat(40),
        graphVersionId: "graph-version-1",
        graphContextArtifactId: "graph-context-1",
        impactEvidenceDigest: `sha256:${"f".repeat(64)}`,
        overallConfidence: "high",
        whatChanged: "The provider removed the legacy request field.",
        knownFacts: ["The removed field is used in src/client.ts."],
        unknowns: ["Runtime-only callers were not observed."],
        whyAffected: "src/client.ts sends the removed field at the confirmed call site.",
      },
    } : {}),
    changedPaths: ["src/client.ts"],
    sourceDigest: `sha256:${"c".repeat(64)}`,
    candidate: {
      digest: `sha256:${"d".repeat(64)}`,
      entries: deleted ? [] : [{ path: "src/client.ts", size: after.byteLength, sha256: afterSha, executable: false }],
    },
    files: [{
      path: "src/client.ts",
      before: before.toString("base64"),
      after: deleted ? null : after.toString("base64"),
      beforeSha256: beforeSha,
      afterSha256: deleted ? null : afterSha,
    }],
  };
  const bytes = Buffer.from(JSON.stringify(artifact));
  const sealSha = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const sealPath = join(approvalRoot, `${sealSha.slice(7)}.json`);
  writeFileSync(sealPath, bytes);
  insertAgentRun(db, {
    id: "warden-run-1", tenantId: "tenant-a", jobId: "source-job-1", goal: "Repair the SDK",
    repoPath: join(directory, "snapshot"), status: "candidate_approved", ok: true, steps: 3,
    filesChanged: ["src/client.ts"], reportMd: "Target and regression checks passed.",
    resultJson: JSON.stringify({ source: { repositoryId: "repo-1", snapshotId: "snapshot-1", revision: "a".repeat(40) },
      artifacts: { approval: { path: sealPath, sha256: sealSha } },
      review: { decision: "approve", reviewerPrincipalId: "human:reviewer@example.com",
        rationale: "The target and regression checks pass." } }),
    createdAt: NOW, finishedAt: NOW,
  });
  const delivery = enqueueWardenCandidateDelivery(db, {
    tenantId: "tenant-a", runId: "warden-run-1", repositoryId: "repo-1", snapshotId: "snapshot-1",
    baseBranch: "main", expectedBaseRevision: "a".repeat(40), sealedPath: sealPath, sealedSha256: sealSha,
    requesterPrincipalId: "human:reviewer@example.com", rationale: "The target and regression checks pass.", now: NOW,
  });
  const job = claimNextJob(db, ["warden.candidate.deliver"], {
    tenantId: "tenant-a", workerId: "worker-1", leaseMs: 60_000, now: NOW,
  })!;
  return { db, dataRoot, delivery, job };
}

function bindMissionAuthority(
  value: ReturnType<typeof fixture>,
  options: { campaignBoundSource?: boolean } = {},
) {
  const { db } = value;
  insertPrincipal(db, { id: "principal-owner", tenantId: "tenant-a", kind: "human",
    subject: "owner@example.com", displayName: "Owner", createdAt: NOW });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('scm-mission', 'tenant-a', 'github', 'app://1', '1', 'GitHub', ?, ?)`).run(NOW, NOW);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch,
     environment, retention_days, status, created_at, updated_at)
    VALUES ('repo-1', 'tenant-a', 'scm-mission', '1', 'acme', 'sdk', 'main', 'main',
     'production', 30, 'ready', ?, ?)`).run(NOW, NOW);
  db.raw.prepare(`INSERT INTO repository_snapshots
    (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
     submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
    VALUES ('snapshot-1', 'tenant-a', 'repo-1', 'main', ?, ?, 'C:\\snapshot',
     'reject', 'reject', '[]', 1, ?, '2099-01-01T00:00:00.000Z')`)
    .run("a".repeat(40), `sha256:${"b".repeat(64)}`, NOW);
  createMission(db, { id: "mission-1", tenantId: "tenant-a", product: "fettler",
    triggerKind: "provider_change", objective: "Repair SDK", ownerPrincipalId: "principal-owner",
    eventId: "e-mission", idempotencyKey: "c-mission", correlationId: "corr", createdAt: NOW });
  bindMissionScope(db, { tenantId: "tenant-a", missionId: "mission-1", repositoryId: "repo-1",
    snapshotId: "snapshot-1", actorPrincipalId: "principal-owner", eventId: "e-scope",
    idempotencyKey: "c-scope", correlationId: "corr", createdAt: NOW });
  let task = createMissionTask(db, { id: "task-1", tenantId: "tenant-a", missionId: "mission-1",
    taskType: "code_migration", acceptanceCriteria: "Tests pass", risk: "medium",
    actorPrincipalId: "principal-owner", eventId: "e-task", idempotencyKey: "c-task",
    correlationId: "corr", createdAt: NOW });
  task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
    to: "agent_assigned", actorPrincipalId: "principal-owner", eventId: "e-assign",
    idempotencyKey: "c-assign", correlationId: "corr", createdAt: NOW });
  task = transitionMissionTask(db, { tenantId: "tenant-a", taskId: task.id, expectedRevision: task.revision,
    to: "agent_working", actorPrincipalId: "principal-owner", eventId: "e-work",
    idempotencyKey: "c-work", correlationId: "corr", createdAt: NOW });
  const blocker = openTaskHandoff(db, { tenantId: "tenant-a", missionId: "mission-1", taskId: task.id,
    reason: "architecture_decision_required", question: "Deliver?", context: "Candidate passed.",
    ownerPrincipalId: "principal-owner", correlationId: "corr", createdAt: NOW });
  resolveTaskHandoff(db, { tenantId: "tenant-a", priorExceptionId: blocker.id, taskId: task.id,
    resolutionNote: "Approve", decision: "Approve", scope: "handoff_resolution:delivery",
    authorPrincipalId: "principal-owner", correlationId: "corr", createdAt: NOW });
  if (options.campaignBoundSource) {
    // SYNTHETIC BY CONSTRUCTION — see the campaign-bound test below.
    createWardenCampaign(db, { id: "campaign-1", tenantId: "tenant-a", name: "Stripe migration",
      ownerPrincipalId: "principal-owner", concurrencyLimit: 1, completionPolicy: "all",
      eventId: "e-campaign", idempotencyKey: "c-campaign", correlationId: "corr", createdAt: NOW });
    linkFettlerCampaignToMission(db, { tenantId: "tenant-a", campaignId: "campaign-1",
      missionId: "mission-1", actorPrincipalId: "principal-owner", eventId: "e-link",
      idempotencyKey: "c-link", correlationId: "corr", createdAt: NOW });
  }
  enqueueJob(db, { id: "source-job-1", tenantId: "tenant-a", type: "agent.run", createdAt: NOW,
    payload: options.campaignBoundSource
      ? { campaignId: "campaign-1", consumerId: "consumer-1", sessionId: "warden-run-1" }
      : { missionId: "mission-1", consumerId: "consumer-1", sessionId: "warden-run-1" } });
  const authority = createMissionMutationAuthority({ mission: getMission(db, "tenant-a", "mission-1")!,
    task: getMissionTask(db, "tenant-a", "task-1")!, repositoryId: "repo-1", snapshotId: "snapshot-1",
    resolvedSha: "a".repeat(40) });
  db.raw.prepare("UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?")
    .run(JSON.stringify({ deliveryId: value.delivery.id, runId: "warden-run-1",
      missionId: "mission-1", missionAuthority: authority }),
      value.job.id, "tenant-a");
  return { ...value, authority, job: getJob(db, value.job.id, "tenant-a")! };
}

afterEach(() => {
  while (opened.length) {
    const entry = opened.pop()!;
    entry.db.raw.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe("Warden exact candidate draft delivery", () => {
  // S4 ORDERING: the snapshot-expiry gate must run BEFORE
  // authorizeMissionMutationDispatch. Authorizing first leaves a `dispatching`
  // row behind for a remote call that never happens, and that row then fences
  // every other Mission writer with mission_mutation_dispatch_in_flight.
  it("refuses an expired snapshot before arming any Mission dispatch row", async () => {
    const value = bindMissionAuthority(fixture());
    const deliverExactDraft = vi.fn();

    await expect(runWardenCandidateDelivery({ db: value.db,
      job: getJob(value.db, value.job.id, "tenant-a")!,
      github: { deliverExactDraft } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot },
      // Already expired relative to the delivery attempt below.
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main",
        snapshotExpiresAt: "2026-08-06T11:59:59.000Z" }),
      now: () => "2026-08-06T12:00:01.000Z" })).resolves.toMatchObject({ status: "delivery_failed" });

    expect(deliverExactDraft).not.toHaveBeenCalled();
    expect(getJob(value.db, value.job.id, "tenant-a")?.error)
      .toContain("warden_candidate_delivery_snapshot_expired");
    // Move the expiry gate after authorize() and this is 1, not 0.
    expect(value.db.raw.prepare(`SELECT COUNT(*) AS n FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ n: 0 });
  });

  // SYNTHETIC BY CONSTRUCTION: production has no campaign -> `agent.run`
  // originator today. The campaign executor stops at stage `review` and never
  // mints an AgentRun, so no real source job carries a campaign hint. The fixture
  // builds that state by hand to pin the RULE ahead of that join landing, because
  // the moment it lands this is the path an unfenced remote mutation takes.
  it("quarantines a CAMPAIGN-bound source job with no retained authority (fixture-minted state; production has no campaign to agent.run originator yet)", async () => {
    const value = bindMissionAuthority(fixture(), { campaignBoundSource: true });
    // No authority anywhere on the delivery payload: the ONLY signal that this
    // delivery is Mission-bound is the source job's campaign hint.
    value.db.raw.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?`)
      .run(JSON.stringify({ deliveryId: value.delivery.id, runId: "warden-run-1" }),
        value.job.id, "tenant-a");
    value.db.raw.prepare("UPDATE fettler_candidate_deliveries SET mission_authority_json = NULL WHERE id = ?")
      .run(value.delivery.id);
    const deliverExactDraft = vi.fn();

    await expect(runWardenCandidateDelivery({ db: value.db,
      job: getJob(value.db, value.job.id, "tenant-a")!,
      github: { deliverExactDraft } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot },
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
      now: () => NOW })).resolves.toMatchObject({ status: "delivery_failed" });

    // Swap sourceMissionId() back to a raw `payload.missionId` read and this dies:
    // the campaign hint is invisible, authorityBindings is empty, the upgrade
    // check passes, and the delivery proceeds to GitHub with no Mission fence.
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({
      status: "dead_letter",
      error_code: "warden_candidate_delivery_mission_authority_upgrade_required",
    });
    expect(deliverExactDraft).not.toHaveBeenCalled();
    expect(value.db.raw.prepare(`SELECT COUNT(*) AS n FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ n: 0 });
  });

  // The binding must come from the SOURCE job, the way production shapes it.
  // Writing `missionId` straight into the delivery payload — the exact field the
  // guard reads — is what kept this regression from ever exercising
  // `sourceMissionId()`, and so hid the campaign-bound gap entirely.
  it("quarantines a legacy mission-bound delivery without retained authority before GitHub", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET payload_json = ? WHERE id = ? AND tenant_id = ?`)
      .run(JSON.stringify({ deliveryId: value.delivery.id, runId: "warden-run-1" }),
        value.job.id, "tenant-a");
    const deliverExactDraft = vi.fn();
    await expect(runWardenCandidateDelivery({ db: value.db,
      job: getJob(value.db, value.job.id, "tenant-a")!,
      github: { deliverExactDraft } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot },
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
      now: () => NOW })).resolves.toMatchObject({ status: "delivery_failed" });
    expect(getJob(value.db, value.job.id, "tenant-a")).toMatchObject({
      status: "dead_letter",
      error_code: "warden_candidate_delivery_mission_authority_upgrade_required",
    });
    expect(deliverExactDraft).not.toHaveBeenCalled();
  });

  it("claims an approved delivery through the real job loop and resumes the exact reviewed Mission task", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40), draft: true as const,
      number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));

    const outcome = await processJobsOnce(value.db, {
      tenantId: "tenant-a", workerId: "worker-real-delivery", leaseMs: 60_000,
      maxJobs: 1, jobTypes: ["warden.candidate.deliver"], runWardenMaintenance: false,
      wardenEnv: {
        MENDPOINT_DATA_DIR: value.dataRoot,
        MENDPOINT_FETTLER_CI_REENTRY_ENABLED: "1",
        MENDPOINT_FETTLER_CI_REENTRY_CONFIG_JSON: JSON.stringify({
          "repo-1": { requiredChecks: ["check:77:unit"], maxCycles: 2, maxModelCalls: 4, maximumCostUsd: 2 },
        }),
      },
      wardenCandidateGithub: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      wardenCandidateRepositoryResolver: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
        remoteRepositoryId: 101, installationId: 202 }),
    });

    const settledJob = getJob(value.db, value.job.id, "tenant-a")!;
    expect(settledJob).toMatchObject({ status: "done", error_code: null });
    expect(outcome).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(getMissionTask(value.db, "tenant-a", "task-1")).toMatchObject({
      status: "agent_working", revision: value.authority.taskRevision! + 1,
    });
    expect(getWardenCandidateDeliveryByRun(value.db, "tenant-a", "warden-run-1")?.missionAuthority)
      .toMatchObject({ taskId: "task-1", taskStatus: "agent_working" });
    const cycle = value.db.raw.prepare(`SELECT id FROM fettler_ci_cycles
      WHERE tenant_id = 'tenant-a'`).get() as { id: string };
    const retainedCycle = getWardenCiCycle(value.db, "tenant-a", cycle.id)!;
    expect(retainedCycle.missionAuthority)
      .toMatchObject({ missionId: "mission-1", taskId: "task-1", taskStatus: "agent_working" });
    expect(JSON.parse(getJob(value.db, retainedCycle.observationJobId, "tenant-a")!.payload_json))
      .toMatchObject({ missionId: "mission-1", missionAuthority: {
        missionId: "mission-1", taskId: "task-1", taskStatus: "agent_working",
      } });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("replays an uncertain approved delivery under a new lease without losing Mission authority", async () => {
    const value = bindMissionAuthority(fixture());
    value.db.raw.prepare(`UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a");
    const deliver = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("response lost"), { remoteSideEffectUncertain: true }))
      .mockImplementationOnce(async (input: ExactDraftDeliveryInput) => ({
        branch: input.branch, title: input.title, baseBranch: input.baseBranch,
        baseSha: input.expectedBaseSha, commitSha: "b".repeat(40), draft: true as const,
        number: 17, url: "https://github.com/acme/sdk/pull/17",
      }));
    const options = {
      tenantId: "tenant-a", leaseMs: 60_000, maxJobs: 1,
      jobTypes: ["warden.candidate.deliver"], runWardenMaintenance: false,
      wardenEnv: { MENDPOINT_DATA_DIR: value.dataRoot },
      wardenCandidateGithub: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      wardenCandidateRepositoryResolver: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    } as const;

    const first = await processJobsOnce(value.db, { ...options, workerId: "worker-delivery-one" });
    expect(first).toMatchObject({ claimed: 1, failed: 1, retried: 1 });
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "uncertain" });
    const mission = getMission(value.db, "tenant-a", "mission-1")!;
    expect(() => transitionMission(value.db, { tenantId: "tenant-a", missionId: mission.id,
      expectedRevision: mission.revision, to: "cancelled", actorPrincipalId: "principal-owner",
      eventId: "e-cancel-uncertain-delivery", idempotencyKey: "c-cancel-uncertain-delivery",
      correlationId: "corr", createdAt: "2026-08-26T18:00:01.000Z" }))
      .toThrow("mission_mutation_dispatch_in_flight");
    value.db.raw.prepare(`UPDATE jobs SET available_at = ? WHERE id = ? AND tenant_id = ?`)
      .run("2026-01-01T00:00:00.000Z", value.job.id, "tenant-a");

    const second = await processJobsOnce(value.db, { ...options, workerId: "worker-delivery-two" });
    expect(second).toEqual({ claimed: 1, succeeded: 1, failed: 0, retried: 0, inconclusive: 0 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "settled" });
    expect(getMissionTask(value.db, "tenant-a", "task-1")).toMatchObject({
      status: "agent_working", revision: value.authority.taskRevision! + 1,
    });
    expect(getWardenCandidateDeliveryByRun(value.db, "tenant-a", "warden-run-1")?.missionAuthority)
      .toMatchObject({ missionId: "mission-1", taskId: "task-1", taskStatus: "agent_working" });
  });

  it("reverifies the seal and creates a draft from the exact approved bytes", async () => {
    const { db, dataRoot, job } = fixture();
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    const github = { deliverExactDraft: deliver } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main",
        snapshotExpiresAt: SNAPSHOT_EXPIRES_AT, remoteRepositoryId: 101, installationId: 202 }),
      ciReentry: {
        requiredChecks: ["check:77:unit"],
        maxCycles: 3,
        maxModelCalls: 4,
        maximumCostUsd: 1.5,
      },
    });
    expect(result.status).toBe("delivered");
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      expectedBaseSha: "a".repeat(40),
      files: [{ path: "src/client.ts", content: "export const fixed = 1;\n", mode: "100644" }],
    }));
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("The target and regression checks pass.");
    expect(body).toContain("Change 1: src/client.ts");
    expect(body).toContain("Category: api_repair");
    expect(body).toContain("Rationale: This source change repairs the bounded SDK call.");
    expect(body).toContain("Risk: medium");
    expect(body).toContain("Confidence: 1.000");
    expect(body).toContain("Command 1: npm test");
    expect(body).toContain(`Output digest: sha256:${"e".repeat(64)}`);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-1")?.draftPrUrl)
      .toBe("https://github.com/acme/sdk/pull/17");
    const cycle = db.raw.prepare("SELECT id FROM fettler_ci_cycles WHERE tenant_id = 'tenant-a'").get() as { id: string };
    expect(getWardenCiCycle(db, "tenant-a", cycle.id)).toMatchObject({
      status: "observation_pending",
      currentHeadSha: "b".repeat(40),
      allowedChangedPaths: ["src/client.ts"],
      requiredChecks: ["check:77:unit"],
    });
  });

  it("renders complete source-bound edit authority for a version four approval", async () => {
    const { db, dataRoot, job } = fixture(true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("Target symbol: createCharge");
    expect(body).toContain("Source evidence: src/client.ts");
    expect(body).toContain("Precondition: The exact legacy SDK call is still present.");
    expect(body).toContain("Postcondition: The approved SDK request and regression checks pass.");
    expect(body).toContain("Rollback: Restore the exact observed source bytes.");
  });

  it("renders sealed provider, graph, impact, verification, and uncertainty evidence", async () => {
    const { db, dataRoot, job } = fixture(true, false, true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    const body = (deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).body;
    expect(body).toContain("Provider change");
    expect(body).toContain("Provider: stripe");
    expect(body).toContain("Provider versions: 2025-01 (version-stripe-2025-01) to 2026-08 (version-stripe-2026-08)");
    expect(body).toContain("Provider content hash: 0123456789abcdef");
    expect(body).toContain("Graph version: graph-version-1");
    expect(body).toContain(`Impact evidence: sha256:${"f".repeat(64)}`);
    expect(body).toContain("What changed");
    expect(body).toContain("The provider removed the legacy request field.");
    expect(body).toContain("Why this code is affected");
    expect(body).toContain("Known: The removed field is used in src/client.ts.");
    expect(body).toContain("Unknown: Runtime-only callers were not observed.");
    expect(body).toContain("Objective verification");
    expect(body).toContain("Proposed migration");
    expect((deliver.mock.calls[0]![0] as ExactDraftDeliveryInput).branch).toMatch(/^mendpoint\/fettler-/);
  });

  it("does not call GitHub for a second approved run scoped to the same sealed provider change", async () => {
    const { db, dataRoot, delivery, job } = fixture(true, false, true);
    const firstDeliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));
    const first = await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: firstDeliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    expect(first.status).toBe("delivered");
    expect(firstDeliver).toHaveBeenCalledTimes(1);

    const firstRun = db.raw.prepare(
      "SELECT result_json FROM agent_runs WHERE id = ? AND tenant_id = ?",
    ).get("warden-run-1", "tenant-a") as { result_json: string };
    insertAgentRun(db, {
      id: "warden-run-2", tenantId: "tenant-a", jobId: "source-job-2", goal: "Repair the same SDK change",
      repoPath: join(dataRoot, "snapshot"), status: "candidate_approved", ok: true, steps: 3,
      filesChanged: ["src/client.ts"], reportMd: "Target and regression checks passed.",
      resultJson: firstRun.result_json, createdAt: NOW, finishedAt: NOW,
    });
    enqueueWardenCandidateDelivery(db, {
      tenantId: "tenant-a", runId: "warden-run-2", repositoryId: "repo-1", snapshotId: "snapshot-1",
      baseBranch: "main", expectedBaseRevision: "a".repeat(40), sealedPath: delivery.sealedPath,
      sealedSha256: delivery.sealedSha256, requesterPrincipalId: "human:reviewer@example.com",
      rationale: "The target and regression checks pass.", now: "2026-08-06T12:00:02.000Z",
    });
    const secondJob = claimNextJob(db, ["warden.candidate.deliver"], {
      tenantId: "tenant-a", workerId: "worker-2", leaseMs: 60_000,
      now: "2026-08-06T12:00:03.000Z",
    })!;
    const secondDeliver = vi.fn();
    const second = await runWardenCandidateDelivery({
      db, job: secondJob, github: { deliverExactDraft: secondDeliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:04.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(second.status).toBe("delivery_failed");
    expect(secondDeliver).not.toHaveBeenCalled();
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", "warden-run-2")).toMatchObject({
      status: "delivery_failed",
      errorMessage: "warden_candidate_delivery_scope_conflict",
    });
  });

  it("delivers an approved deletion as an exact delete operation", async () => {
    const { db, dataRoot, job } = fixture(true, true);
    const deliver = vi.fn(async (input: ExactDraftDeliveryInput) => ({
      branch: input.branch, title: input.title, baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha, commitSha: "b".repeat(40),
      draft: true as const, number: 17, url: "https://github.com/acme/sdk/pull/17",
    }));

    await runWardenCandidateDelivery({
      db, job, github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      files: [{ path: "src/client.ts", delete: true }],
    }));
  });

  it("fails closed before GitHub when the sealed bytes are changed", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    writeFileSync(delivery.sealedPath, "{}", "utf8");
    const deliver = vi.fn();
    const github = { deliverExactDraft: deliver } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({ db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }) });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not call GitHub when the exact Mission is cancelled after the delivery is claimed", async () => {
    const value = bindMissionAuthority(fixture());
    const mission = getMission(value.db, "tenant-a", "mission-1")!;
    transitionMission(value.db, { tenantId: "tenant-a", missionId: mission.id,
      expectedRevision: mission.revision, to: "cancelled", actorPrincipalId: "principal-owner",
      eventId: "e-cancel-delivery", idempotencyKey: "c-cancel-delivery", correlationId: "corr", createdAt: NOW });
    const deliver = vi.fn();
    const result = await runWardenCandidateDelivery({ db: value.db, job: value.job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }) });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("does not call GitHub when a blocker is raised after claim but before dispatch", async () => {
    const value = bindMissionAuthority(fixture());
    const deliver = vi.fn();
    const result = await runWardenCandidateDelivery({ db: value.db, job: value.job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => {
        raiseMissionException(value.db, { tenantId: "tenant-a", missionId: "mission-1",
          reason: "policy_exception", impact: "A current policy blocker forbids remote mutation.",
          resolutionPath: "Resolve the policy exception before delivery.", blocking: true,
          ownerPrincipalId: "principal-owner", correlationId: "corr", createdAt: NOW });
        return { owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT };
      } });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("revokes an armed delivery when cancellation lands after intent binding but before remote dispatch", async () => {
    const value = bindMissionAuthority(fixture());
    const deliver = vi.fn();
    const result = await runWardenCandidateDelivery({ db: value.db, job: value.job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
      beforeRemoteDispatch: () => {
        const mission = getMission(value.db, "tenant-a", "mission-1")!;
        transitionMission(value.db, { tenantId: "tenant-a", missionId: mission.id,
          expectedRevision: mission.revision, to: "cancelled", actorPrincipalId: "principal-owner",
          eventId: "e-cancel-armed-delivery", idempotencyKey: "c-cancel-armed-delivery",
          correlationId: "corr", createdAt: "2026-08-06T12:00:00.500Z" });
      } });
    expect(result.status).not.toBe("delivered");
    expect(deliver).not.toHaveBeenCalled();
    expect(value.db.raw.prepare(`SELECT state FROM mission_mutation_dispatches
      WHERE tenant_id = 'tenant-a' AND job_id = ?`).get(value.job.id)).toEqual({ state: "revoked" });
  });

  it("does not call GitHub when the delivery lease transfers after intent binding", async () => {
    const value = bindMissionAuthority(fixture());
    const deliver = vi.fn();
    await expect(runWardenCandidateDelivery({ db: value.db, job: value.job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: value.dataRoot }, now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
      beforeRemoteDispatch: () => value.db.raw.prepare(`UPDATE jobs SET lease_owner = 'worker-b',
        lease_generation = lease_generation + 1 WHERE id = ? AND tenant_id = ?`).run(value.job.id, "tenant-a") }))
      .rejects.toThrow("warden_candidate_delivery_lease_lost");
    expect(deliver).not.toHaveBeenCalled();
  });

  it("fails closed before GitHub when the bound snapshot expires before delivery", async () => {
    const { db, dataRoot, job } = fixture(true, false, true);
    const deliver = vi.fn();
    const result = await runWardenCandidateDelivery({
      db,
      job,
      github: { deliverExactDraft: deliver } as unknown as GitHubDelivery,
      artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({
        owner: "acme",
        repo: "sdk",
        baseBranch: "main",
        snapshotExpiresAt: "2026-08-06T12:00:00.500Z",
      }),
    });
    expect(result.status).toBe("delivery_failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(getJob(db, job.id, "tenant-a")?.error).toContain(
      "warden_candidate_delivery_snapshot_expired",
    );
  });

  it("keeps a lost GitHub response pending past the ordinary attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const uncertain = Object.assign(new Error("request ended after GitHub accepted it"), {
      code: "GITHUB_EXACT_DRAFT_REMOTE_SIDE_EFFECT_UNCERTAIN",
      remoteSideEffectUncertain: true,
    });
    const github = { deliverExactDraft: vi.fn(async () => { throw uncertain; }) } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("keeps invalid returned GitHub evidence pending past the ordinary attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const github = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => ({
        branch: input.branch,
        title: input.title,
        baseBranch: input.baseBranch,
        baseSha: input.expectedBaseSha,
        commitSha: "b".repeat(40),
        draft: false,
        number: 17,
        url: "https://github.com/acme/sdk/pull/17",
      })),
    } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("keeps transaction setup failure after GitHub success pending past the attempt cap", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const originalExec = db.raw.exec.bind(db.raw);
    let remoteReturned = false;
    let injected = false;
    db.raw.exec = ((sql: string) => {
      if (remoteReturned && !injected && sql === "BEGIN IMMEDIATE") {
        injected = true;
        throw new Error("simulated_transaction_begin_failure");
      }
      return originalExec(sql);
    }) as typeof db.raw.exec;
    const github = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => {
        remoteReturned = true;
        return {
          branch: input.branch,
          title: input.title,
          baseBranch: input.baseBranch,
          baseSha: input.expectedBaseSha,
          commitSha: "b".repeat(40),
          draft: true as const,
          number: 17,
          url: "https://github.com/acme/sdk/pull/17",
        };
      }),
    } as unknown as GitHubDelivery;

    const result = await runWardenCandidateDelivery({
      db, job, github, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });

    expect(injected).toBe(true);
    expect(result.status).toBe("retry_scheduled");
    expect(getJob(db, job.id, "tenant-a")).toMatchObject({
      status: "pending",
      error_code: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      errorCode: "warden_candidate_delivery_remote_side_effect_uncertain",
    });
  });

  it("reconciles an exhausted lease after GitHub succeeded but local finalization lost its fence", async () => {
    const { db, dataRoot, delivery, job } = fixture();
    db.raw.prepare("UPDATE jobs SET attempts = max_attempts WHERE id = ?").run(job.id);
    const exactResult = (input: ExactDraftDeliveryInput) => ({
      branch: input.branch,
      title: input.title,
      baseBranch: input.baseBranch,
      baseSha: input.expectedBaseSha,
      commitSha: "b".repeat(40),
      draft: true as const,
      number: 17,
      url: "https://github.com/acme/sdk/pull/17",
    });
    const firstGitHub = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => {
        db.raw.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?")
          .run("2026-08-06T12:00:00.500Z", job.id);
        return exactResult(input);
      }),
    } as unknown as GitHubDelivery;

    await expect(runWardenCandidateDelivery({
      db, job, github: firstGitHub, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:00:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    })).rejects.toThrow("warden_candidate_delivery_lease_lost");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)).toMatchObject({
      status: "delivery_pending",
      intentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });

    expect(recoverExpiredJobs(db, "2026-08-06T12:00:02.000Z", "tenant-a")).toBe(1);
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("pending");
    const replay = claimNextJob(db, ["warden.candidate.deliver"], {
      tenantId: "tenant-a", workerId: "worker-2", leaseMs: 60_000,
      now: "2026-08-06T12:10:00.000Z",
    })!;
    const replayGitHub = {
      deliverExactDraft: vi.fn(async (input: ExactDraftDeliveryInput) => exactResult(input)),
    } as unknown as GitHubDelivery;
    const result = await runWardenCandidateDelivery({
      db, job: replay, github: replayGitHub, artifactEnv: { MENDPOINT_DATA_DIR: dataRoot },
      now: () => "2026-08-06T12:10:01.000Z",
      resolveRepository: () => ({ owner: "acme", repo: "sdk", baseBranch: "main", snapshotExpiresAt: SNAPSHOT_EXPIRES_AT }),
    });
    expect(result.status).toBe("delivered");
    expect(getJob(db, job.id, "tenant-a")?.status).toBe("done");
    expect(getWardenCandidateDeliveryByRun(db, "tenant-a", delivery.runId)?.status).toBe("delivered");
  });
});
