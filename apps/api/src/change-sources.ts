import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  confirmCustomerIncident,
  createChangeSourceArtifact,
  escalateCustomerIncident,
  getChangeSourceArtifact,
  listChangeSourceEvents,
  listChangeSourceRevisions,
  openChangeSourceStore,
  requireApprovedChangeSourceForFanout,
  reviewChangeSourceArtifact,
  type ChangeSourceArtifact,
  type ChangeSourceEvent,
  type ChangeSourceRevision,
  type ChangeSourceStore,
  type CustomerIncidentInput,
  type ManualProviderAnnouncementInput,
} from "@mendpoint/change-intel";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiEnv } from "./auth.js";
import {
  mappedErrorResponse,
  type PublicErrorRule,
} from "./error-boundary.js";

type JsonObject = Record<string, unknown>;
type ApiResponse = Readonly<{ data?: unknown; error?: Readonly<{ code: string; message: string }> }>;

type ApiRequestRow = {
  tenant_id: string;
  request_id: string;
  operation: string;
  resource_id: string;
  request_sha256: string;
  actor_principal_id: string;
  state: "pending" | "completed";
  response_status: number | null;
  response_json: string | null;
  created_at: string;
};

export type ChangeSourceRoutesOptions = Readonly<{
  store?: ChangeSourceStore;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: () => string;
}>;

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const PENDING_STALE_MS = 30_000;
const FORBIDDEN_CREATE_FIELDS = new Set([
  "id",
  "tenantId",
  "author",
  "createdAt",
  "rawDetails",
  "rawLogs",
  "unredactedDetails",
  "secret",
  "token",
  "authorization",
]);

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

const CHANGE_SOURCE_VALIDATION_BASES = [
  "change_source_affected_products",
  "change_source_announcement",
  "change_source_artifact_id",
  "change_source_author_name",
  "change_source_author_principal",
  "change_source_captured_at",
  "change_source_captured_by",
  "change_source_confirmation_actor",
  "change_source_confirmation_reason",
  "change_source_confirmed_at",
  "change_source_created_at",
  "change_source_effective_date",
  "change_source_escalated_at",
  "change_source_escalation_actor",
  "change_source_escalation_reason",
  "change_source_escalation_severity",
  "change_source_escalation_target",
  "change_source_evidence_kind",
  "change_source_evidence_sha256",
  "change_source_excerpt",
  "change_source_excerpt_location",
  "change_source_incident_details",
  "change_source_incident_ref",
  "change_source_observed_at",
  "change_source_override_affected_products",
  "change_source_override_effective_date",
  "change_source_override_excerpt",
  "change_source_override_excerpt_location",
  "change_source_provider_slug",
  "change_source_redacted_fields",
  "change_source_redaction_method",
  "change_source_redaction_source_sha256",
  "change_source_review_reason",
  "change_source_reviewed_at",
  "change_source_reviewer_principal",
  "change_source_source_kind",
  "change_source_source_revision",
  "change_source_source_uri",
  "change_source_tenant_id",
] as const;

const CHANGE_SOURCE_VALIDATION_CODES = [
  ...CHANGE_SOURCE_VALIDATION_BASES.flatMap((base) => [
    `${base}_required`,
    `${base}_invalid`,
  ]),
  "change_source_request_body_invalid",
  "change_source_expectedRevision_invalid",
  "change_source_decision_invalid",
  "change_source_request_id_invalid",
  "change_source_unredacted_incident_material_rejected",
  "change_source_server_owned_field_rejected",
  "change_source_kind_invalid",
  "change_source_confirmed_invalid",
  "change_source_confidence_invalid",
  "change_source_evidence_required",
  "change_source_evidence_invalid",
  "change_source_evidence_kind_invalid",
  "change_source_evidence_sha256_invalid",
  "change_source_reviewer_override_invalid",
  "change_source_provenance_time_invalid",
  "change_source_source_uri_unsafe",
  "change_source_manual_source_kind_invalid",
  "change_source_incident_source_kind_invalid",
  "change_source_incident_details_not_redacted",
  "change_source_redaction_evidence_required",
  "change_source_redaction_source_sha256_invalid",
  "change_source_not_customer_incident",
  ...Array.from({ length: 100 }, (_, index) => [
    `change_source_evidence_locator_${index}_required`,
    `change_source_evidence_locator_${index}_invalid`,
    `change_source_evidence_locator_${index}_unsafe`,
  ]).flat(),
] as const;

