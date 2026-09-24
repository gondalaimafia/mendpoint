import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  createDb,
  createMission,
  createWardenCampaign,
  insertPrincipal,
  insertRepositorySnapshot,
  insertRepositorySnapshotPolicy,
  linkFettlerCampaignToMission,
  listWardenCampaignTargets,
  planWardenRollout,
  transitionWardenCampaign,
  type AppDb,
} from "@mendpoint/db";
import { ingestRepositoryEvidence, openGraphLearnMemory, type GraphLearnDb } from "@mendpoint/graph-learn";
import type { UnifiedSourceArtifact } from "@mendpoint/change-intel";
import {
  executeWardenCampaignTarget,
  ensureDefaultPolicyEnvelopeBinding,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import { fieldRenameRecipeDependencies } from "./warden-campaign-recipe.js";
import { runWardenCampaignExecuteTarget } from "./warden-campaign-execute-dispatch.js";

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

function fixture(options: { expiresAt?: string; maintenanceStart?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-recipe-e2e-"));
  const snapshotRoot = join(dir, "snapshot");
  mkdirSync(join(snapshotRoot, "src"), { recursive: true });
  writeFileSync(join(snapshotRoot, "check.mjs"), "process.exit(0);\n", "utf8");
  // Real source the recipe will find and rewrite (amount_cents -> amount).
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
    expiresAt: options.expiresAt ?? "2026-08-03T14:00:00.000Z" });
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
      maintenanceWindow: { start: options.maintenanceStart ?? "2026-08-02T13:00:00.000Z", end: "2026-08-02T16:00:00.000Z" } }],
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
    taxonomySignals: [{ kind: "field", subject: "charge.amount_cents", before: "amount_cents",
      after: "amount", breaking: true, evidenceLocation: "release.body:12" }],
    createdAt,
  };
}

