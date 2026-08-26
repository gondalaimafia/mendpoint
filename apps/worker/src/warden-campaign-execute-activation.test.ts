import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  createDb,
  createMission,
  createMissionTask,
  createWardenCampaign,
  enqueueJob,
  fettlerCampaignMissionTaskId,
  getJob,
  getMission,
  getMissionTask,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  linkFettlerCampaignToMission,
  listJobs,
  listWardenCampaignTargets,
  missionTaskIdForJob,
  planWardenRollout,
  transitionWardenCampaign,
  type AppDb,
} from "@mendpoint/db";
import { ingestRepositoryEvidence, openGraphLearnMemory, type GraphLearnDb } from "@mendpoint/graph-learn";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import {
  ensureDefaultPolicyEnvelopeBinding,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import { WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE } from "./warden-campaign-execute-dispatch.js";
import { fieldRenameRecipeDependencies, payloadRenameDeriver } from "./warden-campaign-recipe.js";
import { processJobsOnce } from "./cli.js";
import { buildMissionContext } from "./mission-context.js";
import { enqueueReadyWardenCampaignTargets } from "./warden-campaign-execute-activation.js";

// End-to-end proof of the field-rename activation: the diff's rename op rides in
// the campaign job payload, the loop routes it, and `resolveDependencies(renames)`
// builds the recipe from THAT payload rename (via `payloadRenameDeriver`). No
// deriver reads the lossy artifact taxonomy — the correct rename is the diff's.

const opened: Array<{ db: AppDb; graph: GraphLearnDb; dir: string }> = [];
const createdAt = "2026-08-02T14:00:00.000Z";
const resolvedSha = "a".repeat(40);
const manifestSha256 = "b".repeat(64);
const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  for (const item of opened.splice(0)) {
    item.db.raw.close();
    item.graph.raw.close();
    rmSync(item.dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-activation-e2e-"));
  const snapshotRoot = join(dir, "snapshot");
  mkdirSync(join(snapshotRoot, "src"), { recursive: true });
  writeFileSync(join(snapshotRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  writeFileSync(join(snapshotRoot, "src", "payments.ts"),
    "export function createCharge(amount_cents: number) {\n  return { amount_cents };\n}\n", "utf8");
  const db = createDb(join(dir, "warden.sqlite"));
  const graph = openGraphLearnMemory();
  opened.push({ db, graph, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'team', 'active', 10, ?)`).run(createdAt);
  for (const [id, kind, subject, name] of [
    ["owner", "human", "owner@example.com", "Owner"],
    ["reviewer", "human", "reviewer@example.com", "Reviewer"],
    ["worker", "service", "warden-worker", "Warden worker"],
  ] as const) {
    insertPrincipal(db, { id, tenantId: "tenant-a", kind, subject, displayName: name, createdAt });
  }
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('connection', 'tenant-a', 'local_git', 'vault://connection', 'account', 'Local', ?, ?)`).run(createdAt, createdAt);
  db.raw.prepare(`INSERT INTO connected_repositories
    (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
     retention_days, status, created_at, updated_at)
    VALUES ('repo-a', 'tenant-a', 'connection', 'repo-a', 'acme', 'payments', 'main', 'main', 'test',
     30, 'ready', ?, ?)`).run(createdAt, createdAt);
  insertRepositorySnapshot(db, { id: "snapshot-a", tenantId: "tenant-a", repositoryId: "repo-a",
    requestedRef: "main", resolvedSha, manifestSha256, storagePath: snapshotRoot, createdAt,
    expiresAt: "2026-08-03T14:00:00.000Z" });
  insertRepositorySnapshotPolicy(db, { id: "snapshot-policy", tenantId: "tenant-a", snapshotId: "snapshot-a",
    codeowners: { "src/**": ["@payments"] }, ciFiles: [".github/workflows/ci.yml"],
    verificationCommands: ["node check.mjs"], protectedBranch: { name: "main" }, createdAt });
  createWardenCampaign(db, { id: "campaign-a", tenantId: "tenant-a", name: "Payments update",
    ownerPrincipalId: "owner", concurrencyLimit: 1, completionPolicy: "all", eventId: "campaign-created",
    idempotencyKey: "campaign-created", correlationId: "campaign-a", createdAt });
  createMission(db, {
    id: "mission-a", tenantId: "tenant-a", product: "fettler", triggerKind: "provider_change",
    objective: "Payments update", ownerPrincipalId: "owner", eventId: "mission-created",
    idempotencyKey: "mission-created", correlationId: "campaign-a", createdAt,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "tenant-a", campaignId: "campaign-a", missionId: "mission-a",
    actorPrincipalId: "owner", eventId: "mission-linked", idempotencyKey: "mission-linked",
    correlationId: "campaign-a", createdAt,
  });
  const campaignTaskId = fettlerCampaignMissionTaskId("mission-a", "repo-a");
  createMissionTask(db, {
    id: campaignTaskId,
    tenantId: "tenant-a",
    missionId: "mission-a",
    taskType: "code_migration",
    acceptanceCriteria: "Complete the enrolled Fettler unit for repository repo-a.",
    risk: "medium",
    actorPrincipalId: "owner",
    eventId: `${campaignTaskId}-created`,
    idempotencyKey: `mission-task-create-${campaignTaskId}`,
    correlationId: "campaign-a",
    createdAt,
  });
  ensureDefaultPolicyEnvelopeBinding(db, {
    tenantId: "tenant-a", missionId: "mission-a", actorPrincipalId: "owner",
    correlationId: "campaign-a", createdAt,
  });
  addWardenCampaignTarget(db, { id: "target-a", tenantId: "tenant-a", campaignId: "campaign-a",
    repositoryId: "repo-a", snapshotId: "snapshot-a", ownerPrincipalId: "owner", maxAttempts: 2,
    eventId: "target-created", idempotencyKey: "target-created", correlationId: "campaign-a", createdAt });
  const decision = planWardenRollout(db, { id: "rollout-a", tenantId: "tenant-a", campaignId: "campaign-a",
    expectedCampaignRevision: 1,
    profiles: [{ targetId: "target-a", risk: "medium", environment: "test", verificationConfidence: 0.99,
      canaryEligible: true, ownerGroup: "payments", ownerMaxParallel: 1,
      maintenanceWindow: { start: "2026-08-02T13:00:00.000Z", end: "2026-08-02T16:00:00.000Z" } }],
    canaryTargetId: "target-a", maxCohortSize: 1,
    stopConditions: { pauseFailureRate: 0.1, abortFailureRate: 0.25, minimumVerificationConfidence: 0.9,
      abortOnCriticalFailure: true },
    actorPrincipalId: "owner", eventId: "rollout-created", idempotencyKey: "rollout-created",
    correlationId: "campaign-a", createdAt });
  transitionWardenCampaign(db, { tenantId: "tenant-a", campaignId: "campaign-a", expectedRevision: 1,
    to: "running", actorPrincipalId: "owner", eventId: "campaign-running", idempotencyKey: "campaign-running",
    correlationId: "campaign-a", createdAt });
  ingestRepositoryEvidence(graph, { tenantId: "tenant-a", repositoryId: "repo-a", snapshotId: "snapshot-a",
    exactCommit: resolvedSha, capturedAt: createdAt,
    evidence: [
      { type: "codeowners", id: "owners-1", observedAt: createdAt, codeownersPath: ".github/CODEOWNERS",
        owners: ["@payments"], matchedPaths: ["src/payments.ts"] },
      { type: "ci", id: "ci-1", observedAt: createdAt, provider: "github_actions",
        workflow: "CI", job: "test", conclusion: "success", runId: "100" },
      { type: "runtime_trace", id: "runtime-1", observedAt: createdAt,
        operation: "POST /charges", status: "ok", durationMs: 17 },
    ] });
  return { db, graph, dir, snapshotRoot, decision };
}

function source(): UnifiedSourceArtifact {
  const content = JSON.stringify({ provider: "provider", version: "2026-08" });
  return {
    id: "source-release-1", tenantId: "tenant-a", sourceKind: "release",
    sourceUri: "https://provider.example/releases/2026-08", providerSlug: "provider",
    sourceRevision: "2026-08", contentSha256: digest(content), contentType: "application/json", content,
    observedAt: createdAt, capturedAt: createdAt, capturedBy: "worker:catalog",
    taxonomyVersion: "2026-08-02",
    // The lossy taxonomy signal is deliberately absent of any rename direction:
    // the correct rename rides in the job payload below (from the diff), proving
    // the deriver does NOT depend on the artifact taxonomy.
    taxonomySignals: [],
    createdAt,
  };
}

const passingVerify: WardenCampaignExecutionDependencies["verify"] = async (input) =>
  input.commands.map((command) => ({
    command, status: "passed" as const, failureFingerprints: [],
    outputSha256: digest(`${command}:passed`), durationMs: 1, sandboxBackend: "fly_machines" as const,
  }));

describe("field-rename activation end to end through the worker loop", () => {
  it("carries durable target scope from the production enqueuer into canonical Mission context", async () => {
    const value = fixture();
    const enqueued = enqueueReadyWardenCampaignTargets(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", actorPrincipalId: "worker", createdAt,
      source: source(), renames: [{ from: "amount_cents", to: "amount" }],
      rolloutDecisionId: "rollout-a",
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    });
    const job = getJob(value.db, enqueued.jobIds[0]!, "tenant-a")!;
    const payload = JSON.parse(job.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({
      campaignId: "campaign-a",
      targetId: "target-a",
      repositoryId: "repo-a",
      snapshotId: "snapshot-a",
    });

    const result = await processJobsOnce(value.db, {
      allTenants: true,
      runWardenMaintenance: false,
      wardenCampaignExecution: {
        resolveDependencies: (renames) => ({
          ...fieldRenameRecipeDependencies({ deriveRename: payloadRenameDeriver(renames), graphDb: value.graph }),
          verify: passingVerify,
        }),
      },
    });

    const campaignTaskId = fettlerCampaignMissionTaskId("mission-a", "repo-a");
    const mission = getMission(value.db, "tenant-a", "mission-a")!;
    const compiled = buildMissionContext(value.db, {
      tenantId: "tenant-a",
      mission,
      task: {
        taskId: campaignTaskId,
        capability: "code_migration",
        riskClass: "medium",
        goal: "Complete the exact repository campaign.",
      },
      fallback: {
        objective: mission.objective,
        repositoryId: payload.repositoryId as string,
        snapshotId: payload.snapshotId as string,
      },
    });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(getMissionTask(value.db, "tenant-a", campaignTaskId)).toMatchObject({
      status: "human_review_required",
      taskType: "code_migration",
    });
    expect(getMissionTask(value.db, "tenant-a", missionTaskIdForJob(job.id))).toBeUndefined();
    expect(compiled.refs).toContainEqual(expect.objectContaining({ kind: "mission_artifact" }));
  });

  it("routes the payload rename through resolveDependencies and lands the target in review", async () => {
    const value = fixture();
    enqueueJob(value.db, {
      id: "job-exec-a",
      tenantId: "tenant-a",
      type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
      createdAt,
      payload: {
        campaignId: "campaign-a", targetId: "target-a", rolloutDecisionId: "rollout-a",
        actorPrincipalId: "worker", runId: "run-a", createdAt,
        source: source(),
        // The diff's fromField -> toField, carried in the payload at enqueue time.
        renames: [{ from: "amount_cents", to: "amount" }],
        rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
        ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
      },
    });

    const result = await processJobsOnce(value.db, {
      allTenants: true,
      runWardenMaintenance: false,
      wardenCampaignExecution: {
        resolveDependencies: (renames) => ({
          ...fieldRenameRecipeDependencies({ deriveRename: payloadRenameDeriver(renames), graphDb: value.graph }),
          verify: passingVerify,
        }),
      },
    });

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, retried: 0 });
    expect(listJobs(value.db, 10, "tenant-a")[0]).toMatchObject({ id: "job-exec-a", status: "done" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage: "review" });
    // The rename lived only in the candidate copy; the snapshot on disk is untouched.
    expect(readFileSync(join(value.snapshotRoot, "src", "payments.ts"), "utf8")).toContain("amount_cents");
  });

  it("fails closed (no edit) when the payload carries no rename", async () => {
    const value = fixture();
    enqueueJob(value.db, {
      id: "job-exec-b",
      tenantId: "tenant-a",
      type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE,
      createdAt,
      payload: {
        campaignId: "campaign-a", targetId: "target-a", rolloutDecisionId: "rollout-a",
        actorPrincipalId: "worker", runId: "run-b", createdAt,
        source: source(),
        rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
        ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
      },
    });

    const result = await processJobsOnce(value.db, {
      allTenants: true,
      runWardenMaintenance: false,
      wardenCampaignExecution: {
        resolveDependencies: (renames) => ({
          ...fieldRenameRecipeDependencies({ deriveRename: payloadRenameDeriver(renames), graphDb: value.graph }),
          verify: passingVerify,
        }),
      },
    });

    // No rename -> empty edit set -> the executor fails closed (terminal), so the
    // job does not report success and the target never reaches review.
    expect(result.succeeded).toBe(0);
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0].stage).not.toBe("review");
  });
});

