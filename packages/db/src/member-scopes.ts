/**
 * Repository- and environment-scoped access for a tenant membership (S3-rbac).
 *
 * A membership already carries an RBAC role (see identity.ts). This table lets an
 * admin FURTHER narrow a member to specific repositories and/or environments —
 * least privilege on top of the role, never a widening. A scope row is a positive
 * allow-list entry: with NO rows of a given type the member keeps their role's full
 * reach for that dimension; with one or more rows the member is confined to the
 * intersection of those values with what the tenant actually has (real repositories,
 * declared config environments). The intersection is computed at the enforcement
 * seam (see apps/api access-scope resolver); this module only stores and lists.
 *
 * Every field is validated fail-closed and every row is tenant-scoped. Grants are
 * idempotent per (tenant, member, scope_type, scope_value) so re-granting the same
 * scope never duplicates or errors.
 */
import type { AppDb } from "./index.js";
import type { MemberScopeRow, MemberScopeType } from "./schema.js";

const MEMBER_SCOPE_TYPES = new Set<MemberScopeType>(["repository", "environment"]);

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

function scopeType(value: unknown): MemberScopeType {
  if (typeof value !== "string" || !MEMBER_SCOPE_TYPES.has(value as MemberScopeType)) {
    throw new Error("member_scope_type_invalid");
  }
  return value as MemberScopeType;
}

function scopeValue(value: string): string {
  const normalized = required("member_scope_value", value);
  if (normalized.length > 512) throw new Error("member_scope_value_invalid");
  return normalized;
}

function scope(
  db: AppDb,
  tenantId: string,
  issuer: string,
  subject: string,
  type: MemberScopeType,
  value: string,
): MemberScopeRow | undefined {
  return db.raw
    .prepare(
      `SELECT * FROM tenant_member_scopes
       WHERE tenant_id = ? AND issuer = ? AND subject = ?
         AND scope_type = ? AND scope_value = ?`,
    )
    .get(tenantId, issuer, subject, type, value) as MemberScopeRow | undefined;
}

/**
 * Grant a repository/environment scope to a member. Idempotent: re-granting the
 * same (tenant, member, type, value) returns the existing row unchanged.
 */
export function grantMemberScope(
  db: AppDb,
  input: {
    id: string;
    tenantId: string;
    issuer: string;
    subject: string;
    scopeType: MemberScopeType;
    scopeValue: string;
    createdBy: string;
    createdAt: string;
  },
): MemberScopeRow {
  const id = required("member_scope_id", input.id);
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const type = scopeType(input.scopeType);
  const value = scopeValue(input.scopeValue);
  const createdBy = required("member_scope_created_by", input.createdBy);
  const createdAt = timestamp("member_scope_created_at", input.createdAt);
  db.raw
    .prepare(
      `INSERT INTO tenant_member_scopes
         (id, tenant_id, issuer, subject, scope_type, scope_value, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tenant_id, issuer, subject, scope_type, scope_value) DO NOTHING`,
    )
    .run(id, tenantId, issuer, subject, type, value, createdAt, createdBy);
  return scope(db, tenantId, issuer, subject, type, value)!;
}

/** Revoke a single scope. Returns true when a row was removed, false when absent. */
export function revokeMemberScope(
  db: AppDb,
  input: {
    tenantId: string;
    issuer: string;
    subject: string;
    scopeType: MemberScopeType;
    scopeValue: string;
  },
): boolean {
  const tenantId = required("tenant_id", input.tenantId);
  const issuer = required("membership_issuer", input.issuer);
  const subject = required("membership_subject", input.subject);
  const type = scopeType(input.scopeType);
  const value = scopeValue(input.scopeValue);
  const result = db.raw
    .prepare(
      `DELETE FROM tenant_member_scopes
       WHERE tenant_id = ? AND issuer = ? AND subject = ?
         AND scope_type = ? AND scope_value = ?`,
    )
    .run(tenantId, issuer, subject, type, value);
  return result.changes === 1;
}

/** Every scope for one member, tenant-scoped, deterministically ordered. */
export function listMemberScopes(
  db: AppDb,
  tenantId: string,
  issuer: string,
  subject: string,
): MemberScopeRow[] {
  return db.raw
    .prepare(
      `SELECT * FROM tenant_member_scopes
       WHERE tenant_id = ? AND issuer = ? AND subject = ?
       ORDER BY scope_type, scope_value`,
    )
    .all(
      required("tenant_id", tenantId),
      required("membership_issuer", issuer),
      required("membership_subject", subject),
    ) as MemberScopeRow[];
}

/** Every scope for the whole tenant, for admin listing/audit. */
export function listTenantMemberScopes(db: AppDb, tenantId: string): MemberScopeRow[] {
  return db.raw
    .prepare(
      `SELECT * FROM tenant_member_scopes
       WHERE tenant_id = ?
       ORDER BY issuer, subject, scope_type, scope_value`,
    )
    .all(required("tenant_id", tenantId)) as MemberScopeRow[];
}
