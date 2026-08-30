import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  createAuditExportManifest,
  createAuditLegalHold,
  getAuditExportManifest,
  listAuditExportDestinations,
  listAuditLegalHolds,
  listAuditRetentionDecisions,
  registerAuditExportDestination,
  releaseAuditLegalHold,
  revokeAuditExportDestination,
  verifyStoredAuditExport,
  verifyAuditGovernanceIntegrity,
  type AppDb,
} from "@mendpoint/db";
import { nowIso } from "@mendpoint/shared";
import type { Principal } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse } from "./error-boundary.js";

export type AuditGovernanceRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => string;
  createId?: () => string;
}>;

const INPUT_ERRORS = [
  { internalCode: "audit_hold_id_invalid", status: 400 as const },
  { internalCode: "audit_hold_scope_invalid", status: 400 as const },
  { internalCode: "audit_hold_scope_required", status: 400 as const },
  { internalCode: "audit_hold_reason_invalid", status: 400 as const },
  { internalCode: "audit_hold_event_id_invalid", status: 400 as const },
  { internalCode: "audit_hold_event_not_found", status: 404 as const },
  { internalCode: "audit_hold_not_found", status: 404 as const },
  { internalCode: "audit_hold_exists", status: 409 as const },
  { internalCode: "audit_hold_not_active", status: 409 as const },
  { internalCode: "audit_hold_idempotency_conflict", status: 409 as const },
  { internalCode: "audit_destination_id_invalid", status: 400 as const },
  { internalCode: "audit_destination_exists", status: 409 as const },
  { internalCode: "audit_destination_not_found", status: 404 as const },
  { internalCode: "audit_destination_not_active", status: 409 as const },
  { internalCode: "audit_destination_idempotency_conflict", status: 409 as const },
  { internalCode: "audit_export_destination_invalid", status: 400 as const },
  { internalCode: "audit_export_destination_tenant_mismatch", status: 403 as const },
  { internalCode: "audit_export_id_invalid", status: 400 as const },
  { internalCode: "audit_export_limit_invalid", status: 400 as const },
  { internalCode: "audit_export_idempotency_conflict", status: 409 as const },
  { internalCode: "audit_retention_at_invalid", status: 400 as const },
  { internalCode: "audit_retention_limit_invalid", status: 400 as const },
  { internalCode: "audit_source_integrity_invalid", status: 409 as const },
  { internalCode: "audit_governance_integrity_invalid", status: 409 as const },
];

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024
    ? value : null;
}

function optionalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return requiredText(value) ?? undefined;
}

function eventIds(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 500 ||
    value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  return Object.freeze([...new Set(value as string[])].sort());
}

function idempotencyKey(header: string | undefined): string | null {
  return typeof header === "string" && RESOURCE_ID.test(header) ? header : null;
}

function optionalId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && RESOURCE_ID.test(value) ? value : null;
}

type MutationAuthority =
  | Readonly<{ ok: true; principal: Principal }>
  | Readonly<{ ok: false; response: Response }>;

function principalForMutation(c: Context<ApiEnv>): MutationAuthority {
  const principal = c.get("principal");
  if (!principal) return { ok: false, response: c.json({ error: "authenticated_principal_required" }, 401) };
  if (principal.role !== "owner" && principal.role !== "admin") {
    return { ok: false, response: c.json({ error: "tenant_administration_required" }, 403) };
  }
  return { ok: true, principal };
}

