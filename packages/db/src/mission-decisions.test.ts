import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  getActiveMissionDecisions,
  insertPrincipal,
  listDomainEvents,
  listMissionDecisions,
  recordMissionDecision,
  retractMissionDecision,
  supersedeMissionDecision,
  type AppDb,
} from "./index.js";

const T0 = "2026-01-01T00:00:00.000Z";
const opened: Array<{ db: AppDb; dir: string }> = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mdec-"));
  const db = createDb(join(dir, "d.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1','one','One','team','active',10,?), ('t2','two','Two','team','active',10,?)`).run(T0, T0);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com", displayName: "One", createdAt: T0 });
  insertPrincipal(db, { id: "p2", tenantId: "t2", kind: "human", subject: "two@example.com", displayName: "Two", createdAt: T0 });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p1", eventId: "ev-m1", idempotencyKey: "cm-m1", correlationId: "corr", createdAt: T0 });
  createMission(db, { id: "m2", tenantId: "t2", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate off v1", ownerPrincipalId: "p2", eventId: "ev-m2", idempotencyKey: "cm-m2", correlationId: "corr", createdAt: T0 });
  return db;
}

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(db: AppDb, decision: string, at: string, scope = "phase-1") {
  return recordMissionDecision(db, { tenantId: "t1", missionId: "m1", decision, scope,
    authorPrincipalId: "p1", evidence: ["evidence_records:e1"], correlationId: "corr", createdAt: at });
}

describe("mission decision log", () => {
  it("records a decision as active with a domain event and reads it back", () => {
    const db = fixture();
    const d = record(db, "use a compatibility shim for phase 1", T0);
    expect(d.status).toBe("active");
    expect(d.id).toBe(d.contentDigest);
    const active = getActiveMissionDecisions(db, "t1", "m1");
    expect(active.map((x) => x.decision)).toContain("use a compatibility shim for phase 1");
    const events = listDomainEvents(db, "t1", "mission", "m1").map((e) => e.event_type);
    expect(events).toContain("mission.decision_recorded");
  });

  // CONTROL: supersession is a chain, not an overwrite. Deleting this behaviour
  // (or overwriting instead of chaining) fails this test.
  it("keeps a superseded decision readable and the chain intact", () => {
    const db = fixture();
    const first = record(db, "delay the database migration until stage 3", T0);
    const second = supersedeMissionDecision(db, { tenantId: "t1", priorDecisionId: first.id,
      decision: "delay the database migration until stage 5", scope: "phase-1", authorPrincipalId: "p1",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" });
    const all = listMissionDecisions(db, "t1", "m1");
    expect(all).toHaveLength(2);
    const prior = all.find((x) => x.id === first.id)!;
    const successor = all.find((x) => x.id === second.id)!;
    // The prior decision is still fully readable...
    expect(prior.decision).toBe("delay the database migration until stage 3");
    // ...and reads as superseded, pointing at its successor.
    expect(prior.effectiveStatus).toBe("superseded");
    expect(prior.supersededById).toBe(second.id);
    expect(successor.effectiveStatus).toBe("active");
    expect(successor.supersedesId).toBe(first.id);
    // Only the successor still governs.
    expect(getActiveMissionDecisions(db, "t1", "m1").map((x) => x.id)).toEqual([second.id]);
  });

  it("refuses to fork a chain: a decision may be superseded only once", () => {
    const db = fixture();
    const first = record(db, "do not modify generated SDK code", T0);
    supersedeMissionDecision(db, { tenantId: "t1", priorDecisionId: first.id,
      decision: "do not modify generated SDK code except imports", scope: "phase-1", authorPrincipalId: "p1",
      correlationId: "corr", createdAt: "2026-01-02T00:00:00.000Z" });
    expect(() => supersedeMissionDecision(db, { tenantId: "t1", priorDecisionId: first.id,
      decision: "a different replacement", scope: "phase-1", authorPrincipalId: "p1",
      correlationId: "corr", createdAt: "2026-01-03T00:00:00.000Z" })).toThrow(/already_superseded/);
  });

  it("retracts a decision: prior superseded, retraction retracted, neither active", () => {
    const db = fixture();
    const first = record(db, "allow temporary dual-write", T0);
    const retraction = retractMissionDecision(db, { tenantId: "t1", priorDecisionId: first.id,
      rationale: "dual-write proved unsafe", authorPrincipalId: "p1", correlationId: "corr",
      createdAt: "2026-01-02T00:00:00.000Z" });
    const all = listMissionDecisions(db, "t1", "m1");
    expect(all.find((x) => x.id === first.id)!.effectiveStatus).toBe("superseded");
    expect(all.find((x) => x.id === retraction.id)!.effectiveStatus).toBe("retracted");
    expect(getActiveMissionDecisions(db, "t1", "m1")).toHaveLength(0);
  });

  // CONTROL: append-only. Deleting the triggers fails this test.
  it("is append-only: UPDATE and DELETE are rejected", () => {
    const db = fixture();
    const d = record(db, "pin the runtime image", T0);
    expect(() => db.raw.prepare(`UPDATE mission_decisions SET status = 'retracted' WHERE id = ?`).run(d.id))
      .toThrow(/append_only/);
    expect(() => db.raw.prepare(`DELETE FROM mission_decisions WHERE id = ?`).run(d.id))
      .toThrow(/append_only/);
  });

  // CONTROL: cross-tenant read is structurally impossible. Deleting the tenant
  // scope guard, or dropping tenantId from the content digest, fails this test.
  it("makes cross-tenant collision structurally impossible", () => {
    const db = fixture();
    const d1 = record(db, "same words", T0);
    // Identical logical content under t2 yields a DIFFERENT id, because tenant_id
    // is inside the content digest.
    const d2 = recordMissionDecision(db, { tenantId: "t2", missionId: "m2", decision: "same words",
      scope: "phase-1", authorPrincipalId: "p2", evidence: ["evidence_records:e1"], correlationId: "corr", createdAt: T0 });
    expect(d1.id).not.toBe(d2.id);
    // A t1 write cannot bind to t2's mission.
    expect(() => recordMissionDecision(db, { tenantId: "t1", missionId: "m2", decision: "x", scope: "s",
      authorPrincipalId: "p1", correlationId: "corr", createdAt: T0 })).toThrow(/mission_not_found/);
    // A t1 read never sees t2's decision.
    expect(listMissionDecisions(db, "t1", "m1").map((x) => x.id)).not.toContain(d2.id);
  });

  it("detects tampering: a mutated stored digest is rejected on read", () => {
    const db = fixture();
    const d = record(db, "verify tamper", T0);
    // Bypass the append-only trigger via a raw copy to simulate storage corruption.
    db.raw.exec("DROP TRIGGER mission_decisions_no_update");
    db.raw.prepare(`UPDATE mission_decisions SET decision = 'tampered' WHERE id = ?`).run(d.id);
    expect(() => listMissionDecisions(db, "t1", "m1")).toThrow(/mission_decision_corrupt/);
  });
});
