import { Hono, type Context, type Next } from "hono";
import { getPrincipal, getTenantMembership, recordAudit, type AppDb } from "@mendpoint/db";
import { createHash } from "node:crypto";
import type { EnvelopeKeyLocator, KeyEncryptionKeyProvider } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";
import {
  DurableSecretLifecycleService,
  assertSecretLifecycleKeySeparation,
  isAuditedBreakGlassError,
  type SecretLifecycleRequestCommitment,
} from "./secret-lifecycle-service.js";

type AuditInput = Parameters<typeof recordAudit>[1];

export function createSecretBreakGlassDenialAuditMiddleware(options: Readonly<{
  db: AppDb;
  audit?: (input: AuditInput) => void;
}>) {
  const audit = options.audit ?? ((input: AuditInput) => recordAudit(options.db, input));
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    const match = /^\/platform\/secrets\/([^/]+)\/break-glass$/u.exec(path);
    if (c.req.method !== "POST" || !match) return next();
    await next();
    if ((c.res.status !== 401 && c.res.status !== 403) || c.get("secretBreakGlassAuditHandled")) {
      return;
    }
    const principal = c.get("principal");
    const authorityPrincipalId = c.get("authorityPrincipalId") ?? null;
    const credentialPrincipalId = c.get("trustPrincipalId") ?? null;
    try {
      audit({
        tenantId: principal?.tenantId || "tenant_unattributed",
        actor: "system",
        principalId: authorityPrincipalId,
        apiKeyId: c.get("apiKeyId") ?? null,
        requestId: c.get("requestId") ?? null,
        action: "secret.break_glass.denied",
        resourceType: "secret_lifecycle",
        resourceId: match[1] || null,
        metadata: {
          outcome: "denied",
          failure: principal ? "authorization_denied" : "authentication_denied",
          status: c.res.status,
          role: principal?.role ?? null,
          tenantId: principal?.tenantId ?? null,
          authorityPrincipalId,
          credentialPrincipalId,
          apiKeyId: c.get("apiKeyId") ?? null,
          requestId: c.get("requestId") ?? null,
        },
      });
      c.set("secretBreakGlassAuditHandled", true);
    } catch {
      c.set("secretBreakGlassAuditHandled", true);
      c.res = c.json({ error: "service_unavailable" }, 503);
    }
  };
}

const ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "authenticated_principal_required", publicCode: "unauthorized", status: 401 },
  { internalCode: "secret_lifecycle_authority_required", publicCode: "forbidden", status: 403 },
  { internalCode: "secret_lifecycle_authority_invalid", publicCode: "forbidden", status: 403 },
  { internalCode: "secret_break_glass_owner_required", publicCode: "forbidden", status: 403 },
  { internalCode: "secret_break_glass_disabled", status: 403 },
  { internalCode: "secret_lifecycle_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "secret_lifecycle_version_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "secret_lifecycle_idempotency_conflict", status: 409 },
  { internalCode: "secret_rotation_generation_conflict", status: 409 },
  { internalCode: "secret_lifecycle_already_revoked", status: 409 },
  { internalCode: "secret_lifecycle_authority_changed", publicCode: "forbidden", status: 403 },
  { internalCode: "vault_provider_disabled", status: 503 },
  { internalCode: "external_vault_key_not_attested", status: 503 },
  { internalCode: "vault_key_attestation_mismatch", status: 503 },
  { internalCode: "secret_lifecycle_idempotency_key_invalid", status: 400 },
  { internalCode: "secret_lifecycle_request_digest_invalid", status: 400 },
  { internalCode: "secret_lifecycle_commitment_unconfigured", status: 503 },
  { internalCode: "secret_rotation_material_required", status: 400 },
  { internalCode: "secret_rotation_material_unchanged", status: 409 },
  { internalCode: "secret_material_lineage_revoked", status: 409 },
  { internalCode: "secret_rewrap_key_unchanged", status: 409 },
  { internalCode: "secret_rewrap_key_material_unchanged", status: 409 },
  { internalCode: "secret_material_lineage_missing", status: 409 },
  { internalCode: "secret_break_glass_generation_inactive", status: 409 },
  { internalCode: "vault_access_audit_failed", status: 503 },
  { internalCode: "secret_credential_id_invalid", status: 400 },
  { internalCode: "secret_source_reference_invalid", status: 400 },
  { internalCode: "secret_audiences_invalid", status: 400 },
  { internalCode: "secret_revocation_reason_required", status: 400 },
  { internalCode: "secret_break_glass_reason_required", status: 400 },
  { internalCode: "secret_break_glass_reason_invalid", status: 400 },
  { internalCode: "secret_revocation_reason_invalid", status: 400 },
  { internalCode: "secret_lifecycle_request_invalid", status: 400 },
  { internalCode: "secret_lifecycle_payload_too_large", status: 413 },
  { internalCode: "secret_lifecycle_content_type_invalid", status: 400 },
  { internalCode: "secret_generation_invalid", status: 400 },
  { internalCode: "secret_key_reference_invalid", status: 400 },
  { internalCode: "secret_expires_at_invalid", status: 400 },
  { internalCode: "secret_rotate_after_invalid", status: 400 },
  { internalCode: "secret_timestamp_order_invalid", status: 400 },
];

