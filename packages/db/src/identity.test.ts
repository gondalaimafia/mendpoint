import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDb,
  getTenantMembership,
  putTenantMembership,
  setTenantMembershipStatus,
  type AppDb,
} from "./index.js";

const dirs: string[] = [];
const dbs: AppDb[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.raw.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function testDb(): AppDb {
  const dir = mkdtempSync(join(tmpdir(), "mendpoint-identity-"));
  dirs.push(dir);
  const db = createDb(join(dir, "identity.sqlite"));
  dbs.push(db);
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
  ).run("tenant-a", "tenant-a", "Tenant A", "2026-08-02T00:00:00.000Z");
  db.raw.prepare(
    `INSERT INTO tenants (id, slug, name, plan, billing_status, seat_limit, created_at)
     VALUES (?, ?, ?, 'enterprise', 'active', 20, ?)`,
  ).run("tenant-b", "tenant-b", "Tenant B", "2026-08-02T00:00:00.000Z");
  return db;
}

describe("tenant identity memberships", () => {
  it("looks up an active membership only inside the asserted tenant", () => {
    const db = testDb();
    putTenantMembership(db, {
      tenantId: "tenant-a",
      issuer: "https://id.example.com",
      subject: "user-123",
      email: "owner@example.com",
      displayName: "Tenant Owner",
      role: "owner",
      status: "active",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(
      getTenantMembership(db, "tenant-a", "https://id.example.com", "user-123"),
    ).toMatchObject({
      tenant_id: "tenant-a",
      email: "owner@example.com",
      role: "owner",
      status: "active",
    });
    expect(
      getTenantMembership(db, "tenant-b", "https://id.example.com", "user-123"),
    ).toBeUndefined();
  });

  it("fails closed after a member is offboarded and permits an explicit reactivation", () => {
    const db = testDb();
    const input = {
      tenantId: "tenant-a",
      issuer: "https://id.example.com",
      subject: "user-123",
      email: null,
      displayName: "Reviewer",
      role: "engineer" as const,
      status: "active" as const,
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    putTenantMembership(db, input);

    expect(
      setTenantMembershipStatus(db, {
        tenantId: input.tenantId,
        issuer: input.issuer,
        subject: input.subject,
        status: "offboarded",
        updatedAt: "2026-08-02T01:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      getTenantMembership(db, input.tenantId, input.issuer, input.subject),
    ).toMatchObject({
      status: "offboarded",
      offboarded_at: "2026-08-02T01:00:00.000Z",
    });

    expect(
      setTenantMembershipStatus(db, {
        tenantId: input.tenantId,
        issuer: input.issuer,
        subject: input.subject,
        status: "active",
        updatedAt: "2026-08-02T00:30:00.000Z",
      }),
    ).toBe(false);
    expect(
      getTenantMembership(db, input.tenantId, input.issuer, input.subject),
    ).toMatchObject({ status: "offboarded" });

    putTenantMembership(db, {
      ...input,
      status: "active",
      updatedAt: "2026-08-02T02:00:00.000Z",
    });
    expect(
      getTenantMembership(db, input.tenantId, input.issuer, input.subject),
    ).toMatchObject({ status: "active", offboarded_at: null });
  });

  it("rejects invalid roles and nonexistent tenants", () => {
    const db = testDb();
    const base = {
      tenantId: "tenant-a",
      issuer: "https://id.example.com",
      subject: "user-123",
      email: null,
      displayName: "Reviewer",
      status: "active" as const,
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(() => putTenantMembership(db, { ...base, role: "root" as never })).toThrow(
      "tenant_membership_role_invalid",
    );
    expect(() =>
      putTenantMembership(db, { ...base, tenantId: "tenant-missing", role: "viewer" }),
    ).toThrow();
  });
});
