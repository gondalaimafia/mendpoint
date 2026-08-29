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
  linkRegaugeCampaignToMission,
  listMissionExceptions,
  resolveMissionException,
  type AppDb,
  type SnapshotIdentity,
} from "@mendpoint/db";
import {
  canonicalPolicyEnvelopeJson,
  defaultPolicyEnvelope,
  type PolicyEnvelope,
} from "@mendpoint/policy";
import { assertRegaugePilotMissionPolicy } from "./regauge-pilot-policy.js";

const at = "2026-08-25T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-regauge-policy-"));
  const db = createDb(join(dir, "t.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?)`).run(at);
  insertPrincipal(db, {
    id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: at,
  });
  const mission = createMission(db, {
    id: "m1", tenantId: "t1", product: "regauge", triggerKind: "migration_objective",
    objective: "Upgrade", ownerPrincipalId: "p1", eventId: "e-m1",
    idempotencyKey: "c-m1", correlationId: "campaign-a", createdAt: at,
  });
  linkRegaugeCampaignToMission(db, {
    tenantId: "t1", missionId: mission.id, regaugeCampaignId: "campaign-a",
    actorPrincipalId: "p1", eventId: "e-link", idempotencyKey: "c-link",
    correlationId: "campaign-a", createdAt: at,
  });
  // Seed the repo and two immutable unit snapshots the claim could execute
  // against. NOTE: we deliberately do NOT bindMissionScope here. The deny binds
  // to the caller-threaded unit snapshot (the runnable campaign's
  // taskSnapshotId), not to mission.snapshotId — so leaving the Mission scope
  // unbound is exactly the shape that must still bind and stay resolvable.
  db.raw.prepare(
    `INSERT INTO scm_connections (id, tenant_id, provider, credential_ref, external_account_id, display_name, created_at, updated_at)
     VALUES ('c1', 't1', 'github', 'me://ref', 'acct', 'Acme', ?, ?)`,
  ).run(at, at);
  db.raw.prepare(
    `INSERT INTO connected_repositories
       (id, tenant_id, connection_id, remote_id, owner, name, default_branch, selected_branch, environment, retention_days, status, created_at, updated_at)
     VALUES ('repo-a', 't1', 'c1', '1', 'acme', 'svc', 'main', 'main', 'production', 30, 'ready', ?, ?)`,
  ).run(at, at);
  seedSnapshot(db, "snapA", "a".repeat(40));
  seedSnapshot(db, "snapB", "c".repeat(40));
  return db;
}

function seedSnapshot(db: AppDb, snapshotId: string, sha: string): void {
  db.raw.prepare(
    `INSERT INTO repository_snapshots
       (id, tenant_id, repository_id, requested_ref, resolved_sha, manifest_sha256, storage_path,
        submodules_policy, lfs_policy, sparse_paths_json, file_manifest_version, created_at, expires_at)
     VALUES (?, 't1', 'repo-a', 'main', ?, ?, ?, 'reject', 'reject', '[]', 1, ?, '2026-09-01T00:00:00.000Z')`,
  ).run(snapshotId, sha, "b".repeat(64), `C:/tmp/${snapshotId}`, at);
}

const snapA: SnapshotIdentity = { snapshotId: "snapA", resolvedSha: "a".repeat(40) };
const snapB: SnapshotIdentity = { snapshotId: "snapB", resolvedSha: "c".repeat(40) };

function bind(db: AppDb, envelope: PolicyEnvelope) {
  createPolicyEnvelope(db, {
    tenantId: "t1", version: envelope.version, policyEnvelopeId: envelope.policyEnvelopeId,
    envelopeJson: canonicalPolicyEnvelopeJson(envelope), createdAt: at,
  });
  bindMissionToPolicyEnvelope(db, {
    tenantId: "t1", missionId: "m1", version: envelope.version, actorPrincipalId: "p1",
    eventId: "e-bind", idempotencyKey: "bind-1", correlationId: "campaign-a", createdAt: at,
  });
}

const claim = {
  tenantId: "t1",
  campaignId: "campaign-a",
  repositoryId: "repo-a",
  externalProcessing: false,
  changedPaths: ["package.json"],
  observedAgainst: snapA,
  observedAt: at,
} as const;

describe("assertRegaugePilotMissionPolicy", () => {
  it("is a no-op when the campaign has no Mission", () => {
    const db = fixture();
    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim, campaignId: "unbound",
    })).not.toThrow();
  });

  it("fails closed when a bound Mission has no envelope", () => {
    const db = fixture();
    expect(() => assertRegaugePilotMissionPolicy(db, claim))
      .toThrow("mission_policy_envelope_missing");
  });

  it("allows a task inside the inherited default envelope", () => {
    const db = fixture();
    bind(db, defaultPolicyEnvelope({
      tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
    }));
    expect(() => assertRegaugePilotMissionPolicy(db, claim)).not.toThrow();
  });

  it("denies a repository outside the pinned envelope scope", () => {
    const db = fixture();
    bind(db, {
      ...defaultPolicyEnvelope({
        tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
      }),
      repositoryScope: Object.freeze(["repo-other"]),
    });
    expect(() => assertRegaugePilotMissionPolicy(db, claim))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
  });

  it("does not evaluate another tenant's campaign id", () => {
    const db = fixture();
    bind(db, {
      ...defaultPolicyEnvelope({
        tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
      }),
      repositoryScope: Object.freeze(["repo-other"]),
    });
    db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
      VALUES ('t2','two','Two','team','active',10,?)`).run(at);
    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim, tenantId: "t2",
    })).not.toThrow();
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("raises a blocking policy_exception when the inherited envelope denies the claim", () => {
    const db = fixture();
    bind(db, {
      ...defaultPolicyEnvelope({
        tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
      }),
      repositoryScope: Object.freeze(["repo-other"]),
    });
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("policy_exception");
    expect(rows[0]?.blocking).toBe(true);
    expect(rows[0]?.reason).toContain("repository_out_of_scope:repo-a");
    expect(evaluateMissionExceptions(db, "t1", "m1", snapA).missionBlocked).toBe(true);

    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim, observedAt: "2026-08-25T00:00:01.000Z",
    })).toThrow(/mission_policy_denied/);
    expect(listMissionExceptions(db, "t1", "m1")).toHaveLength(1);
  });

  it("raises a snapshot-bound policy_exception when a bound Mission has no envelope", () => {
    const db = fixture();
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("mission_policy_envelope_missing");
    expect(rows[0]?.category).toBe("policy_exception");
    expect(rows[0]?.observedSnapshotId).toBe("snapA");
    expect(rows[0]?.observedResolvedSha).toBe("a".repeat(40));
  });

  it("does not raise an exception when the claim is allowed", () => {
    const db = fixture();
    bind(db, defaultPolicyEnvelope({
      tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
    }));
    assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at });
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("does not swallow a raiseMissionException failure before deny", async () => {
    const db = fixture();
    const dbModule = await import("@mendpoint/db");
    const raise = vi.spyOn(dbModule, "raiseMissionException")
      .mockImplementationOnce(() => {
        throw new Error("exception_store_unavailable");
      });
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("exception_store_unavailable");
    raise.mockRestore();
    expect(listMissionExceptions(db, "t1", "m1")).toEqual([]);
  });

  it("re-raises after the previous policy_exception is resolved", () => {
    const db = fixture();
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    const first = listMissionExceptions(db, "t1", "m1");
    resolveMissionException(db, {
      tenantId: "t1",
      priorExceptionId: first[0]!.id,
      resolutionNote: "rebound envelope",
      actorPrincipalId: "p1",
      correlationId: "corr-resolve",
      createdAt: "2026-08-25T00:00:02.000Z",
    });
    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim,
      observedAt: "2026-08-25T00:00:03.000Z",
    })).toThrow("mission_policy_envelope_missing");
    const evaluation = evaluateMissionExceptions(db, "t1", "m1", snapA);
    expect(evaluation.missionBlocked).toBe(true);
    expect(evaluation.blocking).toHaveLength(1);
    expect(evaluation.blocking[0]?.createdAt).toBe("2026-08-25T00:00:03.000Z");
  });

  it("binds the deny to the caller unit snapshot (not mission.snapshotId) and goes stale on a later snapshot", () => {
    const db = fixture();
    bind(db, {
      ...defaultPolicyEnvelope({
        tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
      }),
      repositoryScope: Object.freeze(["repo-other"]),
    });
    // Guard the premise: the Mission carries no snapshot scope here, so a binding
    // derived from mission.snapshotId would be undefined (a no-op that blocks
    // forever). The binding must come from the caller's unit snapshot instead.
    expect(getMission(db, "t1", "m1")?.snapshotId).toBeNull();
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow(/mission_policy_denied:repository_out_of_scope:repo-a/);
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observedSnapshotId).toBe("snapA");
    expect(rows[0]?.observedResolvedSha).toBe("a".repeat(40));
    // On that snapshot the deny still blocks the mission...
    const current = evaluateMissionExceptions(db, "t1", "m1", snapA);
    expect(current.missionBlocked).toBe(true);
    expect(current.blocking).toHaveLength(1);
    // ...but once a later wave runs against a newer unit snapshot the prior deny
    // is STALE, not blocking. Reverting the observedAgainst binding turns this
    // back to blocking — the mutation guard.
    const advanced = evaluateMissionExceptions(db, "t1", "m1", snapB);
    expect(advanced.missionBlocked).toBe(false);
    expect(advanced.blocking).toHaveLength(0);
    expect(advanced.stale).toHaveLength(1);
  });
});
