import {
  createApiKey,
  getIdentitySession,
  getPrincipal,
  getTenantMembership,
  insertPrincipal,
  listApiKeys,
  listPrincipals,
  recordAudit,
  revokeApiKey,
  revokePrincipal,
  type AppDb,
  type ApiKeyRow,
} from "@mendpoint/db";
import { permissionsFor, type Permission } from "@mendpoint/platform";
import { createHash } from "node:crypto";
import type { Context } from "hono";
import { Hono } from "hono";
import type { ApiEnv } from "./auth.js";

const MAX_BODY_BYTES = 32 * 1_024;
const MAX_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const SUBJECT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
/** Scopes a service principal can actually exercise through the agent role. */
export const SERVICE_PRINCIPAL_ALLOWED_SCOPES = Object.freeze(
  permissionsFor("agent").slice().sort(),
) satisfies readonly Permission[];
const ALLOWED_SCOPES = new Set<Permission>(SERVICE_PRINCIPAL_ALLOWED_SCOPES);

type Options = Readonly<{ db: AppDb; now?: () => Date }>;

function actor(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!principal || !trustPrincipalId) throw new Error("service_principal_authentication_required");
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("service_principal_manager_required");
  }
  return { ...principal, trustPrincipalId };
}

function liveManager(c: Context<ApiEnv>, options: Options, observedAt: Date) {
  const claimed = actor(c);
  const observedAtMs = observedAt.getTime();
  if (!Number.isFinite(observedAtMs)) throw new Error("service_principal_observed_at_invalid");
  const trust = getPrincipal(options.db, claimed.tenantId, claimed.trustPrincipalId);
  if (
    !trust ||
    trust.kind !== "human" ||
    trust.created_at > observedAt.toISOString() ||
    trust.revoked_at !== null ||
    (trust.expires_at !== null && Date.parse(trust.expires_at) <= observedAtMs) ||
    !trust.audience ||
    !trust.subject.startsWith(`${trust.audience}|`)
  ) throw new Error("service_principal_authentication_required");
  const subject = trust.subject.slice(trust.audience.length + 1);
  const membership = subject
    ? getTenantMembership(options.db, claimed.tenantId, trust.audience, subject)
    : undefined;
  if (
    !membership ||
    membership.status !== "active" ||
    (membership.role !== "owner" && membership.role !== "admin") ||
    claimed.id !== `human:${trust.subject}`
  ) throw new Error("service_principal_manager_required");
  const authMethod = c.get("authMethod");
  if (authMethod === "api_key") {
    const apiKeyId = c.get("apiKeyId");
    const key = apiKeyId
      ? listApiKeys(options.db, claimed.tenantId).find((candidate) => candidate.id === apiKeyId)
      : undefined;
    let liveScopes: unknown;
    try { liveScopes = key ? JSON.parse(key.scopes_json) : null; } catch { liveScopes = null; }
    if (
      !key ||
      key.created_at > observedAt.toISOString() ||
      key.revoked_at !== null ||
      !Array.isArray(liveScopes) ||
      (!liveScopes.includes("tenant:admin") && !liveScopes.includes("*"))
    ) throw new Error("service_principal_authentication_required");
  } else if (authMethod === "oidc") {
    const sessionId = c.get("identitySessionId");
    const session = sessionId
      ? getIdentitySession(options.db, claimed.tenantId, sessionId)
      : undefined;
    const evidenceId = `membership:${createHash("sha256")
      .update(`${claimed.tenantId}\n${trust.audience}\n${subject}`, "utf8")
      .digest("hex")}`;
    if (
      !session ||
      session.principal_id !== trust.id ||
      session.issuer !== trust.audience ||
      session.subject !== subject ||
      session.membership_updated_at !== membership.updated_at ||
      session.issued_at > observedAt.toISOString() ||
      session.expires_at <= observedAt.toISOString() ||
      session.revoked_at !== null ||
      c.get("membershipEvidenceId") !== evidenceId
    ) throw new Error("service_principal_authentication_required");
  } else {
    throw new Error("service_principal_authentication_required");
  }
  return { ...claimed, role: membership.role };
}

async function body(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new Error("service_principal_content_type_invalid");
  }
  const declared = Number(c.req.header("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new Error("service_principal_payload_too_large");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new Error("service_principal_payload_too_large");
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error("service_principal_payload_invalid");
  }
}

function text(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new Error(code);
  return value.trim();
}

function scopes(value: unknown): Permission[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ALLOWED_SCOPES.size) {
    throw new Error("service_principal_scopes_invalid");
  }
  const normalized = [...new Set(value.map((item) => text(item, "service_principal_scopes_invalid", 64)))] as Permission[];
  if (normalized.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw new Error("service_principal_scopes_invalid");
  }
  return normalized.sort();
}

function expiration(value: unknown, now: Date): string {
  const expiresAt = text(value, "service_principal_expiry_invalid", 64);
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(nowMs) ||
    !Number.isFinite(expiresAtMs) ||
    new Date(expiresAtMs).toISOString() !== expiresAt ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > MAX_LIFETIME_MS
  ) throw new Error("service_principal_expiry_invalid");
  return expiresAt;
}

