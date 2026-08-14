import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Hono, type Context } from "hono";
import {
  NODE_RUNTIME_18_TO_20_RECIPE,
  TransformerDomainError,
  TransformerControlPlaneStore,
  recipeReference,
  resolveRecipe,
  type BlueprintPolicy,
  type CampaignState,
  type MutationContext,
  type TransformerEvent,
} from "@mendpoint/transformer";
import {
  assessTransformerGate,
  type TransformerGateBoundary,
  type TransformerGateDecision,
} from "@mendpoint/ops";
import type { ApiEnv } from "./auth.js";
import {
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";

const DB_ENV = "MENDPOINT_TRANSFORMER_CONTROL_PLANE_DB";
const SECRET_KEY = /(?:secret|token|password|credential|private.?key|api.?key)/i;
const PATH_KEY = /(?:path|directory|workspace|checkout)/i;
const WINDOWS_PATH = /^(?:[a-z]:[\\/]|\\\\)/i;
const SECRET_VALUE = /^(?:sk_|ghp_|github_pat_|me_)[a-z0-9_-]+$/i;
const CAMPAIGN_STATES = new Set<CampaignState>([
  "draft",
  "ready",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

function publicRules(
  status: PublicErrorRule["status"],
  publicMessage: string,
  ...internalCodes: readonly string[]
): readonly PublicErrorRule[] {
  return internalCodes.map((internalCode) => ({ internalCode, status, publicMessage }));
}

const TRANSFORMER_CONTROL_PLANE_ERRORS: readonly PublicErrorRule[] = [
  {
    internalCode: "authenticated_principal_required",
    publicCode: "unauthorized",
    status: 401,
    publicMessage: "Authenticated principal required",
  },
  ...publicRules(
    404,
    "Requested resource was not found",
    "campaign_not_found",
    "blueprint_not_found",
    "bsg_not_found",
    "exception_not_found",
    "attempt_unit_not_found",
    "pr_unit_not_found",
    "wave_unit_not_found",
  ),
  ...publicRules(
    409,
    "Request conflicts with current state",
    "idempotency_conflict",
    "review_revision_conflict",
    "campaign_revision_conflict",
    "blueprint_revision_conflict",
    "bsg_revision_conflict",
    "exception_revision_conflict",
    "campaign_identity_immutable",
    "blueprint_identity_immutable",
    "bsg_identity_immutable",
    "exception_identity_immutable",
    "locked_bsg_immutable",
    "reviewed_blueprint_immutable",
  ),
  ...publicRules(
    400,
    "Request validation failed",
    "json_body_required",
    "request_id_required",
    "idempotency_key_required",
    "evidence_refs_required",
    "evidence_ref_invalid",
    "campaign_bundle_required",
    "campaign_required",
    "campaign_id_required",
    "campaign_name_required",
    "campaign_source_required",
    "campaign_target_required",
    "campaign_state_invalid",
    "campaign_expected_revision_invalid",
    "blueprint_required",
    "blueprint_id_required",
    "blueprint_objective_required",
    "blueprint_content_required",
    "blueprint_policy_required",
    "blueprint_policy_invalid",
    "blueprint_owner_required",
    "blueprint_risks_required",
    "blueprint_unknowns_required",
    "blueprint_risk_invalid",
    "blueprint_risk_id_required",
    "blueprint_risk_statement_required",
    "blueprint_risk_severity_invalid",
    "blueprint_risk_owner_required",
    "blueprint_risk_evidence_required",
    "blueprint_risk_evidence_invalid",
    "blueprint_unknown_invalid",
    "blueprint_unknown_id_required",
    "blueprint_unknown_question_required",
    "blueprint_unknown_owner_required",
    "blueprint_unknown_evidence_required",
    "blueprint_unknown_evidence_invalid",
    "blueprint_verification_required",
    "blueprint_rollback_required",
    "blueprint_rollback_strategy_invalid",
    "blueprint_rollback_verification_required",
    "blueprint_approval_required",
    "blueprint_reviewer_required",
    "blueprint_recipe_invalid",
    "blueprint_recipe_mismatch",
    "blueprint_expected_revision_invalid",
    "bsg_required",
    "bsg_invalid",
    "bsg_id_required",
    "bsg_node_invalid",
    "bsg_node_id_required",
    "bsg_node_kind_required",
    "bsg_node_spec_required",
    "bsg_node_source_refs_required",
    "bsg_node_source_ref_invalid",
    "bsg_edge_invalid",
    "bsg_edge_id_required",
    "bsg_edge_from_required",
    "bsg_edge_to_required",
    "bsg_edge_kind_required",
    "bsg_expected_revision_invalid",
    "bsg_nodes_limit",
    "bsg_edges_limit",
    "review_required",
    "blueprint_reviewer_not_authorized",
    "independent_blueprint_reviewer_required",
    "transition_required",
    "exception_required",
    "exception_id_required",
    "exception_code_required",
    "exception_message_required",
    "exception_unit_id_invalid",
    "approval_note_required",
    "approval_reviewer_required",
    "artifact_digest_invalid",
    "attempt_number_invalid",
    "campaign_running_required",
    "nonempty_bsg_required",
    "nonempty_locked_bsg_required",
    "pr_number_invalid",
    "reviewed_blueprint_required",
  ),
];

const TRANSFORMER_CONTROL_PLANE_DETAIL_CODES = new Set([
  "invalid_campaign_transition",
  "invalid_blueprint_transition",
  "invalid_bsg_transition",
  "invalid_exception_transition",
]);

const TRANSFORMER_CONTROL_PLANE_DOMAIN_ERRORS: readonly PublicErrorRule[] = publicRules(
  409,
  "Request conflicts with current state",
  ...TRANSFORMER_CONTROL_PLANE_DETAIL_CODES,
);

type JsonRecord = Record<string, unknown>;

export type TransformerGateRuntime = Readonly<{
  rawConfig?: string;
  environment?: string;
}>;

export type TransformerMutationRequest = Readonly<{
  tenantId: string;
  actorId: string;
  requestId: string;
  idempotencyKey: string;
  evidenceRefs: readonly string[];
}>;

export type CampaignBundleInput = Readonly<{
  campaign: Readonly<{
    id: string;
    name: string;
    sourceSystem: string;
    targetSystem: string;
  }>;
  blueprint: Readonly<{
    id: string;
    objective: string;
    content: JsonRecord;
    policy: Omit<BlueprintPolicy, "recipe"> & { recipe?: BlueprintPolicy["recipe"] };
  }>;
  bsg: Readonly<{
    id: string;
    nodes: Array<{ id: string; kind: string; spec: string; sourceRefs: string[] }>;
    edges: Array<{ id: string; from: string; to: string; kind: string }>;
  }>;
}>;

export function transformerControlPlanePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const override = env[DB_ENV]?.trim();
  if (override) return resolve(override);
  const dataDir = env.MENDPOINT_DATA_DIR?.trim();
  return join(dataDir ? resolve(dataDir) : join(cwd, "data"), "transformer-control-plane.sqlite");
}

function requiredString(value: unknown, code: string, max = 2_000): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(code);
  }
  return value.trim();
}

