import {
  getPrincipal,
  getTenantMembership,
  listApiKeys,
  listTenantMemberships,
  putTenantMembership,
  recordAudit,
  revokeIdentitySessionsForMember,
  type AppDb,
  type TenantMembershipRow,
} from "@mendpoint/db";
import { scimBindingsFromEnv, type ScimBinding } from "@mendpoint/platform";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const MAX_BODY_BYTES = 64 * 1_024;
const MAX_AUTHORITY_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
type ScimRole = Exclude<TenantMembershipRow["role"], "owner">;
const SCIM_ROLES = new Set<ScimRole>(["admin", "engineer", "viewer", "fde"]);

export { scimBindingsFromEnv };
export type { ScimBinding };
type Options = Readonly<{ db: AppDb; bindings: ReadonlyMap<string, ScimBinding>; now?: () => Date }>;

function canonicalTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? milliseconds
    : null;
}

function activeBoundPrincipalLifetime(
  principal: Readonly<{ created_at: string; expires_at: string | null }>,
  observedAt: string,
): boolean {
  const createdAtMs = canonicalTimestamp(principal.created_at);
  const expiresAtMs = canonicalTimestamp(principal.expires_at);
  const observedAtMs = canonicalTimestamp(observedAt);
  return createdAtMs !== null && expiresAtMs !== null && observedAtMs !== null &&
    createdAtMs <= observedAtMs && expiresAtMs > observedAtMs &&
    expiresAtMs - createdAtMs <= MAX_AUTHORITY_LIFETIME_MS;
}

function attribute(input: Record<string, unknown>, name: string): unknown {
  const matches = Object.keys(input).filter((key) => key.toLowerCase() === name.toLowerCase());
  if (matches.length > 1) throw new Error("scim_payload_invalid");
  return matches[0] === undefined ? undefined : input[matches[0]];
}

function requireSchema(input: Record<string, unknown>, expected: string, code: string): void {
  const schemas = attribute(input, "schemas");
  if (
    !Array.isArray(schemas) ||
    schemas.some((value) => typeof value !== "string") ||
    !schemas.some((value) => value.toLowerCase() === expected.toLowerCase())
  ) throw new Error(code);
}

function text(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}

export function validateScimBindings(
  db: AppDb,
  bindings: ReadonlyMap<string, ScimBinding>,
  observedAt = new Date().toISOString(),
): void {
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) {
    throw new Error("scim_bindings_observed_at_invalid");
  }
  for (const binding of bindings.values()) {
    const principal = getPrincipal(db, binding.tenantId, binding.principalId);
    if (
      !principal ||
      principal.kind !== "service" ||
      principal.audience !== "mendpoint-scim" ||
      !activeBoundPrincipalLifetime(principal, observedAt) ||
      principal.revoked_at !== null ||
      principal.expires_at === null
    ) throw new Error("scim_binding_principal_invalid");
    const activeKeys = listApiKeys(db, binding.tenantId).filter(
      (key) => key.principal_id === binding.principalId && key.created_at <= observedAt && key.revoked_at === null,
    );
    if (
      activeKeys.length === 0 ||
      activeKeys.some((key) => {
        let scopes: unknown;
        try { scopes = JSON.parse(key.scopes_json); } catch { return true; }
        return !Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== "identity:provision";
      })
    ) throw new Error("scim_binding_scope_invalid");
  }
}

function scimError(c: Context<ApiEnv>, status: number, detail: string, scimType?: string): Response {
  return c.json({ schemas: [ERROR_SCHEMA], status: String(status), detail, ...(scimType ? { scimType } : {}) }, status as 400);
}

