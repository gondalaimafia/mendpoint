import type { AppDb } from "./index.js";
import { createHash } from "node:crypto";
import type { IdentitySessionRow, TenantMembershipRow } from "./schema.js";

const MEMBERSHIP_ROLES = new Set<TenantMembershipRow["role"]>([
  "owner",
  "admin",
  "engineer",
  "viewer",
  "fde",
]);
const MEMBERSHIP_STATUSES = new Set<TenantMembershipRow["status"]>([
  "active",
  "offboarded",
]);

function required(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name}_required`);
  return normalized;
}

function timestamp(name: string, value: string): string {
  const normalized = required(name, value);
  if (
    !Number.isFinite(Date.parse(normalized)) ||
    new Date(normalized).toISOString() !== normalized
  ) {
    throw new Error(`${name}_invalid`);
  }
  return normalized;
}

function membership(
  db: AppDb,
  tenantId: string,
  issuer: string,
  subject: string,
): TenantMembershipRow | undefined {
  return db.raw.prepare(
    `SELECT * FROM tenant_memberships
     WHERE tenant_id = ? AND issuer = ? AND subject = ?`,
  ).get(tenantId, issuer, subject) as TenantMembershipRow | undefined;
}

export function listTenantMemberships(
  db: AppDb,
  tenantId: string,
): TenantMembershipRow[] {
  return db.raw.prepare(
    `SELECT * FROM tenant_memberships
     WHERE tenant_id = ?
     ORDER BY status, role, display_name, issuer, subject`,
  ).all(required("tenant_id", tenantId)) as TenantMembershipRow[];
}

export function countActiveTenantOwners(db: AppDb, tenantId: string): number {
  const row = db.raw.prepare(
    `SELECT COUNT(*) AS count FROM tenant_memberships
     WHERE tenant_id = ? AND role = 'owner' AND status = 'active'`,
  ).get(required("tenant_id", tenantId)) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getTenantMembership(
  db: AppDb,
  tenantId: string,
  issuer: string,
  subject: string,
): TenantMembershipRow | undefined {
  return membership(
    db,
    required("tenant_id", tenantId),
    required("membership_issuer", issuer),
    required("membership_subject", subject),
  );
}

export function putTenantMembership(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    email: string | null;
    displayName: string;
    role: TenantMembershipRow["role"];
    status: TenantMembershipRow["status"];
    updatedAt: string;
  },
): TenantMembershipRow {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const displayName = required("membership_display_name", input.displayName);
  const updatedAt = timestamp("membership_updated_at", input.updatedAt);
  if (!MEMBERSHIP_ROLES.has(input.role)) {
    throw new Error("tenant_membership_role_invalid");
  }
  if (!MEMBERSHIP_STATUSES.has(input.status)) {
    throw new Error("tenant_membership_status_invalid");
  }
  const email = input.email?.trim() || null;
  const offboardedAt = input.status === "offboarded" ? updatedAt : null;

  db.raw.prepare(
    `INSERT INTO tenant_memberships
       (tenant_id, issuer, subject, email, display_name, role, status,
        created_at, updated_at, offboarded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (tenant_id, issuer, subject) DO UPDATE SET
       email = excluded.email,
       display_name = excluded.display_name,
       role = excluded.role,
       status = excluded.status,
       updated_at = excluded.updated_at,
       offboarded_at = excluded.offboarded_at
     WHERE excluded.updated_at > tenant_memberships.updated_at`,
  ).run(
    tenantId,
    issuer,
    subject,
    email,
    displayName,
    input.role,
    input.status,
    updatedAt,
    updatedAt,
    offboardedAt,
  );
  return membership(db, tenantId, issuer, subject)!;
}

export function createTenantMembership(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    email: string | null;
    displayName: string;
    role: TenantMembershipRow["role"];
    createdAt: string;
  },
): TenantMembershipRow {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const displayName = required("membership_display_name", input.displayName);
  const createdAt = timestamp("membership_created_at", input.createdAt);
  if (!MEMBERSHIP_ROLES.has(input.role)) {
    throw new Error("tenant_membership_role_invalid");
  }
  const email = input.email?.trim() || null;
  try {
    db.raw.prepare(
      `INSERT INTO tenant_memberships
         (tenant_id, issuer, subject, email, display_name, role, status,
          created_at, updated_at, offboarded_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
    ).run(
      tenantId,
      issuer,
      subject,
      email,
      displayName,
      input.role,
      createdAt,
      createdAt,
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new Error("tenant_membership_exists");
    }
    throw error;
  }
  return membership(db, tenantId, issuer, subject)!;
}

