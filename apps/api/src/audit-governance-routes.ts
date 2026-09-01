import { randomUUID } from "node:crypto";
import { Hono, type Context, type Next } from "hono";
import {
  createAuditExportManifest,
  createAuditLegalHold,
  getAuditExportManifest,
  listAuditExportDestinations,
  listAuditLegalHolds,
  listAuditRetentionDecisions,
  recordAudit,
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

type AuditInput = Parameters<typeof recordAudit>[1];

export type AuditGovernanceRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => string;
  createId?: () => string;
  audit?: (input: AuditInput) => void;
}>;

/** Resource type every audit-control-plane event is filed under. */
const AUDIT_RESOURCE_TYPE = "audit_governance";

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

/**
 * Audit-control-plane denials that never reach a handler.
 *
 * `principalForMutation` and the global auth middleware can both answer 401/403
 * before any route body runs, and every store mutation is wrapped in a
 * transaction that rolls back on throw. Without this the control plane could not
 * answer "who tried to change this and was refused" — the one question it exists
 * to answer. Mirrors `createSecretBreakGlassDenialAuditMiddleware`.
 */
export function createAuditGovernanceDenialAuditMiddleware(options: Readonly<{
  db: AppDb;
  audit?: (input: AuditInput) => void;
}>) {
  const audit = options.audit ?? ((input: AuditInput) => recordAudit(options.db, input));
  return async (c: Context<ApiEnv>, next: Next) => {
    const path = new URL(c.req.url).pathname;
    if (c.req.method !== "POST" || !/^\/audit-governance(?:\/|$)/u.test(path)) return next();
    await next();
    if ((c.res.status !== 401 && c.res.status !== 403) ||
      c.get("auditGovernanceAuditHandled")) {
      return;
    }
    const principal = c.get("principal");
    const target = auditGovernanceTarget(path);
    try {
      audit({
        tenantId: principal?.tenantId || "tenant_unattributed",
        actor: "system",
        principalId: principal?.id ?? c.get("authorityPrincipalId") ?? null,
        apiKeyId: c.get("apiKeyId") ?? null,
        requestId: c.get("requestId") ?? null,
        action: "audit.governance.denied",
        resourceType: AUDIT_RESOURCE_TYPE,
        resourceId: target.resourceId,
        metadata: {
          outcome: "denied",
          failure: principal ? "authorization_denied" : "authentication_denied",
          status: c.res.status,
          collection: target.collection,
          role: principal?.role ?? null,
          tenantId: principal?.tenantId ?? null,
          requestId: c.get("requestId") ?? null,
        },
      });
      c.set("auditGovernanceAuditHandled", true);
    } catch {
      c.set("auditGovernanceAuditHandled", true);
      c.res = c.json({ error: "service_unavailable" }, 503);
    }
  };
}