function authority(c: Context<ApiEnv>, options: Options, observedAt: Date): ScimBinding {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  const apiKeyId = c.get("apiKeyId");
  const scopes = c.get("authScopes") ?? [];
  if (!principal || !trustPrincipalId || !apiKeyId || c.get("authMethod") !== "api_key") {
    throw new Error("scim_authentication_required");
  }
  const binding = options.bindings.get(principal.tenantId);
  if (
    !binding ||
    binding.principalId !== trustPrincipalId ||
    scopes.length !== 1 ||
    scopes[0] !== "identity:provision"
  ) {
    throw new Error("scim_binding_required");
  }
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new Error("scim_observed_at_invalid");
  const observedAtIso = observedAt.toISOString();
  const trust = getPrincipal(options.db, principal.tenantId, trustPrincipalId);
  if (
    !trust ||
    trust.kind !== "service" ||
    trust.audience !== "mendpoint-scim" ||
    !activeBoundPrincipalLifetime(trust, observedAtIso) ||
    trust.revoked_at !== null ||
    trust.expires_at === null
  ) {
    throw new Error("scim_principal_invalid");
  }
  const key = listApiKeys(options.db, principal.tenantId).find((candidate) => candidate.id === apiKeyId);
  let liveScopes: unknown;
  try { liveScopes = key ? JSON.parse(key.scopes_json) : null; } catch { liveScopes = null; }
  if (
    !key ||
    key.principal_id !== trustPrincipalId ||
    key.created_at > observedAtIso ||
    key.revoked_at !== null ||
    !Array.isArray(liveScopes) ||
    liveScopes.length !== 1 ||
    liveScopes[0] !== "identity:provision"
  ) {
    throw new Error("scim_binding_required");
  }
  return binding;
}

async function jsonBody(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/scim+json") && !contentType.startsWith("application/json")) {
    throw new Error("scim_content_type_invalid");
  }
  const declaredHeader = c.req.header("content-length");
  if (declaredHeader !== undefined) {
    const declared = declaredHeader.trim();
    if (!/^\d+$/.test(declared)) {
      await c.req.raw.body?.cancel("scim_content_length_invalid");
      throw new Error("scim_content_length_invalid");
    }
    if (BigInt(declared) > BigInt(MAX_BODY_BYTES)) {
      await c.req.raw.body?.cancel("scim_payload_too_large");
      throw new Error("scim_payload_too_large");
    }
  }
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel("scim_payload_too_large");
        throw new Error("scim_payload_too_large");
      }
      chunks.push(value);
    }
  }
  let raw: string;
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("scim_payload_invalid");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("scim_payload_invalid");
  }
}

function userId(tenantId: string, issuer: string, subject: string): string {
  return `scim-user-${createHash("sha256").update(`${tenantId}\n${issuer}\n${subject}`, "utf8").digest("hex").slice(0, 32)}`;
}

function version(updatedAt: string): string {
  return `W/"${updatedAt}"`;
}

function dto(row: TenantMembershipRow) {
  return {
    schemas: [USER_SCHEMA],
    id: userId(row.tenant_id, row.issuer, row.subject),
    externalId: row.subject,
    userName: row.email ?? row.subject,
    displayName: row.display_name,
    active: row.status === "active",
    roles: [{ value: row.role, primary: true }],
    meta: {
      resourceType: "User",
      created: row.created_at,
      lastModified: row.updated_at,
      version: version(row.updated_at),
    },
  };
}

function memberById(db: AppDb, binding: ScimBinding, id: string): TenantMembershipRow | undefined {
  return listTenantMemberships(db, binding.tenantId)
    .filter((row) => row.issuer === binding.issuer)
    .find((row) => userId(row.tenant_id, row.issuer, row.subject) === id);
}

function role(value: unknown): ScimRole {
  const entry = (candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { primary: false, value: candidate };
    }
    const record = candidate as Record<string, unknown>;
    const primary = attribute(record, "primary");
    if (primary !== undefined && typeof primary !== "boolean") throw new Error("scim_role_invalid");
    return { primary: primary === true, value: attribute(record, "value") };
  };
  const candidates = Array.isArray(value) ? value.map(entry) : [entry(value)];
  const primary = candidates.filter((candidate) => candidate.primary);
  if (primary.length > 1 || (candidates.length > 1 && primary.length !== 1)) {
    throw new Error("scim_role_invalid");
  }
  const raw = (primary[0] ?? candidates[0])?.value;
  const normalized = text(raw, "scim_role_invalid", 32).toLowerCase() as ScimRole;
  if (!SCIM_ROLES.has(normalized)) throw new Error("scim_role_invalid");
  return normalized;
}

