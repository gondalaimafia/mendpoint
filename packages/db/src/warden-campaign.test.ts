import { afterEach, describe, expect, it } from "vitest";
import {
  addWardenCampaignTarget,
  claimReadyWardenTargets,
  createDb,
  createWardenCampaign,
  insertPrincipal,
  listWardenCampaignTargets,
  listDomainEvents,
  getWardenRolloutDecision,
  planWardenRollout,
  planWardenRollback,
  transitionWardenCampaign,
  transitionWardenTarget,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-warden-"));
  const db = createDb(join(dir, "warden.sqlite")); opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, '2026-01-01T00:00:00.000Z'),
           ('t2', 'two', 'Two', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`).run();
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: "2026-01-01T00:00:00.000Z" });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com",
    displayName: "Two", createdAt: "2026-01-01T00:00:00.000Z" });
  db.raw.prepare(`INSERT INTO scm_connections
    (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
    VALUES ('c1', 't1', 'local_git', 'ref', 'acct', 'Local', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run();
  for (const id of ["r1", "r2", "r3", "r4", "r5"]) {
    db.raw.prepare(`INSERT INTO connected_repositories
      (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment,
       retention_days, status, created_at, updated_at)
      VALUES (?, 't1', 'c1', ?, 'owner', ?, 'main', 'main', 'test', 30, 'ready',
       '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`).run(id, id, id);
    db.raw.prepare(`INSERT INTO repository_snapshots
      (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
       submodules_policy, lfs_policy, sparse_paths_json, created_at, expires_at)
      VALUES (?, 't1', ?, 'main', ?, ?, ?, 'reject', 'reject', '[]',
       '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`).run(`s${id.slice(1)}`, id,
        id.repeat(40).slice(0, 40), id.repeat(64).slice(0, 64), `C:/tmp/${id}`);
  }
  return db;
}
afterEach(() => { for (const { db, dir } of opened.splice(0)) { db.raw.close(); rmSync(dir, { recursive: true, force: true }); } });

function create(db: AppDb) {
  return createWardenCampaign(db, { id: "campaign", tenantId: "t1", name: "Payments upgrade",
    ownerPrincipalId: "p1", concurrencyLimit: 1, completionPolicy: "all", eventId: "event-create",
    idempotencyKey: "create", correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}
function add(db: AppDb, id: string, repositoryId: string, dependsOn: string[] = []) {
  return addWardenCampaignTarget(db, { id, tenantId: "t1", campaignId: "campaign", repositoryId,
    snapshotId: `s${repositoryId.slice(1)}`, ownerPrincipalId: "p1", dependsOn,
    eventId: `event-${id}`, idempotencyKey: `add-${id}`, correlationId: "corr",
    createdAt: `2026-01-01T00:00:0${id.slice(1)}.000Z` });
}
function move(db: AppDb, id: string, revision: number, from: Parameters<typeof transitionWardenTarget>[1]["from"],
  to: Parameters<typeof transitionWardenTarget>[1]["to"], extra: Record<string, unknown> = {}) {
  return transitionWardenTarget(db, { tenantId: "t1", campaignId: "campaign", targetId: id,
    expectedRevision: revision, from, to, actorPrincipalId: "p1", eventId: `event-${id}-${revision}`,
    idempotencyKey: `move-${id}-${revision}`, correlationId: "corr", createdAt: `2026-01-02T00:00:0${revision}.000Z`, ...extra });
}

describe("warden campaign control plane", () => {
  it("persists dependency ordered work with concurrency and revision fencing", () => {
    const db = fixture(); const campaign = create(db);
    expect(() => createWardenCampaign(db, { id: "bad", tenantId: "t1", name: "Bad", ownerPrincipalId: "p2",
      concurrencyLimit: 1, completionPolicy: "all", eventId: "bad-event", idempotencyKey: "bad",
      correlationId: "bad", createdAt: campaign.createdAt })).toThrow("warden_principal_tenant_mismatch");
    add(db, "target1", "r1"); add(db, "target2", "r2", ["target1"]); add(db, "target3", "r3", ["target1"]);
    expect(() => add(db, "cycle", "r3", ["cycle"])).toThrow("warden_dependency_cycle");
    const running = transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "running", actorPrincipalId: "p1", eventId: "event-run", idempotencyKey: "run", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(claimReadyWardenTargets(db, "t1", "campaign").map((item) => item.id)).toEqual(["target1"]);
    expect(() => transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "paused", actorPrincipalId: "p1", eventId: "stale", idempotencyKey: "stale", correlationId: "corr",
      createdAt: running.updatedAt })).toThrow("warden_revision_conflict");
    move(db, "target1", 1, "queued", "analyzing");
    expect(claimReadyWardenTargets(db, "t1", "campaign")).toEqual([]);
    move(db, "target1", 2, "analyzing", "editing");
    move(db, "target1", 3, "editing", "verifying");
    expect(() => move(db, "target1", 4, "verifying", "review")).toThrow("warden_pr_package_required");
    db.raw.prepare(`INSERT INTO artifact_manifests
      (id, tenant_id, kind, schema_version, sha256, media_type, size_bytes, storage_ref, created_at)
      VALUES ('package1', 't1', 'warden-pr-package', 1, ?, 'application/json', 1, 'db:package1',
       '2026-01-02T00:00:00.000Z')`).run("a".repeat(64));
    move(db, "target1", 4, "verifying", "review", { packageArtifactId: "package1" });
    move(db, "target1", 5, "review", "delivering"); move(db, "target1", 6, "delivering", "completed");
    expect(claimReadyWardenTargets(db, "t1", "campaign").map((item) => item.id)).toEqual(["target2"]);
    expect(listDomainEvents(db, "t1", "warden_campaign", "campaign").length).toBe(11);
  });

  it("plans rollback in reverse dependency order", () => {
    const db = fixture(); create(db); add(db, "target1", "r1"); add(db, "target2", "r2", ["target1"]);
    transitionWardenCampaign(db, { tenantId: "t1", campaignId: "campaign", expectedRevision: 1,
      to: "running", actorPrincipalId: "p1", eventId: "run", idempotencyKey: "run", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    db.raw.prepare(`UPDATE warden_campaign_targets SET stage = 'completed' WHERE campaign_id = 'campaign'`).run();
    expect(planWardenRollback(db, "t1", "campaign").map((item) => item.id)).toEqual(["target2", "target1"]);
  });

  it("persists a deterministic dependency and risk ordered rollout with bounded cohorts", () => {
    const db = fixture(); create(db);
    add(db, "target1", "r1");
    add(db, "target2", "r2", ["target1"]);
    add(db, "target3", "r3", ["target1"]);
    add(db, "target4", "r4", ["target1"]);
    add(db, "target5", "r5", ["target2"]);
    const profiles = [
      { targetId: "target1", risk: "medium" as const, environment: "production" as const,
        verificationConfidence: 0.98, canaryEligible: true, ownerGroup: "payments", ownerMaxParallel: 1,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
      { targetId: "target2", risk: "low" as const, environment: "production" as const,
        verificationConfidence: 0.99, canaryEligible: true, ownerGroup: "payments", ownerMaxParallel: 1,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
      { targetId: "target3", risk: "high" as const, environment: "staging" as const,
        verificationConfidence: 0.96, canaryEligible: true, ownerGroup: "search", ownerMaxParallel: 2,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
      { targetId: "target4", risk: "medium" as const, environment: "test" as const,
        verificationConfidence: 0.97, canaryEligible: true, ownerGroup: "search", ownerMaxParallel: 2,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
      { targetId: "target5", risk: "critical" as const, environment: "production" as const,
        verificationConfidence: 0.95, canaryEligible: false, ownerGroup: "payments", ownerMaxParallel: 1,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
    ];
    const common = {
      tenantId: "t1", campaignId: "campaign", expectedCampaignRevision: 1,
      canaryTargetId: "target1", maxCohortSize: 2,
      stopConditions: { pauseFailureRate: 0.1, abortFailureRate: 0.25,
        minimumVerificationConfidence: 0.9, abortOnCriticalFailure: true },
      actorPrincipalId: "p1", correlationId: "corr", createdAt: "2026-01-02T12:00:00.000Z",
    } as const;
    const first = planWardenRollout(db, { ...common, id: "decision-1", profiles,
      eventId: "event-plan-1", idempotencyKey: "plan-1" });
    const second = planWardenRollout(db, { ...common, id: "decision-2", profiles: [...profiles].reverse(),
      eventId: "event-plan-2", idempotencyKey: "plan-2" });

    expect(first.canaryTargetId).toBe("target1");
    expect(first.cohorts.map((cohort) => cohort.targetIds)).toEqual([
      ["target1"], ["target2", "target4"], ["target3", "target5"],
    ]);
    expect(first.cohorts.every((cohort) => cohort.targetIds.length <= 2)).toBe(true);
    expect(first.requiresHumanApproval).toBe(true);
    expect(first.stopConditions).toEqual(common.stopConditions);
    expect(first.targetEvidence.find((item) => item.targetId === "target5")).toMatchObject({
      risk: "critical", environment: "production", dependsOn: ["target2"],
    });
    expect(first.decisionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second.decisionSha256).toBe(first.decisionSha256);
    expect(getWardenRolloutDecision(db, "t1", "decision-1")).toEqual(first);
    expect(db.raw.prepare(`SELECT status FROM warden_campaigns WHERE id = 'campaign'`).get()).toEqual({ status: "draft" });
    expect(listWardenCampaignTargets(db, "t1", "campaign").every((target) => target.stage === "queued")).toBe(true);
    expect(listDomainEvents(db, "t1", "warden_campaign", "campaign").at(-1)?.event_type).toBe("warden.rollout.planned");
  });

  it("rejects unsafe canary and stop condition plans without persisting evidence", () => {
    const db = fixture(); create(db); add(db, "target1", "r1"); add(db, "target2", "r2", ["target1"]);
    const profiles = [
      { targetId: "target1", risk: "low" as const, environment: "test" as const,
        verificationConfidence: 0.99, canaryEligible: true, ownerGroup: "one", ownerMaxParallel: 1,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
      { targetId: "target2", risk: "high" as const, environment: "production" as const,
        verificationConfidence: 0.8, canaryEligible: false, ownerGroup: "two", ownerMaxParallel: 1,
        maintenanceWindow: { start: "2026-01-03T00:00:00.000Z", end: "2026-01-03T04:00:00.000Z" } },
    ];
    const input = { id: "unsafe", tenantId: "t1", campaignId: "campaign", expectedCampaignRevision: 1,
      profiles, canaryTargetId: "target2", maxCohortSize: 2,
      stopConditions: { pauseFailureRate: 0.3, abortFailureRate: 0.2,
        minimumVerificationConfidence: 0.9, abortOnCriticalFailure: true },
      actorPrincipalId: "p1", eventId: "unsafe-event", idempotencyKey: "unsafe",
      correlationId: "corr", createdAt: "2026-01-02T12:00:00.000Z" } as const;
    expect(() => planWardenRollout(db, input)).toThrow("warden_stop_conditions_invalid");
    expect(db.raw.prepare(`SELECT count(*) AS total FROM warden_rollout_decisions`).get()).toEqual({ total: 0 });
    insertPrincipal(db, { id: "service-planner", tenantId: "t1", kind: "service",
      subject: "rollout-service", displayName: "Rollout service",
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(() => planWardenRollout(db, { ...input, profiles: profiles.map((profile) =>
      profile.targetId === "target2" ? { ...profile, verificationConfidence: 0.95 } : profile),
      stopConditions: { ...input.stopConditions, pauseFailureRate: 0.1 }, canaryTargetId: "target1",
      actorPrincipalId: "service-planner", id: "unsafe-service", eventId: "unsafe-service-event",
      idempotencyKey: "unsafe-service" })).toThrow("warden_human_planner_required");
    expect(() => planWardenRollout(db, { ...input, stopConditions: { ...input.stopConditions,
      pauseFailureRate: 0.1 }, id: "unsafe-canary", eventId: "unsafe-canary-event",
      idempotencyKey: "unsafe-canary" })).toThrow("warden_canary_ineligible");
    expect(db.raw.prepare(`SELECT count(*) AS total FROM warden_rollout_decisions`).get()).toEqual({ total: 0 });
    expect(() => planWardenRollout(db, { ...input, stopConditions: { ...input.stopConditions,
      pauseFailureRate: 0.1 }, canaryTargetId: "target1", id: "unsafe-confidence",
      eventId: "unsafe-confidence-event", idempotencyKey: "unsafe-confidence" }))
      .toThrow("warden_verification_confidence_below_threshold");
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
