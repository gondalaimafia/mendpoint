import { createHash } from "node:crypto";
import { findActiveLearningConsent, type AdaptiveDeliveryOutcome } from "@mendpoint/db";
import type {
  LearningOutcomeStatus,
  LearningProvenanceQualifier,
  LearningRiskClass,
} from "@mendpoint/pipeline";
import { learningLoopEnabled } from "./transformer-learning-outcome.js";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  temporalContaminationFree,
  type GovernedLearningAdmissionResult,
} from "./governed-learning-producer.js";
import { deriveOutcomeAttribution } from "./outcome-attribution.js";
import type { AdmitApprovedOutcomeInput } from "./transformer-learning-producer.js";

/**
 * The governed producer needs the delivery's terminal outcome (which lives on the
 * delivery row, not the candidate) so it can refuse to admit before the PR merges.
 */
export type AdmitTransformerGovernedLearningInput = AdmitApprovedOutcomeInput & Readonly<{
  deliveryOutcome: AdaptiveDeliveryOutcome | null;
}>;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;
const RISK_BY_CLASS: Readonly<Record<string, LearningRiskClass>> = Object.freeze({
  low: "low",
  medium: "medium",
  high: "high",
});

function boundedLine(value: string, max: number, fallback: string): string {
  const collapsed = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

/**
 * Admit ONE human-approved, deterministically verified ReGauge (Transformer)
 * adaptive outcome as a governed learning event, ADDITIVELY alongside the legacy
 * approved-outcome record. This is a second, parallel emission under the governed
 * consent purpose, distinct from the legacy `transformer-adaptive-*` purposes; the
 * legacy producer keeps running unchanged.
 *
 * Best-effort and default-off (same guarantees as the Warden producer): the
 * learning loop flag gates it, an absent governed consent skips it, and every
 * other failure is swallowed. It never affects delivery.
 */
export function admitTransformerGovernedLearningEvent(
  input: AdmitTransformerGovernedLearningInput,
): GovernedLearningAdmissionResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ admitted: false, reason: "disabled" });
  const { db, tenantId, candidate, artifact } = input;
  // Terminal-outcome gate. A delivered draft PR has no verified outcome yet, so
  // admitting any record at delivery would fabricate an outcome the PR never
  // reached — and learning_records is append-only, so it could never be retracted.
  // Admit only a TERMINAL outcome: a null outcome is "pending" and is skipped. A
  // merged outcome is a positive result; a closed_unmerged or reverted outcome is
  // a negative result. Both terminal outcomes are now admitted so the corpus
  // carries real outcome variance, but every non-success outcome is recorded
  // honestly (see the branching below) and can never train weights: it carries no
  // verification authority, so its verdict is `inconclusive`, which caps evidence
  // strength at "insufficient" and keeps it off the model_weight path. This
  // producer runs at the delivery seam, where the outcome is always null, so it
  // still no-ops until admission is re-invoked at outcome resolution (a
  // corpus-pipeline change; see the PR body); the widened gate makes it ready.
  if (input.deliveryOutcome === null) {
    return Object.freeze({ admitted: false, reason: "outcome_pending" });
  }
  // A merged PR is the positive, corrected outcome; a closed_unmerged repair
  // failed to be accepted, and a reverted one was accepted then rolled back. Each
  // maps to the honest `observedOutcome.status` member, never a success value.
  const succeeded = input.deliveryOutcome === "merged";
  const outcomeStatus: LearningOutcomeStatus =
    input.deliveryOutcome === "merged" ? "corrected" : input.deliveryOutcome === "reverted" ? "rolled_back" : "failed";
  try {
    if (
      candidate.reviewDecision !== "approve" ||
      !candidate.reviewerPrincipalId ||
      !candidate.reviewRationale ||
      !candidate.reviewedAt
    ) {
      return Object.freeze({ admitted: false, reason: "not_approved" });
    }

    const consent = findActiveLearningConsent(db, {
      tenantId,
      purpose: GOVERNED_LEARNING_PURPOSE,
      at: input.now,
    });
    if (!consent) return Object.freeze({ admitted: false, reason: "no_active_consent" });

    const snapshotDigest = `sha256:${createHash("sha256")
      .update([tenantId, candidate.repositoryId, candidate.snapshotId, candidate.expectedBaseRevision].join("\0"), "utf8")
      .digest("hex")}`;

    // The adaptive review carries a deterministic objective-verification command
    // (`review.verification.passed` is set only when a real command exited zero),
    // so the VERDICT is hard. The overall `confidence` below remains the model's
    // own number: the adaptive review has no per-edit assessmentSource, so its
    // confidence is intrinsically a model self-score. It is recorded as-is but
    // never contributes to evidence strength or weight eligibility — only the
    // recorded signal class does.
    const deterministic = artifact.review.verification.passed === true;
    const authority = deterministic
      ? Object.freeze({ signalClass: "hard" as const, producedBy: "sandbox_command" as const, producerModelId: null })
      : Object.freeze({ signalClass: "soft" as const, producedBy: "model_verifier" as const, producerModelId: null });
    // A non-success outcome keeps only `reviewer_accepted`: the candidate was
    // reviewer-approved at delivery, but its correctness was never established (it
    // was not merged), so `deterministically_verified`/`merged_and_verified` would
    // be a false claim.
    const provenanceQualifiers: readonly LearningProvenanceQualifier[] =
      succeeded && authority.signalClass === "hard"
        ? ["deterministically_verified", "reviewer_accepted"]
        : ["reviewer_accepted"];

    // Derive the outcome attribution from evidence, not a constant. A hard verdict
    // means the deterministic verification command actually established the outcome
    // (verify.ts `verified`); a soft verdict established nothing objective and is
    // `not_verified`. This seam observes no graph-context delivery — there is no
    // trajectory-by-run link on the adaptive candidate path — so `contextDelivery`
    // is the honest `unrecorded`; it only narrows a failure and never a verified
    // success. See deriveOutcomeAttribution for the precision-first rationale.
    const attribution = deriveOutcomeAttribution({
      verification: authority.signalClass === "hard" ? "verified" : "not_verified",
      contextDelivery: "unrecorded",
    });

    return admitGovernedLearningOutcome({
      db,
      tenantId,
      consentId: consent.id,
      residencyRegion: consent.residency_region,
      product: "regauge",
      sourceObjectType: "transformer_adaptive_candidate",
      sourceObjectId: candidate.id,
      repositoryId: candidate.repositoryId,
      taskType: "legacy_migration",
      capability: "remediation_generation",
      specialization: {
        provider: candidate.provider,
        framework: candidate.framework,
        language: null,
        runtime: null,
        migrationFamily: candidate.family ?? "adaptive_repair",
        riskClass: RISK_BY_CLASS[artifact.review.overallRisk] ?? "medium",
      },
      execution: {
        modelId: null,
        adapterId: null,
        routerDecisionId: `transformer_route_${candidate.id}`,
        fallback: false,
      },
      predictionSummary: boundedLine(
        artifact.review.edits[0]?.rationale ?? "Adaptive repair candidate.",
        4000,
        "Adaptive repair candidate.",
      ),
      outcome: {
        // Record the honest terminal outcome, never forced to a success value: a
        // merged repair is `corrected`, a reverted one `rolled_back`, a
        // closed_unmerged one `failed`.
        status: outcomeStatus,
        summary: succeeded
          ? boundedLine(artifact.review.verification.summary, 4000, "The repair passed objective verification.")
          : boundedLine(candidate.reviewRationale, 4000, "The delivered repair was not accepted."),
        attribution,
      },
      // The candidate was reviewer-approved before delivery; the terminal fate is a
      // downstream outcome, not a review rejection, so the review decision stays
      // `accepted` for both paths (the admission gate binds it to
      // accepted/modified/merged).
      reviewerDecision: "accepted",
      // A correction is substantive only on the success path, and only when the
      // reviewed repair actually carries edits (not asserting `true`). A non-success
      // outcome established no substantive correction — the repair was not accepted
      // — so it is `false`: the conservative not-established value, which also keeps
      // a failure off the model_weight path in `classify`.
      correctionSubstantive: succeeded && artifact.review.edits.length > 0,
      // Attest contamination-freedom from the temporal determination this producer
      // can genuinely make, not a literal: the outcome was observed (at the review
      // time) before admission. A malformed/future timestamp fails closed.
      contaminationFree: temporalContaminationFree(candidate.reviewedAt, input.now),
      // Confidence is a prediction-time value present regardless of outcome, so it
      // is recorded on both paths: a failed outcome with a recorded confidence is
      // precisely the calibration signal a failure teaches.
      confidence: Math.min(1, Math.max(0, artifact.review.confidence / 100)),
      // A merged repair carries its correctness-verification authority; a
      // non-success outcome carries the explicit not-observed state (null): its
      // repair correctness was never objectively verified, so the derived verdict
      // stays `inconclusive`.
      verificationAuthority: succeeded ? authority : null,
      // No per-candidate token meter exists at this seam; economics are unmetered.
      economics: { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
      sourceClass: "design_partner_verified",
      provenanceQualifiers,
      mayLeaveTenantBoundary: false,
      revision: candidate.expectedBaseRevision,
      snapshotDigest,
      scenarioId: null,
      syntheticFamilyId: null,
      reviewerPrincipalId: candidate.reviewerPrincipalId,
      reviewRationale: boundedLine(candidate.reviewRationale, 512, "Approved in adaptive review."),
      observedAt: candidate.reviewedAt,
      now: input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ admitted: false, reason: `error:${message}` });
  }
}