function email(value: unknown): string {
  const normalized = text(value, "scim_user_name_invalid", 320).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("scim_user_name_invalid");
  return normalized;
}

function active(value: unknown, defaultValue?: boolean): boolean {
  if (value === undefined) {
    if (defaultValue === undefined) throw new Error("scim_active_invalid");
    return defaultValue;
  }
  if (typeof value !== "boolean") throw new Error("scim_active_invalid");
  return value;
}

function putScimMembership(
  db: AppDb,
  input: Parameters<typeof putTenantMembership>[1],
): TenantMembershipRow {
  try {
    return putTenantMembership(db, input);
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("tenant_memberships_username_domain_uidx") ||
        error.message.includes("tenant_memberships.tenant_id, tenant_memberships.issuer"))
    ) throw new Error("scim_user_conflict");
    throw error;
  }
}

type MutableScimUser = {
  email: string | null;
  displayName: string;
  role: TenantMembershipRow["role"];
  status: TenantMembershipRow["status"];
};

function replaceAttribute(next: MutableScimUser, path: string, value: unknown): void {
  switch (path.toLowerCase()) {
    case "active":
      next.status = active(value) ? "active" : "offboarded";
      return;
    case "roles":
      next.role = role(value);
      return;
    case "displayname":
      next.displayName = text(value, "scim_display_name_invalid", 200);
      return;
    case "username":
      next.email = email(value);
      return;
    default:
      throw new Error("scim_patch_invalid");
  }
}

