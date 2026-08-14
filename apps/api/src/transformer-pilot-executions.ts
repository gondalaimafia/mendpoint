import { join, resolve } from "node:path";
import { Hono, type Context } from "hono";
import {
  TransformerDomainError,
  TransformerPilotExecutionStore,
  generateModernizationReport,
  renderModernizationReportMarkdown,
  type TransformerAdaptiveAttemptAccounting,
  type TransformerPilotCampaignInput,
  type TransformerRollbackAction,
  type TransformerScmObservation,
} from "@mendpoint/transformer";
import {
  assessTransformerGate,
  type TransformerGateBoundary,
  type TransformerGateDecision,
} from "@mendpoint/ops";
import { resolveRenamedEnv } from "@mendpoint/shared";
import type { ApiEnv } from "./auth.js";
import {
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";

const DB_ENV = "MENDPOINT_REGAUGE_PILOT_DB";
const CONTROL_ACTIONS = new Set([
  "pause",
  "resume",
  "cancel",
  "authorize_retry",
  "resolve_exception",
  "waive_exception",
]);

function publicRules(
  status: PublicErrorRule["status"],
  publicMessage: string,
  ...internalCodes: readonly string[]
): readonly PublicErrorRule[] {
  return internalCodes.map((internalCode) => ({ internalCode, status, publicMessage }));
}

const TRANSFORMER_PILOT_ERRORS: readonly PublicErrorRule[] = [
  {
    internalCode: "authenticated_principal_required",
    publicCode: "unauthorized",
    status: 401,
    publicMessage: "Authenticated principal required",
  },
  {
    internalCode: "transformer_worker_principal_denied",
    status: 403,
    publicMessage: "Transformer worker principal required",
  },
  ...publicRules(
    404,
    "Requested resource was not found",
    "transformer_pilot_campaign_not_found",
    "transformer_pilot_rollback_plan_not_found",
    "transformer_pilot_unit_not_found",
  ),
  ...publicRules(
    409,
    "Request conflicts with current execution state",
    "transformer_pilot_adaptive_candidate_handoff_conflict",
    "transformer_pilot_adaptive_candidate_import_conflict",
    "transformer_pilot_attempt_not_running",
    "transformer_pilot_campaign_exists",
    "transformer_pilot_campaign_not_running",
    "transformer_pilot_candidate_drift",
    "transformer_pilot_exception_not_open",
    "transformer_pilot_fence_expired",
    "transformer_pilot_fence_not_expired",
    "transformer_pilot_fence_stale",
    "transformer_pilot_idempotency_conflict",
    "transformer_pilot_model_reservation_conflict",
    "transformer_pilot_pause_invalid",
    "transformer_pilot_regeneration_resume_blocked",
    "transformer_pilot_resume_blocked",
    "transformer_pilot_retry_invalid",
    "transformer_pilot_routing_settlement_conflict",
    "transformer_pilot_routing_terminal_conflict",
    "transformer_pilot_source_drift",
    "transformer_pilot_wave_execution_incomplete",
    "transformer_pilot_wave_observation_incomplete",
  ),
  ...publicRules(
    400,
    "Request validation failed",
    "json_body_required",
    "request_id_required",
    "idempotency_key_required",
    "evidence_refs_required",
    "evidence_refs_required_duplicate",
    "transformer_pilot_adaptive_accounting_invalid",
    "transformer_pilot_adaptive_budget_cost_invalid",
    "transformer_pilot_adaptive_budget_invalid",
    "transformer_pilot_adaptive_candidate_attempt_invalid",
    "transformer_pilot_adaptive_candidate_attempt_mismatch",
    "transformer_pilot_adaptive_candidate_digest_mismatch",
    "transformer_pilot_adaptive_candidate_expiry_invalid",
    "transformer_pilot_adaptive_candidate_file_modes_invalid",
    "transformer_pilot_adaptive_candidate_handoff_mismatch",
    "transformer_pilot_adaptive_candidate_paths_invalid",
    "transformer_pilot_adaptive_candidate_seal_path_invalid",
    "transformer_pilot_adaptive_candidate_source_mismatch",
    "transformer_pilot_attempt_limit_invalid",
    "transformer_pilot_budget_override_invalid",
    "transformer_pilot_budget_override_reason_invalid",
    "transformer_pilot_campaign_invalid",
    "transformer_pilot_campaign_limit_invalid",
    "transformer_pilot_campaign_required",
    "transformer_pilot_cancel_invalid",
    "transformer_pilot_candidate_digest_invalid",
    "transformer_pilot_candidate_revision_invalid",
    "transformer_pilot_changed_paths_required",
    "transformer_pilot_claim_replay_invalid",
    "transformer_pilot_claim_required",
    "transformer_pilot_completion_required",
    "transformer_pilot_constraint_scope_mismatch",
    "transformer_pilot_control_invalid",
    "transformer_pilot_control_required",
    "transformer_pilot_cost_invalid",
    "transformer_pilot_crash_required",
    "transformer_pilot_delivery_approvals_invalid",
    "transformer_pilot_delivery_approvals_invalid_duplicate",
    "transformer_pilot_delivery_required",
    "transformer_pilot_dependency_cycle",
    "transformer_pilot_dependency_invalid",
    "transformer_pilot_exception_invalid",
    "transformer_pilot_failure_code_invalid",
    "transformer_pilot_lease_duration_invalid",
    "transformer_pilot_lease_generation_invalid",
    "transformer_pilot_lease_token_invalid",
    "transformer_pilot_model_reservation_bound_invalid",
    "transformer_pilot_model_reservation_provenance_invalid",
    "transformer_pilot_observation_required",
    "transformer_pilot_observations_required",
    "transformer_pilot_observed_at_invalid",
    "transformer_pilot_regeneration_candidate_binding_mismatch",
    "transformer_pilot_regeneration_state_invalid",
    "transformer_pilot_resolution_required",
    "transformer_pilot_rollback_plan_empty",
    "transformer_pilot_routing_attempt_mismatch",
    "transformer_pilot_routing_latency_invalid",
    "transformer_pilot_routing_settlement_limit_invalid",
    "transformer_pilot_routing_settlement_mismatch",
    "transformer_pilot_snapshot_manifest_invalid",
    "transformer_pilot_source_digest_invalid",
    "transformer_pilot_source_revision_invalid",
    "transformer_pilot_unit_duplicate",
    "transformer_pilot_unit_invalid",
    "transformer_pilot_units_invalid",
    "transformer_pilot_verification_invalid",
    "transformer_pilot_wave_invalid",
    "transformer_pilot_wave_observation_scope_invalid",
  ),
];

const TRANSFORMER_PILOT_DETAIL_CODES = new Set([
  "transformer_pilot_gate_denied",
  "transformer_pilot_delivery_denied",
  "transformer_pilot_constraint_denied",
]);

const TRANSFORMER_PILOT_DOMAIN_ERRORS: readonly PublicErrorRule[] = [
  ...publicRules(
    403,
    "Transformer authorization denied",
    "transformer_pilot_gate_denied",
    "transformer_pilot_delivery_denied",
  ),
  ...publicRules(
    400,
    "Request validation failed",
    "transformer_pilot_constraint_denied",
  ),
];

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
  const override = resolveRenamedEnv(env, DB_ENV)?.trim();
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

function nonnegativeInteger(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(code);
  return Number(value);
}

function adaptiveAccounting(value: unknown): TransformerAdaptiveAttemptAccounting {
  const input = record(value, "transformer_pilot_adaptive_accounting_required");
  const accounting = {
    plannerCalls: nonnegativeInteger(input.plannerCalls, "transformer_pilot_adaptive_accounting_invalid"),
    modelCalls: nonnegativeInteger(input.modelCalls, "transformer_pilot_adaptive_accounting_invalid"),
    inputTokens: nonnegativeInteger(input.inputTokens, "transformer_pilot_adaptive_accounting_invalid"),
    outputTokens: nonnegativeInteger(input.outputTokens, "transformer_pilot_adaptive_accounting_invalid"),
    totalTokens: nonnegativeInteger(input.totalTokens, "transformer_pilot_adaptive_accounting_invalid"),
    actualCostUsd: nonnegativeNumber(input.actualCostUsd, "transformer_pilot_adaptive_accounting_invalid"),
    wallTimeMs: nonnegativeInteger(input.wallTimeMs, "transformer_pilot_adaptive_accounting_invalid"),
  };
  if (
    accounting.modelCalls > accounting.plannerCalls ||
    accounting.totalTokens !== accounting.inputTokens + accounting.outputTokens
  ) {
    throw new Error("transformer_pilot_adaptive_accounting_invalid");
  }
  return Object.freeze(accounting);
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
  if (
    error instanceof TransformerDomainError &&
    TRANSFORMER_PILOT_DETAIL_CODES.has(error.code)
  ) {
    return mappedErrorResponse(
      c,
      new Error(error.code, { cause: error }),
      TRANSFORMER_PILOT_DOMAIN_ERRORS,
    );
  }
  return mappedErrorResponse(c, error, TRANSFORMER_PILOT_ERRORS);
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
      environment: runtime.environment ?? resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_ENVIRONMENT") ?? "",
      rawGateConfig: runtime.rawGateConfig ?? resolveRenamedEnv(process.env, "MENDPOINT_REGAUGE_GATE"),
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
    if (!decision.allowed) {
      throw new TransformerDomainError("transformer_pilot_gate_denied", decision.reasons.join(","));
    }
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

  report(tenantId: string, campaignId: string) {
    this.get(tenantId, campaignId);
    const report = generateModernizationReport(this.store, tenantId, campaignId);
    return { report, markdown: renderModernizationReportMarkdown(report) };
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
      accounting: adaptiveAccounting(input.accounting),
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
      accounting: adaptiveAccounting(input.accounting),
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

  app.get("/transformer/executions/:campaignId/report", (c) => {
    try {
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json(service.report(principal.tenantId, c.req.param("campaignId")));
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
    delivery: service.get(request.tenantId, campaignId).units
      .filter((unit) => unit.state === "draft")
      .every((unit) => unit.draftDelivery !== undefined)
        ? "queued"
        : "external",
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