function auditGovernanceTarget(path: string): Readonly<{
  collection: string | null;
  resourceId: string | null;
}> {
  const match = /^\/audit-governance\/([^/]+)(?:\/([^/]+))?/u.exec(path);
  const collection = match?.[1] ?? null;
  const resource = match?.[2];
  return Object.freeze({
    collection: collection && RESOURCE_ID.test(collection) ? collection : null,
    resourceId: resource && RESOURCE_ID.test(resource) ? resource : null,
  });
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
  const audit = options.audit ?? ((input: AuditInput) => recordAudit(options.db, input));

  /** File one control-plane attempt against the tenant audit chain. */
  function record(c: Context<ApiEnv>, input: Readonly<{
    principal?: Principal;
    action: string;
    resourceId: string | null;
    outcome: "allowed" | "denied";
    failure?: string;
    status?: number;
    detail?: Readonly<Record<string, unknown>>;
  }>): void {
    audit({
      tenantId: input.principal?.tenantId || "tenant_unattributed",
      actor: "operator",
      principalId: input.principal?.id ?? null,
      apiKeyId: c.get("apiKeyId") ?? null,
      requestId: c.get("requestId") ?? null,
      action: input.action,
      resourceType: AUDIT_RESOURCE_TYPE,
      resourceId: input.resourceId !== null && RESOURCE_ID.test(input.resourceId)
        ? input.resourceId
        : null,
      metadata: {
        outcome: input.outcome,
        failure: input.failure ?? null,
        status: input.status ?? null,
        role: input.principal?.role ?? null,
        tenantId: input.principal?.tenantId ?? null,
        requestId: c.get("requestId") ?? null,
        ...input.detail,
      },
    });
    c.set("auditGovernanceAuditHandled", true);
  }

  /**
   * Record the refusal, then answer with the caller's own response body. Denials
   * are filed outside the store transaction so a rolled-back mutation still
   * leaves the attempt visible.
   */
  function deny(c: Context<ApiEnv>, input: Readonly<{
    principal?: Principal;
    action: string;
    resourceId: string | null;
    failure: string;
    response: Response;
  }>): Response {
    record(c, {
      principal: input.principal,
      action: input.action,
      resourceId: input.resourceId,
      outcome: "denied",
      failure: input.failure,
      status: input.response.status,
    });
    return input.response;
  }

  /**
   * Commit a store mutation and its evidence together. The store's own
   * `transaction` helper is re-entrant, so opening the transaction here makes
   * "no accepted mutation without evidence" exact rather than best effort: if
   * the audit write fails, the mutation rolls back with it.
   */
  function auditedMutation<T>(operation: () => T): T {
    const raw = options.db.raw;
    const owns = !raw.isTransaction;
    if (owns) raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      if (owns) raw.exec("COMMIT");
      return result;
    } catch (error) {
      if (owns && raw.isTransaction) raw.exec("ROLLBACK");
      throw error;
    }
  }

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
    const principal = auth.principal;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.denied",
        resourceId: null,
        failure: "idempotency_key_required",
        response: c.json({ error: "idempotency_key_required" }, 400),
      });
    }
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const reason = requiredText(body?.reason);
    const resourceType = optionalText(body?.resourceType);
    const resourceId = optionalText(body?.resourceId);
    const ids = eventIds(body?.eventIds);
    const holdId = optionalId(body?.holdId);
    if (!body || !reason || resourceType === undefined || resourceId === undefined ||
      ids === null || holdId === null) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.denied",
        resourceId: null,
        failure: "audit_hold_input_invalid",
        response: c.json({ error: "audit_hold_input_invalid" }, 400),
      });
    }
    const requestedHoldId = holdId ?? createId();
    try {
      const event = auditedMutation(() => {
        const created = createAuditLegalHold(options.db, {
          id: createId(),
          holdId: requestedHoldId,
          tenantId: principal.tenantId,
          reason,
          resourceType,
          resourceId,
          eventIds: ids,
          actorId: principal.id,
          idempotencyKey: key,
          createdAt: clock(),
        });
        record(c, {
          principal,
          action: "audit.legal_hold.created",
          resourceId: created.hold_id,
          outcome: "allowed",
          status: 201,
          detail: { holdEventId: created.id, sequence: created.sequence },
        });
        return created;
      });
      return c.json({ legalHold: event }, 201);
    } catch (error) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.denied",
        resourceId: requestedHoldId,
        failure: error instanceof Error ? error.message : "audit_hold_failed",
        response: mappedErrorResponse(c, error, INPUT_ERRORS),
      });
    }
  });

  routes.post("/legal-holds/:id/release", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const principal = auth.principal;
    const holdId = c.req.param("id");
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.release_denied",
        resourceId: holdId,
        failure: "idempotency_key_required",
        response: c.json({ error: "idempotency_key_required" }, 400),
      });
    }
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const reason = requiredText(body?.reason);
    if (!reason) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.release_denied",
        resourceId: holdId,
        failure: "reason_required",
        response: c.json({ error: "reason_required" }, 400),
      });
    }
    try {
      const event = auditedMutation(() => {
        const released = releaseAuditLegalHold(options.db, {
          id: createId(),
          holdId,
          tenantId: principal.tenantId,
          reason,
          actorId: principal.id,
          idempotencyKey: key,
          createdAt: clock(),
        });
        record(c, {
          principal,
          action: "audit.legal_hold.released",
          resourceId: released.hold_id,
          outcome: "allowed",
          status: 200,
          detail: { holdEventId: released.id, sequence: released.sequence },
        });
        return released;
      });
      return c.json({ legalHold: event });
    } catch (error) {
      return deny(c, {
        principal,
        action: "audit.legal_hold.release_denied",
        resourceId: holdId,
        failure: error instanceof Error ? error.message : "audit_hold_release_failed",
        response: mappedErrorResponse(c, error, INPUT_ERRORS),
      });
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
    const principal = auth.principal;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) {
      return deny(c, {
        principal,
        action: "audit.export_destination.denied",
        resourceId: null,
        failure: "idempotency_key_required",
        response: c.json({ error: "idempotency_key_required" }, 400),
      });
    }
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const uri = requiredText(body?.uri);
    const destinationId = optionalId(body?.destinationId);
    if (!uri || destinationId === null) {
      return deny(c, {
        principal,
        action: "audit.export_destination.denied",
        resourceId: null,
        failure: "audit_destination_input_invalid",
        response: c.json({ error: "audit_destination_input_invalid" }, 400),
      });
    }
    const requestedDestinationId = destinationId ?? createId();
    try {
      const event = auditedMutation(() => {
        const registered = registerAuditExportDestination(options.db, {
          id: createId(),
          destinationId: requestedDestinationId,
          tenantId: principal.tenantId,
          uri,
          actorId: principal.id,
          idempotencyKey: key,
          createdAt: clock(),
        });
        record(c, {
          principal,
          action: "audit.export_destination.registered",
          resourceId: registered.destination_id,
          outcome: "allowed",
          status: 201,
          detail: { destinationEventId: registered.id, sequence: registered.sequence },
        });
        return registered;
      });
      return c.json({ destination: event }, 201);
    } catch (error) {
      return deny(c, {
        principal,
        action: "audit.export_destination.denied",
        resourceId: requestedDestinationId,
        failure: error instanceof Error ? error.message : "audit_destination_failed",
        response: mappedErrorResponse(c, error, INPUT_ERRORS),
      });
    }
  });

  routes.post("/destinations/:id/revoke", async (c) => {
    const auth = principalForMutation(c);
    if (!auth.ok) return auth.response;
    const principal = auth.principal;
    const destinationId = c.req.param("id");
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) {
      return deny(c, {
        principal,
        action: "audit.export_destination.revoke_denied",
        resourceId: destinationId,
        failure: "idempotency_key_required",
        response: c.json({ error: "idempotency_key_required" }, 400),
      });
    }
    try {
      const event = auditedMutation(() => {
        const revoked = revokeAuditExportDestination(options.db, {
          id: createId(),
          destinationId,
          tenantId: principal.tenantId,
          actorId: principal.id,
          idempotencyKey: key,
          createdAt: clock(),
        });
        record(c, {
          principal,
          action: "audit.export_destination.revoked",
          resourceId: revoked.destination_id,
          outcome: "allowed",
          status: 200,
          detail: { destinationEventId: revoked.id, sequence: revoked.sequence },
        });
        return revoked;
      });
      return c.json({ destination: event });
    } catch (error) {
      return deny(c, {
        principal,
        action: "audit.export_destination.revoke_denied",
        resourceId: destinationId,
        failure: error instanceof Error ? error.message : "audit_destination_revoke_failed",
        response: mappedErrorResponse(c, error, INPUT_ERRORS),
      });
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
    const principal = auth.principal;
    const key = idempotencyKey(c.req.header("Idempotency-Key"));
    if (!key) {
      return deny(c, {
        principal,
        action: "audit.export.denied",
        resourceId: null,
        failure: "idempotency_key_required",
        response: c.json({ error: "idempotency_key_required" }, 400),
      });
    }
    const body = bodyObject(await c.req.json<unknown>().catch(() => null));
    const destinationId = requiredText(body?.destinationId);
    const exportId = optionalId(body?.exportId);
    const profile = body?.redactionProfile;
    const limit = body?.limit === undefined ? 2000 : body.limit;
    if (!destinationId || exportId === null || !["support", "security", "minimal"].includes(String(profile)) ||
      !Number.isSafeInteger(limit)) {
      return deny(c, {
        principal,
        action: "audit.export.denied",
        resourceId: null,
        failure: "audit_export_input_invalid",
        response: c.json({ error: "audit_export_input_invalid" }, 400),
      });
    }
    const requestedExportId = exportId ?? createId();
    try {
      const output = auditedMutation(() => {
        const created = createAuditExportManifest(options.db, {
          id: requestedExportId,
          tenantId: principal.tenantId,
          destinationId,
          requestedByActorId: principal.id,
          redactionProfile: profile as "support" | "security" | "minimal",
          limit: limit as number,
          idempotencyKey: key,
          createdAt: clock(),
        });
        record(c, {
          principal,
          action: "audit.export.created",
          resourceId: created.manifest.id,
          outcome: "allowed",
          status: 201,
          detail: {
            destinationId: created.manifest.destination_id,
            redactionProfile: created.manifest.redaction_profile,
            recordCount: created.manifest.record_count,
            exportSha256: created.manifest.export_sha256,
          },
        });
        return created;
      });
      c.header("Cache-Control", "no-store");
      return c.json(output, 201);
    } catch (error) {
      return deny(c, {
        principal,
        action: "audit.export.denied",
        resourceId: requestedExportId,
        failure: error instanceof Error ? error.message : "audit_export_failed",
        response: mappedErrorResponse(c, error, INPUT_ERRORS),
      });
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
