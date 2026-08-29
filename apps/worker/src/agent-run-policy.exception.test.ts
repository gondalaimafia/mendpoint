import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  evaluateMissionExceptions,
  getMission,
  insertPrincipal,
  listMissionExceptions,
  resolveMissionException,
  type AppDb,
  type SnapshotIdentity,
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
  // The Mission is created exactly as the Fettler enrollment path creates it
  // (warden-campaign-enrollment): no repository/snapshot scope is ever bound.
  // `bindMissionScope` is a ReGauge-only launch step, so on the Fettler path
  // `mission.snapshotId` stays null. The deny's snapshot binding therefore must
  // come from the caller's execution snapshot, not from the Mission row.
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
  // Seed the repo and two immutable snapshots the agent.run could execute
  // against. NOTE: we deliberately do NOT call bindMissionScope here — the real
  // Fettler path never does, and faking it is what let a mission-derived binding
  // (undefined on this path) look green while being a no-op in production.
  db.raw.prepare(
    `INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
     VALUES ('c1', ?, 'github', 'me://ref', 'acct', 'Acme', ?, ?)`,
  ).run(tenantId, at, at);
  db.raw.prepare(
    `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
     VALUES ('repo-a', ?, 'c1', '1', 'acme', 'svc', 'main', 'main', 'production', 30, 'ready', ?, ?)`,
  ).run(tenantId, at, at);
  seedSnapshot(db, tenantId, "snapA", "a".repeat(40));
  seedSnapshot(db, tenantId, "snapB", "c".repeat(40));
  return db;
}

function seedSnapshot(db: AppDb, tenantId: string, snapshotId: string, sha: string): void {
  db.raw.prepare(
    `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
        submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
     VALUES (?, ?, 'repo-a', 'main', ?, ?, ?, 'reject', 'reject', '[]', 1, ?, '2026-09-01T00:00:00.000Z')`,
  ).run(snapshotId, tenantId, sha, "b".repeat(64), `C:/tmp/${snapshotId}`, at);
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

const snapA: SnapshotIdentity = { snapshotId: "snapA", resolvedSha: "a".repeat(40) };
const snapB: SnapshotIdentity = { snapshotId: "snapB", resolvedSha: "c".repeat(40) };

const claim = {
  tenantId: "t1",
  missionId: "m1",
  repositoryId: "repo-a",
  branch: "main",
  targetPaths: ["src/pay.ts"],
  useLlm: false,
  risk: "medium",
  observedAgainst: snapA,
  observedAt: at,
} as const;

describe("assertAgentRunMissionPolicy records policy_exception", () => {
  it("records a blocking policy_exception bound to the execution snapshot when no envelope is bound", () => {
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
      resolutionPath: "rebind_policy_envelope; deny goes stale once a later agent.run supersedes this snapshot",
      createdAt: at,
      observedSnapshotId: "snapA",
      observedResolvedSha: "a".repeat(40),
    });
    expect(evaluateMissionExceptions(db, "t1", "m1", snapA).missionBlocked).toBe(true);
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
    expect(rows[0]?.resolutionPath).toBe("rebind_policy_envelope; deny goes stale once a later agent.run supersedes this snapshot");
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

  it("does not duplicate a still-blocking policy_exception on replay against the same snapshot", () => {
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
    const evaluation = evaluateMissionExceptions(db, "t1", "m1", snapA);
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

  it("binds the deny to the caller snapshot on the real Fettler path (no Mission scope) and goes stale on a later snapshot", () => {
    const db = fixture();
    bindRestricted(db);
    // Guard the premise: the Fettler Mission has NO bound scope, so a binding
    // derived from mission.snapshotId would be undefined here (a no-op that
    // blocks forever). The binding must come from the caller instead.
    expect(getMission(db, "t1", "m1")?.snapshotId).toBeNull();
    expect(getMission(db, "t1", "m1")?.repositoryId).toBeNull();
    expect(() => assertAgentRunMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    // Bound to the execution snapshot the caller threaded, NOT null.
    expect(rows[0]?.observedSnapshotId).toBe("snapA");
    expect(rows[0]?.observedResolvedSha).toBe("a".repeat(40));
    // On that snapshot the deny still blocks the mission...
    const current = evaluateMissionExceptions(db, "t1", "m1", snapA);
    expect(current.missionBlocked).toBe(true);
    expect(current.blocking).toHaveLength(1);
    // ...but once a later agent.run runs against a newer snapshot the prior deny
    // is STALE, not blocking: it does not pin the mission forever. Reverting the
    // observedAgainst binding (context-independent, as the mission-derived path
    // collapses to here) turns this back to blocking — the mutation guard.
    const advanced = evaluateMissionExceptions(db, "t1", "m1", snapB);
    expect(advanced.missionBlocked).toBe(false);
    expect(advanced.blocking).toHaveLength(0);
    expect(advanced.stale).toHaveLength(1);
  });
});
