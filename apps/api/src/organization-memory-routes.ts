/**
 * Organization Memory inspection API (spec: docs/memory/ORGANIZATION_MEMORY.md).
 *
 * Backend correctness matters here; polished UX does not. The one hard product
 * requirement is that this store never becomes invisible, irreversible
 * personalization: every memory is listable with its source and provenance, and
 * every one is disableable. These authenticated routes make that reachable.
 *
 * Tenant is ALWAYS derived from the authenticated principal, never from the
 * request body (a prior cross-tenant bug in this repo came from trusting a
 * body-supplied tenant id). Mutations that assert a human decision — create,
 * confirm, reject, edit, disable, delete — require a human trust principal,
 * supplied by the server, never by the body.
 */
import { Hono } from "hono";
import { nowIso } from "@mendpoint/shared";
import {
  activateOrganizationMemory,
  confirmOrganizationMemory,
  createExplicitMemory,
  deleteOrganizationMemory,
  disableOrganizationMemory,
  editOrganizationMemory,
  getPrincipal,
  getOrganizationMemoryProvenance,
  getOrganizationMemoryScope,
  listOrganizationMemory,
  recordOrganizationMemoryObservation,
  rejectOrganizationMemory,
  ORGANIZATION_MEMORY_STATUSES,
  type AppDb,
  type OrganizationMemoryStatus,
} from "@mendpoint/db";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse } from "./error-boundary.js";

export type OrganizationMemoryRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => string;
}>;

const NOT_FOUND_ERRORS = [
  { internalCode: "organization_memory_not_found", status: 404 as const },
  { internalCode: "organization_memory_tenant_mismatch", status: 404 as const },
];

const VALIDATION_ERRORS = [
  { internalCode: "organization_memory_category_invalid", status: 400 as const },
  { internalCode: "organization_memory_confidence_invalid", status: 400 as const },
  { internalCode: "organization_memory_observation_source_invalid", status: 400 as const },
  { internalCode: "organization_memory_source_ref_invalid", status: 400 as const },
  { internalCode: "organization_memory_observer_authority_invalid", status: 401 as const },
  { internalCode: "organization_memory_applies_to_invalid", status: 400 as const },
];

const STATE_ERRORS = [
  { internalCode: "organization_memory_exists", status: 409 as const },
  { internalCode: "organization_memory_not_open", status: 409 as const },
  { internalCode: "organization_memory_not_confirmable", status: 409 as const },
  { internalCode: "organization_memory_not_rejectable", status: 409 as const },
  { internalCode: "organization_memory_not_disableable", status: 409 as const },
  { internalCode: "organization_memory_not_deletable", status: 409 as const },
  { internalCode: "organization_memory_not_editable", status: 409 as const },
  { internalCode: "organization_memory_not_staleable", status: 409 as const },
  { internalCode: "organization_memory_activation_blocked_already_active", status: 409 as const },
  { internalCode: "organization_memory_activation_blocked_status_terminal", status: 409 as const },
  { internalCode: "organization_memory_activation_blocked_insufficient_corroboration", status: 409 as const },
  { internalCode: "organization_memory_activation_blocked_memory_not_found", status: 404 as const },
  { internalCode: "organization_memory_observation_conflict", status: 409 as const },
];

const ALL_ERRORS = [...NOT_FOUND_ERRORS, ...VALIDATION_ERRORS, ...STATE_ERRORS];

function reqStr(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function optRefs(value: unknown): string[] | undefined | { error: true } {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    return { error: true };
  }
  return value as string[];
}

function parseStatus(value: string | undefined): OrganizationMemoryStatus | undefined | { error: true } {
  if (value === undefined) return undefined;
  return (ORGANIZATION_MEMORY_STATUSES as readonly string[]).includes(value)
    ? (value as OrganizationMemoryStatus)
    : { error: true };
}

function humanAuthority(input: Readonly<{
  db: AppDb;
  tenantId: string;
  trustPrincipalId: string | undefined;
  authMethod: "oidc" | "api_key" | undefined;
  membershipEvidenceId: string | undefined;
  at: string;
}>): string | null {
  if (!input.trustPrincipalId || input.authMethod !== "oidc" || !input.membershipEvidenceId) return null;
  const principal = getPrincipal(input.db, input.tenantId, input.trustPrincipalId);
  const expiresAt = principal?.expires_at === null ? null : Date.parse(principal?.expires_at ?? "");
  if (!principal || principal.kind !== "human" || principal.revoked_at !== null ||
      (expiresAt !== null && (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(input.at)))) return null;
  return principal.id;
}

