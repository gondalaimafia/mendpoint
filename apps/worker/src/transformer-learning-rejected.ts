import {
  TRANSFORMER_REJECTED_OUTCOME_PURPOSE,
  buildRejectedOutcome,
  learningLoopEnabled,
  serializeOutcomeDocument,
} from "./transformer-learning-outcome.js";
import {
  OUTCOME_SOURCE_OBJECT_TYPE,
  REJECTED_OUTCOME_SUBJECT_TYPE,
  admitGovernedLearningRecord,
  type AdmitApprovedOutcomeInput,
  type LearningAdmissionResult,
} from "./transformer-learning-producer.js";

export type { LearningAdmissionResult } from "./transformer-learning-producer.js";

/**
 * The redacted-outcome change-spec cap is generous for a rejected outcome, which
 * carries only the change specification plus the reviewer's rationale (no raw file
 * bodies). Anything larger is a redaction failure and the outcome is not admitted.
 */
const REJECTED_REDACTION_CAP = 200_000;

/**
 * Whether rejected-outcome capture is enabled at all. Default-off: only an explicit
 * "1" enables it, exactly as the rest of the learning loop. The API reject path
 * calls this BEFORE reading the sealed artifact so that, when the loop is off, the
 * reject flow does no extra work and stays byte-identical to today.
 */
export function rejectedOutcomeCaptureEnabled(env: NodeJS.ProcessEnv): boolean {
  return learningLoopEnabled(env);
}

/**
 * Admit ONE human-REJECTED adaptive candidate as a NEGATIVE governed learning
 * record under {@link TRANSFORMER_REJECTED_OUTCOME_PURPOSE}.
 *
 * This is the negative-signal producer seam. It originates from the API review
 * REJECT decision and must run BEFORE the sealed candidate artifact is discarded.
 * The record is redacted, consent-gated (its own purpose), residency-scoped (from
 * that consent), append-only, and labeled `decision: "rejected"` INSIDE the
 * document, so {@link admitGovernedLearningRecord}'s approve-review requirement is
 * met without weakening it.
 *
 * Strictly best-effort and never throws: disabled flag, absent/ambiguous rejected
 * consent, a candidate that is not actually rejected, unredactable content, or a
 * future-dated observation all yield a non-admission result and leave the reject
 * and discard flow untouched.
 */
export function admitRejectedOutcomeLearningRecord(
  input: AdmitApprovedOutcomeInput,
): LearningAdmissionResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ admitted: false, reason: "disabled" });
  const { tenantId, candidate, artifact } = input;
  try {
    // Rejected outcomes only: the review decision must be a rejection carrying a
    // reviewer, rationale, and review timestamp. Anything else is not a source.
    if (
      candidate.reviewDecision !== "reject" ||
      !candidate.reviewerPrincipalId ||
      !candidate.reviewRationale ||
      !candidate.reviewedAt
    ) {
      return Object.freeze({ admitted: false, reason: "not_rejected" });
    }
    const observedAt = candidate.reviewedAt;
    const rawJson = serializeOutcomeDocument(
      buildRejectedOutcome(candidate, artifact, observedAt),
    );
    return admitGovernedLearningRecord({
      db: input.db,
      tenantId,
      purpose: TRANSFORMER_REJECTED_OUTCOME_PURPOSE,
      seed: `${tenantId} ${candidate.id} ${TRANSFORMER_REJECTED_OUTCOME_PURPOSE}`,
      sourceObjectType: OUTCOME_SOURCE_OBJECT_TYPE,
      subjectType: REJECTED_OUTCOME_SUBJECT_TYPE,
      sourceObjectId: candidate.id,
      rawJson,
      redactionCap: REJECTED_REDACTION_CAP,
      verificationCommandId: artifact.review.verification.commandId,
      verificationOutputDigest: artifact.review.verification.outputDigest,
      observedAt,
      admittedByPrincipalId: candidate.reviewerPrincipalId,
      reviewRationale: candidate.reviewRationale,
      now: input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ admitted: false, reason: `error:${message}` });
  }
}
