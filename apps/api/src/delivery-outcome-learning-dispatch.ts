import { createHash } from "node:crypto";
import { enqueueJob, getJob, type AppDb } from "@mendpoint/db";

/**
 * Job type the worker claims to re-invoke the governed learning producer once a
 * delivered PR reaches a terminal outcome. Kept in sync with the same literal in
 * apps/worker/src/outcome-resolution-learning.ts (LEARNING_OUTCOME_RESOLVE_JOB_TYPE).
 */
export const LEARNING_OUTCOME_RESOLVE_JOB_TYPE = "learning.outcome.resolve";

/** Which delivery lane a resolution job re-invokes. */
export type DeliveryOutcomeLane = "fettler" | "regauge";

export type DeliveryOutcomeLearningPayload = Readonly<{
  lane: DeliveryOutcomeLane;
  deliveryId: string;
}>;

export type EnqueueDeliveryOutcomeLearningInput = Readonly<{
  db: AppDb;
  lane: DeliveryOutcomeLane;
  tenantId: string;
  deliveryId: string;
  createdAt: string;
  /**
   * Enqueue seam, defaulting to the durable job enqueue. Injectable so a test can
   * assert the payload and dedup without a full job runtime.
   */
  enqueue?: (input: Readonly<{
    db: AppDb;
    jobId: string;
    tenantId: string;
    payload: DeliveryOutcomeLearningPayload;
    createdAt: string;
  }>) => void;
}>;

export type EnqueueDeliveryOutcomeLearningResult =
  | { status: "enqueued"; jobId: string }
  | { status: "duplicate"; jobId: string };

/**
 * Deterministic on (lane, tenant, delivery): one resolution job per delivery, so a
 * redelivered webhook (a distinct delivery id describing the same merged PR)
 * collapses to the existing job. Reverted has no observation source, and the legal
 * outcome transitions make merged and closed_unmerged mutually exclusive terminal
 * states, so a delivery reaches at most one terminal outcome through this path.
 */
function resolveJobId(lane: DeliveryOutcomeLane, tenantId: string, deliveryId: string): string {
  const hash = createHash("sha256")
    .update([lane, tenantId, deliveryId].join("\0"), "utf8")
    .digest("hex");
  return `learning-outcome-${hash.slice(0, 40)}`;
}

function defaultEnqueue(input: Readonly<{
  db: AppDb;
  jobId: string;
  tenantId: string;
  payload: DeliveryOutcomeLearningPayload;
  createdAt: string;
}>): void {
  enqueueJob(input.db, {
    id: input.jobId,
    tenantId: input.tenantId,
    type: LEARNING_OUTCOME_RESOLVE_JOB_TYPE,
    payload: input.payload,
    createdAt: input.createdAt,
  });
}

/**
 * Enqueue a governed-learning re-invocation for a delivery whose PR reached a
 * terminal outcome, idempotently. The outcome itself is already recorded on the
 * delivery row by the caller (never carried in this payload); the worker reloads it
 * and lets the producer decide what to admit. Tenant-scoped: the job is enqueued
 * under the same tenant the webhook derived from the matched delivery row.
 */
export function enqueueDeliveryOutcomeLearning(
  input: EnqueueDeliveryOutcomeLearningInput,
): EnqueueDeliveryOutcomeLearningResult {
  const jobId = resolveJobId(input.lane, input.tenantId, input.deliveryId);
  if (getJob(input.db, jobId, input.tenantId)) {
    return { status: "duplicate", jobId };
  }
  const payload: DeliveryOutcomeLearningPayload = Object.freeze({
    lane: input.lane,
    deliveryId: input.deliveryId,
  });
  (input.enqueue ?? defaultEnqueue)({
    db: input.db,
    jobId,
    tenantId: input.tenantId,
    payload,
    createdAt: input.createdAt,
  });
  return { status: "enqueued", jobId };
}