function audience(value: unknown): "mendpoint-api" | "mendpoint-scim" {
  if (value === undefined || value === "mendpoint-api") return "mendpoint-api";
  if (value === "mendpoint-scim") return "mendpoint-scim";
  throw new Error("service_principal_audience_invalid");
}

function idempotency(c: Context<ApiEnv>): string {
  return text(c.req.header("idempotency-key"), "service_principal_idempotency_key_required", 128);
}

function deterministicId(prefix: string, values: string[]): string {
  return `${prefix}_${createHash("sha256").update(values.join("\n"), "utf8").digest("hex").slice(0, 32)}`;
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

function responseError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "internal_error";
  if (code.endsWith("_authentication_required")) return c.json({ error: "unauthorized" }, 401);
  if (code.endsWith("_manager_required")) return c.json({ error: "forbidden" }, 403);
  if (code.endsWith("_not_found")) return c.json({ error: code }, 404);
  if (code.endsWith("_conflict") || code === "service_principal_credential_already_issued") {
    return c.json({ error: code }, 409);
  }
  if (code === "service_principal_payload_too_large") return c.json({ error: code }, 413);
  if (code.startsWith("service_principal_")) return c.json({ error: code }, 422);
  console.error(code);
  return c.json({ error: "internal_error", requestId: c.get("requestId") ?? null }, 500);
}

function principalDto(row: ReturnType<typeof listPrincipals>[number], keys: ReturnType<typeof listApiKeys>) {
  return {
    id: row.id,
    subject: row.subject,
    displayName: row.display_name,
    audience: row.audience,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    credentials: keys.filter((key) => key.principal_id === row.id).map((key) => ({
      id: key.id,
      name: key.name,
      prefix: key.key_prefix,
      scopes: JSON.parse(key.scopes_json) as string[],
      createdAt: key.created_at,
      lastUsedAt: key.last_used_at,
      revokedAt: key.revoked_at,
    })),
  };
}

