import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindMissionScope,
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  evaluateMissionExceptions,
  insertConnectedRepository,
  insertPrincipal,
  insertRepositorySnapshot,
  listMissionExceptions,
  resolveMissionException,
  upsertScmConnection,
  type AppDb,
} from "@mendpoint/db";
import { ensureDefaultPolicyEnvelopeBinding } from "@mendpoint/pipeline";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";
import { assertAgentRunMissionPolicy } from "./agent-run-policy.js";

const at = "2026-08-28T22:40:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(input: { tenantId?: string; missionId?: string } = {}): AppDb {
  const tenantId = input.tenantId ?? "t1";
  const missionId = input.missionId ?? "m1";
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-agent-run-policy-exc-"));
  const db = createDb(join(dir, "app.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, 'one', 'One', 'team', 'active', 10, ?)`,
  ).run(tenantId, at);
  insertPrincipal(db, {
    id: "p1",
    tenantId,
    kind: "human",
    subject: "owner@example.com",
    displayName: "Owner",
    createdAt: at,
  });
  createMission(db, {
    id: missionId,
    tenantId,
    product: "fettler",
    triggerKind: "provider_change",
    objective: "Remediate the payments field rename",
    ownerPrincipalId: "p1",
    eventId: `e-${missionId}`,
    idempotencyKey: `c-${missionId}`,
    correlationId: "corr",
    createdAt: at,
  });
  return db;
}

function bindRestricted(db: AppDb): void {
  const restricted: PolicyEnvelope = {
    ...defaultPolicyEnvelope({
      tenantId: "t1",
      policyEnvelopeId: "pe-restricted",
      createdAt: at,
    }),
    repositoryScope: ["repo-other"],
    allowedTools: ["read"],
  };
  createPolicyEnvelope(db, {
    tenantId: "t1",
    version: 1,
    policyEnvelopeId: restricted.policyEnvelopeId,
    envelopeJson: canonicalPolicyEnvelopeJson(restricted),
    createdAt: at,
  });
  bindMissionToPolicyEnvelope(db, {
    tenantId: "t1",
    missionId: "m1",
    version: 1,
    actorPrincipalId: "p1",
    eventId: "e-bind",
    idempotencyKey: "bind-1",
    correlationId: "corr",
    createdAt: at,
  });
}

