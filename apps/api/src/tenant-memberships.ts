import {
  changeTenantMembershipRole,
  countActiveTenantOwners,
  createTenantMembership,
  getTenantMembership,
  listTenantMemberships,
  offboardTenantMembership,
  recordAudit,
  revokeIdentitySessionsForMember,
  type AppDb,
  type TenantMembershipRow,
} from "@mendpoint/db";
import { createHash, randomUUID } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";

const MAX_BODY_BYTES = 32 * 1_024;
const ROLES = new Set<TenantMembershipRow["role"]>([
  "owner",
  "admin",
  "engineer",
  "viewer",
  "fde",
]);

const ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "tenant_membership_authentication_required", publicCode: "unauthorized", status: 401, publicMessage: "Authentication is required", responseShape: "nested" },
  { internalCode: "tenant_membership_manager_required", publicCode: "forbidden", status: 403, publicMessage: "Tenant owner or admin authority is required", responseShape: "nested" },
  { internalCode: "tenant_membership_owner_authority_required", publicCode: "forbidden", status: 403, publicMessage: "Tenant owner authority is required for owner membership changes", responseShape: "nested" },
  { internalCode: "tenant_membership_not_found", status: 404, publicMessage: "Tenant membership was not found", responseShape: "nested" },
  { internalCode: "tenant_membership_bootstrap_exists", status: 409, publicMessage: "Tenant membership bootstrap is already complete", responseShape: "nested" },
  { internalCode: "tenant_membership_exists", status: 409, publicMessage: "Tenant membership already exists", responseShape: "nested" },
  { internalCode: "tenant_membership_version_conflict", status: 409, publicMessage: "Tenant membership changed before this request completed", responseShape: "nested" },
  { internalCode: "tenant_membership_last_owner_required", status: 409, publicMessage: "At least one active tenant owner is required", responseShape: "nested" },
  { internalCode: "tenant_membership_payload_too_large", status: 413, publicMessage: "Tenant membership payload is too large", responseShape: "nested" },
  ...[
    "tenant_membership_content_type_invalid",
    "tenant_membership_payload_invalid",
    "tenant_membership_field_invalid",
    "tenant_membership_issuer_invalid",
    "tenant_membership_subject_invalid",
    "tenant_membership_email_invalid",
    "tenant_membership_display_name_invalid",
    "tenant_membership_role_invalid",
    "tenant_membership_expected_updated_at_invalid",
  ].map((internalCode): PublicErrorRule => ({
    internalCode,
    status: 422,
    publicMessage: "Tenant membership request is invalid",
    responseShape: "nested",
  })),
];

export type TenantMembershipRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => Date;
  createId?: () => string;
}>;

function manager(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal || !trustPrincipalId) throw new Error("tenant_membership_authentication_required");
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("tenant_membership_manager_required");
  }
  return { ...principal, trustPrincipalId };
}

async function jsonBody(c: Context<ApiEnv>, allowed: ReadonlySet<string>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("tenant_membership_content_type_invalid");
  }
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error("tenant_membership_payload_too_large");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new Error("tenant_membership_payload_too_large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("tenant_membership_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("tenant_membership_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("tenant_membership_field_invalid");
  }
  return value;
}

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

function issuer(value: unknown): string {
  const normalized = requiredText(value, "tenant_membership_issuer_invalid", 2_048).replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("tenant_membership_issuer_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.toString().replace(/\/$/, "") !== normalized
  ) throw new Error("tenant_membership_issuer_invalid");
  return normalized;
}

function email(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const normalized = requiredText(value, "tenant_membership_email_invalid", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error("tenant_membership_email_invalid");
  }
  return normalized;
}

function role(value: unknown): TenantMembershipRow["role"] {
  if (typeof value !== "string" || !ROLES.has(value as TenantMembershipRow["role"])) {
    throw new Error("tenant_membership_role_invalid");
  }
  return value as TenantMembershipRow["role"];
}

