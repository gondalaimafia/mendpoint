import type { Context } from "hono";
import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { ApiEnv } from "./auth.js";
import {
  createDesignPartnerApplicationStore,
  type ApplicationSourceMetadata,
  type DesignPartnerApplicationStore,
} from "./design-partner-applications-store.js";
import { recordAudit, type AppDb } from "@mendpoint/db";

const MAX_APPLICATION_BYTES = 16 * 1_024;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export type DesignPartnerApplicationRoutesOptions = Readonly<{
  db: AppDb;
  store?: DesignPartnerApplicationStore;
  key?: Buffer | string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  createId?: () => string;
  rateLimit?: number;
  rateWindowMs?: number;
  retentionMs?: number;
}>;

function authenticatedPrincipal(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  if (!principal) throw new Error("application_authentication_required");
  return principal;
}

function requestId(c: Context<ApiEnv>): string {
  const value = c.get("requestId") || c.req.header("X-Request-Id") || "";
  if (!REQUEST_ID_PATTERN.test(value)) throw new Error("application_request_id_invalid");
  return value;
}

function boundedHeader(c: Context<ApiEnv>, name: string, max: number): string | null {
  const value = c.req.header(name)?.trim();
  if (!value || value.length > max || /[\r\n\0]/.test(value)) return null;
  return value;
}