const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const SOURCE_REF = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._/@:-]+$/u;
const MAX_LIFECYCLE_BODY_BYTES = 1_100_000;
const MAX_REASON_CHARS = 4_096;
const CREATE_FIELDS = new Set([
  "credentialId", "sourceRef", "plaintext", "audiences", "expiresAt", "rotateAfter", "key",
]);
const ROTATE_FIELDS = new Set(["expectedGeneration", "plaintext", "key"]);
const REWRAP_FIELDS = new Set(["expectedGeneration", "key"]);
const REVOKE_FIELDS = new Set(["generation", "reason"]);
const BREAK_GLASS_FIELDS = new Set(["reason"]);
const KEY_FIELDS = new Set(["provider", "keyId", "version"]);

function objectBody(value: unknown, allowed?: ReadonlySet<string>): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("secret_lifecycle_request_invalid");
  }
  const record = value as Record<string, unknown>;
  if (allowed && Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("secret_lifecycle_request_invalid");
  }
  return record;
}

async function requestBody(
  c: Context<ApiEnv>,
  allowed: ReadonlySet<string>,
): Promise<Record<string, unknown>> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim();
  if (mediaType !== "application/json") {
    throw new Error("secret_lifecycle_content_type_invalid");
  }
  const declaredHeader = c.req.header("content-length");
  if (declaredHeader !== undefined) {
    if (!/^\d+$/u.test(declaredHeader)) throw new Error("secret_lifecycle_request_invalid");
    if (Number(declaredHeader) > MAX_LIFECYCLE_BODY_BYTES) {
      throw new Error("secret_lifecycle_payload_too_large");
    }
  }
  try {
    const reader = c.req.raw.body?.getReader();
    if (!reader) throw new Error("secret_lifecycle_request_invalid");
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_LIFECYCLE_BODY_BYTES) {
        await reader.cancel();
        throw new Error("secret_lifecycle_payload_too_large");
      }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
    return objectBody(JSON.parse(raw) as unknown, allowed);
  } catch (error) {
    if (error instanceof Error && [
      "secret_lifecycle_request_invalid",
      "secret_lifecycle_payload_too_large",
    ].includes(error.message)) throw error;
    throw new Error("secret_lifecycle_request_invalid");
  }
}

function text(value: unknown, code: string, max = 16_384): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new Error(code);
  return value;
}

function identifier(value: unknown, code: string): string {
  const result = text(value, code, 256);
  if (!BOUNDED_ID.test(result)) throw new Error(code);
  return result;
}

function generation(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("secret_generation_invalid");
  return value as number;
}

function timestamp(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  const result = text(value, code, 64);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) throw new Error(code);
  return result;
}

function keyLocator(value: unknown): EnvelopeKeyLocator {
  const key = objectBody(value, KEY_FIELDS);
  return Object.freeze({
    provider: identifier(key.provider, "secret_key_reference_invalid"),
    keyId: identifier(key.keyId, "secret_key_reference_invalid"),
    version: identifier(key.version, "secret_key_reference_invalid"),
  });
}