export function transformerBlueprintApprovalId(blueprintId: string, reviewerId: string): string {
  const reviewerDigest = createHash("sha256").update(reviewerId, "utf8").digest("hex").slice(0, 24);
  return `blueprint-review-${blueprintId}-${reviewerDigest}`;
}

function record(value: unknown, code: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonRecord;
}

function stringArray(value: unknown, code: string, max = 500): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value.map((item) => requiredString(item, code, max));
}

function safeReference(value: string, code: string): string {
  const ref = requiredString(value, code, 500);
  if (WINDOWS_PATH.test(ref) || ref.startsWith("/") || ref.toLowerCase().startsWith("file://")) {
    throw new Error(code);
  }
  return ref;
}

function exactRecipe(value: unknown): BlueprintPolicy["recipe"] {
  if (value === undefined) return recipeReference(NODE_RUNTIME_18_TO_20_RECIPE);
  const supplied = record(value, "blueprint_recipe_invalid");
  const reference = {
    id: requiredString(supplied.id, "blueprint_recipe_invalid", 200),
    version: positiveRevision(supplied.version, "blueprint_recipe_invalid"),
    digest: requiredString(supplied.digest, "blueprint_recipe_invalid", 80),
  };
  try {
    resolveRecipe(reference);
  } catch {
    throw new Error("blueprint_recipe_mismatch");
  }
  return reference;
}

