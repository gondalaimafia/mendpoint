import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claimIdentitySession,
  createDb,
  getTenantMembership,
  insertPrincipal,
  putTenantMembership,
  revokeIdentitySession,
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

  it("binds durable sessions to the exact tenant principal and immutable membership authority", () => {
    const db = testDb();
    putTenantMembership(db, {
      tenantId: "tenant-a", issuer: "https://id.example.com", subject: "user-123",
      email: "owner@example.com", displayName: "Owner", role: "owner", status: "active",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    insertPrincipal(db, {
      id: "principal-human-a", tenantId: "tenant-a", kind: "human",
      subject: "https://id.example.com|user-123", displayName: "Owner",
      audience: "https://id.example.com", createdAt: "2026-08-02T00:00:00.000Z",
    });
    const session = claimIdentitySession(db, {
      tenantId: "tenant-a", principalId: "principal-human-a", issuer: "https://id.example.com",
      subject: "user-123", membershipUpdatedAt: "2026-08-02T00:00:00.000Z",
      authStrength: "amr:mfa", token: "private-bearer-token",
      issuedAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-02T01:00:00.000Z",
      observedAt: "2026-08-02T00:10:00.000Z",
    });
    expect(JSON.stringify(session)).not.toContain("private-bearer-token");
    expect(() => db.raw.prepare(
      "UPDATE identity_sessions SET subject = 'other' WHERE id = ?",
    ).run(session.id)).toThrow("identity_session_identity_immutable");
    expect(() => db.raw.prepare(
      "UPDATE identity_sessions SET revoked_at = ?, revoked_by_principal_id = ?, revoke_reason = ? WHERE id = ?",
    ).run(
      "2026-08-02T00:20:00.000Z", "principal-human-a", "logout", session.id,
    )).not.toThrow();
    expect(() => db.raw.prepare(
      "UPDATE identity_sessions SET revoke_reason = 'rewritten' WHERE id = ?",
    ).run(session.id)).toThrow("identity_session_revocation_immutable");
    expect(() => db.raw.prepare(
      `INSERT INTO identity_sessions
       (id, tenant_id, principal_id, issuer, subject, membership_updated_at, auth_strength,
        token_sha256, issued_at, expires_at, last_seen_at, created_at)
       VALUES ('cross-tenant', 'tenant-b', 'principal-human-a', 'https://id.example.com',
        'user-123', ?, 'amr:mfa', ?, ?, ?, ?, ?)`,
    ).run(
      "2026-08-02T00:00:00.000Z", "a".repeat(64), "2026-08-02T00:00:00.000Z",
      "2026-08-02T01:00:00.000Z", "2026-08-02T00:10:00.000Z", "2026-08-02T00:10:00.000Z",
    )).toThrow(/FOREIGN KEY/);
  });

  it("requires a current tenant-bound actor when revoking a durable session", () => {
    const db = testDb();
    putTenantMembership(db, {
      tenantId: "tenant-a", issuer: "https://id.example.com", subject: "user-123",
      email: null, displayName: "User", role: "engineer", status: "active",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
    insertPrincipal(db, {
      id: "principal-human-a", tenantId: "tenant-a", kind: "human",
      subject: "https://id.example.com|user-123", displayName: "User",
      audience: "https://id.example.com", createdAt: "2026-08-02T00:00:00.000Z",
    });
    insertPrincipal(db, {
      id: "principal-expired-operator", tenantId: "tenant-a", kind: "service",
      subject: "expired", displayName: "Expired", audience: "mendpoint-scim",
      createdAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-02T00:05:00.000Z",
    });
    const session = claimIdentitySession(db, {
      tenantId: "tenant-a", principalId: "principal-human-a", issuer: "https://id.example.com",
      subject: "user-123", membershipUpdatedAt: "2026-08-02T00:00:00.000Z",
      authStrength: "amr:mfa", token: "private-bearer-token",
      issuedAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-02T01:00:00.000Z",
      observedAt: "2026-08-02T00:10:00.000Z",
    });
    expect(() => revokeIdentitySession(db, {
      tenantId: "tenant-a", sessionId: session.id, actorPrincipalId: "principal-expired-operator",
      reason: "operator_revoke", revokedAt: "2026-08-02T00:10:00.000Z",
    })).toThrow("identity_session_actor_invalid");
    const exact = {
      tenantId: "tenant-a",
      sessionId: session.id,
      actorPrincipalId: "principal-human-a",
      reason: "human_logout",
      revokedAt: "2026-08-02T00:10:00.000Z",
    };
    expect(revokeIdentitySession(db, exact)).toMatchObject({
      revoked_at: exact.revokedAt,
      revoked_by_principal_id: exact.actorPrincipalId,
      revoke_reason: exact.reason,
    });
    expect(revokeIdentitySession(db, exact)).toMatchObject({
      revoked_at: exact.revokedAt,
    });
    expect(() => revokeIdentitySession(db, {
      ...exact,
      reason: "rewritten",
    })).toThrow("identity_session_revoke_conflict");
  });
});