export function createServicePrincipalRoutes(options: Options): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const now = options.now ?? (() => new Date());

  routes.get("/", (c) => {
    try {
      const identity = actor(c);
      const keys = listApiKeys(options.db, identity.tenantId);
      return c.json({ data: listPrincipals(options.db, identity.tenantId, "service").map((row) => principalDto(row, keys)) });
    } catch (error) {
      return responseError(c, error);
    }
  });

  routes.post("/", async (c) => {
    try {
      const claimed = actor(c);
      const input = await body(c);
      if (Object.keys(input).some((key) => !["subject", "displayName", "scopes", "expiresAt", "audience"].includes(key))) {
        throw new Error("service_principal_payload_invalid");
      }
      const subject = text(input.subject, "service_principal_subject_invalid", 128);
      if (!SUBJECT.test(subject)) throw new Error("service_principal_subject_invalid");
      const displayName = text(input.displayName, "service_principal_display_name_invalid", 200);
      const grantedScopes = scopes(input.scopes);
      const requestedAudience = audience(input.audience);
      if (
        requestedAudience === "mendpoint-scim" &&
        (grantedScopes.length !== 1 || grantedScopes[0] !== "identity:provision")
      ) throw new Error("service_principal_scim_scope_invalid");
      if (requestedAudience === "mendpoint-api" && grantedScopes.includes("identity:provision")) {
        throw new Error("service_principal_scim_audience_required");
      }
      const observedAt = now();
      const expiresAt = expiration(input.expiresAt, observedAt);
      const requestKey = idempotency(c);
      const principalId = deterministicId("principal-service", [claimed.tenantId, subject]);
      const apiKeyId = deterministicId("key-service", [claimed.tenantId, principalId, requestKey]);
      const created = transact(options.db, () => {
        const identity = liveManager(c, options, observedAt);
        const replay = listApiKeys(options.db, identity.tenantId).find((key) => key.id === apiKeyId);
        if (replay) throw new Error("service_principal_credential_already_issued");
        const principal = insertPrincipal(options.db, {
          id: principalId,
          tenantId: identity.tenantId,
          kind: "service",
          subject,
          displayName,
          audience: requestedAudience,
          expiresAt,
          createdAt: observedAt.toISOString(),
        });
        const credential = createApiKey(options.db, {
          id: apiKeyId,
          name: `${displayName} credential`,
          tenantId: identity.tenantId,
          principalId: principal.id,
          scopes: grantedScopes,
          createdAt: observedAt.toISOString(),
        });
        recordAudit(options.db, {
          id: deterministicId("audit-service", [identity.tenantId, apiKeyId]),
          tenantId: identity.tenantId,
          actor: identity.id,
          principalId: identity.trustPrincipalId,
          apiKeyId: c.get("apiKeyId") ?? null,
          requestId: c.get("requestId") ?? null,
          action: "service_principal.create",
          resourceType: "service_principal",
          resourceId: principal.id,
          metadata: { credentialId: credential.id, prefix: credential.prefix, scopes: grantedScopes, expiresAt, audience: requestedAudience },
        });
        return { principal, credential };
      });
      return c.json({ data: { ...principalDto(created.principal, []), credential: { id: created.credential.id, token: created.credential.token, prefix: created.credential.prefix, scopes: grantedScopes } } }, 201);
    } catch (error) {
      return responseError(c, error);
    }
  });

  routes.post("/:principalId/credentials/rotate", async (c) => {
    try {
      const claimed = actor(c);
      const input = await body(c);
      if (Object.keys(input).some((key) => !["currentCredentialId", "scopes"].includes(key))) {
        throw new Error("service_principal_payload_invalid");
      }
      const principalId = text(c.req.param("principalId"), "service_principal_id_invalid", 96);
      const currentCredentialId = text(input.currentCredentialId, "service_principal_credential_invalid", 96);
      const grantedScopes = scopes(input.scopes);
      const requestKey = idempotency(c);
      const observedAt = now();
      const observedAtIso = observedAt.toISOString();
      const nextCredentialId = deterministicId("key-service", [claimed.tenantId, principalId, requestKey]);
      const credential = transact(options.db, () => {
        const identity = liveManager(c, options, observedAt);
        const principal = getPrincipal(options.db, identity.tenantId, principalId);
        if (!principal || principal.kind !== "service") throw new Error("service_principal_not_found");
        if (
          principal.audience === "mendpoint-scim" &&
          (grantedScopes.length !== 1 || grantedScopes[0] !== "identity:provision")
        ) throw new Error("service_principal_scim_scope_invalid");
        if (principal.audience !== "mendpoint-scim" && grantedScopes.includes("identity:provision")) {
          throw new Error("service_principal_scim_audience_required");
        }
        if (principal.revoked_at || (principal.expires_at && Date.parse(principal.expires_at) <= observedAt.getTime())) {
          throw new Error("service_principal_inactive_conflict");
        }
        const replay = listApiKeys(options.db, identity.tenantId).find((key) => key.id === nextCredentialId);
        if (replay) throw new Error("service_principal_credential_already_issued");
        const current = options.db.raw.prepare(
          `SELECT * FROM api_keys WHERE tenant_id = ? AND id = ? AND principal_id = ? AND revoked_at IS NULL`,
        ).get(identity.tenantId, currentCredentialId, principalId) as ApiKeyRow | undefined;
        if (!current) throw new Error("service_principal_credential_not_found");
        if (!revokeApiKey(options.db, currentCredentialId, observedAtIso, identity.tenantId)) {
          throw new Error("service_principal_credential_conflict");
        }
        const next = createApiKey(options.db, {
          id: nextCredentialId,
          name: current.name,
          tenantId: identity.tenantId,
          principalId,
          scopes: grantedScopes,
          createdAt: observedAtIso,
        });
        recordAudit(options.db, {
          id: deterministicId("audit-service", [identity.tenantId, nextCredentialId]),
          tenantId: identity.tenantId,
          actor: identity.id,
          principalId: identity.trustPrincipalId,
          apiKeyId: c.get("apiKeyId") ?? null,
          requestId: c.get("requestId") ?? null,
          action: "service_principal.credential_rotate",
          resourceType: "service_principal",
          resourceId: principalId,
          metadata: { priorCredentialId: currentCredentialId, credentialId: next.id, prefix: next.prefix, scopes: grantedScopes },
        });
        return next;
      });
      return c.json({ data: { id: credential.id, token: credential.token, prefix: credential.prefix, scopes: grantedScopes } }, 201);
    } catch (error) {
      return responseError(c, error);
    }
  });

  routes.post("/:principalId/revoke", (c) => {
    try {
      const identity = actor(c);
      const principalId = text(c.req.param("principalId"), "service_principal_id_invalid", 96);
      const observedAt = now().toISOString();
      const revoked = transact(options.db, () => {
        const current = getPrincipal(options.db, identity.tenantId, principalId);
        if (!current || current.kind !== "service") throw new Error("service_principal_not_found");
        if (current.revoked_at) return current;
        const row = revokePrincipal(options.db, { tenantId: identity.tenantId, principalId, revokedAt: observedAt });
        if (!row) throw new Error("service_principal_revoke_conflict");
        for (const key of listApiKeys(options.db, identity.tenantId).filter((candidate) => candidate.principal_id === principalId && !candidate.revoked_at)) {
          revokeApiKey(options.db, key.id, observedAt, identity.tenantId);
        }
        recordAudit(options.db, {
          id: deterministicId("audit-service-revoke", [identity.tenantId, principalId, observedAt]),
          tenantId: identity.tenantId,
          actor: identity.id,
          principalId: identity.trustPrincipalId,
          apiKeyId: c.get("apiKeyId") ?? null,
          requestId: c.get("requestId") ?? null,
          action: "service_principal.revoke",
          resourceType: "service_principal",
          resourceId: principalId,
          metadata: { revokedAt: observedAt },
        });
        return row;
      });
      return c.json({ data: principalDto(revoked, listApiKeys(options.db, identity.tenantId)) });
    } catch (error) {
      return responseError(c, error);
    }
  });

  return routes;
}
