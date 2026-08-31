import { createHash } from "node:crypto";
import { recordOrganizationMemoryObservation, type AppDb } from "@mendpoint/db";
import type { LearningOutcomeStatus } from "@mendpoint/pipeline";
import { redactSourceForModel } from "@mendpoint/shared";

export type GovernedLearningMemoryProjectionInput = Readonly<{
  db: AppDb;
  tenantId: string;
  product: "fettler" | "regauge";
  repositoryId: string;
  taskType: string;
  migrationFamily: string;
  outcomeStatus: LearningOutcomeStatus;
  reviewerDecision: "accepted" | "modified" | "merged";
  reviewerPrincipalId: string;
  reviewRationale: string;
  eventId: string;
  learningRecordId: string;
  revision: string;
  snapshotDigest: string;
  observedAt: string;
}>;

export type GovernedLearningMemoryProjection = Readonly<
  | { status: "observed"; memoryId: string; recordId: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string }
>;

const MAX_RATIONALE_BYTES = 4_096;

function redactedRationale(value: string): string | null {
  const result = redactSourceForModel(
    JSON.stringify({ reviewRationale: value }),
    MAX_RATIONALE_BYTES,
  );
  if (result.excluded || result.truncated) return null;
  try {
    const parsed = JSON.parse(result.text) as { reviewRationale?: unknown };
    if (typeof parsed.reviewRationale !== "string") return null;
    const normalized = parsed.reviewRationale.replace(/\s+/gu, " ").trim();
    return normalized.length > 0 ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * One `:`-delimited `subjectKey` segment, with `%` and `:` percent-encoded so the
 * delimiter cannot appear inside a component. Without this a `taskType` of `a:b`
 * and a `(taskType, migrationFamily)` pair of `(a, b)` would produce the same
 * subjectKey, and therefore the same `memoryId` — two different conventions
 * silently sharing one memory chain. Both values are enum-ish today, so this is a
 * structural guard rather than a live defect.
 */
function subjectSegment(value: string): string {
  return value.replace(/%/gu, "%25").replace(/:/gu, "%3A");
}

/**
 * Project a terminal, human-reviewed governed outcome into Organization Memory.
 *
 * This records a low-confidence REVIEW_PREFERENCE candidate only. It never
 * activates memory, never marks it training eligible, and never affects outcome
 * delivery. The Organization Memory lifecycle remains the sole promotion
 * authority: a human confirmation or independent corroboration is still required.
 */
export function projectGovernedOutcomeToOrganizationMemory(
  input: GovernedLearningMemoryProjectionInput,
): GovernedLearningMemoryProjection {
  const rationale = redactedRationale(input.reviewRationale);
  if (!rationale) return Object.freeze({ status: "skipped", reason: "review_rationale_not_safe" });
  try {
    const statement = `Reviewer guidance after ${input.outcomeStatus}: ${rationale}`;
    const meaningDigest = createHash("sha256").update(statement, "utf8").digest("hex");
    const memory = recordOrganizationMemoryObservation(input.db, {
      tenantId: input.tenantId,
      category: "REVIEW_PREFERENCE",
      // `scope` needs no escaping: `repository:` is a fixed prefix and the repository
      // id is the entire remainder, so no colon in it can shift a boundary.
      scope: `repository:${input.repositoryId}`,
      subjectKey: [
        subjectSegment(input.product),
        subjectSegment(input.taskType),
        subjectSegment(input.migrationFamily),
        meaningDigest,
      ].join(":"),
      statement,
      observerPrincipalId: input.reviewerPrincipalId,
      source: "reviewer_correction",
      confidence: "low",
      // Carries only the fields that describe the CONVENTION, never the event that
      // observed it. `recordOrganizationMemoryObservation` compares `structuredValue`
      // canonically to decide whether a later observation restates the same meaning
      // (`sameObservedMeaning`), so any per-event field here — eventId,
      // learningRecordId, revision, snapshotDigest — makes every governed outcome
      // after the first throw `organization_memory_observation_conflict` instead of
      // reaching the idempotency/corroboration branch. Because the production
      // producers fall back to a constant rationale ("Approved in Warden review.",
      // "Approved in adaptive review."), outcomes routinely share a subjectKey, so
      // that collision is the common path, not an edge case — and it would also make
      // a second reviewer's independent observation conflict rather than corroborate,
      // contradicting the "independent corroboration is still required" promise above.
      // The per-event lineage is not lost: it is carried in `sourceRefs` and `reason`,
      // which the record writes on every revision and which are not part of the
      // meaning comparison.
      structuredValue: {
        schemaVersion: 1,
        product: input.product,
        repositoryId: input.repositoryId,
        taskType: input.taskType,
        migrationFamily: input.migrationFamily,
        outcomeStatus: input.outcomeStatus,
        reviewerDecision: input.reviewerDecision,
      },
      appliesTo: [input.repositoryId, input.product],
      sourceRefs: [
        `learning-event:${input.eventId}`,
        `learning-record:${input.learningRecordId}`,
        `revision:${input.revision}`,
        input.snapshotDigest,
      ],
      reason: `governed_learning_outcome:${input.eventId}`,
      at: input.observedAt,
    });
    return Object.freeze({ status: "observed", memoryId: memory.memoryId, recordId: memory.recordId });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return Object.freeze({ status: "failed", reason });
  }
}
