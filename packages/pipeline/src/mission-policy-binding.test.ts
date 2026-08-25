import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  createMission,
  getMissionPolicyEnvelope,
  insertPrincipal,
  type AppDb,
} from "@mendpoint/db";
import { parsePolicyEnvelope } from "@mendpoint/policy";
import {
  DEFAULT_POLICY_ENVELOPE_VERSION,
  defaultPolicyEnvelopeId,
  ensureDefaultPolicyEnvelopeBinding,
} from "./mission-policy-binding.js";

const opened: Array<{ db: AppDb; dir: string }> = [];
const at = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-mission-policy-"));
  const db = createDb(join(dir, "mp.sqlite"));
  opened.push({ db, dir });
  db.raw.prepare(`INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
    VALUES ('t1', 'one', 'One', 'team', 'active', 10, ?)`).run(at);
  insertPrincipal(db, { id: "p1", tenantId: "t1", kind: "human", subject: "one@example.com",
    displayName: "One", createdAt: at });
  createMission(db, { id: "m1", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
    objective: "Migrate consumers off v1", ownerPrincipalId: "p1", eventId: "e-m1",
    idempotencyKey: "create-m1", correlationId: "corr", createdAt: at });
  return db;
}

describe("ensureDefaultPolicyEnvelopeBinding", () => {
  it("creates the tenant default envelope and pins it on the mission", () => {
    const db = fixture();
    const bound = ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1", missionId: "m1", actorPrincipalId: "p1", correlationId: "corr", createdAt: at,
    });
    expect(bound.policyEnvelopeVersion).toBe(String(DEFAULT_POLICY_ENVELOPE_VERSION));

    const stored = getMissionPolicyEnvelope(db, "t1", "m1");
    expect(stored).not.toBeNull();
    const envelope = parsePolicyEnvelope(JSON.parse(stored!.envelopeJson));
    expect(envelope.policyEnvelopeId).toBe(defaultPolicyEnvelopeId("t1"));
    // Product-invariant defaults: review-first, no auto-deploy, no training.
    expect(envelope.reviewRequired).toBe(true);
    expect(envelope.deploymentAllowed).toBe(false);
    expect(envelope.trainingDataAllowed).toBe(false);
    // Unrestricted scope so existing execution is not blocked by the default.
    expect(envelope.repositoryScope).toEqual([]);
    expect(envelope.allowedTools).toEqual([]);
  });

  it("is idempotent: repeated binding neither errors nor rewrites the envelope", () => {
    const db = fixture();
    const first = ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1", missionId: "m1", actorPrincipalId: "p1", correlationId: "corr", createdAt: at,
    });
    const second = ensureDefaultPolicyEnvelopeBinding(db, {
      tenantId: "t1", missionId: "m1", actorPrincipalId: "p1", correlationId: "corr", createdAt: at,
    });
    expect(second.policyEnvelopeVersion).toBe(first.policyEnvelopeVersion);
    expect(second.revision).toBe(first.revision);
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM policy_envelopes WHERE tenant_id = 't1'").get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("shares one default envelope across missions in the same tenant", () => {
    const db = fixture();
    createMission(db, { id: "m2", tenantId: "t1", product: "fettler", triggerKind: "provider_change",
      objective: "Second campaign", ownerPrincipalId: "p1", eventId: "e-m2",
      idempotencyKey: "create-m2", correlationId: "corr2", createdAt: at });
    ensureDefaultPolicyEnvelopeBinding(db, { tenantId: "t1", missionId: "m1", actorPrincipalId: "p1", correlationId: "c", createdAt: at });
    ensureDefaultPolicyEnvelopeBinding(db, { tenantId: "t1", missionId: "m2", actorPrincipalId: "p1", correlationId: "c", createdAt: at });
    const rows = db.raw.prepare("SELECT COUNT(*) AS n FROM policy_envelopes WHERE tenant_id = 't1'").get() as { n: number };
    expect(rows.n).toBe(1);
    expect(getMissionPolicyEnvelope(db, "t1", "m1")!.version).toBe(1);
    expect(getMissionPolicyEnvelope(db, "t1", "m2")!.version).toBe(1);
  });
});
