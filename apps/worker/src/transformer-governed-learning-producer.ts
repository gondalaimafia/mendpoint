import { createHash } from "node:crypto";
import { findActiveLearningConsent, type AdaptiveDeliveryOutcome } from "@mendpoint/db";
import type {
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
  // admitting a "corrected/accepted" record at delivery fabricates one the
  // reviewer never gave — and learning_records is append-only, so it could never
  // be retracted when the PR is later closed unmerged. Admit only a genuinely
  // merged outcome; a null outcome is "pending" and a closed_unmerged/reverted
  // outcome is a negative result. This producer runs at the delivery seam, where
  // the outcome is always null, so it now no-ops until admission is re-invoked at
  // outcome resolution (a corpus-pipeline change; see the PR body).
  if (input.deliveryOutcome !== "merged") {
    return Object.freeze({
      admitted: false,
      reason: input.deliveryOutcome === null ? "outcome_pending" : `outcome_${input.deliveryOutcome}`,
    });
  }
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
    const provenanceQualifiers: readonly LearningProvenanceQualifier[] = authority.signalClass === "hard"
      ? ["deterministically_verified", "reviewer_accepted"]
      : ["reviewer_accepted"];

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
        status: "corrected",
        summary: boundedLine(artifact.review.verification.summary, 4000, "The repair passed objective verification."),
        attribution: "model_behavior",
      },
      reviewerDecision: "accepted",
      // A correction is substantive when the reviewed repair actually carries
      // edits, rather than asserting `true`: an adaptive review with no edits is a
      // no-op and must not be treated as a substantive model-behavior correction.
      correctionSubstantive: artifact.review.edits.length > 0,
      // Attest contamination-freedom from the temporal determination this producer
      // can genuinely make, not a literal: the merged outcome was observed (at the
      // review time) before admission. A malformed/future timestamp fails closed.
      contaminationFree: temporalContaminationFree(candidate.reviewedAt, input.now),
      confidence: Math.min(1, Math.max(0, artifact.review.confidence / 100)),
      verificationAuthority: authority,
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