describe("field-rename recipe end to end through the campaign executor", () => {
  it.each([
    {
      name: "refuses a queued job after its maintenance window closes",
      enqueuedAt: createdAt,
      maintenanceStart: "2026-08-02T13:00:00.000Z",
      executionTime: "2026-08-02T17:00:00.000Z",
      expiresAt: "2026-08-03T14:00:00.000Z",
      expected: { status: "retry_scheduled", code: "warden_maintenance_window_closed" },
      stage: "queued",
    },
    {
      name: "refuses a snapshot that expires while its job waits in the queue",
      enqueuedAt: createdAt,
      maintenanceStart: "2026-08-02T13:00:00.000Z",
      executionTime: "2026-08-02T15:00:00.000Z",
      expiresAt: "2026-08-02T15:00:00.000Z",
      expected: { status: "failed", code: "warden_snapshot_expired" },
      stage: "queued",
    },
    {
      name: "executes a waiting job once its maintenance window opens",
      enqueuedAt: createdAt,
      maintenanceStart: "2026-08-02T14:30:00.000Z",
      executionTime: "2026-08-02T15:00:00.000Z",
      expiresAt: "2026-08-03T14:00:00.000Z",
      expected: { status: "executed", stage: "review" },
      stage: "review",
    },
  ])("$name", async ({ enqueuedAt, executionTime, expiresAt, maintenanceStart, expected, stage }) => {
    const value = fixture({ expiresAt, maintenanceStart });
    let verificationCalls = 0;
    const queuedJob = {
      id: "job-a", tenant_id: "tenant-a", type: "warden.campaign.execute-target",
      payload_json: JSON.stringify({
        campaignId: "campaign-a", targetId: "target-a", rolloutDecisionId: "rollout-a",
        source: source(), actorPrincipalId: "worker", runId: "run-a", createdAt: enqueuedAt,
        rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
        ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
        renames: [{ from: "amount_cents", to: "amount" }],
      }),
    };
    const outcome = await runWardenCampaignExecuteTarget({
      db: value.db, job: queuedJob, now: () => executionTime,
      resolveDependencies: (renames) => ({
        ...fieldRenameRecipeDependencies({ deriveRename: () => renames[0]!, graphDb: value.graph }),
        verify: async (input) => {
          verificationCalls++;
          return input.commands.map((command) => ({
            command, status: "passed" as const, failureFingerprints: [],
            outputSha256: digest(`${command}:passed`), durationMs: 1, sandboxBackend: "fly_machines" as const,
          }));
        },
      }),
    });
    expect(outcome).toEqual(expected);
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage });
    expect(verificationCalls).toBe(stage === "review" ? 2 : 0);
    // Observe the two clocks, not that the input object was left alone: on a landed
    // run the immutable run events carry the STABLE enqueue clock, never the later
    // authority (execution) time. The refusal cases already prove authority follows
    // execution time through their outcome (they only refuse because the window/
    // expiry is judged at executionTime, not enqueuedAt).
    if (stage === "review") {
      const runEventTimes = value.db.raw.prepare(
        "SELECT created_at FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'warden_run' AND aggregate_id = ?",
      ).all("tenant-a", "run-a") as { created_at: string }[];
      expect(runEventTimes.length).toBeGreaterThan(0);
      expect(runEventTimes.every((row) => row.created_at === enqueuedAt)).toBe(true);
      expect(runEventTimes.some((row) => row.created_at === executionTime)).toBe(false);
    }
  });

  it("retries the same job at a later worker time after a failure between run_started and the analyzing transition", async () => {
    const value = fixture(); // window 13:00-16:00; snapshot valid through 2026-08-03
    const enqueuedAt = createdAt; // 14:00, inside the window
    const passingVerify: WardenCampaignExecutionDependencies["verify"] = async (input) =>
      input.commands.map((command) => ({
        command, status: "passed" as const, failureFingerprints: [],
        outputSha256: digest(`${command}:passed`), durationMs: 1, sandboxBackend: "fly_machines" as const,
      }));
    const queuedJob = {
      id: "job-retry", tenant_id: "tenant-a", type: "warden.campaign.execute-target",
      payload_json: JSON.stringify({
        campaignId: "campaign-a", targetId: "target-a", rolloutDecisionId: "rollout-a",
        source: source(), actorPrincipalId: "worker", runId: "run-a", createdAt: enqueuedAt,
        rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
        ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
        renames: [{ from: "amount_cents", to: "amount" }],
      }),
    };
    const resolveDependencies = (renames: readonly { from: string; to: string }[]) => ({
      ...fieldRenameRecipeDependencies({ deriveRename: () => renames[0]!, graphDb: value.graph }),
      verify: passingVerify,
    });

    // Reproduce the crash between run_started and the queued->analyzing transition:
    // a trigger that aborts the transition into 'analyzing'. run_started has already
    // committed by then, so the run's first event is on disk.
    value.db.raw.exec(
      `CREATE TEMP TRIGGER fail_analyzing BEFORE UPDATE OF stage ON fettler_campaign_targets
       WHEN NEW.stage = 'analyzing' BEGIN SELECT RAISE(ABORT, 'injected_transition_failure'); END;`,
    );

    // Attempt 1 at 15:00 (in window): the transition aborts, the executor maps the
    // storage fault to a retryable failure, and the target stays queued.
    const first = await runWardenCampaignExecuteTarget({
      db: value.db, job: queuedJob, now: () => "2026-08-02T15:00:00.000Z", resolveDependencies,
    });
    expect(first).toEqual({ status: "retry_scheduled", code: "warden_execution_failed" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage: "queued" });

    value.db.raw.exec("DROP TRIGGER fail_analyzing");

    // Attempt 2 at a LATER worker time (15:30, still in window): attempt 1 recorded
    // a terminal run_failed, so this attempt continues the run's event sequence past
    // it (see wardenRunResumePoint / issue #696) instead of colliding on attempt 1's
    // numbers. Every run event still stamps the STABLE enqueue clock, so nothing
    // throws domain_event_idempotency_conflict. The target advances to review.
    const second = await runWardenCampaignExecuteTarget({
      db: value.db, job: queuedJob, now: () => "2026-08-02T15:30:00.000Z", resolveDependencies,
    });
    expect(second).toEqual({ status: "executed", stage: "review" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage: "review" });

    // The re-appended run events carry the stable enqueue clock, not either worker time.
    const runEventTimes = value.db.raw.prepare(
      "SELECT created_at FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'warden_run' AND aggregate_id = ?",
    ).all("tenant-a", "run-a") as { created_at: string }[];
    expect(runEventTimes.length).toBeGreaterThan(0);
    expect(runEventTimes.every((row) => row.created_at === enqueuedAt)).toBe(true);
  });

  it("plans and applies the rename, verifies, and lands a review package with typed edits", async () => {
    const value = fixture();
    const dependencies: WardenCampaignExecutionDependencies = {
      ...fieldRenameRecipeDependencies({
        deriveRename: () => ({ from: "amount_cents", to: "amount" }),
        graphDb: value.graph,
      }),
      // Deterministic passing verify (baseline + post-edit) — the sandbox path is
      // exercised in its own suite; here we prove the recipe's plan/apply flow.
      verify: async (input) => input.commands.map((command) => ({
        command, status: "passed" as const, failureFingerprints: [],
        outputSha256: digest(`${command}:passed`), durationMs: 1, sandboxBackend: "fly_machines" as const,
      })),
    };

    const result = await executeWardenCampaignTarget({
      db: value.db, tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a",
      rolloutDecisionId: "rollout-a", source: source(), actorPrincipalId: "worker", runId: "run-a", createdAt, now: createdAt,
      rolloutApproval: { decisionSha256: value.decision.decisionSha256, approvedByPrincipalId: "reviewer", approvedAt: createdAt },
      ownerApproval: { ownerPrincipalId: "owner", ownerHandle: "@payments", approvedAt: createdAt },
      dependencies,
    });

    expect(result).toMatchObject({ tenantId: "tenant-a", campaignId: "campaign-a", targetId: "target-a", stage: "review" });
    expect(listWardenCampaignTargets(value.db, "tenant-a", "campaign-a")[0]).toMatchObject({ stage: "review" });

    const reviewPackage = value.db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE id = ?")
      .get(result.packageArtifactId) as { content_text: string };
    const parsed = JSON.parse(reviewPackage.content_text) as { typedEdits: Array<{ kind: string; targetPath: string; targetSymbol: string }> };
    expect(parsed.typedEdits).toContainEqual(expect.objectContaining({
      kind: "typed_recipe", targetPath: "src/payments.ts", targetSymbol: "amount_cents",
    }));
    // The snapshot on disk is untouched; the rename lived only in the candidate copy.
    expect(readFileSync(join(value.snapshotRoot, "src", "payments.ts"), "utf8")).toContain("amount_cents");
  });
});