export function createAuditGovernanceRoutes(options: AuditGovernanceRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const clock = options.now ?? nowIso;
  const createId = options.createId ?? randomUUID;

  routes.get("/legal-holds", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const integrity = verifyAuditGovernanceIntegrity(options.db, principal.tenantId);
    if (!integrity.ok) return c.json({ error: "audit_governance_integrity_invalid" }, 409);
    c.header("Cache-Control", "no-store");
    return c.json({ data: listAuditLegalHolds(options.db, principal.tenantId) });
  });

  routes.post("/legal-holds", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const reason = requiredText(body?.reason);
    const resourceType = optionalText(body?.resourceType);
    const resourceId = optionalText(body?.resourceId);
    const ids = eventIds(body?.eventIds);
    const holdId = optionalId(body?.holdId);
    if (!body || !reason || resourceType === undefined || resourceId === undefined ||
      ids === null || holdId === null) {
      return c.json({ error: "audit_hold_input_invalid" }, 400);
    }
    try {
      const event = createAuditLegalHold(options.db, {
        id: createId(),
        holdId: holdId ?? createId(),
        tenantId: auth.principal.tenantId,
        reason,
        resourceType,
        resourceId,
        eventIds: ids,
        actorId: auth.principal.id,
        idempotencyKey: key,
        createdAt: clock(),
      });
      return c.json({ legalHold: event }, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.post("/legal-holds/:id/release", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const reason = requiredText(body?.reason);
    if (!reason) return c.json({ error: "reason_required" }, 400);
    try {
      const event = releaseAuditLegalHold(options.db, {
        id: createId(),
        holdId: c.req.param("id"),
        tenantId: auth.principal.tenantId,
        reason,
        actorId: auth.principal.id,
        idempotencyKey: key,
        createdAt: clock(),
      });
      return c.json({ legalHold: event });
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.get("/destinations", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const integrity = verifyAuditGovernanceIntegrity(options.db, principal.tenantId);
    if (!integrity.ok) return c.json({ error: "audit_governance_integrity_invalid" }, 409);
    c.header("Cache-Control", "no-store");
    return c.json({ data: listAuditExportDestinations(options.db, principal.tenantId) });
  });

  routes.post("/destinations", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const uri = requiredText(body?.uri);
    const destinationId = optionalId(body?.destinationId);
    if (!uri || destinationId === null) return c.json({ error: "audit_destination_input_invalid" }, 400);
    try {
      const event = registerAuditExportDestination(options.db, {
        id: createId(),
        destinationId: destinationId ?? createId(),
        tenantId: auth.principal.tenantId,
        uri,
        actorId: auth.principal.id,
        idempotencyKey: key,
        createdAt: clock(),
      });
      return c.json({ destination: event }, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.post("/destinations/:id/revoke", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    try {
      const event = revokeAuditExportDestination(options.db, {
        id: createId(),
        destinationId: c.req.param("id"),
        tenantId: auth.principal.tenantId,
        actorId: auth.principal.id,
        idempotencyKey: key,
        createdAt: clock(),
      });
      return c.json({ destination: event });
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.get("/retention", (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const at = c.req.query("at") ?? clock();
    const requestedLimit = c.req.query("limit");
    const limit = requestedLimit === undefined ? 5000 : Number(requestedLimit);
    try {
      const integrity = verifyAuditGovernanceIntegrity(options.db, auth.principal.tenantId);
      if (!integrity.ok) return c.json({ error: "audit_governance_integrity_invalid" }, 409);
      c.header("Cache-Control", "no-store");
      return c.json({
        evaluatedAt: at,
        data: listAuditRetentionDecisions(options.db, auth.principal.tenantId, at, limit),
      });
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.post("/exports", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) return c.json({ error: "idempotency_key_required" }, 400);
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const destinationId = requiredText(body?.destinationId);
    const exportId = optionalId(body?.exportId);
    const profile = body?.redactionProfile;
    const limit = body?.limit === undefined ? 2000 : body.limit;
    if (!destinationId || exportId === null || !["support", "security", "minimal"].includes(String(profile)) ||
      !Number.isSafeInteger(limit)) return c.json({ error: "audit_export_input_invalid" }, 400);
    try {
      const output = createAuditExportManifest(options.db, {
        id: exportId ?? createId(),
        tenantId: auth.principal.tenantId,
        destinationId,
        requestedByActorId: auth.principal.id,
        redactionProfile: profile as "support" | "security" | "minimal",
        limit: limit as number,
        idempotencyKey: key,
        createdAt: clock(),
      });
      c.header("Cache-Control", "no-store");
      return c.json(output, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, INPUT_ERRORS);
    }
  });

  routes.get("/exports/:id", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const verification = verifyStoredAuditExport(options.db, principal.tenantId, c.req.param("id"));
    if (verification.error === "audit_export_not_found") return c.json({ error: "not_found" }, 404);
    if (!verification.ok) return c.json({ error: "audit_export_replay_invalid" }, 409);
    const output = getAuditExportManifest(options.db, principal.tenantId, c.req.param("id"));
    if (!output) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "no-store");
    return c.json(output);
  });

  routes.get("/exports/:id/replay", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const verification = verifyStoredAuditExport(options.db, principal.tenantId, c.req.param("id"));
    c.header("Cache-Control", "no-store");
    return c.json(verification, verification.error === "audit_export_not_found" ? 404 : verification.ok ? 200 : 409);
  });

  return routes;
}
