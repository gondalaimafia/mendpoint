import type { AppDb, JobRow } from "@mendpoint/db";
import type { GovernedLearningAdmissionResult } from "./governed-learning-producer.js";
import { admitWardenLearningForResolvedOutcome } from "./warden-candidate-delivery.js";
import { admitTransformerLearningForResolvedOutcome } from "./transformer-adaptive-delivery.js";

/**
 * Job type the outcome webhook enqueues (apps/api) and the worker claims to
 * re-invoke the governed learning producer once a delivered PR reaches a terminal
 * outcome. Kept in sync with the same literal in
 * apps/api/src/delivery-outcome-learning-dispatch.ts.
 */
export const LEARNING_OUTCOME_RESOLVE_JOB_TYPE = "learning.outcome.resolve";

/** Which delivery lane a resolution job re-invokes. */
export type OutcomeResolutionLane = "fettler" | "regauge";

export type OutcomeResolutionLearningPayload = Readonly<{
  lane: OutcomeResolutionLane;
  deliveryId: string;
}>;

export type OutcomeResolutionLearningInput = Readonly<{
  db: AppDb;
  job: JobRow;
  artifactEnv?: NodeJS.ProcessEnv;
  now?: () => string;
}>;

function parsePayload(job: JobRow): OutcomeResolutionLearningPayload {
  let value: unknown;
  try { value = JSON.parse(job.payload_json); } catch { throw new Error("learning_outcome_resolve_payload_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("learning_outcome_resolve_payload_invalid");
  }
  const record = value as Record<string, unknown>;
  if ((record.lane !== "fettler" && record.lane !== "regauge") || typeof record.deliveryId !== "string") {
    throw new Error("learning_outcome_resolve_payload_invalid");
  }
  return Object.freeze({ lane: record.lane, deliveryId: record.deliveryId });
}

/**
 * Re-invoke the governed learning producer for a delivery whose PR has reached a
 * terminal outcome. The outcome is read only from the delivery row (recorded by
 * the webhook, never inferred), the producer is the sole authority on which
 * outcomes admit, and admission is idempotent — so a retried job admits at most
 * once. Tenant is taken from the claimed job row, the same binding the delivery
 * seam carries. The underlying admit functions never throw; the result carries the
 * producer's admission verdict for the worker's counters.
 */
export function runOutcomeResolutionLearning(
  input: OutcomeResolutionLearningInput,
): GovernedLearningAdmissionResult {
  if (input.job.type !== LEARNING_OUTCOME_RESOLVE_JOB_TYPE) {
    throw new Error("learning_outcome_resolve_job_invalid");
  }
  const payload = parsePayload(input.job);
  const shared = Object.freeze({
    db: input.db,
    tenantId: input.job.tenant_id,
    deliveryId: payload.deliveryId,
    artifactEnv: input.artifactEnv,
    now: input.now,
  });
  return payload.lane === "fettler"
    ? admitWardenLearningForResolvedOutcome(shared)
    : admitTransformerLearningForResolvedOutcome(shared);
}
