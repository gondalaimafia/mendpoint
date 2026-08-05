import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import {
  TransformerPilotExecutionStore,
  type TransformerPilotCampaignInput,
  type TransformerRollbackAction,
  type TransformerScmObservation,
} from "@mendpoint/transformer";
import {
  assessTransformerGate,
  type TransformerGateBoundary,
  type TransformerGateDecision,
} from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";

const DB_ENV = "MENDPOINT_TRANSFORMER_PILOT_DB";
const CONTROL_ACTIONS = new Set([
  "pause",
  "resume",
  "cancel",
  "authorize_retry",
  "resolve_exception",
  "waive_exception",
]);

type JsonRecord = Record<string, unknown>;

export type TransformerPilotApiRuntime = Readonly<{
  rawGateConfig?: string;
  environment?: string;
  now?: () => string;
}>;

type MutationRequest = Readonly<{
  tenantId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  evidenceRefs: readonly string[];
}>;

export function transformerPilotExecutionPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const override = env[DB_ENV]?.trim();
  if (override) return resolve(override);
  const dataDir = env.MENDPOINT_DATA_DIR?.trim();
  return join(dataDir ? resolve(dataDir) : join(cwd, "data"), "transformer-pilot.sqlite");
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function requiredString(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(code);
  }
  return value.trim();
}

function stringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  const values = value.map((item) => requiredString(item, code, 500));
  if (new Set(values).size !== values.length) throw new Error(`${code}_duplicate`);
  return values;
}

function optionalStringArray(value: unknown, code: string): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value, code);
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
}

