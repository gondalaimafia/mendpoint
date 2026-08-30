import { Hono, type Context, type Next } from "hono";
import { recordAudit, type AppDb } from "@mendpoint/db";
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
  { internalCode: "vault_provider_disabled", status: 503 },
  { internalCode: "external_vault_key_not_attested", status: 503 },
  { internalCode: "vault_key_attestation_mismatch", status: 503 },
  { internalCode: "secret_lifecycle_idempotency_key_invalid", status: 400 },
  { internalCode: "secret_lifecycle_request_digest_invalid", status: 400 },
  { internalCode: "secret_lifecycle_commitment_unconfigured", status: 503 },
  { internalCode: "secret_rotation_material_required", status: 400 },
  { internalCode: "secret_rotation_material_unchanged", status: 409 },
  { internalCode: "secret_material_lineage_missing", status: 409 },
  { internalCode: "secret_break_glass_generation_inactive", status: 409 },
  { internalCode: "vault_access_audit_failed", status: 503 },
  { internalCode: "secret_credential_id_invalid", status: 400 },
  { internalCode: "secret_source_reference_invalid", status: 400 },
  { internalCode: "secret_audiences_invalid", status: 400 },
  { internalCode: "secret_revocation_reason_required", status: 400 },
  { internalCode: "secret_break_glass_reason_required", status: 400 },
];

export function createSecretLifecycleRoutes(options: Readonly<{
  db: AppDb;
  providers: readonly KeyEncryptionKeyProvider[];
  breakGlassEnabled: boolean;
  requestCommitment?: SecretLifecycleRequestCommitment;
}>) {
  assertSecretLifecycleKeySeparation(options.providers, options.requestCommitment);
  const routes = new Hono<ApiEnv>();

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
    });
  }

  routes.post("/", async (c) => {
    try {
      const body = await c.req.json<{
        credentialId: string;
        sourceRef: string;
        plaintext: string;
        audiences: string[];
        expiresAt?: string;
        rotateAfter?: string;
        key: EnvelopeKeyLocator;
      }>();
      const idempotencyKey = c.req.header("Idempotency-Key") ?? "";
      const result = await service(c).create({ ...body, idempotencyKey });
      return c.json(result, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/rotate", async (c) => {
    try {
      const body = await c.req.json<{
        expectedGeneration: number;
        plaintext: string;
        key: EnvelopeKeyLocator;
      }>();
      const result = await service(c).rotate({
        ...body,
        credentialId: c.req.param("id"),
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      return c.json(result);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/rewrap", async (c) => {
    try {
      const body = await c.req.json<{ expectedGeneration: number; key: EnvelopeKeyLocator }>();
      const result = await service(c).rewrap({
        ...body,
        credentialId: c.req.param("id"),
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      return c.json(result);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/revoke", async (c) => {
    try {
      const body = await c.req.json<{ generation: number; reason: string }>();
      return c.json(service(c).revoke({
        credentialId: c.req.param("id"),
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
      const body = await c.req.json<unknown>();
      reason = body !== null && typeof body === "object"
        ? (body as { reason?: unknown }).reason
        : undefined;
      const plaintext = await service(c).breakGlass({
        credentialId: c.req.param("id"),
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
            resourceId: c.req.param("id") || null,
            metadata: {
              outcome: "denied",
              failure: error instanceof Error ? error.message : "secret_break_glass_denied",
              role: principal?.role ?? null,
              tenantId: principal?.tenantId ?? null,
              actorId: c.get("authorityPrincipalId") ?? c.get("trustPrincipalId") ?? principal?.id ?? null,
              authorityPrincipalId: c.get("authorityPrincipalId") ?? null,
              credentialPrincipalId: c.get("trustPrincipalId") ?? null,
              requestId: c.get("requestId") ?? null,
              reason: typeof reason === "string" ? reason.trim() || null : null,
              idempotencyKey: c.req.header("Idempotency-Key") ?? null,
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