function parsePolicy(value: unknown): BlueprintPolicy {
  const input = record(value, "blueprint_policy_required");
  const risks = Array.isArray(input.risks) ? input.risks : undefined;
  const unknowns = Array.isArray(input.unknowns) ? input.unknowns : undefined;
  if (!risks || !unknowns) throw new Error("blueprint_policy_invalid");
  const verification = record(input.verification, "blueprint_verification_required");
  const rollback = record(input.rollback, "blueprint_rollback_required");
  const approval = record(input.approval, "blueprint_approval_required");
  return {
    ownerIds: stringArray(input.ownerIds, "blueprint_owner_required"),
    risks: risks.map((item) => {
      const risk = record(item, "blueprint_risk_invalid");
      const severity = requiredString(risk.severity, "blueprint_risk_severity_invalid");
      if (!["low", "medium", "high", "critical"].includes(severity)) {
        throw new Error("blueprint_risk_severity_invalid");
      }
      return {
        id: requiredString(risk.id, "blueprint_risk_id_required"),
        statement: requiredString(risk.statement, "blueprint_risk_statement_required"),
        severity: severity as "low" | "medium" | "high" | "critical",
        ownerId: requiredString(risk.ownerId, "blueprint_risk_owner_required"),
        evidenceRefs: stringArray(risk.evidenceRefs, "blueprint_risk_evidence_required").map(
          (ref) => safeReference(ref, "blueprint_risk_evidence_invalid"),
        ),
      };
    }),
    unknowns: unknowns.map((item) => {
      const unknown = record(item, "blueprint_unknown_invalid");
      return {
        id: requiredString(unknown.id, "blueprint_unknown_id_required"),
        question: requiredString(unknown.question, "blueprint_unknown_question_required"),
        ownerId: requiredString(unknown.ownerId, "blueprint_unknown_owner_required"),
        evidenceRefs: stringArray(
          unknown.evidenceRefs,
          "blueprint_unknown_evidence_required",
        ).map((ref) => safeReference(ref, "blueprint_unknown_evidence_invalid")),
      };
    }),
    verification: {
      commands: stringArray(verification.commands, "blueprint_verification_required", 10_000),
    },
    rollback: {
      strategy:
        rollback.strategy === "inverse_operations"
          ? "inverse_operations"
          : (() => {
              throw new Error("blueprint_rollback_strategy_invalid");
            })(),
      verificationCommands: stringArray(
        rollback.verificationCommands,
        "blueprint_rollback_verification_required",
        10_000,
      ),
    },
    approval: {
      required:
        approval.required === true
          ? true
          : (() => {
              throw new Error("blueprint_approval_required");
            })(),
      reviewerIds: stringArray(approval.reviewerIds, "blueprint_reviewer_required"),
    },
    recipe: exactRecipe(input.recipe),
  };
}

function parseBundle(value: unknown): CampaignBundleInput {
  const body = record(value, "campaign_bundle_required");
  const campaign = record(body.campaign, "campaign_required");
  const blueprint = record(body.blueprint, "blueprint_required");
  const bsg = record(body.bsg, "bsg_required");
  const nodes = Array.isArray(bsg.nodes) ? bsg.nodes : undefined;
  const edges = Array.isArray(bsg.edges) ? bsg.edges : undefined;
  if (!nodes || !edges) throw new Error("bsg_invalid");
  return {
    campaign: {
      id: requiredString(campaign.id, "campaign_id_required", 200),
      name: requiredString(campaign.name, "campaign_name_required"),
      sourceSystem: requiredString(campaign.sourceSystem, "campaign_source_required"),
      targetSystem: requiredString(campaign.targetSystem, "campaign_target_required"),
    },
    blueprint: {
      id: requiredString(blueprint.id, "blueprint_id_required", 200),
      objective: requiredString(blueprint.objective, "blueprint_objective_required"),
      content: record(blueprint.content, "blueprint_content_required"),
      policy: parsePolicy(blueprint.policy),
    },
    bsg: {
      id: requiredString(bsg.id, "bsg_id_required", 200),
      nodes: nodes.map((item) => {
        const node = record(item, "bsg_node_invalid");
        return {
          id: requiredString(node.id, "bsg_node_id_required", 200),
          kind: requiredString(node.kind, "bsg_node_kind_required"),
          spec: requiredString(node.spec, "bsg_node_spec_required"),
          sourceRefs: stringArray(node.sourceRefs, "bsg_node_source_refs_required").map((ref) =>
            safeReference(ref, "bsg_node_source_ref_invalid"),
          ),
        };
      }),
      edges: edges.map((item) => {
        const edge = record(item, "bsg_edge_invalid");
        return {
          id: requiredString(edge.id, "bsg_edge_id_required", 200),
          from: requiredString(edge.from, "bsg_edge_from_required", 200),
          to: requiredString(edge.to, "bsg_edge_to_required", 200),
          kind: requiredString(edge.kind, "bsg_edge_kind_required"),
        };
      }),
    },
  };
}