const CHANGE_SOURCE_ERRORS: readonly PublicErrorRule[] = [
  {
    internalCode: "authenticated_principal_required",
    publicCode: "unauthorized",
    status: 401,
    publicMessage: "Authentication is required",
    responseShape: "nested",
  },
  {
    internalCode: "change_source_artifact_not_found",
    publicCode: "not_found",
    status: 404,
    publicMessage: "Change source was not found",
    responseShape: "nested",
  },
  ...nestedRules(
    409,
    "Change source state changed; refresh and retry",
    "change_source_revision_conflict",
    "change_source_artifact_id_conflict",
  ),
  ...nestedRules(
    422,
    "Change source request was rejected",
    ...CHANGE_SOURCE_VALIDATION_CODES,
  ),
];

let defaultStore: ChangeSourceStore | undefined;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonObject)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function asObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("change_source_request_body_invalid");
  }
  return value as JsonObject;
}

function numberField(body: JsonObject, name: string): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`change_source_${name}_invalid`);
  }
  return Number(value);
}

function stringField(body: JsonObject, name: string, max = 4000): string {
  const value = body[name];
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`change_source_${name}_invalid`);
  }
  return value.trim();
}

function reviewDecision(body: JsonObject): "approve" | "reject" | "request_changes" {
  const value = stringField(body, "decision", 32);
  if (value !== "approve" && value !== "reject" && value !== "request_changes") {
    throw new Error("change_source_decision_invalid");
  }
  return value;
}

function requestIdentity(c: Context<ApiEnv>) {
  const principal = c.get("principal");
  if (!principal) throw new Error("authenticated_principal_required");
  return principal;
}

function requestId(c: Context<ApiEnv>): string {
  const value = c.get("requestId") ?? c.req.header("x-request-id") ?? "";
  if (!REQUEST_ID.test(value)) throw new Error("change_source_request_id_invalid");
  return value;
}

function deterministicArtifactId(tenantId: string, idempotencyKey: string): string {
  return `source-${createHash("sha256")
    .update(`${tenantId}\n${idempotencyKey}`, "utf8")
    .digest("hex")
    .slice(0, 40)}`;
}

export function changeSourceStorePath(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const explicit = env.MENDPOINT_CHANGE_SOURCE_DB_PATH?.trim();
  if (explicit === ":memory:") return explicit;
  if (explicit) return resolve(explicit);
  const dataDirectory = env.MENDPOINT_DATA_DIR?.trim();
  return resolve(dataDirectory || join(cwd, "data"), "change-sources.sqlite");
}

export function getDefaultChangeSourceStore(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): ChangeSourceStore {
  defaultStore ??= openChangeSourceStore(changeSourceStorePath(env, cwd));
  return defaultStore;
}

export function closeDefaultChangeSourceStore(): void {
  defaultStore?.close();
  defaultStore = undefined;
}

function ensureApiRequestLedger(store: ChangeSourceStore): void {
  store.raw.exec(`CREATE TABLE IF NOT EXISTS change_source_api_requests (
    tenant_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64),
    actor_principal_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
    response_status INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (tenant_id, request_id)
  )`);
}

function revisionDto(revision: ChangeSourceRevision) {
  return {
    id: revision.id,
    artifactId: revision.artifactId,
    revision: revision.revision,
    reviewState: revision.reviewState,
    reviewerPrincipalId: revision.reviewerPrincipalId,
    reviewerOverride: revision.reviewerOverride,
    incidentConfirmation: revision.incidentConfirmation,
    escalation: revision.escalation,
    reason: revision.reason,
    createdAt: revision.createdAt,
  };
}

