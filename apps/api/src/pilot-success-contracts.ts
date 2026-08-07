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
import {
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";

const MAX_BODY_BYTES = 128 * 1_024;

function nestedRules(
  status: PublicErrorRule["status"],
  publicMessage: string,
  ...internalCodes: readonly string[]
): readonly PublicErrorRule[] {
  return internalCodes.map((internalCode) => ({
    internalCode,
    status,
    publicMessage,
    responseShape: "nested",
  }));
}

const PILOT_CONTRACT_TEXT_FIELDS = [
  "provider",
  "change_description",
  "repository_owner",
  "repository_name",
  "repository_branch",
  "repository_scope",
  "threshold_metric",
  "threshold_unit",
  "owner_principal",
  "support_coverage",
  "privacy_deletion_procedure",
  "rollback_trigger",
  "rollback_procedure",
  "rollback_owner",
  "review_time",
  "review_owner",
  "conversion_due_at",
  "conversion_owner",
] as const;

const PILOT_CONTRACT_ERRORS: readonly PublicErrorRule[] = [
  {
    internalCode: "pilot_contract_authentication_required",
    publicCode: "unauthorized",
    status: 401,
    publicMessage: "Authentication is required",
    responseShape: "nested",
  },
  ...[
    "pilot_contract_manager_required",
    "pilot_contract_reviewer_role_required",
  ].map((internalCode): PublicErrorRule => ({
    internalCode,
    publicCode: "forbidden",
    status: 403,
    publicMessage: "This operation requires pilot contract authority",
    responseShape: "nested",
  })),
  {
    internalCode: "pilot_contract_not_found",
    publicCode: "not_found",
    status: 404,
    publicMessage: "Pilot success contract was not found",
    responseShape: "nested",
  },
  ...nestedRules(
    409,
    "Pilot success contract conflicts with current state",
    "pilot_contract_version_conflict",
    "pilot_contract_id_conflict",
    "pilot_contract_already_approved",
  ),
  ...nestedRules(
    413,
    "Pilot success contract payload is too large",
    "pilot_contract_payload_too_large",
  ),
  ...nestedRules(
    422,
    "Pilot success contract was rejected",
    "pilot_contract_content_type_invalid",
    "pilot_contract_payload_invalid",
    "pilot_contract_definition_required",
    "pilot_contract_definition_invalid",
    "pilot_contract_version_invalid",
    "pilot_contract_change_class_invalid",
    "pilot_contract_repositories_required",
    "pilot_contract_repository_duplicate",
    "pilot_contract_thresholds_required",
    "pilot_contract_threshold_operator_invalid",
    "pilot_contract_threshold_target_invalid",
    "pilot_contract_threshold_duplicate",
    "pilot_contract_owners_required",
    "pilot_contract_owner_responsibility_invalid",
    "pilot_contract_owner_duplicate",
    "pilot_contract_owner_customer_owner_required",
    "pilot_contract_owner_mendpoint_owner_required",
    "pilot_contract_owner_technical_reviewer_required",
    "pilot_contract_owner_privacy_contact_required",
    "pilot_contract_owner_rollback_owner_required",
    "pilot_contract_support_responses_required",
    "pilot_contract_support_severity_invalid",
    "pilot_contract_support_response_minutes_invalid",
    "pilot_contract_support_severity_duplicate",
    "pilot_contract_privacy_data_categories_required",
    "pilot_contract_privacy_data_categories_invalid",
    "pilot_contract_privacy_data_categories_duplicate",
    "pilot_contract_privacy_retention_days_invalid",
    "pilot_contract_privacy_processing_regions_required",
    "pilot_contract_privacy_processing_regions_invalid",
    "pilot_contract_privacy_processing_regions_duplicate",
    "pilot_contract_rollback_recovery_minutes_invalid",
    "pilot_contract_rollback_owner_mismatch",
    "pilot_contract_review_day_invalid",
    "pilot_contract_review_time_invalid",
    "pilot_contract_review_agenda_required",
    "pilot_contract_review_agenda_invalid",
    "pilot_contract_review_agenda_duplicate",
    "pilot_contract_review_owner_mismatch",
    "pilot_contract_conversion_criteria_required",
    "pilot_contract_conversion_criteria_invalid",
    "pilot_contract_conversion_criteria_duplicate",
    "pilot_contract_conversion_owner_mismatch",
    "pilot_contract_principal_tenant_mismatch",
    "pilot_contract_human_reviewer_required",
    "pilot_contract_independent_reviewer_required",
    "pilot_contract_reviewer_not_assigned",
    ...PILOT_CONTRACT_TEXT_FIELDS.map((field) => `pilot_contract_${field}_invalid`),
  ),
];

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
  return mappedErrorResponse(c, error, PILOT_CONTRACT_ERRORS);
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