function context(request: TransformerMutationRequest, suffix: string): MutationContext {
  return {
    actorId: requiredString(request.actorId, "authenticated_principal_required", 200),
    correlationId: requiredString(request.requestId, "request_id_required", 200),
    causationId: requiredString(request.requestId, "request_id_required", 200),
    evidenceRefs: stringArray(request.evidenceRefs, "evidence_refs_required").map((ref) =>
      safeReference(ref, "evidence_ref_invalid"),
    ),
    idempotencyKey: `${requiredString(request.idempotencyKey, "idempotency_key_required", 200)}:${suffix}`,
  };
}

function sanitize(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key) || PATH_KEY.test(key)) return undefined;
  if (typeof value === "string") {
    if (WINDOWS_PATH.test(value) || value.startsWith("/") || value.toLowerCase().startsWith("file://")) {
      return "[redacted]";
    }
    if (SECRET_VALUE.test(value)) return "[redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item)).filter((item) => item !== undefined);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as JsonRecord)
      .map(([childKey, child]) => [childKey, sanitize(child, childKey)] as const)
      .filter((entry) => entry[1] !== undefined),
  );
}

function revisionFields(value: { id: string; state: string; revision: number; createdAt: string }) {
  return { id: value.id, state: value.state, revision: value.revision, createdAt: value.createdAt };
}

export class TransformerCampaignService {
  readonly store: TransformerControlPlaneStore;

  constructor(path = transformerControlPlanePath()) {
    this.store = new TransformerControlPlaneStore(path);
  }

  close(): void {
    this.store.close();
  }

  private validateBundle(request: TransformerMutationRequest, input: CampaignBundleInput): void {
    const validation = new TransformerControlPlaneStore();
    try {
      validation.createCampaign(
        {
          tenantId: request.tenantId,
          id: input.campaign.id,
          name: input.campaign.name,
          sourceSystem: input.campaign.sourceSystem,
          targetSystem: input.campaign.targetSystem,
          blueprintId: input.blueprint.id,
          bsgId: input.bsg.id,
        },
        context(request, "campaign"),
      );
      validation.createBlueprint(
        {
          tenantId: request.tenantId,
          campaignId: input.campaign.id,
          id: input.blueprint.id,
          objective: input.blueprint.objective,
          content: input.blueprint.content,
          policy: input.blueprint.policy as BlueprintPolicy,
        },
        context(request, "blueprint"),
      );
      validation.createBsg(
        {
          tenantId: request.tenantId,
          campaignId: input.campaign.id,
          id: input.bsg.id,
          nodes: input.bsg.nodes,
          edges: input.bsg.edges,
        },
        context(request, "bsg"),
      );
    } finally {
      validation.close();
    }
  }

