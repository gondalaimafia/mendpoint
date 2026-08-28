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
  linkRegaugeCampaignToMission,
  listMissionExceptions,
  resolveMissionException,
  upsertScmConnection,
  type AppDb,
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
  return db;
}

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
    correlationId: "campaign-a",
    createdAt: at,
  });
  return { snapshotId, resolvedSha } as const;
}

const claim = {
  tenantId: "t1",
  campaignId: "campaign-a",
  repositoryId: "repo-a",
  externalProcessing: false,
  changedPaths: ["package.json"],
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
    expect(evaluateMissionExceptions(db, "t1", "m1").missionBlocked).toBe(true);

    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim, observedAt: "2026-08-25T00:00:01.000Z",
    })).toThrow(/mission_policy_denied/);
    expect(listMissionExceptions(db, "t1", "m1")).toHaveLength(1);
  });

  it("raises a policy_exception when a bound Mission has no envelope", () => {
    const db = fixture();
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    const rows = listMissionExceptions(db, "t1", "m1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reason).toBe("mission_policy_envelope_missing");
    expect(rows[0]?.category).toBe("policy_exception");
    expect(rows[0]?.observedSnapshotId).toBeNull();
    expect(rows[0]?.observedResolvedSha).toBeNull();
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
    const evaluation = evaluateMissionExceptions(db, "t1", "m1");
    expect(evaluation.missionBlocked).toBe(true);
    expect(evaluation.blocking).toHaveLength(1);
    expect(evaluation.blocking[0]?.createdAt).toBe("2026-08-25T00:00:03.000Z");
  });

  it("binds a scoped Mission deny to that snapshot so a later snapshot leaves it stale", () => {
    const db = fixture();
    bind(db, {
      ...defaultPolicyEnvelope({
        tenantId: "t1", policyEnvelopeId: "pe-1", createdAt: at, version: 1,
      }),
      repositoryScope: Object.freeze(["repo-other"]),
    });
    const snap = bindMissionSnapshot(db);
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
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
    expect(() => assertRegaugePilotMissionPolicy(db, { ...claim, observedAt: at }))
      .toThrow("mission_policy_envelope_missing");
    expect(() => assertRegaugePilotMissionPolicy(db, {
      ...claim,
      observedAt: "2026-08-25T00:00:01.000Z",
    })).toThrow("mission_policy_envelope_missing");
    expect(listMissionExceptions(db, "t1", "m1")).toHaveLength(1);
  });
});