function applyReplace(next: MutableScimUser, path: unknown, value: unknown): void {
  if (typeof path === "string") {
    replaceAttribute(next, path, value);
    return;
  }
  if (path !== undefined || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scim_patch_invalid");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) throw new Error("scim_patch_invalid");
  const names = new Set<string>();
  for (const [attributeName] of entries) {
    const normalized = attributeName.toLowerCase();
    if (names.has(normalized)) throw new Error("scim_patch_invalid");
    names.add(normalized);
  }
  for (const [attributeName, attributeValue] of entries) {
    replaceAttribute(next, attributeName, attributeValue);
  }
}

function nextTimestamp(now: Date, previous?: string): string {
  const value = now.getTime();
  if (!Number.isFinite(value)) throw new Error("scim_observed_at_invalid");
  return new Date(Math.max(value, previous ? Date.parse(previous) + 1 : value)).toISOString();
}

function requireVersion(c: Context<ApiEnv>, row: TenantMembershipRow): void {
  if (c.req.header("if-match") !== version(row.updated_at)) throw new Error("scim_version_conflict");
}

function audit(options: Options, c: Context<ApiEnv>, binding: ScimBinding, action: string, row: TenantMembershipRow) {
  const at = row.updated_at;
  recordAudit(options.db, {
    id: `audit-scim-${createHash("sha256").update(`${binding.tenantId}\n${action}\n${row.subject}\n${at}`).digest("hex").slice(0, 32)}`,
    tenantId: binding.tenantId,
    actor: c.get("principal")!.id,
    principalId: binding.principalId,
    apiKeyId: c.get("apiKeyId") ?? null,
    requestId: c.get("requestId") ?? null,
    action,
    resourceType: "tenant_membership",
    resourceId: userId(binding.tenantId, binding.issuer, row.subject),
    metadata: { status: row.status, role: row.role, updatedAt: row.updated_at },
  });
}

function transact<T>(db: AppDb, operation: () => T): T {
  const owns = !db.raw.isTransaction;
  if (owns) db.raw.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (owns) db.raw.exec("COMMIT");
    return result;
  } catch (error) {
    if (owns && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function failure(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "scim_internal_error";
  if (code === "scim_authentication_required") return scimError(c, 401, "SCIM authentication is required");
  if (code === "scim_binding_required" || code === "scim_principal_invalid") return scimError(c, 403, "SCIM authority is not valid");
  if (code === "scim_not_found") return scimError(c, 404, "Resource not found");
  if (code === "scim_version_conflict") return scimError(c, 412, "Resource version changed", "mutability");
  if (code === "scim_user_conflict") return scimError(c, 409, "User already exists", "uniqueness");
  if (code === "scim_payload_too_large") return scimError(c, 413, "Payload is too large");
  if (code.startsWith("scim_")) return scimError(c, 400, "SCIM request is invalid", "invalidValue");
  console.error(code);
  return scimError(c, 500, "SCIM request failed");
}

export function createScimRoutes(options: Options): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const now = options.now ?? (() => new Date());

  routes.get("/Users", (c) => {
    try {
      const binding = authority(c, options, now());
      let rows = listTenantMemberships(options.db, binding.tenantId).filter((row) => row.issuer === binding.issuer);
      const filter = c.req.query("filter");
      if (filter) {
        const match = /^(username|externalid)\s+(eq)\s+"([^"]{1,512})"$/i.exec(filter);
        if (!match) throw new Error("scim_filter_invalid");
        const attributeName = match[1]!.toLowerCase();
        const expected = match[3]!;
        rows = rows.filter((row) => attributeName === "externalid"
          ? row.subject === expected
          : row.email?.toLowerCase() === expected.toLowerCase());
      }
      const resources = rows.map(dto);
      return c.json({ schemas: [LIST_SCHEMA], totalResults: resources.length, startIndex: 1, itemsPerPage: resources.length, Resources: resources });
    } catch (error) { return failure(c, error); }
  });

  routes.get("/Users/:id", (c) => {
    try {
      const binding = authority(c, options, now());
      const row = memberById(options.db, binding, c.req.param("id"));
      if (!row) throw new Error("scim_not_found");
      c.header("ETag", version(row.updated_at));
      return c.json(dto(row));
    } catch (error) { return failure(c, error); }
  });

  routes.post("/Users", async (c) => {
    try {
      authority(c, options, now());
      const input = await jsonBody(c);
      requireSchema(input, USER_SCHEMA, "scim_user_schema_invalid");
      const subject = text(attribute(input, "externalId"), "scim_external_id_invalid", 512);
      const requested = {
        email: email(attribute(input, "userName")),
        displayName: text(attribute(input, "displayName"), "scim_display_name_invalid", 200),
        role: role(attribute(input, "roles")),
        status: active(attribute(input, "active"), true) ? "active" as const : "offboarded" as const,
      };
      const result = transact(options.db, () => {
        const binding = authority(c, options, now());
        const existing = getTenantMembership(options.db, binding.tenantId, binding.issuer, subject);
        if (existing) {
          if (
            existing.email === requested.email && existing.display_name === requested.displayName &&
            existing.role === requested.role && existing.status === requested.status
          ) return { row: existing, created: false } as const;
          throw new Error("scim_user_conflict");
        }
        const created = putScimMembership(options.db, {
          tenantId: binding.tenantId,
          issuer: binding.issuer,
          subject,
          email: requested.email,
          displayName: requested.displayName,
          role: requested.role,
          status: requested.status,
          updatedAt: nextTimestamp(now()),
        });
        audit(options, c, binding, "scim.user.provision", created);
        return { row: created, created: true } as const;
      });
      if (result.created) {
        c.header("Location", `/scim/v2/Users/${userId(result.row.tenant_id, result.row.issuer, result.row.subject)}`);
      }
      c.header("ETag", version(result.row.updated_at));
      return c.json(dto(result.row), result.created ? 201 : 200);
    } catch (error) { return failure(c, error); }
  });

  routes.put("/Users/:id", async (c) => {
    try {
      authority(c, options, now());
      const input = await jsonBody(c);
      requireSchema(input, USER_SCHEMA, "scim_user_schema_invalid");
      const row = transact(options.db, () => {
        const binding = authority(c, options, now());
        const current = memberById(options.db, binding, c.req.param("id"));
        if (!current) throw new Error("scim_not_found");
        if (current.role === "owner") throw new Error("scim_owner_managed_outside_scim");
        requireVersion(c, current);
        if (text(attribute(input, "externalId"), "scim_external_id_invalid", 512) !== current.subject) throw new Error("scim_external_id_immutable");
        const updatedAt = nextTimestamp(now(), current.updated_at);
        const updated = putScimMembership(options.db, {
          tenantId: binding.tenantId,
          issuer: binding.issuer,
          subject: current.subject,
          email: email(attribute(input, "userName")),
          displayName: text(attribute(input, "displayName"), "scim_display_name_invalid", 200),
          role: role(attribute(input, "roles")),
          status: active(attribute(input, "active"), true) ? "active" : "offboarded",
          updatedAt,
        });
        if (updated.status === "offboarded") revokeIdentitySessionsForMember(options.db, {
          tenantId: binding.tenantId, issuer: binding.issuer, subject: current.subject,
          actorPrincipalId: binding.principalId, reason: "scim_deactivated", revokedAt: updatedAt,
        });
        audit(options, c, binding, "scim.user.replace", updated);
        return updated;
      });
      c.header("ETag", version(row.updated_at));
      return c.json(dto(row));
    } catch (error) { return failure(c, error); }
  });

  routes.patch("/Users/:id", async (c) => {
    try {
      authority(c, options, now());
      const input = await jsonBody(c);
      requireSchema(input, PATCH_SCHEMA, "scim_patch_invalid");
      const operations = attribute(input, "Operations");
      if (!Array.isArray(operations) || operations.length === 0) {
        throw new Error("scim_patch_invalid");
      }
      const row = transact(options.db, () => {
        const binding = authority(c, options, now());
        const current = memberById(options.db, binding, c.req.param("id"));
        if (!current) throw new Error("scim_not_found");
        if (current.role === "owner") throw new Error("scim_owner_managed_outside_scim");
        requireVersion(c, current);
        const next = { email: current.email, displayName: current.display_name, role: current.role, status: current.status };
        for (const operation of operations) {
          if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw new Error("scim_patch_invalid");
          const value = operation as Record<string, unknown>;
          const op = attribute(value, "op");
          if (typeof op !== "string" || op.toLowerCase() !== "replace") {
            throw new Error("scim_patch_invalid");
          }
          applyReplace(next, attribute(value, "path"), attribute(value, "value"));
        }
        const updatedAt = nextTimestamp(now(), current.updated_at);
        const updated = putScimMembership(options.db, {
          tenantId: binding.tenantId, issuer: binding.issuer, subject: current.subject,
          email: next.email, displayName: next.displayName, role: next.role, status: next.status, updatedAt,
        });
        if (updated.status === "offboarded") revokeIdentitySessionsForMember(options.db, {
          tenantId: binding.tenantId, issuer: binding.issuer, subject: current.subject,
          actorPrincipalId: binding.principalId, reason: "scim_deactivated", revokedAt: updatedAt,
        });
        audit(options, c, binding, "scim.user.patch", updated);
        return updated;
      });
      c.header("ETag", version(row.updated_at));
      return c.json(dto(row));
    } catch (error) { return failure(c, error); }
  });

  routes.delete("/Users/:id", (c) => {
    try {
      authority(c, options, now());
      transact(options.db, () => {
        const binding = authority(c, options, now());
        const current = memberById(options.db, binding, c.req.param("id"));
        if (!current) throw new Error("scim_not_found");
        if (current.role === "owner") throw new Error("scim_owner_managed_outside_scim");
        requireVersion(c, current);
        const updatedAt = nextTimestamp(now(), current.updated_at);
        const updated = putScimMembership(options.db, {
          tenantId: binding.tenantId, issuer: binding.issuer, subject: current.subject,
          email: current.email, displayName: current.display_name, role: current.role,
          status: "offboarded", updatedAt,
        });
        revokeIdentitySessionsForMember(options.db, {
          tenantId: binding.tenantId, issuer: binding.issuer, subject: current.subject,
          actorPrincipalId: binding.principalId, reason: "scim_deleted", revokedAt: updatedAt,
        });
        audit(options, c, binding, "scim.user.delete", updated);
      });
      return new Response(null, { status: 204 });
    } catch (error) { return failure(c, error); }
  });

  return routes;
}
