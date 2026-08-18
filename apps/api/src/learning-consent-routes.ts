/**
 * Learning consent + deletion surface (spec §19.5, §19.7).
 *
 * The consent mechanism is enforced at four checkpoints in @mendpoint/db, but a
 * customer or operator had no reachable way to exercise it — grant, revoke, and
 * record deletion existed only as direct SQL. These authenticated routes expose
 * them, plus the reverse-lineage query §19.7 asks for.
 *
 * Tenant is ALWAYS derived from the authenticated principal, never from the
 * request body (a prior cross-tenant bug in this repo came from trusting a
 * body-supplied tenant id — see repository-connect.ts). The human-principal
 * requirement on grant/revoke/delete is enforced in the DB layer by passing the
 * server-derived trust principal id (a DB `principals` row); an API-key
 * principal resolves to a non-human row and is refused there.
 */
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { nowIso } from "@mendpoint/shared";
import {
  deleteLearningRecord,
  grantLearningConsent,
  listLearningRecordLineage,
  revokeLearningConsent,
  type AppDb,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse } from "./error-boundary.js";

export type LearningConsentRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => string;
  createId?: () => string;
}>;

// Human/principal failures shared by every mutating route. The DB enforces the
// human-only rule; these map its codes to stable HTTP statuses.
const PRINCIPAL_ERRORS = [
  { internalCode: "learning_human_principal_required", status: 403 as const },
  { internalCode: "learning_principal_tenant_mismatch", status: 403 as const },
  { internalCode: "learning_principal_revoked", status: 403 as const },
  { internalCode: "learning_principal_expired", status: 403 as const },
];

const GRANT_ERRORS = [
  ...PRINCIPAL_ERRORS,
  { internalCode: "learning_consent_version_invalid", status: 400 as const },
  { internalCode: "learning_consent_expiry_invalid", status: 400 as const },
  { internalCode: "learning_consent_version_conflict", status: 409 as const },
  { internalCode: "learning_consent_already_active", status: 409 as const },
  { internalCode: "learning_consent_supersedes_conflict", status: 409 as const },
  { internalCode: "learning_consent_idempotency_conflict", status: 409 as const },
];

const REVOKE_ERRORS = [
  ...PRINCIPAL_ERRORS,
  { internalCode: "learning_consent_tenant_mismatch", status: 404 as const },
  { internalCode: "learning_consent_not_current", status: 409 as const },
  { internalCode: "learning_consent_version_conflict", status: 409 as const },
  { internalCode: "learning_consent_idempotency_conflict", status: 409 as const },
];

const DELETE_ERRORS = [
  ...PRINCIPAL_ERRORS,
  { internalCode: "learning_record_tenant_mismatch", status: 404 as const },
  { internalCode: "learning_record_already_deleted", status: 409 as const },
  { internalCode: "learning_deletion_idempotency_conflict", status: 409 as const },
];