  createBundle(request: TransformerMutationRequest, rawInput: unknown) {
    const input = parseBundle(rawInput);
    this.validateBundle(request, input);
    return this.store.atomic(() => {
      if (!this.store.getCampaign(request.tenantId, input.campaign.id)) {
        if (this.store.getBlueprint(request.tenantId, input.blueprint.id)) {
          throw new Error("blueprint_already_exists");
        }
        if (this.store.getBsg(request.tenantId, input.bsg.id)) {
          throw new Error("bsg_already_exists");
        }
      }
      this.store.createCampaign(
        {
          tenantId: request.tenantId,
          id: input.campaign.id,
          name: input.campaign.name,
          sourceSystem: input.campaign.sourceSystem,
          targetSystem: input.campaign.targetSystem,
          blueprintId: input.blueprint.id,
          bsgId: input.bsg.id,
        },
        context(request, "campaign"),
      );
      this.store.createBlueprint(
        {
          tenantId: request.tenantId,
          campaignId: input.campaign.id,
          id: input.blueprint.id,
          objective: input.blueprint.objective,
          content: input.blueprint.content,
          policy: input.blueprint.policy as BlueprintPolicy,
        },
        context(request, "blueprint"),
      );
      this.store.createBsg(
        {
          tenantId: request.tenantId,
          campaignId: input.campaign.id,
          id: input.bsg.id,
          nodes: input.bsg.nodes,
          edges: input.bsg.edges,
        },
        context(request, "bsg"),
      );
      return this.get(request.tenantId, input.campaign.id);
    });
  }

  get(tenantId: string, campaignId: string) {
    const campaign = this.store.getCampaign(tenantId, requiredString(campaignId, "campaign_id_required"));
    if (!campaign) throw new Error("campaign_not_found");
    const blueprint = this.store.getBlueprint(tenantId, campaign.blueprintId);
    const bsg = this.store.getBsg(tenantId, campaign.bsgId);
    if (!blueprint || !bsg) throw new Error("campaign_bundle_incomplete");
    return sanitize({
      campaign: {
        ...revisionFields(campaign),
        name: campaign.name,
        sourceSystem: campaign.sourceSystem,
        targetSystem: campaign.targetSystem,
        blueprintId: campaign.blueprintId,
        bsgId: campaign.bsgId,
      },
      blueprint: {
        ...revisionFields(blueprint),
        objective: blueprint.objective,
        content: blueprint.content,
        policy: blueprint.policy,
      },
      bsg: {
        ...revisionFields(bsg),
        nodes: bsg.nodes,
        edges: bsg.edges,
      },
    });
  }

