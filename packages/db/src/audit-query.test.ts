import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  exportTenantAuditCsv,
  queryTenantAuditEvents,
  recordAudit,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-audit-query-"));
  dirs.push(dir);
  const db = createDb(join(dir, "audit.sqlite"));
  dbs.push(db);
  return db;
}

function seed(db: AppDb) {
  let n = 0;
  const add = (tenantId: string, actor: string, action: string, resourceType: string) =>
    recordAudit(db, {
      id: `evt-${tenantId}-${++n}`,
      tenantId,
      actor,
      action,
      resourceType,
      resourceId: `${resourceType}-1`,
      metadata: { n },
    });
  add("tenant-a", "human:owner-a", "tenant_membership.provision", "tenant_membership");
  add("tenant-a", "human:admin-a", "member_scope.grant", "member_scope");
  add("tenant-a", "human:owner-a", "member_scope.revoke", "member_scope");
  add("tenant-b", "human:owner-b", "member_scope.grant", "member_scope");
}

describe("tenant audit query", () => {
  it("scopes strictly to one tenant and reports total + chain status", () => {
    const db = testDb();
    seed(db);
    const result = queryTenantAuditEvents(db, "tenant-a");
    expect(result.events).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.events.every((e) => e.tenant_id === "tenant-a")).toBe(true);
    expect(result.chain).toEqual({ ok: true, checked: 3 });
  });

  it("filters by actor, action and resource type", () => {
    const db = testDb();
    seed(db);
    expect(
      queryTenantAuditEvents(db, "tenant-a", { action: "member_scope.grant" }).events.map(
        (e) => e.id,
      ),
    ).toEqual(["evt-tenant-a-2"]);
    expect(
      queryTenantAuditEvents(db, "tenant-a", { actor: "human:owner-a" }).total,
    ).toBe(2);
    expect(
      queryTenantAuditEvents(db, "tenant-a", { resourceType: "member_scope" }).total,
    ).toBe(2);
  });

  it("paginates while keeping total for the filter", () => {
    const db = testDb();
    seed(db);
    const page = queryTenantAuditEvents(db, "tenant-a", { limit: 2, offset: 0 });
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);
  });

  it("fails closed on a blank tenant and an inverted window", () => {
    const db = testDb();
    seed(db);
    expect(() => queryTenantAuditEvents(db, " ")).toThrow("tenant_scope_required");
    expect(() =>
      queryTenantAuditEvents(db, "tenant-a", {
        since: "2026-01-02T00:00:00.000Z",
        until: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("audit_window_invalid");
  });

  it("exports CSV with chain fields and without raw metadata", () => {
    const db = testDb();
    seed(db);
    const csv = exportTenantAuditCsv(queryTenantAuditEvents(db, "tenant-a").events);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "created_at,event_sequence,actor,principal_id,action,resource_type,resource_id,request_id,metadata_sha256,prev_hash,event_hash",
    );
    expect(lines).toHaveLength(4); // header + 3 events
    expect(csv).toContain("member_scope.grant");
    expect(csv).not.toContain('"n"'); // raw metadata JSON is never emitted
  });
});