export function changeTenantMembershipRole(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    role: TenantMembershipRow["role"];
    expectedUpdatedAt: string;
    updatedAt: string;
  },
): TenantMembershipRow | undefined {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const expectedUpdatedAt = timestamp("membership_expected_updated_at", input.expectedUpdatedAt);
  const updatedAt = timestamp("membership_updated_at", input.updatedAt);
  if (!MEMBERSHIP_ROLES.has(input.role)) {
    throw new Error("tenant_membership_role_invalid");
  }
  const result = db.raw.prepare(
    `UPDATE tenant_memberships
     SET role = ?, updated_at = ?
     WHERE tenant_id = ? AND issuer = ? AND subject = ?
       AND status = 'active' AND updated_at = ?`,
  ).run(input.role, updatedAt, tenantId, issuer, subject, expectedUpdatedAt);
  return result.changes === 1 ? membership(db, tenantId, issuer, subject) : undefined;
}

export function offboardTenantMembership(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    expectedUpdatedAt: string;
    updatedAt: string;
  },
): TenantMembershipRow | undefined {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const expectedUpdatedAt = timestamp("membership_expected_updated_at", input.expectedUpdatedAt);
  const updatedAt = timestamp("membership_updated_at", input.updatedAt);
  const result = db.raw.prepare(
    `UPDATE tenant_memberships
     SET status = 'offboarded', updated_at = ?, offboarded_at = ?
     WHERE tenant_id = ? AND issuer = ? AND subject = ?
       AND status = 'active' AND updated_at = ?`,
  ).run(updatedAt, updatedAt, tenantId, issuer, subject, expectedUpdatedAt);
  return result.changes === 1 ? membership(db, tenantId, issuer, subject) : undefined;
}

export function setTenantMembershipStatus(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    status: TenantMembershipRow["status"];
    updatedAt: string;
  },
): boolean {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const updatedAt = timestamp("membership_updated_at", input.updatedAt);
  if (!MEMBERSHIP_STATUSES.has(input.status)) {
    throw new Error("tenant_membership_status_invalid");
  }
  const result = db.raw.prepare(
    `UPDATE tenant_memberships
     SET status = ?, updated_at = ?, offboarded_at = ?
     WHERE tenant_id = ? AND issuer = ? AND subject = ? AND updated_at < ?`,
  ).run(
    input.status,
    updatedAt,
    input.status === "offboarded" ? updatedAt : null,
    tenantId,
    issuer,
    subject,
    updatedAt,
  );
  return result.changes === 1;
}