  reviewToReady(
    request: TransformerMutationRequest,
    campaignId: string,
    revisions: { campaign: number; blueprint: number; bsg: number },
  ) {
    return this.store.atomic(() => {
      const campaign = this.store.getCampaign(request.tenantId, campaignId);
      if (!campaign) throw new Error("campaign_not_found");
      const blueprint = this.store.getBlueprint(request.tenantId, campaign.blueprintId);
      const bsg = this.store.getBsg(request.tenantId, campaign.bsgId);
      if (!blueprint || !bsg) throw new Error("campaign_bundle_incomplete");
      const plannerActorId = typeof blueprint.content.plannerActorId === "string"
        ? blueprint.content.plannerActorId
        : undefined;
      if (plannerActorId === request.actorId) {
        throw new Error("independent_blueprint_reviewer_required");
      }
      if (!blueprint.policy.approval.reviewerIds.includes(request.actorId)) {
        throw new Error("blueprint_reviewer_not_authorized");
      }
      const initial =
        campaign.state === "draft" &&
        campaign.revision === revisions.campaign &&
        blueprint.state === "draft" &&
        blueprint.revision === revisions.blueprint &&
        bsg.state === "draft" &&
        bsg.revision === revisions.bsg &&
        bsg.nodes.length > 0;
      const replay =
        campaign.state === "ready" &&
        campaign.revision === revisions.campaign + 1 &&
        blueprint.state === "reviewed" &&
        blueprint.revision === revisions.blueprint + 2 &&
        bsg.state === "locked" &&
        bsg.revision === revisions.bsg + 1;
      if (!initial && !replay) throw new Error("review_revision_conflict");
      const approvalId = transformerBlueprintApprovalId(blueprint.id, request.actorId);
      const existingApproval = this.store.getApproval(request.tenantId, approvalId);
      if (!existingApproval) {
        const approval = this.store.createApproval({
          tenantId: request.tenantId,
          campaignId,
          id: approvalId,
          subjectType: "blueprint",
          subjectId: blueprint.id,
        }, context(request, "blueprint-review-created"));
        this.store.transitionApproval(
          request.tenantId,
          approval.id,
          "approved",
          { reviewerId: request.actorId },
          approval.revision,
          context(request, "blueprint-review-approved"),
        );
      } else if (
        existingApproval.state !== "approved" ||
        existingApproval.subjectType !== "blueprint" ||
        existingApproval.subjectId !== blueprint.id ||
        existingApproval.reviewerId !== request.actorId
      ) {
        throw new Error("blueprint_reviewer_not_authorized");
      }
      const review = blueprint.content.review && typeof blueprint.content.review === "object" &&
          !Array.isArray(blueprint.content.review)
        ? blueprint.content.review as JsonRecord
        : undefined;
      const minimumApprovals = review?.minimumApprovals === undefined
        ? 1
        : positiveRevision(review.minimumApprovals, "blueprint_approval_required");
      if (minimumApprovals > blueprint.policy.approval.reviewerIds.length) {
        throw new Error("blueprint_approval_required");
      }
      const approvalCount = blueprint.policy.approval.reviewerIds.filter((reviewerId) => {
        const candidate = this.store.getApproval(
          request.tenantId,
          transformerBlueprintApprovalId(blueprint.id, reviewerId),
        );
        return candidate?.state === "approved" && candidate.reviewerId === reviewerId &&
          candidate.subjectType === "blueprint" && candidate.subjectId === blueprint.id;
      }).length;
      if (approvalCount < minimumApprovals) return this.get(request.tenantId, campaignId);
      this.store.transitionBlueprint(
        request.tenantId,
        campaign.blueprintId,
        "in_review",
        revisions.blueprint,
        context(request, "blueprint-in-review"),
      );
      this.store.transitionBlueprint(
        request.tenantId,
        campaign.blueprintId,
        "reviewed",
        revisions.blueprint + 1,
        context(request, "blueprint-reviewed"),
      );
      this.store.lockBsg(
        request.tenantId,
        campaign.bsgId,
        revisions.bsg,
        context(request, "bsg-locked"),
      );
      this.store.transitionCampaign(
        request.tenantId,
        campaignId,
        "ready",
        revisions.campaign,
        context(request, "campaign-ready"),
      );
      return this.get(request.tenantId, campaignId);
    });
  }

  transition(
    request: TransformerMutationRequest,
    campaignId: string,
    state: CampaignState,
    expectedRevision: number,
  ) {
    if (!CAMPAIGN_STATES.has(state)) throw new Error("campaign_state_invalid");
    this.store.transitionCampaign(
      request.tenantId,
      campaignId,
      state,
      expectedRevision,
      context(request, `campaign-${state}`),
    );
    return this.get(request.tenantId, campaignId);
  }

  createException(
    request: TransformerMutationRequest,
    campaignId: string,
    rawInput: unknown,
  ) {
    const input = record(rawInput, "exception_required");
    const exception = this.store.createException(
      {
        tenantId: request.tenantId,
        campaignId,
        id: requiredString(input.id, "exception_id_required", 200),
        code: requiredString(input.code, "exception_code_required", 200),
        message: requiredString(input.message, "exception_message_required"),
        unitId:
          input.unitId === undefined
            ? undefined
            : requiredString(input.unitId, "exception_unit_id_invalid", 200),
      },
      context(request, "exception"),
    );
    return sanitize({
      exception: {
        ...revisionFields(exception),
        campaignId: exception.campaignId,
        code: exception.code,
        message: exception.message,
        unitId: exception.unitId,
      },
    });
  }

  events(tenantId: string, campaignId: string): TransformerEvent[] {
    return this.store.listEvents(tenantId, campaignId);
  }
}

function requestMetadata(c: Context<ApiEnv>): TransformerMutationRequest {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  const requestId = c.get("requestId");
  const idempotencyKey = c.req.header("idempotency-key");
  const evidence = c.req.header("x-mendpoint-evidence-refs");
  return {
    tenantId: principal.tenantId,
    actorId: principal.id,
    requestId: requiredString(requestId, "request_id_required", 200),
    idempotencyKey: requiredString(idempotencyKey, "idempotency_key_required", 200),
    evidenceRefs: stringArray(
      evidence?.split(",").map((value) => value.trim()).filter(Boolean),
      "evidence_refs_required",
    ),
  };
}

