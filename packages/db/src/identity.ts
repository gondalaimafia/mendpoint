import type { AppDb } from "./index.js";
import type { TenantMembershipRow } from "./schema.js";

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