function eventDto(event: ChangeSourceEvent) {
  return {
    id: event.id,
    artifactId: event.artifactId,
    sequence: event.sequence,
    eventType: event.eventType,
    actorPrincipalId: event.actorPrincipalId,
    payload: event.payload,
    previousHash: event.previousHash,
    eventHash: event.eventHash,
    createdAt: event.createdAt,
  };
}

function artifactDto(artifact: ChangeSourceArtifact) {
  const content = artifact.kind === "manual_provider_announcement"
    ? {
        providerSlug: artifact.content.providerSlug,
        announcement: artifact.content.announcement,
      }
    : {
        incidentRef: artifact.content.incidentRef,
        redactedDetails: artifact.content.redactedDetails,
      };
  return {
    id: artifact.id,
    kind: artifact.kind,
    contentSha256: artifact.contentSha256,
    content,
    author: artifact.author,
    source: artifact.source,
    effectiveDate: artifact.effectiveDate,
    affectedProducts: artifact.affectedProducts,
    evidence: artifact.evidence,
    provenance: artifact.provenance,
    excerpt: artifact.excerpt,
    confidence: artifact.confidence,
    redactionEvidence: artifact.redactionEvidence
      ? {
          method: artifact.redactionEvidence.method,
          redactedContentSha256: artifact.redactionEvidence.redactedContentSha256,
          redactedFields: artifact.redactionEvidence.redactedFields,
        }
      : null,
    createdAt: artifact.createdAt,
    latestRevision: revisionDto(artifact.latestRevision),
  };
}

function artifactDtoAtRevision(artifact: ChangeSourceArtifact, revision: ChangeSourceRevision) {
  return { ...artifactDto(artifact), latestRevision: revisionDto(revision) };
}

function apiRequest(
  store: ChangeSourceStore,
  tenantId: string,
  id: string,
): ApiRequestRow | undefined {
  return store.raw.prepare(`SELECT tenant_id, request_id, operation, resource_id,
    request_sha256, actor_principal_id, state, response_status, response_json, created_at
    FROM change_source_api_requests WHERE tenant_id = ? AND request_id = ?`)
    .get(tenantId, id) as ApiRequestRow | undefined;
}

type Reconciliation =
  | Readonly<{ kind: "complete"; status: ContentfulStatusCode; body: ApiResponse }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "conflict" }>;

function reconcilePendingMutation(
  store: ChangeSourceStore,
  tenantId: string,
  actorPrincipalId: string,
  operation: string,
  resourceId: string,
  body: JsonObject,
): Reconciliation {
  const artifact = getChangeSourceArtifact(store, tenantId, resourceId);
  if (operation === "change_source.create") {
    return artifact
      ? { kind: "complete", status: 201, body: { data: { ...artifactDto(artifact), deduplicated: false } } }
      : { kind: "retry" };
  }
  if (!artifact) return { kind: "conflict" };
  const expectedRevision = numberField(body, "expectedRevision");
  const target = listChangeSourceRevisions(store, tenantId, resourceId)
    .find((revision) => revision.revision === expectedRevision + 1);
  if (!target) {
    return artifact.latestRevision.revision === expectedRevision
      ? { kind: "retry" }
      : { kind: "conflict" };
  }
  if (target.reviewerPrincipalId !== actorPrincipalId || target.reason !== stringField(body, "reason")) {
    return { kind: "conflict" };
  }
  if (operation === "change_source.review") {
    const desiredState = body.decision === "approve"
      ? "approved"
      : body.decision === "reject"
        ? "rejected"
        : body.decision === "request_changes"
          ? "changes_requested"
          : "invalid";
    if (
      target.reviewState !== desiredState ||
      canonicalJson(target.reviewerOverride) !== canonicalJson(body.override ?? null)
    ) {
      return { kind: "conflict" };
    }
  } else if (operation === "customer_incident.confirm") {
    if (
      typeof body.confirmed !== "boolean" ||
      target.incidentConfirmation !== (body.confirmed ? "confirmed" : "rejected")
    ) {
      return { kind: "conflict" };
    }
  } else if (operation === "customer_incident.escalate") {
    if (
      !target.escalation ||
      target.escalation.severity !== stringField(body, "severity", 32) ||
      target.escalation.target !== stringField(body, "target", 256) ||
      target.escalation.reason !== stringField(body, "reason")
    ) {
      return { kind: "conflict" };
    }
  } else {
    return { kind: "conflict" };
  }
  return {
    kind: "complete",
    status: 200,
    body: { data: artifactDtoAtRevision(artifact, target) },
  };
}

