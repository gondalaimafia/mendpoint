import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionToPolicyEnvelope,
  createDb,
  createMission,
  createPolicyEnvelope,
  insertPrincipal,
  linkRegaugeCampaignToMission,
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

const claim = {
  tenantId: "t1",
  campaignId: "campaign-a",
  repositoryId: "repo-a",
  externalProcessing: false,
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
  });
});
