import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import { can } from "@mendpoint/platform";
import type { ApiEnv } from "./auth.js";
import { TransformerMissionService, type TransformerMissionPlanInput } from "./transformer-missions.js";

const MAX_BODY_BYTES = 256_000;
const MAX_REPOSITORIES = 16;

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

async function body(c: Context<ApiEnv>): Promise<Record<string, unknown>> {
  const raw = await c.req.text();
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw new Error("transformer_mission_body_invalid");
  try {
    return record(JSON.parse(raw), "transformer_mission_body_invalid");
  } catch (error) {
    if (error instanceof Error && error.message === "transformer_mission_body_invalid") throw error;
    throw new Error("transformer_mission_body_invalid");
  }
}

function idempotencyKey(c: Context<ApiEnv>): string {
  const value = c.req.header("idempotency-key")?.trim();
  if (!value || value.length > 200) throw new Error("idempotency_key_required");
  return value;
}

function mutation(c: Context<ApiEnv>, key: string) {
  const principal = c.get("principal");
  const trustPrincipalId = c.get("trustPrincipalId");
  const requestId = c.get("requestId");
  if (!principal || !trustPrincipalId || !requestId) throw new Error("transformer_mission_authentication_required");
  if (!can(principal, "plan:execute")) throw new Error("transformer_mission_permission_denied");
  return Object.freeze({
    tenantId: principal.tenantId,
    actorId: principal.id,
    requestId,
    idempotencyKey: key,
    evidenceRefs: Object.freeze([
      `trust-principal:${trustPrincipalId}`,
      `request:${requestId}`,
    ]),
  });
}

function campaignId(tenantId: string, key: string): string {
  return `mission-${createHash("sha256").update(`${tenantId}\0${key}`, "utf8").digest("hex").slice(0, 32)}`;
}

function repositoryIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REPOSITORIES) {
    throw new Error("transformer_mission_repository_invalid");
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item)) {
      throw new Error("transformer_mission_repository_invalid");
    }
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error("transformer_mission_repository_invalid");
  return result;
}

function failure(c: Context<ApiEnv>, error: unknown) {
  const code = error instanceof Error ? error.message.split(":", 1)[0]! : "transformer_mission_failed";
  if (code === "transformer_mission_authentication_required") {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (code === "transformer_mission_permission_denied" || code === "transformer_pilot_gate_denied") {
    return c.json({ error: "forbidden" }, 403);
  }
  if (code.endsWith("_not_found") || code === "campaign_not_found") {
    return c.json({ error: "not_found" }, 404);
  }
  if (code.includes("review_required") || code.includes("conflict") || code.includes("drift")) {
    return c.json({ error: "conflict", code }, 409);
  }
  return c.json({ error: "invalid_request", code }, 400);
}

export function createTransformerMissionRoutes(options: Readonly<{
  service: Pick<TransformerMissionService, "plan" | "launch">;
  environment?: string;
  now?: () => string;
}>) {
  const routes = new Hono<ApiEnv>();
  const now = options.now ?? (() => new Date().toISOString());
  const environment = options.environment ?? process.env.MENDPOINT_TRANSFORMER_ENVIRONMENT ?? "";

  routes.post("/", async (c) => {
    try {
      const key = idempotencyKey(c);
      const request = mutation(c, key);
      const input = await body(c);
      const evaluatedAt = now();
      const result = options.service.plan(request, {
        campaignId: campaignId(request.tenantId, key),
        environment,
        evaluatedAt,
        maxEvidenceAgeMs: 7 * 24 * 60 * 60_000,
        constraints: { maxUnits: 32, maxRepositories: MAX_REPOSITORIES, maxPathsPerUnit: 128 },
        repositoryIds: repositoryIds(input.repositoryIds),
        objective: record(input.objective, "transformer_mission_objective_invalid") as unknown as TransformerMissionPlanInput["objective"],
      });
      return c.json(result, result.decision === "planned" ? 201 : 200);
    } catch (error) {
      return failure(c, error);
    }
  });

  routes.post("/:campaignId/launch", (c) => {
    try {
      const key = idempotencyKey(c);
      const result = options.service.launch(mutation(c, key), c.req.param("campaignId"));
      return c.json(result, 201);
    } catch (error) {
      return failure(c, error);
    }
  });

  return routes;
}
