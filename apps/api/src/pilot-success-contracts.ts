import {
  approvePilotSuccessContract,
  createPilotSuccessContract,
  getPilotSuccessContract,
  listPilotSuccessContracts,
  recordAudit,
  revisePilotSuccessContract,
  type AppDb,
  type PilotSuccessContractDefinition,
} from "@mendpoint/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { ApiEnv } from "./auth.js";

const MAX_BODY_BYTES = 128 * 1_024;

export type PilotSuccessContractRoutesOptions = Readonly<{
  db: AppDb;
  now?: () => Date;
  createId?: (kind: "pilot-contract" | "pilot-approval" | "pilot-audit") => string;
}>;

function principal(c: Context<ApiEnv>) {
  const value = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  if (!value || !trustPrincipalId) throw new Error("pilot_contract_authentication_required");
  return { ...value, trustPrincipalId };
}

function requireManager(c: Context<ApiEnv>) {
  const value = principal(c);
  if (value.role !== "owner" && value.role !== "admin") {
    throw new Error("pilot_contract_manager_required");
  }
  return value;
}

function requireReviewer(c: Context<ApiEnv>) {
  const value = principal(c);
  if (value.role !== "owner" && value.role !== "admin" && value.role !== "fde") {
    throw new Error("pilot_contract_reviewer_role_required");
  }
  return value;
}

async function body(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) throw new Error("pilot_contract_content_type_invalid");
  const declared = Number(c.req.header("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("pilot_contract_payload_too_large");
  const content = await c.req.text();
  if (Buffer.byteLength(content, "utf8") > MAX_BODY_BYTES) throw new Error("pilot_contract_payload_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("pilot_contract_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("pilot_contract_payload_invalid");
  }
  return parsed as Record<string, unknown>;
}

function replyError(c: Context<ApiEnv>, error: unknown): Response {
  const code = error instanceof Error ? error.message : "pilot_contract_internal_error";
  if (code === "pilot_contract_authentication_required") {
    return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
  }
  if (code === "pilot_contract_manager_required" || code === "pilot_contract_reviewer_role_required") {
    return c.json({ error: { code: "forbidden", message: "This operation requires pilot contract authority" } }, 403);
  }
  if (code === "pilot_contract_not_found") {
    return c.json({ error: { code: "not_found", message: "Pilot success contract was not found" } }, 404);
  }
  if (code === "pilot_contract_version_conflict" || code === "pilot_contract_id_conflict" ||
    code === "pilot_contract_already_approved") {
    return c.json({ error: { code, message: "Pilot success contract conflicts with current state" } }, 409);
  }
  if (code === "pilot_contract_payload_too_large") {
    return c.json({ error: { code, message: "Pilot success contract payload is too large" } }, 413);
  }
  if (code.startsWith("pilot_contract_")) {
    return c.json({ error: { code, message: "Pilot success contract was rejected" } }, 422);
  }
  return c.json({ error: { code: "internal_error", message: "Pilot success contract operation failed" } }, 500);
}

function requestId(c: Context<ApiEnv>): string {
  return c.get("requestId") ?? randomUUID();
}

function resolveCurrentOperator(value: unknown, trustPrincipalId: string): PilotSuccessContractDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pilot_contract_definition_required");
  }
  return JSON.parse(JSON.stringify(value, (_key, nested) =>
    nested === "current_operator" ? trustPrincipalId : nested)) as PilotSuccessContractDefinition;
}

export function createPilotSuccessContractRoutes(options: PilotSuccessContractRoutesOptions): Hono<ApiEnv> {
  const routes = new Hono<ApiEnv>({ strict: false });
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? ((kind: string) => `${kind}-${randomUUID()}`);

  routes.use("*", async (c, next) => {
    if (!c.get("principal") || !c.get("trustPrincipalId")) {
      return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
    }
    return next();
  });

  routes.get("/", (c) => {
    try {
      const actor = principal(c);
      return c.json({ data: listPilotSuccessContracts(options.db, actor.tenantId) });
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.get("/:id", (c) => {
    try {
      const actor = principal(c);
      const rawVersion = c.req.query("version");
      const version = rawVersion === undefined ? undefined : Number(rawVersion);
      if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) {
        throw new Error("pilot_contract_version_invalid");
      }
      const value = getPilotSuccessContract(options.db, actor.tenantId, c.req.param("id"), version);
      if (!value) throw new Error("pilot_contract_not_found");
      return c.json({ data: value });
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/", async (c) => {
    try {
      const actor = requireManager(c);
      const input = await body(c);
      const value = createPilotSuccessContract(options.db, {
        id: createId("pilot-contract"),
        tenantId: actor.tenantId,
        title: typeof input.title === "string" ? input.title : "",
        definition: resolveCurrentOperator(input.definition, actor.trustPrincipalId),
        createdByPrincipalId: actor.trustPrincipalId,
        createdAt: now().toISOString(),
      }, (pending) => recordAudit(options.db, {
        id: createId("pilot-audit"), tenantId: actor.tenantId, actor: actor.id,
        principalId: actor.trustPrincipalId, requestId: requestId(c),
        action: "pilot_success_contract.create", resourceType: "pilot_success_contract",
        resourceId: pending.id, metadata: { version: pending.version, contentSha256: pending.contentSha256 },
      }));
      return c.json({ data: value }, 201);
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/:id/revisions", async (c) => {
    try {
      const actor = requireManager(c);
      const input = await body(c);
      const expectedVersion = Number(input.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        throw new Error("pilot_contract_version_invalid");
      }
      const value = revisePilotSuccessContract(options.db, {
        tenantId: actor.tenantId,
        contractId: c.req.param("id"),
        expectedVersion,
        title: typeof input.title === "string" ? input.title : "",
        definition: resolveCurrentOperator(input.definition, actor.trustPrincipalId),
        createdByPrincipalId: actor.trustPrincipalId,
        createdAt: now().toISOString(),
      }, (pending) => recordAudit(options.db, {
        id: createId("pilot-audit"), tenantId: actor.tenantId, actor: actor.id,
        principalId: actor.trustPrincipalId, requestId: requestId(c),
        action: "pilot_success_contract.revise", resourceType: "pilot_success_contract",
        resourceId: pending.id, metadata: { version: pending.version, contentSha256: pending.contentSha256 },
      }));
      return c.json({ data: value }, 201);
    } catch (error) {
      return replyError(c, error);
    }
  });

  routes.post("/:id/versions/:version/approvals", async (c) => {
    try {
      const actor = requireReviewer(c);
      const input = await body(c);
      const version = Number(c.req.param("version"));
      if (!Number.isSafeInteger(version) || version < 1) throw new Error("pilot_contract_version_invalid");
      const value = approvePilotSuccessContract(options.db, {
        id: createId("pilot-approval"),
        tenantId: actor.tenantId,
        contractId: c.req.param("id"),
        version,
        reviewerPrincipalId: actor.trustPrincipalId,
        rationale: typeof input.rationale === "string" ? input.rationale : "",
        createdAt: now().toISOString(),
      }, (pending) => recordAudit(options.db, {
        id: createId("pilot-audit"), tenantId: actor.tenantId, actor: actor.id,
        principalId: actor.trustPrincipalId, requestId: requestId(c),
        action: "pilot_success_contract.approve", resourceType: "pilot_success_contract",
        resourceId: pending.id, metadata: { version: pending.version, contentSha256: pending.contentSha256 },
      }));
      return c.json({ data: value }, 201);
    } catch (error) {
      return replyError(c, error);
    }
  });

  return routes;
}