export function createOrganizationMemoryRoutes(
  options: OrganizationMemoryRoutesOptions,
): Hono<ApiEnv> {
  const { db } = options;
  const clock = options.now ?? nowIso;
  const routes = new Hono<ApiEnv>({ strict: false });

  // GET / — list current memory heads, optionally filtered by ?status=.
  routes.get("/", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    const status = parseStatus(c.req.query("status"));
    if (typeof status === "object" && status !== null) {
      return c.json({ error: "status is not a valid organization memory status" }, 400);
    }
    const memories = listOrganizationMemory(db, { tenantId: principal.tenantId, status });
    c.header("Cache-Control", "no-store");
    return c.json({ memories });
  });

  // POST / — create a memory the organization stated directly. Human only.
  routes.post("/", async (c) => {
    const principal = c.get("principal");
    const at = clock();
    const trustPrincipalId = principal ? humanAuthority({
      db,
      tenantId: principal.tenantId,
      trustPrincipalId: c.get("trustPrincipalId"),
      authMethod: c.get("authMethod"),
      membershipEvidenceId: c.get("membershipEvidenceId"),
      at,
    }) : null;
    if (!principal || !trustPrincipalId) {
      return c.json({ error: "authenticated_principal_required" }, 401);
    }
    const body = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    const category = reqStr(body.category);
    const scope = reqStr(body.scope);
    const subjectKey = reqStr(body.subjectKey);
    const statement = reqStr(body.statement);
    const reason = reqStr(body.reason);
    if (!category || !scope || !subjectKey || !statement || !reason) {
      return c.json({ error: "category, scope, subjectKey, statement and reason are required" }, 400);
    }
    const sourceRefs = optRefs(body.sourceRefs);
    const appliesTo = optRefs(body.appliesTo);
    if ((typeof sourceRefs === "object" && "error" in sourceRefs) || (typeof appliesTo === "object" && appliesTo !== undefined && "error" in appliesTo)) {
      return c.json({ error: "sourceRefs and appliesTo must be arrays of non-empty strings" }, 400);
    }
    try {
      const memory = createExplicitMemory(db, {
        tenantId: principal.tenantId,
        category: category as never,
        scope,
        subjectKey,
        statement,
        actorPrincipalId: trustPrincipalId,
        confidence: body.confidence as never,
        structuredValue: body.structuredValue,
        sourceRefs: sourceRefs as string[] | undefined,
        appliesTo: appliesTo as string[] | undefined,
        reason,
        at,
      });
      return c.json({ memory }, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, ALL_ERRORS);
    }
  });

  // POST /observations — record one observation of a convention (inferred).
  // Human only: this subsystem captures *human* organizational convention, so
  // it requires the same human trust principal as every other mutation. The
  // observation records as a MEMORY_CANDIDATE attributed to that principal; it
  // does not mint a verified evidence record, and client sourceRefs are not part
  // of the observation contract.
  routes.post("/observations", async (c) => {
    const principal = c.get("principal");
    const at = clock();
    const trustPrincipalId = principal ? humanAuthority({
      db,
      tenantId: principal.tenantId,
      trustPrincipalId: c.get("trustPrincipalId"),
      authMethod: c.get("authMethod"),
      membershipEvidenceId: c.get("membershipEvidenceId"),
      at,
    }) : null;
    if (!principal || !trustPrincipalId) {
      return c.json({ error: "authenticated_principal_required" }, 401);
    }
    const body = (await c.req.json<unknown>().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return c.json({ error: "invalid_body" }, 400);
    const category = reqStr(body.category);
    const scope = reqStr(body.scope);
    const subjectKey = reqStr(body.subjectKey);
    const statement = reqStr(body.statement);
    const source = reqStr(body.source);
    if (!category || !scope || !subjectKey || !statement || !source) {
      return c.json(
        { error: "category, scope, subjectKey, statement and source are required" },
        400,
      );
    }
    const appliesTo = optRefs(body.appliesTo);
    if (typeof appliesTo === "object" && appliesTo !== undefined && "error" in appliesTo) {
      return c.json({ error: "appliesTo must be an array of non-empty strings" }, 400);
    }
    try {
      const memory = recordOrganizationMemoryObservation(db, {
        tenantId: principal.tenantId,
        category: category as never,
        scope,
        subjectKey,
        statement,
        observerPrincipalId: trustPrincipalId,
        source: source as never,
        confidence: body.confidence as never,
        structuredValue: body.structuredValue,
        appliesTo: appliesTo as string[] | undefined,
        reason: typeof body.reason === "string" ? body.reason : undefined,
        at,
      });
      return c.json({ memory }, 201);
    } catch (error) {
      return mappedErrorResponse(c, error, ALL_ERRORS);
    }
  });

  // Mutating lifecycle transitions keyed by memory id. Each requires a human
  // trust principal, except activate (a routine step) which records the human if
  // present.
  const humanTransition = (
    path: string,
    fn: (args: {
      db: AppDb;
      tenantId: string;
      memoryId: string;
      actorPrincipalId: string;
      reason: string;
      at: string;
      body: Record<string, unknown>;
    }) => unknown,
  ) => {
    routes.post(path, async (c) => {
      const principal = c.get("principal");
      const at = clock();
      const trustPrincipalId = principal ? humanAuthority({
        db,
        tenantId: principal.tenantId,
        trustPrincipalId: c.get("trustPrincipalId"),
        authMethod: c.get("authMethod"),
        membershipEvidenceId: c.get("membershipEvidenceId"),
        at,
      }) : null;
      if (!principal || !trustPrincipalId) {
        return c.json({ error: "authenticated_principal_required" }, 401);
      }
      const body = (await c.req.json<unknown>().catch(() => ({}))) as Record<string, unknown>;
      const reason = reqStr(body?.reason);
      if (!reason) return c.json({ error: "reason is required" }, 400);
      try {
        const memory = fn({
          db,
          tenantId: principal.tenantId,
          memoryId: c.req.param("memoryId") ?? "",
          actorPrincipalId: trustPrincipalId,
          reason,
          at,
          body: body ?? {},
        });
        return c.json({ memory });
      } catch (error) {
        return mappedErrorResponse(c, error, ALL_ERRORS);
      }
    });
  };

  humanTransition("/:memoryId/confirm", (a) =>
    confirmOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
    }),
  );

  humanTransition("/:memoryId/activate", (a) =>
    activateOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
    }),
  );

  humanTransition("/:memoryId/reject", (a) =>
    rejectOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
    }),
  );

  humanTransition("/:memoryId/disable", (a) =>
    disableOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
    }),
  );

  humanTransition("/:memoryId/delete", (a) =>
    deleteOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
    }),
  );

  humanTransition("/:memoryId/edit", (a) => {
    const b = a.body;
    const sourceRefs = optRefs(b.sourceRefs);
    const appliesTo = optRefs(b.appliesTo);
    if (
      (typeof sourceRefs === "object" && sourceRefs !== undefined && "error" in sourceRefs) ||
      (typeof appliesTo === "object" && appliesTo !== undefined && "error" in appliesTo)
    ) {
      throw new Error("organization_memory_applies_to_invalid");
    }
    return editOrganizationMemory(a.db, {
      tenantId: a.tenantId,
      memoryId: a.memoryId,
      actorPrincipalId: a.actorPrincipalId,
      reason: a.reason,
      at: a.at,
      statement: typeof b.statement === "string" ? b.statement : undefined,
      structuredValue: "structuredValue" in b ? b.structuredValue : undefined,
      confidence: b.confidence as never,
      scope: typeof b.scope === "string" ? b.scope : undefined,
      appliesTo: appliesTo as string[] | undefined,
      sourceRefs: sourceRefs as string[] | undefined,
    });
  });

  // GET /:memoryId/provenance — full immutable history.
  routes.get("/:memoryId/provenance", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    try {
      const provenance = getOrganizationMemoryProvenance(db, principal.tenantId, c.req.param("memoryId"));
      if (provenance.length === 0) return c.json({ error: "organization_memory_not_found" }, 404);
      c.header("Cache-Control", "no-store");
      return c.json({ provenance });
    } catch (error) {
      return mappedErrorResponse(c, error, NOT_FOUND_ERRORS);
    }
  });

  // GET /:memoryId/scope — where the memory applies.
  routes.get("/:memoryId/scope", (c) => {
    const principal = c.get("principal");
    if (!principal) return c.json({ error: "authenticated_principal_required" }, 401);
    try {
      const scope = getOrganizationMemoryScope(db, principal.tenantId, c.req.param("memoryId"));
      if (!scope) return c.json({ error: "organization_memory_not_found" }, 404);
      c.header("Cache-Control", "no-store");
      return c.json({ scope });
    } catch (error) {
      return mappedErrorResponse(c, error, NOT_FOUND_ERRORS);
    }
  });

  return routes;
}
