import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  grantMemberScope,
  listMemberScopes,
  listTenantMemberScopes,
  revokeMemberScope,
  type AppDb,
} from "./index.js";

const NOW = "2026-08-12T00:00:00.000Z";
const ISSUER = "https://id.example.com";
const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDb(): { db: AppDb; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-member-scopes-"));
  dirs.push(dir);
  const file = join(dir, "scopes.sqlite");
  const db = createDb(file);
  dbs.push(db);
  for (const id of ["tenant-a", "tenant-b"]) {
    db.raw
      .prepare(
        `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
         VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
      )
      .run(id, id, id, NOW);
  }
  return { db, file };
}

function grant(db: AppDb, over: Record<string, unknown> = {}) {
  return grantMemberScope(db, {
    id: `scope-${Math.random().toString(16).slice(2)}`,
    tenantId: "tenant-a",
    issuer: ISSUER,
    subject: "member-1",
    scopeType: "repository",
    scopeValue: "acme/api",
    createdBy: "actor-admin",
    createdAt: NOW,
    ...over,
  });
}

describe("tenant member scopes", () => {
  it("grants repository and environment scopes and lists them per member", () => {
    const { db } = testDb();
    grant(db, { scopeType: "repository", scopeValue: "acme/api" });
    grant(db, { scopeType: "environment", scopeValue: "production" });

    const scopes = listMemberScopes(db, "tenant-a", ISSUER, "member-1");
    expect(scopes.map((s) => [s.scope_type, s.scope_value])).toEqual([
      ["environment", "production"],
      ["repository", "acme/api"],
    ]);
    expect(scopes[0].created_by).toBe("actor-admin");
  });

  it("is idempotent per (tenant, member, type, value)", () => {
    const { db } = testDb();
    const first = grant(db, { id: "scope-1" });
    const second = grant(db, { id: "scope-2" });
    expect(second.id).toBe(first.id); // conflict kept the original row
    expect(listMemberScopes(db, "tenant-a", ISSUER, "member-1")).toHaveLength(1);
  });

  it("revokes a single scope and reports absence honestly", () => {
    const { db } = testDb();
    grant(db, { scopeValue: "acme/api" });
    expect(
      revokeMemberScope(db, {
        tenantId: "tenant-a",
        issuer: ISSUER,
        subject: "member-1",
        scopeType: "repository",
        scopeValue: "acme/api",
      }),
    ).toBe(true);
    expect(listMemberScopes(db, "tenant-a", ISSUER, "member-1")).toHaveLength(0);
    expect(
      revokeMemberScope(db, {
        tenantId: "tenant-a",
        issuer: ISSUER,
        subject: "member-1",
        scopeType: "repository",
        scopeValue: "acme/api",
      }),
    ).toBe(false);
  });

  it("never leaks scopes across tenants", () => {
    const { db } = testDb();
    grant(db, { tenantId: "tenant-a", scopeValue: "acme/api" });
    grant(db, { tenantId: "tenant-b", scopeValue: "acme/secret" });
    expect(listTenantMemberScopes(db, "tenant-a").map((s) => s.scope_value)).toEqual([
      "acme/api",
    ]);
    expect(listTenantMemberScopes(db, "tenant-b").map((s) => s.scope_value)).toEqual([
      "acme/secret",
    ]);
  });

  it("fails closed on invalid scope type, blank value, and blank tenant", () => {
    const { db } = testDb();
    expect(() => grant(db, { scopeType: "cluster" as never })).toThrow("member_scope_type_invalid");
    expect(() => grant(db, { scopeValue: "   " })).toThrow("member_scope_value_required");
    expect(() => grant(db, { tenantId: " " })).toThrow("tenant_id_required");
  });

  it("converges on reopen: an existing DB gains the table and keeps rows", () => {
    const { db, file } = testDb();
    grant(db, { scopeValue: "acme/api" });
    db.raw.close();
    dbs.splice(dbs.indexOf(db), 1);

    // Simulate an older DB that predates the table, then reopen (ensureTables reruns).
    const reopened = createDb(file);
    dbs.push(reopened);
    expect(listMemberScopes(reopened, "tenant-a", ISSUER, "member-1")).toHaveLength(1);

    reopened.raw.exec("DROP TABLE tenant_member_scopes");
    reopened.raw.close();
    dbs.splice(dbs.indexOf(reopened), 1);
    const upgraded = createDb(file);
    dbs.push(upgraded);
    // Table recreated idempotently; grant works again against the converged schema.
    grantMemberScope(upgraded, {
      id: "scope-after-upgrade",
      tenantId: "tenant-a",
      issuer: ISSUER,
      subject: "member-1",
      scopeType: "environment",
      scopeValue: "staging",
      createdBy: "actor-admin",
      createdAt: NOW,
    });
    expect(listMemberScopes(upgraded, "tenant-a", ISSUER, "member-1").map((s) => s.scope_value)).toEqual([
      "staging",
    ]);
  });
});
