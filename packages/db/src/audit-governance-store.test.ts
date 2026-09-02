import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAuditExportManifest,
  createAuditLegalHold,
  createDb,
  getAuditExportManifest,
  insertTenant,
  listAuditExportDestinations,
  listAuditLegalHolds,
  listAuditRetentionDecisions,
  recordAudit,
  registerAuditExportDestination,
  releaseAuditLegalHold,
  revokeAuditExportDestination,
  verifyStoredAuditExport,
  verifyAuditGovernanceIntegrity,
  type AppDb,
} from "./index.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const at = "2026-08-30T12:00:00.000Z";

afterEach(() => {
  while (dbs.length) dbs.pop()?.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(): { db: AppDb; path: string } {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-audit-governance-"));
  roots.push(root);
  const path = join(root, "app.sqlite");
  const db = createDb(path);
  dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: at });
  insertTenant(db, { id: "tenant-b", slug: "tenant-b", name: "Tenant B", createdAt: at });
  recordAudit(db, {
    id: "audit-a-1",
    tenantId: "tenant-a",
    actor: "api",
    principalId: "human:owner-a",
    action: "repository.connected",
    resourceType: "repository",
    resourceId: "repo-a",
    metadata: { token: "must-not-export", note: "safe" },
  });
  recordAudit(db, {
    id: "audit-b-1",
    tenantId: "tenant-b",
    actor: "api",
    principalId: "human:owner-b",
    action: "repository.connected",
    resourceType: "repository",
    resourceId: "repo-b",
  });
  return { db, path };
}

