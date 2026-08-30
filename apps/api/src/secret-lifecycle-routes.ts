import { Hono, type Context } from "hono";
import { recordAudit, type AppDb } from "@mendpoint/db";
import type { EnvelopeKeyLocator, KeyEncryptionKeyProvider } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";
import { DurableSecretLifecycleService } from "./secret-lifecycle-service.js";

const ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "authenticated_principal_required", publicCode: "unauthorized", status: 401 },
  { internalCode: "secret_lifecycle_authority_required", publicCode: "forbidden", status: 403 },
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
}>) {
  const routes = new Hono<ApiEnv>();

  function service(c: Context<ApiEnv>) {
    const principal = c.get("principal");
    if (!principal) throw new Error("authenticated_principal_required");
    return new DurableSecretLifecycleService({
      db: options.db,
      tenantId: principal.tenantId,
      actorId: c.get("trustPrincipalId") ?? principal.id,
      role: principal.role,
      providers: options.providers,
      breakGlassEnabled: options.breakGlassEnabled,
      audit: (event) => recordAudit(options.db, {
        id: event.id,
        tenantId: event.tenantId,
        actor: "operator",
        principalId: event.actorId,
        apiKeyId: c.get("apiKeyId") ?? null,
        requestId: c.get("requestId") ?? null,
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
      const body = await c.req.json<{ expectedGeneration: number; key: EnvelopeKeyLocator }>();
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

  routes.post("/:id/revoke", async (c) => {
    try {
      const body = await c.req.json<{ generation: number; reason: string }>();
      return c.json(service(c).revoke({ credentialId: c.req.param("id"), ...body }));
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  routes.post("/:id/break-glass", async (c) => {
    try {
      const body = await c.req.json<{ reason: string }>();
      const plaintext = await service(c).breakGlass({
        credentialId: c.req.param("id"),
        reason: body.reason,
        idempotencyKey: c.req.header("Idempotency-Key") ?? "",
      });
      c.header("Cache-Control", "no-store");
      return c.json({ secret: plaintext });
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });

  return routes;
}