function expectedUpdatedAt(value: unknown): string {
  const normalized = requiredText(value, "tenant_membership_expected_updated_at_invalid", 64);
  if (!Number.isFinite(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    throw new Error("tenant_membership_expected_updated_at_invalid");
  }
  return normalized;
}

function output(row: TenantMembershipRow) {
  return {
    tenantId: row.tenant_id,
    issuer: row.issuer,
    subject: row.subject,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    offboardedAt: row.offboarded_at,
  };
}

function nextTimestamp(candidate: Date, previous?: string): string {
  const candidateMs = candidate.getTime();
  if (!Number.isFinite(candidateMs)) throw new Error("tenant_membership_expected_updated_at_invalid");
  const previousMs = previous ? Date.parse(previous) : Number.NEGATIVE_INFINITY;
  return new Date(Math.max(candidateMs, previousMs + 1)).toISOString();
}

function identityResourceId(tenantId: string, issuerValue: string, subject: string): string {
  return `membership:${createHash("sha256")
    .update(`${tenantId}\n${issuerValue}\n${subject}`, "utf8")
    .digest("hex")}`;
}

function transaction<T>(db: AppDb, operation: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const value = operation();
    if (owns) db.raw.exec("COMMIT");
    return value;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function audit(
  options: TenantMembershipRoutesOptions,
  c: Context<ApiEnv>,
  actor: ReturnType<typeof manager>,
  action: string,
  row: TenantMembershipRow,
  metadata: Record<string, unknown>,
) {
  recordAudit(options.db, {
    id: (options.createId ?? (() => `membership-audit-${randomUUID()}`))(),
    tenantId: actor.tenantId,
    actor: actor.id,
    principalId: actor.trustPrincipalId,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? null,
    action,
    resourceType: "tenant_membership",
    resourceId: identityResourceId(actor.tenantId, row.issuer, row.subject),
    metadata,
  });
}

function replyError(c: Context<ApiEnv>, error: unknown): Response {
  return mappedErrorResponse(c, error, ERRORS);
}

const CREATE_FIELDS = new Set(["issuer", "subject", "email", "displayName", "role"]);
const BOOTSTRAP_FIELDS = new Set(["issuer", "subject", "email", "displayName"]);
const ROLE_FIELDS = new Set(["issuer", "subject", "role", "expectedUpdatedAt"]);
const OFFBOARD_FIELDS = new Set(["issuer", "subject", "expectedUpdatedAt"]);

export function createTenantMembershipRoutes(options: TenantMembershipRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const now = options.now ?? (() => new Date());

  routes.get("/", (c) => {
    try {
      const actor = manager(c);
      return c.json({ data: listTenantMemberships(options.db, actor.tenantId).map(output) });
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/bootstrap", async (c) => {
    try {
      const actor = manager(c);
      const body = await jsonBody(c, BOOTSTRAP_FIELDS);
      const created = transaction(options.db, () => {
        if (listTenantMemberships(options.db, actor.tenantId).length > 0) {
          throw new Error("tenant_membership_bootstrap_exists");
        }
        const row = createTenantMembership(options.db, {
          tenantId: actor.tenantId,
          issuer: issuer(body.issuer),
          subject: requiredText(body.subject, "tenant_membership_subject_invalid", 512),
          email: email(body.email),
          displayName: requiredText(body.displayName, "tenant_membership_display_name_invalid", 200),
          role: "owner",
          createdAt: nextTimestamp(now()),
        });
        audit(options, c, actor, "tenant_membership.bootstrap", row, { role: row.role, status: row.status });
        return row;
      });
      return c.json({ data: output(created) }, 201);
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/", async (c) => {
    try {
      const actor = manager(c);
      const body = await jsonBody(c, CREATE_FIELDS);
      const requestedRole = role(body.role);
      if (requestedRole === "owner" && actor.role !== "owner") {
        throw new Error("tenant_membership_owner_authority_required");
      }
      const created = transaction(options.db, () => {
        const row = createTenantMembership(options.db, {
          tenantId: actor.tenantId,
          issuer: issuer(body.issuer),
          subject: requiredText(body.subject, "tenant_membership_subject_invalid", 512),
          email: email(body.email),
          displayName: requiredText(body.displayName, "tenant_membership_display_name_invalid", 200),
          role: requestedRole,
          createdAt: nextTimestamp(now()),
        });
        audit(options, c, actor, "tenant_membership.provision", row, { role: row.role, status: row.status });
        return row;
      });
      return c.json({ data: output(created) }, 201);
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.patch("/role", async (c) => {
    try {
      const actor = manager(c);
      const body = await jsonBody(c, ROLE_FIELDS);
      const issuerValue = issuer(body.issuer);
      const subject = requiredText(body.subject, "tenant_membership_subject_invalid", 512);
      const requestedRole = role(body.role);
      const expected = expectedUpdatedAt(body.expectedUpdatedAt);
      const updated = transaction(options.db, () => {
        const current = getTenantMembership(options.db, actor.tenantId, issuerValue, subject);
        if (!current || current.status !== "active") throw new Error("tenant_membership_not_found");
        if ((current.role === "owner" || requestedRole === "owner") && actor.role !== "owner") {
          throw new Error("tenant_membership_owner_authority_required");
        }
        if (current.role === "owner" && requestedRole !== "owner" && countActiveTenantOwners(options.db, actor.tenantId) <= 1) {
          throw new Error("tenant_membership_last_owner_required");
        }
        const row = changeTenantMembershipRole(options.db, {
          tenantId: actor.tenantId,
          issuer: issuerValue,
          subject,
          role: requestedRole,
          expectedUpdatedAt: expected,
          updatedAt: nextTimestamp(now(), current.updated_at),
        });
        if (!row) throw new Error("tenant_membership_version_conflict");
        audit(options, c, actor, "tenant_membership.role_change", row, {
          previousRole: current.role,
          role: row.role,
          status: row.status,
        });
        return row;
      });
      return c.json({ data: output(updated) });
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/offboard", async (c) => {
    try {
      const actor = manager(c);
      const body = await jsonBody(c, OFFBOARD_FIELDS);
      const issuerValue = issuer(body.issuer);
      const subject = requiredText(body.subject, "tenant_membership_subject_invalid", 512);
      const expected = expectedUpdatedAt(body.expectedUpdatedAt);
      const updated = transaction(options.db, () => {
        const current = getTenantMembership(options.db, actor.tenantId, issuerValue, subject);
        if (!current || current.status !== "active") throw new Error("tenant_membership_not_found");
        if (current.role === "owner" && actor.role !== "owner") {
          throw new Error("tenant_membership_owner_authority_required");
        }
        if (current.role === "owner" && countActiveTenantOwners(options.db, actor.tenantId) <= 1) {
          throw new Error("tenant_membership_last_owner_required");
        }
        const row = offboardTenantMembership(options.db, {
          tenantId: actor.tenantId,
          issuer: issuerValue,
          subject,
          expectedUpdatedAt: expected,
          updatedAt: nextTimestamp(now(), current.updated_at),
        });
        if (!row) throw new Error("tenant_membership_version_conflict");
        revokeIdentitySessionsForMember(options.db, {
          tenantId: actor.tenantId,
          issuer: issuerValue,
          subject,
          actorPrincipalId: actor.trustPrincipalId,
          reason: "membership_offboarded",
          revokedAt: row.offboarded_at!,
        });
        audit(options, c, actor, "tenant_membership.offboard", row, {
          previousRole: current.role,
          role: row.role,
          status: row.status,
        });
        return row;
      });
      return c.json({ data: output(updated) });
    } catch (error) {
      return replyError(c, error);
    }
  });

  return routes;
}