describe("enqueueReadyWardenCampaignTargets", () => {
  it("enqueues one execute-target job per ready target with payload renames", () => {
    const value = fixture();
    const enqueued = enqueueReadyWardenCampaignTargets(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", actorPrincipalId: "worker", createdAt,
      source: source(), renames: [{ from: "amount_cents", to: "amount" }],
      rolloutDecisionId: "rollout-a",
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    });
    expect(enqueued.jobIds).toHaveLength(1);
    const job = listJobs(value.db, 10, "tenant-a")[0];
    expect(job).toMatchObject({ type: WARDEN_CAMPAIGN_EXECUTE_JOB_TYPE, status: "pending" });
    expect(JSON.parse(job.payload_json)).toMatchObject({
      campaignId: "campaign-a", targetId: "target-a",
      renames: [{ from: "amount_cents", to: "amount" }],
    });
  });

  it("does not insert a second job when the same target is claimed again", () => {
    const value = fixture();
    const first = enqueueReadyWardenCampaignTargets(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", actorPrincipalId: "worker", createdAt,
      source: source(), renames: [{ from: "amount_cents", to: "amount" }],
      rolloutDecisionId: "rollout-a",
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    });
    const second = enqueueReadyWardenCampaignTargets(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", actorPrincipalId: "worker", createdAt,
      source: source(), renames: [{ from: "amount_cents", to: "amount" }],
      rolloutDecisionId: "rollout-a",
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    });
    expect(second.jobIds).toEqual(first.jobIds);
    expect(listJobs(value.db, 10, "tenant-a")).toHaveLength(1);
  });

  it("fails closed when the campaign is not running", () => {
    const value = fixture();
    transitionWardenCampaign(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", expectedRevision: 2, to: "paused",
      actorPrincipalId: "owner", eventId: "campaign-paused", idempotencyKey: "campaign-paused",
      correlationId: "campaign-a", createdAt,
    });
    expect(() => enqueueReadyWardenCampaignTargets(value.db, {
      tenantId: "tenant-a", campaignId: "campaign-a", actorPrincipalId: "worker", createdAt,
      source: source(), renames: [],
      rolloutDecisionId: "rollout-a",
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
    })).toThrow("warden_campaign_not_running");
  });
});