function completeApiRequest(
  store: ChangeSourceStore,
  tenantId: string,
  id: string,
  result: Readonly<{ status: ContentfulStatusCode; body: ApiResponse }>,
  completedAt: string,
): void {
  store.raw.prepare(`UPDATE change_source_api_requests
    SET state = 'completed', response_status = ?, response_json = ?, completed_at = ?
    WHERE tenant_id = ? AND request_id = ? AND state = 'pending'`)
    .run(result.status, canonicalJson(result.body), completedAt, tenantId, id);
}

async function idempotentMutation(
  c: Context<ApiEnv>,
  store: ChangeSourceStore,
  operation: string,
  resourceId: string,
  body: JsonObject,
  now: () => string,
  action: () => Promise<Readonly<{ status: ContentfulStatusCode; body: ApiResponse }>> | Readonly<{
    status: ContentfulStatusCode;
    body: ApiResponse;
  }>,
): Promise<Response> {
  const principal = requestIdentity(c);
  const id = requestId(c);
  const requestSha256 = digest({ operation, resourceId, actorPrincipalId: principal.id, body });
  const existing = apiRequest(store, principal.tenantId, id);
  if (existing) {
    if (
      existing.operation !== operation ||
      existing.resource_id !== resourceId ||
      existing.request_sha256 !== requestSha256 ||
      existing.actor_principal_id !== principal.id
    ) {
      return c.json({
        error: {
          code: "idempotency_conflict",
          message: "Request ID was already used for a different operation or payload",
        },
      }, 409);
    }
    if (existing.state !== "completed" || existing.response_status === null || !existing.response_json) {
      const createdAt = Date.parse(existing.created_at);
      const currentTime = Date.parse(now());
      if (!Number.isFinite(createdAt) || !Number.isFinite(currentTime) || currentTime - createdAt < PENDING_STALE_MS) {
        return c.json({
          error: { code: "idempotency_in_progress", message: "Request is already in progress" },
        }, 409);
      }
      const reconciled = reconcilePendingMutation(
        store,
        principal.tenantId,
        principal.id,
        operation,
        resourceId,
        body,
      );
      if (reconciled.kind === "complete") {
        completeApiRequest(store, principal.tenantId, id, reconciled, now());
        return c.json(reconciled.body, reconciled.status);
      }
      if (reconciled.kind === "conflict") {
        return c.json({
          error: {
            code: "idempotency_reconciliation_conflict",
            message: "Request outcome could not be reconciled safely",
          },
        }, 409);
      }
      store.raw.prepare("DELETE FROM change_source_api_requests WHERE tenant_id = ? AND request_id = ? AND state = 'pending'")
        .run(principal.tenantId, id);
    } else {
      return c.json(
        JSON.parse(existing.response_json) as ApiResponse,
        existing.response_status as ContentfulStatusCode,
      );
    }
  }

  store.raw.prepare(`INSERT INTO change_source_api_requests
    (tenant_id, request_id, operation, resource_id, request_sha256, actor_principal_id, state, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(principal.tenantId, id, operation, resourceId, requestSha256, principal.id, now());
  try {
    const result = await action();
    completeApiRequest(store, principal.tenantId, id, result, now());
    return c.json(result.body, result.status);
  } catch (error) {
    try {
      store.raw.prepare("DELETE FROM change_source_api_requests WHERE tenant_id = ? AND request_id = ? AND state = 'pending'")
        .run(principal.tenantId, id);
    } catch {
      // A process or connection failure can leave a durable pending row. A later
      // request reconciles it against the append-only domain revision.
    }
    throw error;
  }
}

function errorResponse(c: Context<ApiEnv>, error: unknown): Response {
  return mappedErrorResponse(c, error, CHANGE_SOURCE_ERRORS);
}

async function jsonBody(c: Context<ApiEnv>): Promise<JsonObject> {
  const value = await c.req.json<unknown>().catch(() => null);
  return asObject(value);
}

function createInput(
  body: JsonObject,
  tenantId: string,
  principalId: string,
  artifactId: string,
  createdAt: string,
): ManualProviderAnnouncementInput | CustomerIncidentInput {
  if (Object.keys(body).some((key) => FORBIDDEN_CREATE_FIELDS.has(key))) {
    throw new Error(
      Object.keys(body).some((key) => ["rawDetails", "rawLogs", "unredactedDetails", "secret", "token", "authorization"].includes(key))
        ? "change_source_unredacted_incident_material_rejected"
        : "change_source_server_owned_field_rejected",
    );
  }
  const common = {
    id: artifactId,
    tenantId,
    author: { principalId, displayName: principalId },
    source: body.source as ManualProviderAnnouncementInput["source"],
    effectiveDate: body.effectiveDate as string | null,
    affectedProducts: body.affectedProducts as readonly string[],
    evidence: body.evidence as ManualProviderAnnouncementInput["evidence"],
    provenance: body.provenance as ManualProviderAnnouncementInput["provenance"],
    excerpt: body.excerpt as ManualProviderAnnouncementInput["excerpt"],
    confidence: body.confidence as number,
    createdAt,
  };
  if (body.kind === "manual_provider_announcement") {
    return {
      ...common,
      kind: body.kind,
      providerSlug: body.providerSlug as string,
      announcement: body.announcement as string,
    };
  }
  if (body.kind === "customer_incident") {
    return {
      ...common,
      kind: body.kind,
      incidentRef: body.incidentRef as string,
      redactedDetails: body.redactedDetails as string,
      redactionEvidence: body.redactionEvidence as CustomerIncidentInput["redactionEvidence"],
    };
  }
  throw new Error("change_source_kind_invalid");
}

export function createChangeSourceRoutes(
  options: ChangeSourceRoutesOptions = {},
): Hono<ApiEnv> {
  const store = options.store ?? getDefaultChangeSourceStore(options.env, options.cwd);
  const now = options.now ?? (() => new Date().toISOString());
  ensureApiRequestLedger(store);
  const routes = new Hono<ApiEnv>({ strict: false });

  routes.use("*", async (c, next) => {
    if (!c.get("principal")) {
      return c.json({ error: { code: "unauthorized", message: "Authentication is required" } }, 401);
    }
    return next();
  });

  routes.post("/", async (c) => {
    try {
      const body = await jsonBody(c);
      const principal = requestIdentity(c);
      const id = requestId(c);
      const artifactId = deterministicArtifactId(principal.tenantId, id);
      return await idempotentMutation(c, store, "change_source.create", artifactId, body, now, () => {
        const createdAt = now();
        const result = createChangeSourceArtifact(
          store,
          createInput(body, principal.tenantId, principal.id, artifactId, createdAt),
        );
        return {
          status: 201,
          body: { data: { ...artifactDto(result.artifact), deduplicated: !result.inserted } },
        };
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/:id", (c) => {
    try {
      const principal = requestIdentity(c);
      const artifact = getChangeSourceArtifact(store, principal.tenantId, c.req.param("id"));
      if (!artifact) throw new Error("change_source_artifact_not_found");
      return c.json({ data: artifactDto(artifact) });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:id/reviews", async (c) => {
    try {
      const body = await jsonBody(c);
      const principal = requestIdentity(c);
      const artifactId = c.req.param("id");
      return await idempotentMutation(c, store, "change_source.review", artifactId, body, now, () => {
        const artifact = reviewChangeSourceArtifact(store, {
          tenantId: principal.tenantId,
          artifactId,
          expectedRevision: numberField(body, "expectedRevision"),
          reviewerPrincipalId: principal.id,
          decision: reviewDecision(body),
          reason: stringField(body, "reason"),
          override: body.override as Parameters<typeof reviewChangeSourceArtifact>[1]["override"],
          reviewedAt: now(),
        });
        return { status: 200, body: { data: artifactDto(artifact) } };
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:id/confirm", async (c) => {
    try {
      const body = await jsonBody(c);
      const principal = requestIdentity(c);
      const artifactId = c.req.param("id");
      return await idempotentMutation(c, store, "customer_incident.confirm", artifactId, body, now, () => {
        if (typeof body.confirmed !== "boolean") throw new Error("change_source_confirmed_invalid");
        const artifact = confirmCustomerIncident(store, {
          tenantId: principal.tenantId,
          artifactId,
          expectedRevision: numberField(body, "expectedRevision"),
          actorPrincipalId: principal.id,
          confirmed: body.confirmed,
          reason: stringField(body, "reason"),
          confirmedAt: now(),
        });
        return { status: 200, body: { data: artifactDto(artifact) } };
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/:id/escalations", async (c) => {
    try {
      const body = await jsonBody(c);
      const principal = requestIdentity(c);
      const artifactId = c.req.param("id");
      return await idempotentMutation(c, store, "customer_incident.escalate", artifactId, body, now, () => {
        const artifact = escalateCustomerIncident(store, {
          tenantId: principal.tenantId,
          artifactId,
          expectedRevision: numberField(body, "expectedRevision"),
          actorPrincipalId: principal.id,
          severity: stringField(body, "severity", 32),
          target: stringField(body, "target", 256),
          reason: stringField(body, "reason"),
          escalatedAt: now(),
        });
        return { status: 200, body: { data: artifactDto(artifact) } };
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/:id/revisions", (c) => {
    try {
      const principal = requestIdentity(c);
      const artifact = getChangeSourceArtifact(store, principal.tenantId, c.req.param("id"));
      if (!artifact) throw new Error("change_source_artifact_not_found");
      return c.json({
        data: listChangeSourceRevisions(store, principal.tenantId, artifact.id).map(revisionDto),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/:id/events", (c) => {
    try {
      const principal = requestIdentity(c);
      const artifact = getChangeSourceArtifact(store, principal.tenantId, c.req.param("id"));
      if (!artifact) throw new Error("change_source_artifact_not_found");
      return c.json({
        data: listChangeSourceEvents(store, principal.tenantId, artifact.id).map(eventDto),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/:id/fanout-eligibility", (c) => {
    try {
      const principal = requestIdentity(c);
      const artifact = getChangeSourceArtifact(store, principal.tenantId, c.req.param("id"));
      if (!artifact) throw new Error("change_source_artifact_not_found");
      try {
        requireApprovedChangeSourceForFanout(store, principal.tenantId, artifact.id);
        return c.json({ data: { artifactId: artifact.id, eligible: true, reasonCode: null } });
      } catch (error) {
        const reasonCode = error instanceof Error ? error.message : "change_source_not_approved_for_fanout";
        if (
          reasonCode !== "change_source_not_approved_for_fanout" &&
          reasonCode !== "change_source_incident_not_confirmed_for_fanout"
        ) {
          throw error;
        }
        return c.json({ data: { artifactId: artifact.id, eligible: false, reasonCode } });
      }
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
