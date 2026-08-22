import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindMissionGraphVersion,
  bindMissionPolicyEnvelopeVersion,
  createDb,
  createMission,
  createWardenCampaign,
  getMission,
  insertPrincipal,
  linkFettlerCampaignToMission,
  linkRegaugeCampaignToMission,
  listDomainEvents,
  resolveMissionForFettlerCampaign,
  resolveMissionForRegaugeCampaign,
  transitionMission,
  verifyDomainEventIntegrity,
  type AppDb,
  type MissionState,
} from "./index.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-"));
  const db = createDb(join(dir, "mission.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, '2026-01-01T00:00:00.000Z'),
           ('t2', 'two', 'Two', 'team', 'active', 10, '2026-01-01T00:00:00.000Z')`).run();
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: "2026-01-01T00:00:00.000Z" });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com",
    displayName: "Two", createdAt: "2026-01-01T00:00:00.000Z" });
  return db;
}
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fettlerMission(db: AppDb, id = "m-fettler") {
  return createMission(db, { id, tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate consumers off v1", ownerPrincipalId: "p1", eventId: `event-${id}`,
    idempotencyKey: `create-${id}`, correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}
function regaugeMission(db: AppDb, id = "m-regauge") {
  return createMission(db, { id, tenantId: "t1", product: "regauge", triggerKind: "migration_objective",
    objective: "Runtime upgrade to Python 3.12", ownerPrincipalId: "p1", eventId: `event-${id}`,
    idempotencyKey: `create-${id}`, correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}
function move(db: AppDb, id: string, revision: number, to: MissionState) {
  return transitionMission(db, { tenantId: "t1", missionId: id, expectedRevision: revision, to,
    actorPrincipalId: "p1", eventId: `event-${id}-${to}`, idempotencyKey: `move-${id}-${to}`,
    correlationId: "corr", createdAt: `2026-01-02T00:00:0${revision}.000Z` });
}
function wardenCampaign(db: AppDb, id = "campaign") {
  return createWardenCampaign(db, { id, tenantId: "t1", name: "Payments upgrade", ownerPrincipalId: "p1",
    concurrencyLimit: 1, completionPolicy: "all", eventId: `wc-${id}`, idempotencyKey: `wc-${id}`,
    correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" });
}

describe("mission execution-context version binding", () => {
  function bindGraph(db: AppDb, id: string, graphVersionId: string, suffix = "") {
    return bindMissionGraphVersion(db, { tenantId: "t1", missionId: id, graphVersionId,
      actorPrincipalId: "p1", eventId: `gv-${id}${suffix}`, idempotencyKey: `gv-${id}${suffix}`,
      correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" });
  }
  function bindPolicy(db: AppDb, id: string, version: string, suffix = "") {
    return bindMissionPolicyEnvelopeVersion(db, { tenantId: "t1", missionId: id, policyEnvelopeVersion: version,
      actorPrincipalId: "p1", eventId: `pev-${id}${suffix}`, idempotencyKey: `pev-${id}${suffix}`,
      correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" });
  }

  it("defaults both version pins to null on a new mission", () => {
    const db = fixture();
    const created = fettlerMission(db);
    expect(created.graphVersionId).toBeNull();
    expect(created.policyEnvelopeVersion).toBeNull();
  });

  it("pins the graph version set-once, bumps the revision, and emits a domain event", () => {
    const db = fixture();
    fettlerMission(db);
    const bound = bindGraph(db, "m-fettler", "sgv1:abc");
    expect(bound.graphVersionId).toBe("sgv1:abc");
    expect(bound.revision).toBe(2);
    expect(getMission(db, "t1", "m-fettler")?.graphVersionId).toBe("sgv1:abc");
    const events = listDomainEvents(db, "t1", "mission", "m-fettler");
    expect(events.map((e) => e.event_type)).toContain("mission.graph_version_bound");
  });

  it("is idempotent when the same graph version is re-bound and does not bump the revision", () => {
    const db = fixture();
    fettlerMission(db);
    const first = bindGraph(db, "m-fettler", "sgv1:abc");
    const again = bindGraph(db, "m-fettler", "sgv1:abc", "-2");
    expect(again.revision).toBe(first.revision);
    expect(again.graphVersionId).toBe("sgv1:abc");
  });

  it("fails closed when a different graph version is bound after the first", () => {
    const db = fixture();
    fettlerMission(db);
    bindGraph(db, "m-fettler", "sgv1:abc");
    expect(() => bindGraph(db, "m-fettler", "sgv1:def", "-2")).toThrow("mission_graph_version_conflict");
  });

  it("pins the policy envelope version independently of the graph version", () => {
    const db = fixture();
    fettlerMission(db);
    bindGraph(db, "m-fettler", "sgv1:abc");
    const bound = bindPolicy(db, "m-fettler", "policy-v7");
    expect(bound.graphVersionId).toBe("sgv1:abc");
    expect(bound.policyEnvelopeVersion).toBe("policy-v7");
    expect(bound.revision).toBe(3);
    const events = listDomainEvents(db, "t1", "mission", "m-fettler");
    expect(events.map((e) => e.event_type)).toContain("mission.policy_envelope_bound");
  });

  it("fails closed when a different policy envelope version is bound after the first", () => {
    const db = fixture();
    fettlerMission(db);
    bindPolicy(db, "m-fettler", "policy-v7");
    expect(() => bindPolicy(db, "m-fettler", "policy-v8", "-2")).toThrow(
      "mission_policy_envelope_version_conflict",
    );
  });

  it("cannot bind a version onto another tenant's mission", () => {
    const db = fixture();
    fettlerMission(db);
    expect(() =>
      bindMissionGraphVersion(db, { tenantId: "t2", missionId: "m-fettler", graphVersionId: "sgv1:abc",
        actorPrincipalId: "p2", eventId: "gv-x", idempotencyKey: "gv-x", correlationId: "corr",
        createdAt: "2026-01-03T00:00:00.000Z" }),
    ).toThrow("mission_not_found");
  });
});

describe("mission primitive", () => {
  it("creates a mission and records it as CREATED with a domain event", () => {
    const db = fixture();
    const mission = fettlerMission(db);
    expect(mission.state).toBe("created");
    expect(mission.revision).toBe(1);
    expect(mission.product).toBe("fettler");
    expect(getMission(db, "t1", "m-fettler")?.id).toBe("m-fettler");
    const events = listDomainEvents(db, "t1", "mission", "m-fettler");
    expect(events.map((e) => e.event_type)).toContain("mission.created");
  });

  it("is idempotent on the mission id and rejects a conflicting redefinition", () => {
    const db = fixture();
    const first = fettlerMission(db);
    const again = fettlerMission(db);
    expect(again).toEqual(first);
    expect(() => createMission(db, { id: "m-fettler", tenantId: "t1", product: "regauge",
      triggerKind: "migration_objective", objective: "different", ownerPrincipalId: "p1",
      eventId: "e-x", idempotencyKey: "x", correlationId: "corr", createdAt: "2026-01-01T00:00:00.000Z" }))
      .toThrow("mission_id_conflict");
  });

  it("walks the full section 8.6 legal state path", () => {
    const db = fixture();
    fettlerMission(db);
    expect(move(db, "m-fettler", 1, "discovering").state).toBe("discovering");
    expect(move(db, "m-fettler", 2, "scoped").state).toBe("scoped");
    expect(move(db, "m-fettler", 3, "planning").state).toBe("planning");
    expect(move(db, "m-fettler", 4, "executing").state).toBe("executing");
    expect(move(db, "m-fettler", 5, "verifying").state).toBe("verifying");
    expect(move(db, "m-fettler", 6, "awaiting_review").state).toBe("awaiting_review");
    const accepted = move(db, "m-fettler", 7, "accepted");
    expect(accepted.state).toBe("accepted");
    expect(accepted.revision).toBe(8);
    const events = listDomainEvents(db, "t1", "mission", "m-fettler")
      .filter((e) => e.event_type === "mission.transitioned");
    expect(events).toHaveLength(7);
  });

  it("keeps the hash-chained domain_events verifiable across every transition", () => {
    const db = fixture();
    regaugeMission(db);
    expect(verifyDomainEventIntegrity(db, "t1").ok).toBe(true);
    move(db, "m-regauge", 1, "discovering");
    move(db, "m-regauge", 2, "scoped");
    move(db, "m-regauge", 3, "planning");
    move(db, "m-regauge", 4, "executing");
    // The per-tenant prev_hash/event_hash chain must remain intact after the
    // create event plus four transition events.
    const integrity = verifyDomainEventIntegrity(db, "t1");
    expect(integrity.ok).toBe(true);
    const missionEvents = listDomainEvents(db, "t1", "mission", "m-regauge");
    expect(missionEvents.map((e) => e.event_type)).toEqual([
      "mission.created",
      "mission.transitioned",
      "mission.transitioned",
      "mission.transitioned",
      "mission.transitioned",
    ]);
  });

  it("lets Fettler skip planning (scoped -> executing) per section 8.6", () => {
    const db = fixture();
    fettlerMission(db);
    move(db, "m-fettler", 1, "discovering");
    move(db, "m-fettler", 2, "scoped");
    expect(move(db, "m-fettler", 3, "executing").state).toBe("executing");
  });

  it("rejects illegal transitions and preserves state", () => {
    const db = fixture();
    fettlerMission(db);
    // created -> executing is not legal (must discover/scope first).
    expect(() => move(db, "m-fettler", 1, "executing")).toThrow("mission_transition_invalid");
    expect(() => move(db, "m-fettler", 1, "accepted")).toThrow("mission_transition_invalid");
    expect(getMission(db, "t1", "m-fettler")?.state).toBe("created");
    // Terminal states accept no further transitions.
    move(db, "m-fettler", 1, "cancelled");
    expect(() => move(db, "m-fettler", 2, "discovering")).toThrow("mission_transition_invalid");
  });

  it("fences transitions on the expected revision", () => {
    const db = fixture();
    fettlerMission(db);
    move(db, "m-fettler", 1, "discovering");
    expect(() => move(db, "m-fettler", 1, "scoped")).toThrow("mission_revision_conflict");
  });

  it("isolates missions by tenant", () => {
    const db = fixture();
    fettlerMission(db);
    // A different tenant cannot see or move the mission.
    expect(getMission(db, "t2", "m-fettler")).toBeUndefined();
    expect(() => transitionMission(db, { tenantId: "t2", missionId: "m-fettler", expectedRevision: 1,
      to: "discovering", actorPrincipalId: "p2", eventId: "x", idempotencyKey: "x", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_not_found");
    // A foreign-tenant principal acting on the owning tenant is rejected before any work.
    expect(() => transitionMission(db, { tenantId: "t1", missionId: "m-fettler", expectedRevision: 1,
      to: "discovering", actorPrincipalId: "p2", eventId: "y", idempotencyKey: "y", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_principal_tenant_mismatch");
  });

  it("resolves a Fettler campaign to its mission via the same-database FK", () => {
    const db = fixture();
    const mission = fettlerMission(db);
    wardenCampaign(db);
    const linked = linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign",
      missionId: mission.id, actorPrincipalId: "p1", eventId: "link-f", idempotencyKey: "link-f",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(linked.id).toBe(mission.id);
    expect(linked.fettlerCampaignId).toBe("campaign");
    const resolved = resolveMissionForFettlerCampaign(db, "t1", "campaign");
    expect(resolved?.id).toBe(mission.id);
    // The FK is set on the mission row (same-database reference into the stack).
    const row = db.raw.prepare("SELECT fettler_campaign_id FROM mission WHERE id = ?")
      .get(mission.id) as { fettler_campaign_id: string };
    expect(row.fettler_campaign_id).toBe("campaign");
    // Tenant isolation of the resolution.
    expect(resolveMissionForFettlerCampaign(db, "t2", "campaign")).toBeUndefined();
  });

  it("resolves a ReGauge campaign to its mission via the projected reference", () => {
    const db = fixture();
    const mission = regaugeMission(db);
    const linked = linkRegaugeCampaignToMission(db, { tenantId: "t1", missionId: mission.id,
      regaugeCampaignId: "tf-campaign-1", actorPrincipalId: "p1", eventId: "link-r",
      idempotencyKey: "link-r", correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(linked.regaugeCampaignId).toBe("tf-campaign-1");
    const resolved = resolveMissionForRegaugeCampaign(db, "t1", "tf-campaign-1");
    expect(resolved?.id).toBe(mission.id);
    // Tenant isolation of the projection.
    expect(resolveMissionForRegaugeCampaign(db, "t2", "tf-campaign-1")).toBeUndefined();
  });

  it("enforces set-once and product-matched linkage", () => {
    const db = fixture();
    const fmission = fettlerMission(db);
    const rmission = regaugeMission(db);
    wardenCampaign(db);
    // Linking a Fettler campaign to a ReGauge mission is rejected.
    expect(() => linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign",
      missionId: rmission.id, actorPrincipalId: "p1", eventId: "e1", idempotencyKey: "e1",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_product_mismatch");
    // Linking a ReGauge campaign id to a Fettler mission is rejected.
    expect(() => linkRegaugeCampaignToMission(db, { tenantId: "t1", missionId: fmission.id,
      regaugeCampaignId: "tf-x", actorPrincipalId: "p1", eventId: "e2", idempotencyKey: "e2",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_product_mismatch");
    // First Fettler link succeeds; a second, different mission cannot claim the same campaign.
    linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign", missionId: fmission.id,
      actorPrincipalId: "p1", eventId: "e3", idempotencyKey: "e3", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    const other = fettlerMission(db, "m-fettler-2");
    expect(() => linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign",
      missionId: other.id, actorPrincipalId: "p1", eventId: "e4", idempotencyKey: "e4",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_link_conflict");
    // Re-linking the same mission to the same campaign is idempotent.
    expect(linkFettlerCampaignToMission(db, { tenantId: "t1", campaignId: "campaign", missionId: fmission.id,
      actorPrincipalId: "p1", eventId: "e5", idempotencyKey: "e5", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" }).id).toBe(fmission.id);
  });

  it("rejects a cross-tenant Fettler campaign link", () => {
    const db = fixture();
    const mission = fettlerMission(db);
    wardenCampaign(db);
    // Mission belongs to t1; asking as t2 cannot find that mission.
    expect(() => linkFettlerCampaignToMission(db, { tenantId: "t2", campaignId: "campaign",
      missionId: mission.id, actorPrincipalId: "p2", eventId: "e", idempotencyKey: "e",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" })).toThrow("mission_not_found");
  });
});