function sourceMetadata(c: Context<ApiEnv>): ApplicationSourceMetadata {
  const bridge = boundedHeader(c, "X-Mendpoint-Application-Bridge", 64);
  const origin = boundedHeader(c, "X-Mendpoint-Application-Origin", 256);
  const referrerPath = boundedHeader(c, "X-Mendpoint-Application-Referrer-Path", 512);
  return {
    bridge: bridge === "public-design-partner-v1" ? bridge : null,
    origin: origin && /^https?:\/\/[^/?#]+$/i.test(origin) ? origin : null,
    referrerPath: referrerPath?.startsWith("/") ? referrerPath : null,
    userAgent: boundedHeader(c, "User-Agent", 256),
  };
}

async function applicationBody(c: Context<ApiEnv>): Promise<unknown> {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("application_content_type_invalid");
  const declaredLength = c.req.header("Content-Length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isFinite(length) || length < 0) throw new Error("application_content_length_invalid");
    if (length > MAX_APPLICATION_BYTES) throw new Error("application_payload_too_large");
  }
  const text = await c.req.text();
  if (Buffer.byteLength(text, "utf8") > MAX_APPLICATION_BYTES) {
    throw new Error("application_payload_too_large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("application_payload_invalid");
  }
}

function errorResponse(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "application_internal_error";
  if (code === "application_authentication_required") {
    return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
  }
  if (code === "application_admin_required") {
    return c.json({ error: { code: "forbidden", message: "Administrative access is required" } }, 403);
  }
  if (code === "application_not_found") {
    return c.json({ error: { code: "not_found", message: "Application was not found" } }, 404);
  }
  if (code === "application_payload_erased" || code === "application_payload_expired") {
    return c.json({ error: { code, message: "Application payload is no longer available" } }, 410);
  }
  if (code === "application_payload_too_large") {
    return c.json({ error: { code, message: "Application payload is too large" } }, 413);
  }
  if (code === "application_rate_limited") {
    c.header("Retry-After", "86400");
    return c.json({ error: { code, message: "Application rate limit reached" } }, 429);
  }
  if (code === "application_idempotency_conflict" || code === "application_duplicate_rejected") {
    return c.json({ error: { code, message: "Application conflicts with an earlier submission" } }, 409);
  }
  if (
    code === "application_audit_callback_required" ||
    code === "application_data_key_envelope_invalid" ||
    code === "application_payload_envelope_invalid" ||
    code === "application_payload_key_missing" ||
    code === "application_retention_evidence_missing"
  ) {
    return c.json({ error: { code: "internal_error", message: "Application operation failed" } }, 500);
  }
  if (code.startsWith("application_")) {
    return c.json({ error: { code, message: "Application was rejected" } }, 422);
  }
  return c.json({ error: { code: "internal_error", message: "Application operation failed" } }, 500);
}

function requireAdmin(c: Context<ApiEnv>) {
  const principal = authenticatedPrincipal(c);
  if (principal.role !== "owner" && principal.role !== "admin") {
    throw new Error("application_admin_required");
  }
  return principal;
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("application_payload_invalid");
  }
  return value as Record<string, unknown>;
}

function auditId(prefix: string, tenantId: string, id: string): string {
  return `${prefix}-${createHash("sha256").update(`${tenantId}\n${id}`, "utf8").digest("hex").slice(0, 40)}`;
}

export function createDesignPartnerApplicationRoutes(
  options: DesignPartnerApplicationRoutesOptions,
): Hono<ApiEnv> {
  const store = options.store ?? createDesignPartnerApplicationStore({
    db: options.db,
    key: options.key,
    env: options.env,
    now: options.now,
    createId: options.createId,
    rateLimit: options.rateLimit,
    rateWindowMs: options.rateWindowMs,
    retentionMs: options.retentionMs,
  });
  const routes = new Hono<ApiEnv>({ strict: false });

  routes.use("*", async (c, next) => {
    if (!c.get("principal")) {
      return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
    }
    return next();
  });

  routes.post("/", async (c) => {
    try {
      const principal = authenticatedPrincipal(c);
      const result = store.create({
        tenantId: principal.tenantId,
        actorPrincipalId: principal.id,
        requestId: requestId(c),
        body: await applicationBody(c),
        source: sourceMetadata(c),
      });
      return c.json({ data: { applicationId: result.application.id } }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/", (c) => {
    try {
      const principal = requireAdmin(c);
      const rawLimit = Number(c.req.query("limit") ?? "50");
      const limit = Number.isFinite(rawLimit) ? rawLimit : 50;
      return c.json({ data: store.list(principal.tenantId, limit) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/:id", (c) => {
    try {
      const principal = requireAdmin(c);
      const application = store.get(principal.tenantId, c.req.param("id"));
      if (!application) throw new Error("application_not_found");
      return c.json({ data: application });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:id/reveals", async (c) => {
    try {
      const principal = requireAdmin(c);
      const body = objectBody(await applicationBody(c));
      const purposeCode = body.purposeCode;
      if (
        purposeCode !== "application_review" &&
        purposeCode !== "applicant_follow_up" &&
        purposeCode !== "privacy_request"
      ) {
        throw new Error("application_reveal_purpose_invalid");
      }
      const result = store.reveal({
        tenantId: principal.tenantId,
        actorPrincipalId: principal.id,
        requestId: requestId(c),
        applicationId: c.req.param("id"),
        purposeCode,
      }, (event) => {
        recordAudit(options.db, {
          id: event.id,
          tenantId: event.tenantId,
          actor: event.actorPrincipalId,
          principalId: event.actorPrincipalId,
          apiKeyId: c.get("apiKeyId") ?? null,
          requestId: event.requestId,
          action: event.action,
          resourceType: "design_partner_application",
          resourceId: event.resourceId,
          metadata: { purposeCode: event.purposeCode },
        });
      });
      c.header("Cache-Control", "no-store, max-age=0");
      c.header("Pragma", "no-cache");
      return c.json({ data: result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:id/erasures", async (c) => {
    try {
      const principal = requireAdmin(c);
      const body = objectBody(await applicationBody(c));
      const reasonCode = body.reasonCode;
      if (
        reasonCode !== "applicant_request" &&
        reasonCode !== "operator_request" &&
        reasonCode !== "retention_expired"
      ) {
        throw new Error("application_erasure_reason_invalid");
      }
      const result = store.erase({
        tenantId: principal.tenantId,
        actorPrincipalId: principal.id,
        requestId: requestId(c),
        applicationId: c.req.param("id"),
        reasonCode,
      });
      recordAudit(options.db, {
        id: auditId("application-erasure-audit", principal.tenantId, requestId(c)),
        tenantId: principal.tenantId,
        actor: principal.id,
        principalId: principal.id,
        apiKeyId: c.get("apiKeyId") ?? null,
        requestId: requestId(c),
        action: "design_partner_application.erase",
        resourceType: "design_partner_application",
        resourceId: result.application.id,
        metadata: { reasonCode: result.erasure.reasonCode },
      });
      return c.json({ data: result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/retention-purges", async (c) => {
    try {
      const principal = requireAdmin(c);
      const body = objectBody(await applicationBody(c));
      const limit = body.limit === undefined ? undefined : Number(body.limit);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
        throw new Error("application_purge_limit_invalid");
      }
      const result = store.purgeExpired({
        tenantId: principal.tenantId,
        actorPrincipalId: principal.id,
        requestId: requestId(c),
        limit,
      });
      recordAudit(options.db, {
        id: auditId("application-retention-purge", principal.tenantId, requestId(c)),
        tenantId: principal.tenantId,
        actor: principal.id,
        principalId: principal.id,
        apiKeyId: c.get("apiKeyId") ?? null,
        requestId: requestId(c),
        action: "design_partner_application.retention_purge",
        resourceType: "design_partner_application",
        metadata: { reasonCode: "retention_expired" },
      });
      return c.json({ data: result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
