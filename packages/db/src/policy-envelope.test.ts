import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  getMissionPolicyEnvelope,
  getPolicyEnvelope,
  insertPrincipal,
  listMissionPolicyEvaluations,
  recordMissionPolicyEvaluation,
  type AppDb,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-policy-envelope-"));
  const db = createDb(join(dir, "pe.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, '2026-01-01T00:00:00.000Z'),
           ('t2', 'two', 'Two', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`).run();
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: "2026-01-01T00:00:00.000Z" });
  return db;
}
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const bodyV1 = JSON.stringify({ version: 1, residency: "us", riskCeiling: "high" });

function fettlerMission(db: AppDb, id = "m1") {
  return createMission(db, { id, tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate consumers off v1", ownerPrincipalId: "p1", eventId: `event-${id}`,
    idempotencyKey: `create-${id}`, correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}

describe("policy envelope store", () => {
  it("persists a version and is idempotent on byte-identical content", () => {
    const db = fixture();
    const first = createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1",
      envelopeJson: bodyV1, createdAt: "2026-01-02T00:00:00.000Z" });
    const again = createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1",
      envelopeJson: bodyV1, createdAt: "2026-01-03T00:00:00.000Z" });
    expect(again.contentSha256).toBe(first.contentSha256);
    expect(getPolicyEnvelope(db, "t1", 1)?.envelopeJson).toBe(bodyV1);
  });

  it("fails closed when a version is re-created with different content", () => {
    const db = fixture();
    createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1", envelopeJson: bodyV1,
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(() => createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1",
      envelopeJson: JSON.stringify({ version: 1, residency: "eu" }), createdAt: "2026-01-02T00:00:00.000Z" }))
      .toThrow("policy_envelope_version_conflict");
  });

  it("is immutable: a direct UPDATE is rejected by trigger", () => {
    const db = fixture();
    createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1", envelopeJson: bodyV1,
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(() => db.raw.prepare(`UPDATE policy_envelopes SET envelope_json = '{}' WHERE tenant_id = 't1' AND version = 1`).run())
      .toThrow("policy_envelope_immutable");
  });

  it("is tenant-scoped: t2 cannot read t1's envelope", () => {
    const db = fixture();
    createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1", envelopeJson: bodyV1,
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(getPolicyEnvelope(db, "t2", 1)).toBeUndefined();
  });
});

describe("mission policy envelope inheritance", () => {
  it("has no inherited envelope before binding", () => {
    const db = fixture();
    fettlerMission(db);
    expect(getMissionPolicyEnvelope(db, "t1", "m1")).toBeNull();
  });

  it("refuses to bind a mission to a policy version that is not retained", () => {
    const db = fixture();
    fettlerMission(db);
    expect(() => bindMissionToPolicyEnvelope(db, { tenantId: "t1", missionId: "m1", version: 9,
      actorPrincipalId: "p1", eventId: "pe-x", idempotencyKey: "pe-x", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_policy_envelope_not_found");
  });

  it("binds a retained envelope and reads the exact envelope back through the mission", () => {
    const db = fixture();
    fettlerMission(db);
    createPolicyEnvelope(db, { tenantId: "t1", version: 1, policyEnvelopeId: "pe-1", envelopeJson: bodyV1,
      createdAt: "2026-01-02T00:00:00.000Z" });
    const bound = bindMissionToPolicyEnvelope(db, { tenantId: "t1", missionId: "m1", version: 1,
      actorPrincipalId: "p1", eventId: "pe-bind", idempotencyKey: "pe-bind", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    expect(bound.policyEnvelopeVersion).toBe("1");
    const inherited = getMissionPolicyEnvelope(db, "t1", "m1");
    expect(inherited?.version).toBe(1);
    expect(inherited?.envelopeJson).toBe(bodyV1);
  });
});

describe("mission policy evaluation evidence", () => {
  const at = "2026-01-02T00:00:00.000Z";
  const taskDigest = "a".repeat(64);

  it("appends an evaluation on a pre-change database that lacked the table", () => {
    const db = fixture();
    fettlerMission(db);
    expect(db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mission_policy_evaluations'`,
    ).get()).toBeUndefined();
    const recorded = recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "m1", envelopeVersion: null, status: "no_envelope",
      allowed: null, reviewRequired: null, violations: [], taskDigest, createdAt: at,
    });
    expect(recorded.status).toBe("no_envelope");
    expect(listMissionPolicyEvaluations(db, "t1", "m1")).toEqual([recorded]);
  });

  it("is idempotent on identical bytes and immutable afterwards", () => {
    const db = fixture();
    fettlerMission(db);
    const first = recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "m1", envelopeVersion: 1, status: "enforced",
      allowed: false, reviewRequired: true,
      violations: [{ code: "deployment_forbidden", detail: "deployment" }],
      taskDigest, createdAt: at,
    });
    const again = recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "m1", envelopeVersion: 1, status: "enforced",
      allowed: false, reviewRequired: true,
      violations: [{ code: "deployment_forbidden", detail: "deployment" }],
      taskDigest, createdAt: at,
    });
    expect(again.id).toBe(first.id);
    expect(listMissionPolicyEvaluations(db, "t1", "m1")).toHaveLength(1);
    expect(() => db.raw.prepare(`DELETE FROM mission_policy_evaluations WHERE id = ?`).run(first.id))
      .toThrow("mission_policy_evaluation_immutable");
  });

  it("is tenant-scoped: t2 cannot list t1 evaluations", () => {
    const db = fixture();
    fettlerMission(db);
    recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "m1", envelopeVersion: null, status: "no_envelope",
      allowed: null, reviewRequired: null, violations: [], taskDigest, createdAt: at,
    });
    expect(listMissionPolicyEvaluations(db, "t2", "m1")).toEqual([]);
  });

  it("fails closed when the mission row is missing", () => {
    const db = fixture();
    expect(() => recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "missing", envelopeVersion: null, status: "no_envelope",
      allowed: null, reviewRequired: null, violations: [], taskDigest, createdAt: at,
    })).toThrow("mission_policy_evaluation_mission_not_found");
  });

  it("fails closed when an enforced row omits the decision fields", () => {
    const db = fixture();
    fettlerMission(db);
    expect(() => recordMissionPolicyEvaluation(db, {
      tenantId: "t1", missionId: "m1", envelopeVersion: null, status: "enforced",
      allowed: null, reviewRequired: null, violations: [], taskDigest, createdAt: at,
    })).toThrow("mission_policy_evaluation_enforced_fields_required");
  });
});