describe("durable audit governance", () => {
  it("creates and releases an append-only legal hold with exact idempotent replay", () => {
    const { db } = fixture();
    const input = {
      id: "hold-event-1",
      holdId: "hold-1",
      tenantId: "tenant-a",
      reason: "customer dispute",
      eventIds: ["audit-a-1"],
      actorId: "human:owner-a",
      idempotencyKey: "hold-create-1",
      createdAt: at,
    } as const;
    const created = createAuditLegalHold(db, input);
    expect(createAuditLegalHold(db, { ...input, id: "ignored-on-replay" })).toEqual(created);
    expect(() => createAuditLegalHold(db, { ...input, reason: "different" })).toThrow(
      "audit_hold_idempotency_conflict",
    );
    expect(() => createAuditLegalHold(db, {
      ...input,
      id: "hold-event-cross",
      holdId: "hold-cross",
      idempotencyKey: "hold-cross",
      eventIds: ["audit-b-1"],
    })).toThrow("audit_hold_event_not_found");
    expect(listAuditRetentionDecisions(db, "tenant-a", "2035-08-30T13:00:00.000Z"))
      .toEqual([expect.objectContaining({
        recordId: "audit-a-1",
        disposition: "retain",
        reason: "legal_hold",
      })]);

    const released = releaseAuditLegalHold(db, {
      id: "hold-event-2",
      holdId: "hold-1",
      tenantId: "tenant-a",
      reason: "matter closed",
      actorId: "human:owner-a",
      idempotencyKey: "hold-release-1",
      createdAt: "2026-08-30T13:00:00.000Z",
    });
    expect(released.sequence).toBe(2);
    expect(released.previous_hash).toBe(created.event_hash);
    expect(listAuditLegalHolds(db, "tenant-a")).toEqual([released]);
    expect(listAuditLegalHolds(db, "tenant-b")).toEqual([]);
    expect(listAuditRetentionDecisions(db, "tenant-a", "2035-08-30T13:00:00.000Z"))
      .toEqual([expect.objectContaining({
        recordId: "audit-a-1",
        disposition: "eligible_for_deletion",
      })]);
    expect(() => db.raw.prepare("UPDATE audit_legal_hold_events SET reason = 'forged'").run())
      .toThrow("audit_legal_hold_events_append_only");
    expect(verifyAuditGovernanceIntegrity(db, "tenant-a")).toEqual({ ok: true, checked: 2 });
  });

  it("detects governance-chain tampering after immutable controls are defeated", () => {
    const { db } = fixture();
    createAuditLegalHold(db, {
      id: "hold-event-1",
      holdId: "hold-1",
      tenantId: "tenant-a",
      reason: "customer dispute",
      eventIds: ["audit-a-1"],
      actorId: "human:owner@example.com",
      idempotencyKey: "hold-create-1",
      createdAt: at,
    });
    db.raw.exec("DROP TRIGGER audit_legal_hold_events_append_only_update");
    db.raw.prepare("UPDATE audit_legal_hold_events SET reason = 'forged' WHERE id = 'hold-event-1'").run();
    expect(verifyAuditGovernanceIntegrity(db, "tenant-a")).toMatchObject({
      ok: false,
      error: "audit_hold_chain_invalid:hold-event-1",
    });
  });

  it("persists a redacted export and proves both bundle replay and source lineage", () => {
    const { db } = fixture();
    registerAuditExportDestination(db, {
      id: "destination-event-a",
      destinationId: "destination-a",
      tenantId: "tenant-a",
      uri: "customer://tenant-a/security/audit",
      actorId: "human:owner-a",
      idempotencyKey: "destination-create-a",
      createdAt: at,
    });
    registerAuditExportDestination(db, {
      id: "destination-event-b",
      destinationId: "destination-b",
      tenantId: "tenant-b",
      uri: "customer://tenant-b/security/audit",
      actorId: "human:owner-b",
      idempotencyKey: "destination-create-b",
      createdAt: at,
    });
    const input = {
      id: "export-a",
      tenantId: "tenant-a",
      destinationId: "destination-a",
      requestedByActorId: "human:owner-a",
      redactionProfile: "security" as const,
      limit: 100,
      idempotencyKey: "export-create-a",
      createdAt: "2026-08-30T14:00:00.000Z",
    };
    const output = createAuditExportManifest(db, input);
    expect(output.bundle.records.map((record) => record.id)).toEqual(["audit-a-1"]);
    expect(JSON.stringify(output.bundle)).not.toContain("must-not-export");
    expect(verifyStoredAuditExport(db, "tenant-a", "export-a")).toEqual({ ok: true, checked: 1 });
    expect(getAuditExportManifest(db, "tenant-b", "export-a")).toBeUndefined();
    expect(createAuditExportManifest(db, { ...input, id: "ignored-on-replay" })).toEqual(output);
    expect(() => createAuditExportManifest(db, {
      ...input,
      id: "cross-export",
      destinationId: "destination-b",
      idempotencyKey: "cross-export",
    })).toThrow("audit_destination_not_active");
  });

  it("fails replay after source tampering and refuses a revoked destination", () => {
    const { db } = fixture();
    registerAuditExportDestination(db, {
      id: "destination-event-1",
      destinationId: "destination-a",
      tenantId: "tenant-a",
      uri: "s3://tenant-a-audit/export",
      actorId: "human:owner-a",
      idempotencyKey: "destination-create",
      createdAt: at,
    });
    createAuditExportManifest(db, {
      id: "export-a",
      tenantId: "tenant-a",
      destinationId: "destination-a",
      requestedByActorId: "human:owner-a",
      redactionProfile: "minimal",
      limit: 50,
      idempotencyKey: "export-create",
      createdAt: "2026-08-30T14:00:00.000Z",
    });
    revokeAuditExportDestination(db, {
      id: "destination-event-2",
      destinationId: "destination-a",
      tenantId: "tenant-a",
      actorId: "human:owner-a",
      idempotencyKey: "destination-revoke",
      createdAt: "2026-08-30T15:00:00.000Z",
    });
    expect(listAuditExportDestinations(db, "tenant-a")[0]?.status).toBe("revoked");
    expect(() => createAuditExportManifest(db, {
      id: "export-after-revoke",
      tenantId: "tenant-a",
      destinationId: "destination-a",
      requestedByActorId: "human:owner-a",
      redactionProfile: "minimal",
      limit: 50,
      idempotencyKey: "export-after-revoke",
      createdAt: "2026-08-30T16:00:00.000Z",
    })).toThrow("audit_destination_not_active");

    db.raw.exec("DROP TRIGGER audit_events_append_only_update");
    db.raw.prepare("UPDATE audit_events SET action = 'forged' WHERE id = 'audit-a-1'").run();
    expect(verifyStoredAuditExport(db, "tenant-a", "export-a")).toMatchObject({
      ok: false,
      error: "audit_source_integrity_invalid:audit-a-1",
    });
  });

  it("rejects a mismatched customer namespace and detects manifest tampering", () => {
    const { db } = fixture();
    expect(() => registerAuditExportDestination(db, {
      id: "destination-cross",
      destinationId: "destination-cross",
      tenantId: "tenant-a",
      uri: "customer://tenant-b/audit",
      actorId: "human:owner@example.com",
      idempotencyKey: "destination-cross",
      createdAt: at,
    })).toThrow("audit_export_destination_tenant_mismatch");
    registerAuditExportDestination(db, {
      id: "destination-event-a",
      destinationId: "destination-a",
      tenantId: "tenant-a",
      uri: "customer://tenant-a/audit",
      actorId: "human:owner@example.com",
      idempotencyKey: "destination-create-a",
      createdAt: at,
    });
    createAuditExportManifest(db, {
      id: "export-a",
      tenantId: "tenant-a",
      destinationId: "destination-a",
      requestedByActorId: "human:owner@example.com",
      redactionProfile: "minimal",
      limit: 100,
      idempotencyKey: "export-create-a",
      createdAt: "2026-08-30T14:00:00.000Z",
    });
    db.raw.exec("DROP TRIGGER audit_export_manifests_append_only_update");
    db.raw.prepare("UPDATE audit_export_manifests SET requested_by_actor_id = 'human:forged@example.com' WHERE id = 'export-a'").run();
    expect(verifyStoredAuditExport(db, "tenant-a", "export-a")).toMatchObject({
      ok: false,
      error: "audit_export_manifest_mismatch",
    });
  });

  it("converges the governance schema and immutable triggers on reopen", () => {
    const { db, path } = fixture();
    db.raw.close();
    dbs.pop();
    const reopened = createDb(path);
    dbs.push(reopened);
    for (const table of [
      "audit_legal_hold_events",
      "audit_export_destination_events",
      "audit_export_manifests",
    ]) {
      expect(reopened.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
      ).get(table)).toBeTruthy();
      expect(reopened.raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      ).get(`${table}_append_only_update`)).toBeTruthy();
    }
  });
  it("holds an action no classifier pattern recognises under the longest retention", () => {
    const { db } = fixture();
    recordAudit(db, {
      id: "audit-a-unclassified",
      tenantId: "tenant-a",
      actor: "worker",
      action: "widget.frobnicated",
      resourceType: "widget",
      resourceId: "widget-1",
    });
    const row = db.raw.prepare("SELECT created_at FROM audit_events WHERE id = ?")
      .get("audit-a-unclassified") as { created_at: string };
    const occurredAt = Date.parse(row.created_at);
    const decisionAfter = (days: number) =>
      listAuditRetentionDecisions(db, "tenant-a", new Date(occurredAt + days * 86_400_000).toISOString())
        .find((entry) => entry.recordId === "audit-a-unclassified")!;

    // Pins the fall-through class in both directions: day 91 dies if the default
    // becomes "operational" (90 days), day 401 dies if it becomes "security"
    // (400 days), and day 2556 dies if the default stops being 2555 days.
    expect(decisionAfter(91)).toMatchObject({ disposition: "retain", reason: "within_retention" });
    expect(decisionAfter(401)).toMatchObject({ disposition: "retain", reason: "within_retention" });
    expect(decisionAfter(2556)).toMatchObject({
      disposition: "eligible_for_deletion",
      reason: "retention_elapsed",
    });
  });

  it("recomputes the tenant source chain once per sweep however many manifests exist", () => {
    const { db } = fixture();
    registerAuditExportDestination(db, {
      id: "destination-event-cost",
      destinationId: "destination-cost",
      tenantId: "tenant-a",
      uri: "customer://tenant-a/audit",
      actorId: "human:owner-a",
      idempotencyKey: "destination-cost",
      createdAt: at,
    });
    for (const index of [1, 2, 3]) {
      createAuditExportManifest(db, {
        id: `export-cost-${index}`,
        tenantId: "tenant-a",
        destinationId: "destination-cost",
        requestedByActorId: "human:owner-a",
        redactionProfile: "minimal",
        limit: 100,
        idempotencyKey: `export-cost-${index}`,
        createdAt: at,
      });
    }

    const prepared: string[] = [];
    const counted: AppDb = {
      raw: new Proxy(db.raw, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              prepared.push(sql);
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key) as unknown;
          return typeof value === "function"
            ? (value as (...args: unknown[]) => unknown).bind(target)
            : value;
        },
      }),
    };

    expect(verifyAuditGovernanceIntegrity(counted, "tenant-a")).toMatchObject({ ok: true });
    // The sweep cost must not multiply by manifest count: one full-chain scan and
    // no per-record row lookup, with three manifests in the tenant.
    expect(prepared.filter((sql) =>
      sql.includes("FROM audit_events WHERE tenant_id = ? ORDER BY event_sequence")).length).toBe(1);
    expect(prepared.filter((sql) =>
      sql.includes("SELECT event_hash FROM audit_events")).length).toBe(0);
  });
});
