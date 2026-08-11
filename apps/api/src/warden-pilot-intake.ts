import { createHash } from "node:crypto";
import {
  enqueueJob,
  getConsumer,
  getConsumerRepo,
  getJob,
  getProviderBySlug,
  getRepositorySnapshotPolicy,
  listMonitoredForConsumer,
  listRepositorySnapshots,
  recordAudit,
  type AppDb,
} from "@mendpoint/db";
import { Hono, type Context } from "hono";
import type { ApiEnv } from "./auth.js";
import { mappedErrorResponse, type PublicErrorRule } from "./error-boundary.js";

const MAX_BODY_BYTES = 8 * 1_024;
const SAFE_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ALLOWED_FIELDS = new Set(["providerSlug", "consumerId"]);

const ERRORS: readonly PublicErrorRule[] = [
  { internalCode: "warden_pilot_authentication_required", publicCode: "unauthorized", status: 401 },
  { internalCode: "warden_pilot_consumer_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "warden_pilot_provider_not_found", publicCode: "not_found", status: 404 },
  { internalCode: "warden_pilot_idempotency_conflict", publicCode: "idempotency_conflict", status: 409 },
  { internalCode: "warden_pilot_provider_not_monitored", publicCode: "provider_not_approved", status: 409 },
  { internalCode: "warden_pilot_snapshot_binding_required", publicCode: "snapshot_not_ready", status: 409 },
  { internalCode: "warden_pilot_snapshot_not_ready", publicCode: "snapshot_not_ready", status: 409 },
  { internalCode: "warden_pilot_verification_policy_required", publicCode: "verification_policy_not_ready", status: 409 },
  { internalCode: "warden_pilot_snapshot_expired", publicCode: "snapshot_expired", status: 409 },
  ...[
    "warden_pilot_content_type_invalid",
    "warden_pilot_payload_invalid",
    "warden_pilot_field_forbidden",
    "warden_pilot_provider_invalid",
    "warden_pilot_consumer_invalid",
    "warden_pilot_idempotency_key_invalid",
  ].map((internalCode): PublicErrorRule => ({ internalCode, status: 422 })),
];

export type WardenPilotIntakeOptions = Readonly<{
  db: AppDb;
  now?: () => string;
}>;

function requiredText(value: unknown, code: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(code);
  return normalized;
}

async function body(c: Context<ApiEnv>) {
  const contentType = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new Error("warden_pilot_content_type_invalid");
  }
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw new Error("warden_pilot_payload_invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("warden_pilot_payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("warden_pilot_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new Error("warden_pilot_field_forbidden");
  }
  return {
    providerSlug: requiredText(value.providerSlug, "warden_pilot_provider_invalid", 100),
    consumerId: requiredText(value.consumerId, "warden_pilot_consumer_invalid", 200),
  };
}

export function createWardenPilotIntakeRoutes(options: WardenPilotIntakeOptions) {
  const routes = new Hono<ApiEnv>();
  const now = options.now ?? (() => new Date().toISOString());
  routes.post("/", async (c) => {
    try {
      const principal = c.get("principal");
      const tenantId = c.get("tenantId");
      const trustPrincipalId = c.get("trustPrincipalId");
      if (!principal || !tenantId || principal.tenantId !== tenantId || !trustPrincipalId) {
        throw new Error("warden_pilot_authentication_required");
      }
      const input = await body(c);
      const idempotencyKey = c.req.header("Idempotency-Key")?.trim() ?? "";
      if (!SAFE_IDEMPOTENCY_KEY.test(idempotencyKey)) {
        throw new Error("warden_pilot_idempotency_key_invalid");
      }
      const identity = createHash("sha256")
        .update(`${tenantId}\0${idempotencyKey}`, "utf8")
        .digest("hex");
      const jobId = `warden-pilot-pipeline-${identity.slice(0, 32)}`;
      const payload = {
        providerSlug: input.providerSlug,
        consumerIds: [input.consumerId],
        wardenPilot: true,
      };
      const payloadJson = JSON.stringify(payload);
      const existing = getJob(options.db, jobId, tenantId);
      if (existing) {
        if (existing.type !== "pipeline.fanout" || existing.payload_json !== payloadJson) {
          throw new Error("warden_pilot_idempotency_conflict");
        }
        return c.json({ jobId, status: existing.status, replayed: true }, 202);
      }

      const consumer = getConsumer(options.db, input.consumerId, tenantId);
      if (!consumer) throw new Error("warden_pilot_consumer_not_found");
      const provider = getProviderBySlug(options.db, input.providerSlug);
      if (!provider) throw new Error("warden_pilot_provider_not_found");
      if (!listMonitoredForConsumer(options.db, consumer.id)
        .some((monitor) => monitor.provider_id === provider.id)) {
        throw new Error("warden_pilot_provider_not_monitored");
      }
      const repo = getConsumerRepo(options.db, consumer.id, tenantId);
      if (!repo?.connected_repository_id || !repo.snapshot_id || !repo.exact_commit) {
        throw new Error("warden_pilot_snapshot_binding_required");
      }
      const snapshot = listRepositorySnapshots(options.db, tenantId, repo.connected_repository_id)
        .find((candidate) => candidate.id === repo.snapshot_id && candidate.resolved_sha === repo.exact_commit);
      if (!snapshot) throw new Error("warden_pilot_snapshot_not_ready");
      const observedAt = now();
      if (!Number.isFinite(Date.parse(observedAt)) || Date.parse(snapshot.expires_at) <= Date.parse(observedAt)) {
        throw new Error("warden_pilot_snapshot_expired");
      }
      if (!getRepositorySnapshotPolicy(options.db, tenantId, snapshot.id)) {
        throw new Error("warden_pilot_verification_policy_required");
      }

      options.db.raw.exec("BEGIN IMMEDIATE");
      try {
        const raced = getJob(options.db, jobId, tenantId);
        if (raced) {
          if (raced.type !== "pipeline.fanout" || raced.payload_json !== payloadJson) {
            throw new Error("warden_pilot_idempotency_conflict");
          }
          options.db.raw.exec("COMMIT");
          return c.json({ jobId, status: raced.status, replayed: true }, 202);
        }
        enqueueJob(options.db, {
          id: jobId,
          tenantId,
          type: "pipeline.fanout",
          payload,
          createdAt: observedAt,
        });
        recordAudit(options.db, {
          id: `audit_${createHash("sha256").update(`${tenantId}\0${jobId}\0requested`).digest("hex")}`,
          tenantId,
          actor: principal.id,
          principalId: trustPrincipalId,
          requestId: c.get("requestId") ?? null,
          action: "warden.pilot.requested",
          resourceType: "job",
          resourceId: jobId,
          metadata: {
            providerSlug: input.providerSlug,
            consumerId: input.consumerId,
            repositoryId: repo.connected_repository_id,
            snapshotId: snapshot.id,
            revision: snapshot.resolved_sha,
          },
        });
        options.db.raw.exec("COMMIT");
      } catch (error) {
        if (options.db.raw.isTransaction) options.db.raw.exec("ROLLBACK");
        throw error;
      }
      return c.json({ jobId, status: "pending", replayed: false }, 202);
    } catch (error) {
      return mappedErrorResponse(c, error, ERRORS);
    }
  });
  return routes;
}
