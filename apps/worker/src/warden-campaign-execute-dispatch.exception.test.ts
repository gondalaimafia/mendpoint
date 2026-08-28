import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  createMission,
  createWardenCampaign,
  evaluateMissionExceptions,
  insertPrincipal,
  linkFettlerCampaignToMission,
  listMissionExceptions,
  resolveMissionException,
  type AppDb,
} from "@mendpoint/db";
import {
  WardenCampaignExecutionError,
  type WardenCampaignExecutionDependencies,
} from "@mendpoint/pipeline";
import {
  runWardenCampaignExecuteTarget,
  type WardenCampaignExecuteJob,
  type WardenCampaignExecutor,
} from "./warden-campaign-execute-dispatch.js";

const at = "2026-08-28T23:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];
const dependencies = {} as unknown as WardenCampaignExecutionDependencies;

afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-campaign-exec-policy-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES ('t1','one','One','team','active',10,?)`,
  ).run(at);
  insertPrincipal(db, {
    id: "p1",
    tenantId: "t1",
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: at,
  });
  createMission(db, {
    id: "m1",
    tenantId: "t1",
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Remediate the payments field rename",
    ownerPrincipalId: "p1",
    eventId: "e-m1",
    idempotencyKey: "c-m1",
    correlationId: "corr",
    createdAt: at,
  });
  createWardenCampaign(db, {
    id: "camp-1",
    tenantId: "t1",
    name: "Payments upgrade",
    ownerPrincipalId: "p1",
    concurrencyLimit: 1,
    completionPolicy: "all",
    eventId: "wc-camp-1",
    idempotencyKey: "wc-camp-1",
    correlationId: "corr",
    createdAt: at,
  });
  linkFettlerCampaignToMission(db, {
    tenantId: "t1",
    campaignId: "camp-1",
    missionId: "m1",
    actorPrincipalId: "p1",
    eventId: "link-1",
    idempotencyKey: "link-1",
    correlationId: "corr",
    createdAt: at,
  });
  return db;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    campaignId: "camp-1",
    targetId: "tgt-1",
    rolloutDecisionId: "rd-1",
    actorPrincipalId: "p1",
    runId: "run-1",
    createdAt: at,
    source: { sourceArtifactId: "src-1" },
    rolloutApproval: {
      decisionSha256: "a".repeat(64),
      approvedByPrincipalId: "p1",
      approvedAt: at,
    },
    ownerApproval: {
      ownerPrincipalId: "p1",
      ownerHandle: "owner",
      approvedAt: at,
    },
    ...overrides,
  };
}

function job(body: Record<string, unknown> = payload()): WardenCampaignExecuteJob {
  return {
    id: "job-1",
    tenant_id: "t1",
    type: "warden.campaign.execute-target",
    payload_json: JSON.stringify(body),
  };
}

function denyExecute(code: string, message = code): WardenCampaignExecutor {
  return (async () => {
    throw new WardenCampaignExecutionError(code, false, message);
  }) as WardenCampaignExecutor;
}

describe("runWardenCampaignExecuteTarget records policy_exception", () => {
  it("records a blocking policy_exception when the executor reports a missing envelope", async () => {
    const db = fixture();
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_policy_envelope_missing" });
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      category: "policy_exception",
      reason: "warden_policy_envelope_missing",
      blocking: true,
      resolutionPath: "adjust_task_or_rebind_policy_envelope",
      createdAt: at,
    });
    expect(evaluateMissionExceptions(db, "t1", "m1").missionBlocked).toBe(true);
  });

  it("records a blocking policy_exception when the executor reports a deny", async () => {
    const db = fixture();
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_denied", "repository_out_of_scope:repo-a"),
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_policy_denied" });
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("repository_out_of_scope:repo-a");
    expect(rows[0]?.category).toBe("policy_exception");
  });

  it("does not record an exception when execute succeeds", async () => {
    const db = fixture();
    const execute = (async () => ({ stage: "review" })) as WardenCampaignExecutor;
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute,
    });
    expect(outcome).toEqual({ status: "executed", stage: "review" });
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not record an exception for a non-policy executor failure", async () => {
    const db = fixture();
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_owner_approval_mismatch"),
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_owner_approval_mismatch" });
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not record an exception when the campaign is unbound", async () => {
    const db = fixture();
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: job(payload({ campaignId: "unbound" })),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_policy_envelope_missing" });
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not record an exception for another tenant", async () => {
    const db = fixture();
    db.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t2','two','Two','team','active',10,?)`,
    ).run(at);
    const outcome = await runWardenCampaignExecuteTarget({
      db,
      job: { ...job(), tenant_id: "t2" },
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    expect(outcome).toEqual({ status: "failed", code: "warden_policy_envelope_missing" });
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
    expect(listMissionExceptions(db, "t2", "m1")).toEqual([]);
  });

  it("does not duplicate a still-blocking policy_exception on replay", async () => {
    const db = fixture();
    await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    await runWardenCampaignExecuteTarget({
      db,
      job: job(payload({ createdAt: "2026-08-28T23:01:00.000Z" })),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(at);
  });

  it("re-raises after the previous policy_exception is resolved", async () => {
    const db = fixture();
    await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    const first = listMissionExceptions(db, "t1", "m1");
    resolveMissionException(db, {
      tenantId: "t1",
      priorExceptionId: first[0]!.id,
      resolutionNote: "rebound envelope",
      actorPrincipalId: "p1",
      correlationId: "corr-resolve",
      createdAt: "2026-08-28T23:02:00.000Z",
    });
    await runWardenCampaignExecuteTarget({
      db,
      job: job(payload({ createdAt: "2026-08-28T23:03:00.000Z" })),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    });
    const evaluation = evaluateMissionExceptions(db, "t1", "m1");
    expect(evaluation.missionBlocked).toBe(true);
    expect(evaluation.blocking).toHaveLength(1);
    expect(evaluation.blocking[0]?.createdAt).toBe("2026-08-28T23:03:00.000Z");
  });

  it("does not swallow a raiseMissionException failure before returning failed", async () => {
    const db = fixture();
    const dbModule = await import("@mendpoint/db");
    vi.spyOn(dbModule, "raiseMissionException").mockImplementationOnce(() => {
      throw new Error("exception_store_unavailable");
    });
    await expect(runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_envelope_missing"),
    })).rejects.toThrow("exception_store_unavailable");
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("CONTROL: a live campaign-execute policy deny without a Mission exception is a red mutation", async () => {
    const db = fixture();
    await runWardenCampaignExecuteTarget({
      db,
      job: job(),
      resolveDependencies: () => dependencies,
      execute: denyExecute("warden_policy_denied", "repository_out_of_scope:repo-a"),
    });
    expect(evaluateMissionExceptions(db, "t1", "m1").blocking).toHaveLength(1);
  });
});