function optionalIntegerBetween(
  value: unknown,
  code: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = positiveInteger(value, code);
  if (parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
}

function nonnegativeNumber(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function boolean(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function requestMetadata(c: Context<ApiEnv>): MutationRequest {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  return {
    tenantId: principal.tenantId,
    actorId: principal.id,
    requestId: requiredString(c.get("requestId"), "request_id_required", 200),
    idempotencyKey: requiredString(c.req.header("idempotency-key"), "idempotency_key_required", 200),
    evidenceRefs: stringArray(
      c.req.header("x-mendpoint-evidence-refs")?.split(",").map((value) => value.trim()).filter(Boolean),
      "evidence_refs_required",
    ),
  };
}

function requireTransformerWorker(c: Context<ApiEnv>): void {
  const principal = c.get("principal");
  const scopes = c.get("authScopes") ?? [];
  if (
    !principal?.id.startsWith("api-key:") ||
    principal.role !== "agent" ||
    (!scopes.includes("*") && !scopes.includes("transformer:worker"))
  ) {
    throw new Error("transformer_worker_principal_denied");
  }
}

async function json(c: Context<ApiEnv>): Promise<unknown> {
  const body = await c.req.json<unknown>().catch(() => undefined);
  if (body === undefined) throw new Error("json_body_required");
  return body;
}

function errorResponse(c: Context<ApiEnv>, error: unknown) {
  const detail = error instanceof Error ? error.message : "internal_error";
  const code = detail.split(":", 1)[0]!;
  if (code === "authenticated_principal_required") {
    return c.json({ error: "unauthorized", message: "Authenticated principal required" }, 401);
  }
  if (code === "transformer_worker_principal_denied") {
    return c.json(
      { error: code, message: "Transformer worker principal required" },
      403,
    );
  }
  if (code.includes("gate_denied") || code.includes("delivery_denied")) {
    return c.json({ error: code, message: "Transformer authorization denied" }, 403);
  }
  if (code.endsWith("_not_found")) {
    return c.json({ error: code, message: "Requested resource was not found" }, 404);
  }
  if (
    code.endsWith("_blocked") ||
    code.endsWith("_conflict") ||
    code.endsWith("_not_running") ||
    code.endsWith("_not_open") ||
    code.endsWith("_stale") ||
    code.endsWith("_expired") ||
    code.endsWith("_drift") ||
    code.endsWith("_incomplete") ||
    code.endsWith("_exists") ||
    code.endsWith("_invalid") && code.includes("pause") ||
    code.endsWith("_invalid") && code.includes("retry")
  ) {
    return c.json({ error: code, message: "Request conflicts with current execution state" }, 409);
  }
  if (
    code.endsWith("_required") ||
    code.endsWith("_invalid") ||
    code.endsWith("_mismatch") ||
    code.endsWith("_duplicate") ||
    code.endsWith("_empty") ||
    code.endsWith("_cycle") ||
    code.includes("constraint_denied")
  ) {
    return c.json({ error: code, message: "Request validation failed" }, 400);
  }
  return c.json({ error: "internal_error", message: "Request could not be completed" }, 500);
}

export class TransformerPilotExecutionService {
  readonly store: TransformerPilotExecutionStore;
  private readonly runtime: Required<Pick<TransformerPilotApiRuntime, "environment" | "now">> &
    Pick<TransformerPilotApiRuntime, "rawGateConfig">;

  constructor(
    path = transformerPilotExecutionPath(),
    runtime: TransformerPilotApiRuntime = {},
  ) {
    this.store = new TransformerPilotExecutionStore(path);
    this.runtime = {
      environment: runtime.environment ?? process.env.MENDPOINT_TRANSFORMER_ENVIRONMENT ?? "",
      rawGateConfig: runtime.rawGateConfig ?? process.env.MENDPOINT_TRANSFORMER_GATE,
      now: runtime.now ?? (() => new Date().toISOString()),
    };
  }

  close(): void {
    this.store.close();
  }

  gate(
    tenantId: string,
    boundary: TransformerGateBoundary,
    productionDeliveryApprovalRefs?: readonly string[],
  ): TransformerGateDecision {
    return assessTransformerGate(
      { tenantId, environment: this.runtime.environment, boundary, productionDeliveryApprovalRefs },
      this.runtime.rawGateConfig,
    );
  }

  private requireGate(
    tenantId: string,
    boundary: TransformerGateBoundary,
    productionDeliveryApprovalRefs?: readonly string[],
  ): TransformerGateDecision {
    const decision = this.gate(tenantId, boundary, productionDeliveryApprovalRefs);
    if (!decision.allowed) throw new Error(`transformer_pilot_gate_denied:${decision.reasons.join(",")}`);
    return decision;
  }

  private mutation(request: MutationRequest, campaignId: string) {
    return {
      tenantId: request.tenantId,
      campaignId: requiredString(campaignId, "transformer_pilot_campaign_invalid", 200),
      observedAt: this.runtime.now(),
      evidenceRefs: request.evidenceRefs,
      idempotencyKey: request.idempotencyKey,
    };
  }

  create(request: MutationRequest, rawInput: unknown) {
    this.requireGate(request.tenantId, "api_control_plane");
    const input = record(rawInput, "transformer_pilot_campaign_required");
    return this.store.createCampaign({
      ...(input as unknown as TransformerPilotCampaignInput),
      tenantId: request.tenantId,
      environment: this.runtime.environment,
      observedAt: this.runtime.now(),
      evidenceRefs: request.evidenceRefs,
      idempotencyKey: request.idempotencyKey,
      gateConfig: this.runtime.rawGateConfig,
    });
  }

  get(tenantId: string, campaignId: string) {
    this.requireGate(tenantId, "api_control_plane");
    const campaign = this.store.getCampaign(tenantId, requiredString(campaignId, "transformer_pilot_campaign_invalid", 200));
    if (!campaign) throw new Error("transformer_pilot_campaign_not_found");
    return campaign;
  }

  events(tenantId: string, campaignId: string) {
    this.get(tenantId, campaignId);
    return this.store.listEvents(tenantId, campaignId);
  }

  metrics(tenantId: string, campaignId: string) {
    this.get(tenantId, campaignId);
    return this.store.metrics(tenantId, campaignId);
  }

  claim(request: MutationRequest, campaignId: string, rawInput: unknown) {
    this.requireGate(request.tenantId, "worker_action");
    const input = record(rawInput, "transformer_pilot_claim_required");
    const leaseDurationMs = optionalIntegerBetween(
      input.leaseDurationMs,
      "transformer_pilot_lease_duration_invalid",
      1_000,
      3_600_000,
    ) ?? 15 * 60_000;
    return this.store.claimNextAttempt({
      ...this.mutation(request, campaignId),
      leaseToken: requiredString(input.leaseToken, "transformer_pilot_lease_token_invalid", 500),
      leaseDurationMs,
      gateConfig: this.runtime.rawGateConfig,
    });
  }

  complete(request: MutationRequest, campaignId: string, rawInput: unknown) {
    this.requireGate(request.tenantId, "worker_action");
    const input = record(rawInput, "transformer_pilot_completion_required");
    return this.store.completeAttempt({
      ...this.mutation(request, campaignId),
      unitId: requiredString(input.unitId, "transformer_pilot_unit_invalid", 200),
      leaseGeneration: positiveInteger(input.leaseGeneration, "transformer_pilot_lease_generation_invalid"),
      leaseToken: requiredString(input.leaseToken, "transformer_pilot_lease_token_invalid", 500),
      sourceRevision: requiredString(input.sourceRevision, "transformer_pilot_source_revision_invalid", 40),
      sourceDigest: requiredString(input.sourceDigest, "transformer_pilot_source_digest_invalid", 80),
      candidateRevision: requiredString(input.candidateRevision, "transformer_pilot_candidate_revision_invalid", 40),
      candidateDigest: requiredString(input.candidateDigest, "transformer_pilot_candidate_digest_invalid", 80),
      verificationPassed: boolean(input.verificationPassed, "transformer_pilot_verification_invalid"),
      actualCostUsd: nonnegativeNumber(input.actualCostUsd, "transformer_pilot_cost_invalid"),
      gateConfig: this.runtime.rawGateConfig,
    });
  }

  crash(request: MutationRequest, campaignId: string, rawInput: unknown) {
    this.requireGate(request.tenantId, "worker_action");
    const input = record(rawInput, "transformer_pilot_crash_required");
    return this.store.recordWorkerCrash({
      ...this.mutation(request, campaignId),
      unitId: requiredString(input.unitId, "transformer_pilot_unit_invalid", 200),
      leaseGeneration: positiveInteger(
        input.leaseGeneration,
        "transformer_pilot_lease_generation_invalid",
      ),
      leaseToken: requiredString(
        input.leaseToken,
        "transformer_pilot_lease_token_invalid",
        500,
      ),
      gateConfig: this.runtime.rawGateConfig,
    });
  }

  observe(request: MutationRequest, campaignId: string, rawInput: unknown) {
    this.requireGate(request.tenantId, "worker_action");
    const input = record(rawInput, "transformer_pilot_observation_required");
    if (!Array.isArray(input.observations) || input.observations.length === 0) {
      throw new Error("transformer_pilot_observations_required");
    }
    return this.store.reconcileWave({
      ...this.mutation(request, campaignId),
      wave: positiveInteger(input.wave, "transformer_pilot_wave_invalid"),
      observations: input.observations as TransformerScmObservation[],
      gateConfig: this.runtime.rawGateConfig,
    });
  }

  control(request: MutationRequest, campaignId: string, rawInput: unknown) {
    this.requireGate(request.tenantId, "api_control_plane");
    const input = record(rawInput, "transformer_pilot_control_required");
    const action = requiredString(input.action, "transformer_pilot_control_invalid", 50);
    if (!CONTROL_ACTIONS.has(action)) throw new Error("transformer_pilot_control_invalid");
    return this.store.control({
      ...this.mutation(request, campaignId),
      action: action as "pause" | "resume" | "cancel" | "authorize_retry" | "resolve_exception" | "waive_exception",
      unitId: input.unitId === undefined ? undefined : requiredString(input.unitId, "transformer_pilot_unit_invalid", 200),
      exceptionId: input.exceptionId === undefined ? undefined : requiredString(input.exceptionId, "transformer_pilot_exception_invalid", 200),
      resolution: input.resolution === undefined ? undefined : requiredString(input.resolution, "transformer_pilot_resolution_required"),
    });
  }

  authorizeDrafts(request: MutationRequest, campaignId: string, rawInput: unknown) {
    const input = record(rawInput, "transformer_pilot_delivery_required");
    const approvals = optionalStringArray(
      input.productionDeliveryApprovalRefs,
      "transformer_pilot_delivery_approvals_invalid",
    );
    this.requireGate(request.tenantId, "delivery", approvals);
    return this.store.authorizeCurrentWaveDrafts({
      ...this.mutation(request, campaignId),
      gateConfig: this.runtime.rawGateConfig,
      productionDeliveryApprovalRefs: approvals,
    });
  }

  planRollback(request: MutationRequest, campaignId: string): readonly TransformerRollbackAction[] {
    this.requireGate(request.tenantId, "api_control_plane");
    return this.store.planRollback(this.mutation(request, campaignId));
  }

  rollbackPlan(tenantId: string, campaignId: string): readonly TransformerRollbackAction[] {
    this.requireGate(tenantId, "api_control_plane");
    return this.store.getRollbackPlan(tenantId, campaignId);
  }
}

export function registerTransformerPilotExecutionRoutes(
  app: Hono<ApiEnv>,
  service: TransformerPilotExecutionService,
): void {
  app.get("/transformer/executions/gate", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json({ gate: service.gate(principal.tenantId, "ui") });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post("/transformer/executions", async (c) => {
    try {
      const result = service.create(requestMetadata(c), await json(c));
      c.header("Location", `/transformer/executions/${result.campaignId}`);
      return c.json(result, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/transformer/executions/:campaignId", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json(service.get(principal.tenantId, c.req.param("campaignId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/transformer/executions/:campaignId/events", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json({ events: service.events(principal.tenantId, c.req.param("campaignId")) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/transformer/executions/:campaignId/metrics", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json({ metrics: service.metrics(principal.tenantId, c.req.param("campaignId")) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  const mutation = (
    path: string,
    operation: (request: MutationRequest, campaignId: string, body: unknown) => unknown,
    status: 200 | 201 = 200,
    workerOnly = false,
  ) => {
    app.post(path, async (c) => {
      try {
        if (workerOnly) requireTransformerWorker(c);
        const campaignId = requiredString(
          c.req.param("campaignId"),
          "transformer_pilot_campaign_invalid",
          200,
        );
        return c.json(operation(requestMetadata(c), campaignId, await json(c)), status);
      } catch (error) {
        return errorResponse(c, error);
      }
    });
  };

  mutation("/transformer/executions/:campaignId/attempts/claim", (request, campaignId, body) => ({
    lease: service.claim(request, campaignId, body),
  }), 200, true);
  mutation("/transformer/executions/:campaignId/attempts/complete", (request, campaignId, body) => service.complete(request, campaignId, body), 200, true);
  mutation("/transformer/executions/:campaignId/attempts/crash", (request, campaignId, body) => service.crash(request, campaignId, body), 200, true);
  mutation("/transformer/executions/:campaignId/observations", (request, campaignId, body) => service.observe(request, campaignId, body), 200, true);
  mutation("/transformer/executions/:campaignId/control", (request, campaignId, body) => service.control(request, campaignId, body));
  mutation("/transformer/executions/:campaignId/drafts/authorize", (request, campaignId, body) => ({
    actions: service.authorizeDrafts(request, campaignId, body),
    delivery: "external",
  }));

  app.post("/transformer/executions/:campaignId/rollback-plan", (c) => {
    try {
      return c.json({
        actions: service.planRollback(requestMetadata(c), c.req.param("campaignId")),
        delivery: "external",
      }, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get("/transformer/executions/:campaignId/rollback-plan", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json({
        actions: service.rollbackPlan(principal.tenantId, c.req.param("campaignId")),
        delivery: "external",
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });
}
