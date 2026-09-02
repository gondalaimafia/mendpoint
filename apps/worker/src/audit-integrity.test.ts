import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuditLegalHold,
  createDb,
  insertTenant,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import {
  clearAlerts,
  recentAlerts,
  setAlertPersistPath,
} from "@mendpoint/platform";
import { checkAuditIntegrityForAllTenants } from "./audit-integrity.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-01T12:00:00.000Z";

afterEach(() => {
  clearAlerts();
  setAlertPersistPath(null);
  while (dbs.length) dbs.pop()?.raw.close?.();
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function setup(): { db: AppDb; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-audit-integrity-"));
  dirs.push(dir);
  // Keep alert persistence off the shared data path during tests.
  setAlertPersistPath(join(dir, "alerts.jsonl"));
  clearAlerts({ wipeFile: true });
  const db = createDb(join(dir, "audit.sqlite"));
  dbs.push(db);
  for (const [id, slug] of [
    ["tenant-a", "a"],
    ["tenant-b", "b"],
  ]) {
    insertTenant(db, { id, slug, name: id, createdAt: at });
  }
  return { db, dir };
}

describe("checkAuditIntegrityForAllTenants", () => {
  it("reports ok and emits no alert when every chain is intact", () => {
    const { db } = setup();
    recordAudit(db, {
      id: "audit-a1",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
      metadata: { verdict: "passed" },
    });
    recordAudit(db, {
      id: "audit-b1",
      tenantId: "tenant-b",
      actor: "test",
      action: "candidate.delivered",
      resourceType: "candidate",
      resourceId: "candidate-b",
    });

    const summary = checkAuditIntegrityForAllTenants(db);

    expect(summary.ok).toBe(true);
    expect(summary.broken).toEqual([]);
    expect(summary.tenantsChecked).toBeGreaterThanOrEqual(2);
    expect(recentAlerts()).toHaveLength(0);
  });

  it("detects a tampered chain and emits a critical alert", () => {
    const { db } = setup();
    recordAudit(db, {
      id: "audit-a1",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
      metadata: { verdict: "passed" },
    });
    recordAudit(db, {
      id: "audit-a2",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.delivered",
      resourceType: "candidate",
      resourceId: "candidate-a",
    });
    recordAudit(db, {
      id: "audit-b1",
      tenantId: "tenant-b",
      actor: "test",
      action: "candidate.delivered",
      resourceType: "candidate",
      resourceId: "candidate-b",
    });

    // Tamper: the audit log is append-only, so a tamper must first defeat the
    // trigger. Mutating a committed row breaks the recomputed hash chain.
    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw
      .prepare("UPDATE audit_events SET action = 'forged' WHERE id = 'audit-a2'")
      .run();

    const summary = checkAuditIntegrityForAllTenants(db);

    expect(summary.ok).toBe(false);
    expect(summary.tenantsChecked).toBeGreaterThanOrEqual(2);
    expect(summary.broken).toHaveLength(1);
    expect(summary.broken[0]).toMatchObject({
      tenantId: "tenant-a",
      error: "audit_chain_hash:audit-a2",
    });

    const alerts = recentAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "critical",
      source: "audit-integrity",
      tenantId: "tenant-a",
    });
    expect(alerts[0].message).toContain("tenant-a");
  });

  it("detects a tampered governance chain and emits a critical alert", () => {
    const { db } = setup();
    createAuditLegalHold(db, {
      id: "hold-event-a1",
      holdId: "hold-a",
      tenantId: "tenant-a",
      reason: "customer legal request",
      resourceType: "candidate",
      resourceId: "candidate-a",
      actorId: "owner-a",
      idempotencyKey: "hold-key-a1",
      createdAt: at,
    });

    db.raw.exec("DROP TRIGGER audit_legal_hold_events_append_only_update");
    db.raw
      .prepare("UPDATE audit_legal_hold_events SET reason = 'forged' WHERE id = 'hold-event-a1'")
      .run();

    const summary = checkAuditIntegrityForAllTenants(db);

    expect(summary.ok).toBe(false);
    expect(summary.broken).toEqual([
      expect.objectContaining({
        tenantId: "tenant-a",
        error: "audit_hold_chain_invalid:hold-event-a1",
      }),
    ]);
    expect(recentAlerts()).toEqual([
      expect.objectContaining({
        severity: "critical",
        source: "audit-integrity",
        tenantId: "tenant-a",
      }),
    ]);
  });
  it("reads the governance chain even when the base chain is already broken", () => {
    const { db } = setup();
    recordAudit(db, {
      id: "audit-a1",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
    });
    recordAudit(db, {
      id: "audit-a2",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.delivered",
      resourceType: "candidate",
      resourceId: "candidate-a",
    });
    createAuditLegalHold(db, {
      id: "hold-event-a1",
      holdId: "hold-a",
      tenantId: "tenant-a",
      reason: "customer legal request",
      eventIds: ["audit-a1"],
      actorId: "owner-a",
      idempotencyKey: "hold-key-a1",
      createdAt: at,
    });

    // Break both chains for the same tenant. The base break used to short-circuit
    // the governance sweep, which then reported ok while never having read it.
    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw.prepare("UPDATE audit_events SET action = 'forged' WHERE id = 'audit-a2'").run();
    db.raw.exec("DROP TRIGGER audit_legal_hold_events_append_only_update");
    db.raw.prepare("UPDATE audit_legal_hold_events SET reason = 'forged' WHERE id = 'hold-event-a1'").run();

    const summary = checkAuditIntegrityForAllTenants(db);

    expect(summary.ok).toBe(false);
    expect(summary.broken).toHaveLength(1);
    expect(summary.broken[0]).toMatchObject({
      tenantId: "tenant-a",
      error: "audit_chain_hash:audit-a2",
      sourceChainOk: false,
      governanceChainOk: false,
    });
    expect(recentAlerts()[0]?.message).toContain("governance=broken");
  });

  it("distinguishes a verified-clean governance chain from a broken source chain", () => {
    const { db } = setup();
    recordAudit(db, {
      id: "audit-a1",
      tenantId: "tenant-a",
      actor: "test",
      action: "candidate.verified",
      resourceType: "candidate",
      resourceId: "candidate-a",
    });
    createAuditLegalHold(db, {
      id: "hold-event-a1",
      holdId: "hold-a",
      tenantId: "tenant-a",
      reason: "customer legal request",
      eventIds: ["audit-a1"],
      actorId: "owner-a",
      idempotencyKey: "hold-key-a1",
      createdAt: at,
    });
    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw.prepare("UPDATE audit_events SET action = 'forged' WHERE id = 'audit-a1'").run();

    const summary = checkAuditIntegrityForAllTenants(db);

    expect(summary.broken[0]).toMatchObject({
      tenantId: "tenant-a",
      sourceChainOk: false,
      governanceChainOk: true,
    });
    expect(recentAlerts()[0]?.message).toContain("governance=verified");
  });
});