function bindMissionSnapshot(db: AppDb, input: {
  snapshotId?: string;
  resolvedSha?: string;
  repositoryId?: string;
} = {}) {
  const dir = opened.find((item) => item.db === db)?.dir;
  if (!dir) throw new Error("test_fixture_dir_missing");
  const snapshotId = input.snapshotId ?? "snap-1";
  const resolvedSha = input.resolvedSha ?? "a".repeat(40);
  const repositoryId = input.repositoryId ?? "repo-a";
  const storage = join(dir, "snapshot");
  mkdirSync(storage, { recursive: true });
  upsertScmConnection(db, {
    id: "scm-1",
    tenantId: "t1",
    provider: "github",
    credentialRef: "github-app://installation/1",
    externalAccountId: "1",
    displayName: "Acme",
    createdAt: at,
    updatedAt: at,
  });
  insertConnectedRepository(db, {
    id: repositoryId,
    tenantId: "t1",
    connectionId: "scm-1",
    remoteId: "200",
    owner: "acme",
    name: "payments",
    defaultBranch: "main",
    status: "ready",
    createdAt: at,
    updatedAt: at,
  });
  insertRepositorySnapshot(db, {
    id: snapshotId,
    tenantId: "t1",
    repositoryId,
    requestedRef: "main",
    resolvedSha,
    manifestSha256: "b".repeat(64),
    storagePath: storage,
    createdAt: at,
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  bindMissionScope(db, {
    tenantId: "t1",
    missionId: "m1",
    repositoryId,
    snapshotId,
    actorPrincipalId: "p1",
    eventId: "e-scope",
    idempotencyKey: "scope-1",
    correlationId: "corr",
    createdAt: at,
  });
  return { snapshotId, resolvedSha } as const;
}

const claim = {
  tenantId: "t1",
  missionId: "m1",
  repositoryId: "repo-a",
  branch: "main",
  targetPaths: ["src/pay.ts"],
  useLlm: false,
  risk: "medium",
} as const;

describe("assertAgentRunMissionPolicy records policy_exception", () => {
  it("records a blocking policy_exception when no envelope is bound", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenantId: "t1",
      missionId: "m1",
      category: "policy_exception",
      reason: "mission_policy_envelope_missing",
      blocking: true,
      resolutionPath: "adjust_task_or_rebind_policy_envelope",
      createdAt: at,
      observedSnapshotId: null,
      observedResolvedSha: null,
    });
    expect(evaluateMissionExceptions(db, "t1", "m1").missionBlocked).toBe(true);
  });

  it("records a blocking policy_exception when the envelope denies the edit", () => {
    const db = fixture();
    bindRestricted(db);
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("policy_exception");
    expect(rows[0]?.blocking).toBe(true);
    expect(rows[0]?.reason).toContain("repository_out_of_scope:repo-a");
    expect(rows[0]?.resolutionPath).toBe("adjust_task_or_rebind_policy_envelope");
  });

  it("records a policy_exception when the pinned envelope is invalid", () => {
    const db = fixture();
    createPolicyEnvelope(db, {
      tenantId: "t1",
      version: 1,
      policyEnvelopeId: "pe-invalid",
      envelopeJson: JSON.stringify({ not: "a policy envelope" }),
      createdAt: at,
    });
    bindMissionToPolicyEnvelope(db, {
      tenantId: "t1",
      missionId: "m1",
      version: 1,
      actorPrincipalId: "p1",
      eventId: "e-bind-invalid",
      idempotencyKey: "bind-invalid",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_denied:policy_envelope_invalid");
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("policy_envelope_invalid");
    expect(rows[0]?.category).toBe("policy_exception");
  });

  it("does not record an exception when the envelope allows the edit", () => {
    const db = fixture();
    ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1",
      missionId: "m1",
      actorPrincipalId: "p1",
      correlationId: "corr",
      createdAt: at,
    });
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at })).not.toThrow();
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not record an exception when the claimed Mission row is missing", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, missionId: "missing", observedAt: at }))
      .toThrow("mission_not_found:missing");
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not record an exception for another tenant", () => {
    const db = fixture();
    db.raw.prepare(
      `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
       VALUES ('t2','two','Two','team','active',10,?)`,
    ).run(at);
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, tenantId: "t2", observedAt: at }))
      .toThrow("mission_not_found:m1");
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
    expect(listMissionExceptions(db, "t2", "m1")).toEqual([]);
  });

  it("does not duplicate a still-blocking policy_exception on replay", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    expect(() => assertAgentRunMissionPolicy(db, {
      ...claim,
      observedAt: "2026-08-28T22:41:00.000Z",
    })).toThrow("mission_policy_envelope_missing");
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.createdAt).toBe(at);
  });

  it("re-raises after the previous policy_exception is resolved", () => {
    const db = fixture();
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    const first = listMissionExceptions(db, "t1", "m1");
    resolveMissionException(db, {
      tenantId: "t1",
      priorExceptionId: first[0]!.id,
      resolutionNote: "rebound envelope",
      actorPrincipalId: "p1",
      correlationId: "corr-resolve",
      createdAt: "2026-08-28T22:42:00.000Z",
    });
    expect(() => assertAgentRunMissionPolicy(db, {
      ...claim,
      observedAt: "2026-08-28T22:43:00.000Z",
    })).toThrow("mission_policy_envelope_missing");
    const evaluation = evaluateMissionExceptions(db, "t1", "m1");
    expect(evaluation.missionBlocked).toBe(true);
    expect(evaluation.blocking).toHaveLength(1);
    expect(evaluation.blocking[0]?.createdAt).toBe("2026-08-28T22:43:00.000Z");
  });

  it("does not swallow a raiseMissionException failure before deny", async () => {
    const db = fixture();
    const dbModule = await import("@mendpoint/db");
    const raise = vi.spyOn(dbModule, "raiseMissionException")
      .mockImplementationOnce(() => {
        throw new Error("exception_store_unavailable");
      });
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("exception_store_unavailable");
    raise.mockRestore();
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("binds a scoped Mission deny to that snapshot so a later snapshot leaves it stale", () => {
    const db = fixture();
    bindRestricted(db);
    const snap = bindMissionSnapshot(db);
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observedSnapshotId).toBe(snap.snapshotId);
    expect(rows[0]?.observedResolvedSha).toBe(snap.resolvedSha);
    const againstBound = evaluateMissionExceptions(db, "t1", "m1", snap);
    expect(againstBound.missionBlocked).toBe(true);
    expect(againstBound.blocking).toHaveLength(1);
    const againstLater = evaluateMissionExceptions(db, "t1", "m1", {
      snapshotId: "snap-later",
      resolvedSha: "c".repeat(40),
    });
    expect(againstLater.missionBlocked).toBe(false);
    expect(againstLater.stale).toHaveLength(1);
    expect(againstLater.blocking).toHaveLength(0);
  });

  it("does not duplicate a snapshot-bound policy_exception on replay against the same snapshot", () => {
    const db = fixture();
    bindMissionSnapshot(db);
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    expect(() => assertAgentRunMissionPolicy(db, {
      ...claim,
      observedAt: "2026-08-28T22:41:00.000Z",
    })).toThrow("mission_policy_envelope_missing");
    expect(listMissionExceptions(db, "t1", "m1")).toHaveLength(1);
  });
});