function sessionById(db: AppDb, tenantId: string, sessionId: string): IdentitySessionRow | undefined {
  return db.raw.prepare(
    "SELECT * FROM identity_sessions WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, sessionId) as IdentitySessionRow | undefined;
}

export function getIdentitySession(
  db: AppDb,
  tenantId: string,
  sessionId: string,
): IdentitySessionRow | undefined {
  return sessionById(
    db,
    required("tenant_id", tenantId),
    required("session_id", sessionId),
  );
}

export function claimIdentitySession(
  db: AppDb,
  input: {
    tenantId: string;
    principalId: string;
    issuer: string;
    subject: string;
    membershipUpdatedAt: string;
    authStrength: string;
    token: string;
    issuedAt: string;
    expiresAt: string;
    observedAt: string;
  },
): IdentitySessionRow {
  const tenantId = required("tenant_id", input.tenantId);
  const principalId = required("principal_id", input.principalId);
  const issuer = required("session_issuer", input.issuer);
  const subject = required("session_subject", input.subject);
  const membershipUpdatedAt = timestamp("session_membership_updated_at", input.membershipUpdatedAt);
  const authStrength = required("session_auth_strength", input.authStrength);
  const issuedAt = timestamp("session_issued_at", input.issuedAt);
  const expiresAt = timestamp("session_expires_at", input.expiresAt);
  const observedAt = timestamp("session_observed_at", input.observedAt);
  if (expiresAt <= issuedAt || observedAt < issuedAt || observedAt >= expiresAt) {
    throw new Error("identity_session_time_invalid");
  }
  const tokenSha256 = createHash("sha256").update(required("session_token", input.token), "utf8").digest("hex");
  const id = `identity-session-${tokenSha256.slice(0, 32)}`;
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const membershipRow = membership(db, tenantId, issuer, subject);
    if (!membershipRow || membershipRow.status !== "active" || membershipRow.updated_at !== membershipUpdatedAt) {
      throw new Error("identity_session_membership_invalid");
    }
    const principal = db.raw.prepare(
      `SELECT id, kind, expires_at, revoked_at FROM principals
       WHERE tenant_id = ? AND id = ? AND kind = 'human'`,
    ).get(tenantId, principalId) as {
      id: string;
      kind: string;
      expires_at: string | null;
      revoked_at: string | null;
    } | undefined;
    if (
      !principal ||
      principal.revoked_at !== null ||
      (principal.expires_at !== null && principal.expires_at <= observedAt)
    ) throw new Error("identity_session_principal_invalid");
    const existing = db.raw.prepare(
      "SELECT * FROM identity_sessions WHERE token_sha256 = ?",
    ).get(tokenSha256) as IdentitySessionRow | undefined;
    if (existing) {
      const sameAuthorityExceptMembership = existing.id === id && existing.tenant_id === tenantId &&
        existing.principal_id === principalId && existing.issuer === issuer &&
        existing.subject === subject && existing.auth_strength === authStrength &&
        existing.issued_at === issuedAt && existing.expires_at === expiresAt;
      if (sameAuthorityExceptMembership && existing.membership_updated_at !== membershipUpdatedAt) {
        throw new Error("identity_session_membership_invalid");
      }
      const exact = existing.id === id && existing.tenant_id === tenantId &&
        existing.principal_id === principalId && existing.issuer === issuer &&
        existing.subject === subject && existing.membership_updated_at === membershipUpdatedAt &&
        existing.auth_strength === authStrength && existing.issued_at === issuedAt &&
        existing.expires_at === expiresAt;
      if (!exact) throw new Error("identity_session_binding_conflict");
      if (existing.revoked_at !== null) throw new Error("identity_session_revoked");
      db.raw.prepare(
        "UPDATE identity_sessions SET last_seen_at = ? WHERE tenant_id = ? AND id = ? AND last_seen_at < ?",
      ).run(observedAt, tenantId, id, observedAt);
    } else {
      db.raw.prepare(
        `INSERT INTO identity_sessions
          (id, tenant_id, principal_id, issuer, subject, membership_updated_at,
           auth_strength, token_sha256, issued_at, expires_at, revoked_at,
           revoked_by_principal_id, revoke_reason, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
      ).run(
        id, tenantId, principalId, issuer, subject, membershipUpdatedAt,
        authStrength, tokenSha256, issuedAt, expiresAt, observedAt, observedAt,
      );
    }
    const row = sessionById(db, tenantId, id)!;
    if (owns) db.raw.exec("COMMIT");
    return row;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function revokeIdentitySession(
  db: AppDb,
  input: {
    tenantId: string;
    sessionId: string;
    actorPrincipalId: string;
    reason: string;
    revokedAt: string;
  },
): IdentitySessionRow | undefined {
  const tenantId = required("tenant_id", input.tenantId);
  const sessionId = required("session_id", input.sessionId);
  const actorPrincipalId = required("principal_id", input.actorPrincipalId);
  const reason = required("session_revoke_reason", input.reason);
  const revokedAt = timestamp("session_revoked_at", input.revokedAt);
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const current = sessionById(db, tenantId, sessionId);
    if (!current) {
      if (owns) db.raw.exec("COMMIT");
      return undefined;
    }
    if (current.revoked_at !== null) {
      if (
        current.revoked_at !== revokedAt ||
        current.revoked_by_principal_id !== actorPrincipalId ||
        current.revoke_reason !== reason
      ) throw new Error("identity_session_revoke_conflict");
      if (owns) db.raw.exec("COMMIT");
      return current;
    }
    const actor = db.raw.prepare(
      `SELECT id FROM principals
       WHERE tenant_id = ? AND id = ? AND created_at <= ? AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(tenantId, actorPrincipalId, revokedAt, revokedAt);
    if (!actor) throw new Error("identity_session_actor_invalid");
    const result = db.raw.prepare(
      `UPDATE identity_sessions
       SET revoked_at = ?, revoked_by_principal_id = ?, revoke_reason = ?
       WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
    ).run(revokedAt, actorPrincipalId, reason, tenantId, sessionId);
    const row = sessionById(db, tenantId, sessionId)!;
    if (result.changes !== 1 && (
      row.revoked_at !== revokedAt ||
      row.revoked_by_principal_id !== actorPrincipalId ||
      row.revoke_reason !== reason
    )) throw new Error("identity_session_revoke_conflict");
    if (owns) db.raw.exec("COMMIT");
    return row;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

export function revokeIdentitySessionsForMember(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    actorPrincipalId: string;
    reason: string;
    revokedAt: string;
  },
): number {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("session_issuer", input.issuer);
  const subject = required("session_subject", input.subject);
  const actorPrincipalId = required("principal_id", input.actorPrincipalId);
  const reason = required("session_revoke_reason", input.reason);
  const revokedAt = timestamp("session_revoked_at", input.revokedAt);
  const actor = db.raw.prepare(
    `SELECT id FROM principals
     WHERE tenant_id = ? AND id = ? AND created_at <= ? AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > ?)`,
  ).get(tenantId, actorPrincipalId, revokedAt, revokedAt);
  if (!actor) throw new Error("identity_session_actor_invalid");
  const result = db.raw.prepare(
    `UPDATE identity_sessions
     SET revoked_at = ?, revoked_by_principal_id = ?, revoke_reason = ?
     WHERE tenant_id = ? AND issuer = ? AND subject = ? AND revoked_at IS NULL`,
  ).run(revokedAt, actorPrincipalId, reason, tenantId, issuer, subject);
  return Number(result.changes);
}
