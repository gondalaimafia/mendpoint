import { createHash } from "node:crypto";
import { findActiveLearningConsent } from "@mendpoint/db";
import type { LearningRiskClass } from "@mendpoint/pipeline";
import { learningLoopEnabled } from "./transformer-learning-outcome.js";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  type GovernedLearningAdmissionResult,
} from "./governed-learning-producer.js";
import type { AdmitApprovedOutcomeInput } from "./transformer-learning-producer.js";

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
  input: AdmitApprovedOutcomeInput,
): GovernedLearningAdmissionResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ admitted: false, reason: "disabled" });
  const { db, tenantId, candidate, artifact } = input;
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
      correctionSubstantive: true,
      confidence: Math.min(1, Math.max(0, artifact.review.confidence / 100)),
      // No per-candidate token meter exists at this seam; economics are unmetered.
      economics: { inputTokens: 0, outputTokens: 0, latencyMs: 0, costUsd: 0 },
      sourceClass: "design_partner_verified",
      provenanceQualifiers: ["deterministically_verified", "reviewer_accepted"],
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