function currentAuthorityVersion(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    actorId: string;
    credentialPrincipalId: string;
    apiKeyId: string | null;
    requiredRole: "admin" | "owner";
  }>,
): Readonly<{ version: string }> {
  const now = Date.now();
  const principal = getPrincipal(db, input.tenantId, input.actorId);
  if (!principal || principal.revoked_at !== null || Date.parse(principal.created_at) > now ||
      (principal.expires_at !== null && Date.parse(principal.expires_at) <= now)) {
    throw new Error("secret_lifecycle_authority_invalid");
  }
  const credentialPrincipal = getPrincipal(db, input.tenantId, input.credentialPrincipalId);
  if (!credentialPrincipal || credentialPrincipal.revoked_at !== null ||
      Date.parse(credentialPrincipal.created_at) > now ||
      (credentialPrincipal.expires_at !== null && Date.parse(credentialPrincipal.expires_at) <= now)) {
    throw new Error("secret_lifecycle_authority_invalid");
  }
  let role: string | null = null;
  let membershipVersion: string | null = null;
  let keyVersion: string | null = null;
  if (input.apiKeyId) {
    const key = db.raw.prepare(`SELECT authority_principal_id, authority_role, scopes_json,
      created_at, revoked_at FROM api_keys WHERE id = ? AND tenant_id = ?`)
      .get(input.apiKeyId, input.tenantId) as {
        authority_principal_id: string | null; authority_role: string | null; scopes_json: string;
        created_at: string; revoked_at: string | null;
      } | undefined;
    if (!key || key.revoked_at !== null || key.authority_principal_id !== input.actorId ||
        (key.authority_role !== "admin" && key.authority_role !== "owner")) {
      throw new Error("secret_lifecycle_authority_invalid");
    }
    const scopes = JSON.parse(key.scopes_json) as unknown;
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string")) {
      throw new Error("secret_lifecycle_authority_invalid");
    }
    role = key.authority_role;
    keyVersion = `${key.created_at}:${key.authority_principal_id}:${key.authority_role}:${key.scopes_json}`;
  }
  if (principal.kind === "human") {
    if (!principal.audience || !principal.subject.startsWith(`${principal.audience}|`)) {
      throw new Error("secret_lifecycle_authority_invalid");
    }
    const membership = getTenantMembership(
      db, input.tenantId, principal.audience, principal.subject.slice(principal.audience.length + 1),
    );
    if (!membership || membership.status !== "active") throw new Error("secret_lifecycle_authority_invalid");
    role = role === "admin" && membership.role === "owner" ? "admin" : membership.role;
    membershipVersion = `${membership.role}:${membership.status}:${membership.updated_at}`;
  }
  if (role === null) throw new Error("secret_lifecycle_authority_invalid");
  if (input.requiredRole === "owner" ? role !== "owner" : role !== "owner" && role !== "admin") {
    throw new Error("secret_lifecycle_authority_required");
  }
  return Object.freeze({
    version: createHash("sha256").update(JSON.stringify({
      principal: [principal.id, principal.created_at, principal.expires_at, principal.revoked_at],
      credentialPrincipal: [credentialPrincipal.id, credentialPrincipal.created_at,
        credentialPrincipal.expires_at, credentialPrincipal.revoked_at],
      role, membershipVersion, keyVersion,
    })).digest("hex"),
  });
}