function positiveRevision(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(code);
  return Number(value);
}

function errorResponse(c: Context<ApiEnv>, error: unknown) {
  if (
    error instanceof TransformerDomainError &&
    TRANSFORMER_CONTROL_PLANE_DETAIL_CODES.has(error.code)
  ) {
    return mappedErrorResponse(
      c,
      new Error(error.code, { cause: error }),
      TRANSFORMER_CONTROL_PLANE_DOMAIN_ERRORS,
    );
  }
  return mappedErrorResponse(c, error, TRANSFORMER_CONTROL_PLANE_ERRORS);
}

async function json(c: Context<ApiEnv>): Promise<unknown> {
  const body = await c.req.json<unknown>().catch(() => undefined);
  if (body === undefined) throw new Error("json_body_required");
  return body;
}

export function registerTransformerControlPlaneRoutes(
  app: Hono<ApiEnv>,
  service: TransformerCampaignService,
  gateRuntime: TransformerGateRuntime = {},
): void {
  const gate = (c: Context<ApiEnv>, boundary: TransformerGateBoundary): TransformerGateDecision => {
    const principal = c.get("principal");
    if (!principal) throw new Error("authenticated_principal_required");
    return assessTransformerGate(
      {
        tenantId: principal.tenantId,
        environment: gateRuntime.environment ?? process.env.MENDPOINT_TRANSFORMER_ENVIRONMENT ?? "",
        boundary,
      },
      gateRuntime.rawConfig ?? process.env.MENDPOINT_TRANSFORMER_GATE,
    );
  };
  const requireGate = (c: Context<ApiEnv>): Response | undefined => {
    const decision = gate(c, "api_control_plane");
    if (decision.allowed) return undefined;
    return c.json(
      {
        error: "transformer_experimental_gate_denied",
        message: "Transformer is unavailable for this tenant and environment",
        gate: decision,
      },
      403,
    );
  };

  const mount = (base: string): void => {
  app.get(`${base}/gate`, (c) => {
    try {
      return c.json({ gate: gate(c, "ui") });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${base}/control-plane/campaigns`, async (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      const result = service.createBundle(requestMetadata(c), await json(c));
      c.header("Location", `${base}/control-plane/campaigns/${(result as { campaign: { id: string } }).campaign.id}`);
      return c.json(result, 201);
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${base}/control-plane/campaigns/:campaignId`, (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      return c.json(service.get(principal.tenantId, c.req.param("campaignId")));
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.get(`${base}/control-plane/campaigns/:campaignId/events`, (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      const principal = c.get("principal");
      if (!principal) throw new Error("authenticated_principal_required");
      const campaignId = c.req.param("campaignId");
      service.get(principal.tenantId, campaignId);
      return c.json({ events: sanitize(service.events(principal.tenantId, campaignId)) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${base}/control-plane/campaigns/:campaignId/review`, async (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      const input = record(await json(c), "review_required");
      return c.json(
        service.reviewToReady(requestMetadata(c), c.req.param("campaignId"), {
          campaign: positiveRevision(input.expectedCampaignRevision, "campaign_expected_revision_invalid"),
          blueprint: positiveRevision(input.expectedBlueprintRevision, "blueprint_expected_revision_invalid"),
          bsg: positiveRevision(input.expectedBsgRevision, "bsg_expected_revision_invalid"),
        }),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${base}/control-plane/campaigns/:campaignId/transitions`, async (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      const input = record(await json(c), "transition_required");
      const state = requiredString(input.state, "campaign_state_invalid") as CampaignState;
      return c.json(
        service.transition(
          requestMetadata(c),
          c.req.param("campaignId"),
          state,
          positiveRevision(input.expectedRevision, "campaign_expected_revision_invalid"),
        ),
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  app.post(`${base}/control-plane/campaigns/:campaignId/exceptions`, async (c) => {
    try {
      const denied = requireGate(c);
      if (denied) return denied;
      return c.json(
        service.createException(requestMetadata(c), c.req.param("campaignId"), await json(c)),
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });
  };
  // Canonical (Regauge) paths plus the legacy /transformer aliases (kept forever
  // for external/legacy callers). Both register the same handlers.
  mount("/regauge");
  mount("/transformer");
}
