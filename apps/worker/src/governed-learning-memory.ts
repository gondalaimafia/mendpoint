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
      scope: `repository:${input.repositoryId}`,
      subjectKey: `${input.product}:${input.taskType}:${input.migrationFamily}:${meaningDigest}`,
      statement,
      observerPrincipalId: input.reviewerPrincipalId,
      source: "reviewer_correction",
      confidence: "low",
      structuredValue: {
        schemaVersion: 1,
        product: input.product,
        repositoryId: input.repositoryId,
        taskType: input.taskType,
        migrationFamily: input.migrationFamily,
        outcomeStatus: input.outcomeStatus,
        reviewerDecision: input.reviewerDecision,
        eventId: input.eventId,
        learningRecordId: input.learningRecordId,
        revision: input.revision,
        snapshotDigest: input.snapshotDigest,
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