function reqStr(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optIsoOrNow(value: unknown, fallback: string): string | { error: true } {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { error: true };
  return value;
}

function optIsoOrNull(value: unknown): string | null | { error: true } {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return { error: true };
  return value;
}

export function createLearningConsentRoutes(
  options: LearningConsentRoutesOptions,
): Hono<ApiEnv> {
  const { db } = options;
  const clock = options.now ?? nowIso;
  const newId = options.createId ?? (() => randomUUID());
  const routes = new Hono<ApiEnv>({ strict: false });

  // POST /consent — grant training consent. Requires a human principal.
  routes.post("/consent", async (c) => {
    const principal = c.get("principal");
    const trustPrincipalId = c.get("trustPrincipalId");
    if (!principal || !trustPrincipalId) {
      return c.json({ error: "authenticated_principal_required" }, 401);
    }
    const body = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);

    const purpose = reqStr(body.purpose);
    const residencyRegion = reqStr(body.residencyRegion);
    const reason = reqStr(body.reason);
    const idempotencyKey = reqStr(body.idempotencyKey);
    if (!purpose || !residencyRegion || !reason || !idempotencyKey) {
      return c.json({ error: "purpose, residencyRegion, reason and idempotencyKey are required" }, 400);
    }
    if (!Number.isInteger(body.consentVersion) || (body.consentVersion as number) < 1) {
      return c.json({ error: "consentVersion must be a positive integer" }, 400);
    }
    const createdAt = clock();
    const effectiveAt = optIsoOrNow(body.effectiveAt, createdAt);
    if (typeof effectiveAt !== "string") return c.json({ error: "effectiveAt must be an ISO timestamp" }, 400);
    const expiresAt = optIsoOrNull(body.expiresAt);
    if (typeof expiresAt === "object" && expiresAt !== null) {
      return c.json({ error: "expiresAt must be an ISO timestamp" }, 400);
    }
    const supersedesConsentId =
      body.supersedesConsentId === undefined || body.supersedesConsentId === null
        ? null
        : reqStr(body.supersedesConsentId);
    if (body.supersedesConsentId !== undefined && body.supersedesConsentId !== null && !supersedesConsentId) {
      return c.json({ error: "supersedesConsentId must be a non-empty string" }, 400);
    }

    try {
      const consent = grantLearningConsent(db, {
        id: newId(),
        tenantId: principal.tenantId,
        consentVersion: body.consentVersion as number,
        purpose,
        residencyRegion,
        authorizedByPrincipalId: trustPrincipalId,
        supersedesConsentId,
        effectiveAt,
        expiresAt: expiresAt as string | null,
        reason,
        idempotencyKey,
        createdAt,
      });
      return c.json({ consent }, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, GRANT_ERRORS);
    }
  });

  // POST /consent/revoke — revoke a previously granted consent. Human only.
  routes.post("/consent/revoke", async (c) => {
    const principal = c.get("principal");
    const trustPrincipalId = c.get("trustPrincipalId");
    if (!principal || !trustPrincipalId) {
      return c.json({ error: "authenticated_principal_required" }, 401);
    }
    const body = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    const consentId = reqStr(body.consentId);
    const reason = reqStr(body.reason);
    const idempotencyKey = reqStr(body.idempotencyKey);
    if (!consentId || !reason || !idempotencyKey) {
      return c.json({ error: "consentId, reason and idempotencyKey are required" }, 400);
    }
    if (!Number.isInteger(body.consentVersion) || (body.consentVersion as number) < 1) {
      return c.json({ error: "consentVersion must be a positive integer" }, 400);
    }
    try {
      const consent = revokeLearningConsent(db, {
        id: newId(),
        tenantId: principal.tenantId,
        consentId,
        consentVersion: body.consentVersion as number,
        authorizedByPrincipalId: trustPrincipalId,
        reason,
        idempotencyKey,
        createdAt: clock(),
      });
      return c.json({ consent });
    } catch (error) {
      return mappedErrorResponse(c, error, REVOKE_ERRORS);
    }
  });

  // POST /records/delete — record a deletion request for a learning record.
  routes.post("/records/delete", async (c) => {
    const principal = c.get("principal");
    const trustPrincipalId = c.get("trustPrincipalId");
    if (!principal || !trustPrincipalId) {
      return c.json({ error: "authenticated_principal_required" }, 401);
    }
    const body = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    const learningRecordId = reqStr(body.learningRecordId);
    const reason = reqStr(body.reason);
    const idempotencyKey = reqStr(body.idempotencyKey);
    if (!learningRecordId || !reason || !idempotencyKey) {
      return c.json({ error: "learningRecordId, reason and idempotencyKey are required" }, 400);
    }
    try {
      const deletion = deleteLearningRecord(db, {
        id: newId(),
        tenantId: principal.tenantId,
        learningRecordId,
        reason,
        requestedByPrincipalId: trustPrincipalId,
        idempotencyKey,
        createdAt: clock(),
      });
      return c.json({ deletion });
    } catch (error) {
      return mappedErrorResponse(c, error, DELETE_ERRORS);
    }
  });

  // GET /records/:id/lineage — reverse lineage §19.7: the dataset versions that
  // consumed this learning record. Read-only; tenant-scoped.
  routes.get("/records/:id/lineage", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    try {
      const lineage = listLearningRecordLineage(db, {
        tenantId: principal.tenantId,
        learningRecordId: c.req.param("id"),
      });
      c.header("Cache-Control", "no-store");
      return c.json(lineage);
    } catch (error) {
      return mappedErrorResponse(c, error, [
        { internalCode: "learning_record_tenant_mismatch", status: 404 },
      ]);
    }
  });

  return routes;
}