export function createSecretLifecycleRoutes(options: Readonly<{
  db: AppDb;
  providers: readonly KeyEncryptionKeyProvider[];
  enabled?: boolean;
  breakGlassEnabled: boolean;
  requestCommitment?: SecretLifecycleRequestCommitment;
}>) {
  assertSecretLifecycleKeySeparation(options.providers, options.requestCommitment);
  const routes = new Hono<ApiEnv>();
  routes.use("*", async (c, next) => {
    if (options.enabled === false) return c.notFound();
    return next();
  });

  function service(c: Context<ApiEnv>) {
    const principal = c.get("principal");
    if (!principal) throw new Error("authenticated_principal_required");
    return new DurableSecretLifecycleService({
      db: options.db,
      tenantId: principal.tenantId,
      actorId: c.get("authorityPrincipalId") ?? c.get("trustPrincipalId") ?? principal.id,
      credentialPrincipalId: c.get("trustPrincipalId") ?? principal.id,
      role: principal.role,
      authorityRole: c.get("authorityRole") ?? "viewer",
      providers: options.providers,
      breakGlassEnabled: options.breakGlassEnabled,
      requestId: c.get("requestId") ?? null,
      apiKeyId: c.get("apiKeyId") ?? null,
      requestCommitment: options.requestCommitment,
      audit: (event) => recordAudit(options.db, {
        id: event.id,
        tenantId: event.tenantId,
        actor: "operator",
        principalId: event.actorId,
        apiKeyId: event.apiKeyId,
        requestId: event.requestId,
        action: event.action,
        resourceType: "secret_lifecycle",
        resourceId: event.credentialId,
        metadata: event.metadata,
      }),
      ...(c.get("authMethod") ? {
        revalidateAuthority: (requiredRole: "admin" | "owner") => currentAuthorityVersion(options.db, {
          tenantId: principal.tenantId,
          actorId: c.get("authorityPrincipalId") ?? c.get("trustPrincipalId") ?? principal.id,
          credentialPrincipalId: c.get("trustPrincipalId") ?? principal.id,
          apiKeyId: c.get("apiKeyId") ?? null,
          requiredRole,
        }),
      } : {}),
    });
  }

  routes.post("/", async (c) => {
    try {
      const raw = await requestBody(c, CREATE_FIELDS);
      const expiresAt = timestamp(raw.expiresAt, "secret_expires_at_invalid");
      const rotateAfter = timestamp(raw.rotateAfter, "secret_rotate_after_invalid");
      if (expiresAt && rotateAfter && Date.parse(rotateAfter) >= Date.parse(expiresAt)) {
        throw new Error("secret_timestamp_order_invalid");
      }
      if (!Array.isArray(raw.audiences) || raw.audiences.length < 1 || raw.audiences.length > 64) {
        throw new Error("secret_audiences_invalid");
      }
      const audiences = raw.audiences.map((audience) => identifier(audience, "secret_audiences_invalid"));
      const sourceRef = text(raw.sourceRef, "secret_source_reference_invalid", 512);
      if (!SOURCE_REF.test(sourceRef)) throw new Error("secret_source_reference_invalid");
      const body = {
        credentialId: identifier(raw.credentialId, "secret_credential_id_invalid"),
        sourceRef,
        plaintext: text(raw.plaintext, "secret_rotation_material_required", 1_048_576),
        audiences,
        ...(expiresAt ? { expiresAt } : {}),
        ...(rotateAfter ? { rotateAfter } : {}),
        key: keyLocator(raw.key),
      };
      const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
      const result = await service(c).create({ ...body, idempotencyKey });
      return c.json(result, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/rotate", async (c) => {
    try {
      const raw = await requestBody(c, ROTATE_FIELDS);
      const body = {
        expectedGeneration: generation(raw.expectedGeneration),
        plaintext: text(raw.plaintext, "secret_rotation_material_required", 1_048_576),
        key: keyLocator(raw.key),
      };
      const result = await service(c).rotate({
        ...body,
        credentialId: identifier(c.req.param("id"), "secret_credential_id_invalid"),
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      return c.json(result);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/rewrap", async (c) => {
    try {
      const raw = await requestBody(c, REWRAP_FIELDS);
      const body = { expectedGeneration: generation(raw.expectedGeneration), key: keyLocator(raw.key) };
      const result = await service(c).rewrap({
        ...body,
        credentialId: identifier(c.req.param("id"), "secret_credential_id_invalid"),
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      return c.json(result);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/revoke", async (c) => {
    try {
      const raw = await requestBody(c, REVOKE_FIELDS);
      const body = {
        generation: generation(raw.generation),
        reason: text(raw.reason, "secret_revocation_reason_invalid", MAX_REASON_CHARS).trim(),
      };
      if (!body.reason) throw new Error("secret_revocation_reason_required");
      return c.json(service(c).revoke({
        credentialId: identifier(c.req.param("id"), "secret_credential_id_invalid"),
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
        ...body,
      }));
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/break-glass", async (c) => {
    let reason: unknown;
    try {
      const body = await requestBody(c, BREAK_GLASS_FIELDS);
      reason = text(body.reason, "secret_break_glass_reason_invalid", MAX_REASON_CHARS);
      const plaintext = await service(c).breakGlass({
        credentialId: identifier(c.req.param("id"), "secret_credential_id_invalid"),
        reason,
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      c.header("Cache-Control", "no-store");
      return c.json({ secret: plaintext });
    } catch (error) {
      if (!isAuditedBreakGlassError(error)) {
        const principal = c.get("principal");
        try {
          recordAudit(options.db, {
            tenantId: principal?.tenantId || "tenant_unattributed",
            actor: "operator",
            principalId: c.get("authorityPrincipalId") ?? c.get("trustPrincipalId") ?? principal?.id ?? null,
            apiKeyId: c.get("apiKeyId") ?? null,
            requestId: c.get("requestId") ?? null,
            action: "secret.break_glass.denied",
            resourceType: "secret_lifecycle",
            resourceId: BOUNDED_ID.test(c.req.param("id")) ? c.req.param("id") : null,
            metadata: {
              outcome: "denied",
              failure: error instanceof Error ? error.message : "secret_break_glass_denied",
              role: principal?.role ?? null,
              tenantId: principal?.tenantId ?? null,
              actorId: c.get("authorityPrincipalId") ?? c.get("trustPrincipalId") ?? principal?.id ?? null,
              authorityPrincipalId: c.get("authorityPrincipalId") ?? null,
              credentialPrincipalId: c.get("trustPrincipalId") ?? null,
              requestId: c.get("requestId") ?? null,
              reason: typeof reason === "string" && reason.length <= MAX_REASON_CHARS
                ? reason.trim() || null
                : null,
              idempotencyKey: BOUNDED_ID.test(c.req.header("Idempotency-Key") ?? "")
                ? c.req.header("Idempotency-Key")!
                : null,
            },
          });
          c.set("secretBreakGlassAuditHandled", true);
        } catch {
          return mappedErrorResponse(c, new Error("vault_access_audit_failed"), ERRORS);
        }
      } else {
        c.set("secretBreakGlassAuditHandled", true);
      }
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  return routes;
}
