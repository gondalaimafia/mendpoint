import { createHash } from "node:crypto";
import {
  findActiveLearningConsent,
  getAgentRunMeter,
  type AgentRunRow,
  type AppDb,
  type WardenCandidateDeliveryRecord,
} from "@mendpoint/db";
import type { CandidateReviewEvidence } from "@mendpoint/shared";
import type { LearningRiskClass } from "@mendpoint/pipeline";
import { learningLoopEnabled } from "./transformer-learning-outcome.js";
import {
  GOVERNED_LEARNING_PURPOSE,
  admitGovernedLearningOutcome,
  type GovernedLearningAdmissionResult,
} from "./governed-learning-producer.js";

export type AdmitWardenGovernedLearningInput = Readonly<{
  db: AppDb;
  delivery: WardenCandidateDeliveryRecord;
  run: AgentRunRow;
  reviewEvidence: CandidateReviewEvidence;
  now: string;
  env?: NodeJS.ProcessEnv;
}>;

const RISK_ORDER: Readonly<Record<string, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });
const RISK_BY_ORDER: readonly LearningRiskClass[] = Object.freeze(["low", "medium", "high"]);
// Control characters the event schema rejects; collapsed to spaces before bounding.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]+/g;

function boundedLine(value: string, max: number, fallback: string): string {
  const collapsed = value.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
  return collapsed.length > 0 ? collapsed : fallback;
}

/** Highest reviewed edit risk, mapped to a learning risk class (default medium). */
function maxRiskClass(review: CandidateReviewEvidence): LearningRiskClass {
  let level = -1;
  for (const edit of review.edits) {
    const risk = edit.risk;
    if (risk && risk in RISK_ORDER) level = Math.max(level, RISK_ORDER[risk]!);
  }
  return level < 0 ? "medium" : RISK_BY_ORDER[level] ?? "medium";
}

/** Minimum reviewed edit confidence in [0,1], or null when none is measured. */
function minConfidence(review: CandidateReviewEvidence): number | null {
  const values = review.edits
    .map((edit) => edit.confidence)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.min(1, Math.max(0, Math.min(...values)));
}

/**
 * Admit a delivered, human-approved, deterministically verified Warden (Fettler)
 * repair as a governed learning event. This runs at the delivery-success seam,
 * where an approved candidate has become a real draft pull request, so the outcome
 * is both reviewer-approved and objectively verified.
 *
 * Best-effort and default-off: the learning loop flag gates it, an absent governed
 * consent skips it, and every other failure is swallowed by
 * {@link admitGovernedLearningOutcome}. It never affects delivery.
 */
export function admitWardenGovernedLearningEvent(
  input: AdmitWardenGovernedLearningInput,
): GovernedLearningAdmissionResult {
  const env = input.env ?? process.env;
  if (!learningLoopEnabled(env)) return Object.freeze({ admitted: false, reason: "disabled" });
  const { db, delivery, run, reviewEvidence } = input;
  try {
    const consent = findActiveLearningConsent(db, {
      tenantId: delivery.tenantId,
      purpose: GOVERNED_LEARNING_PURPOSE,
      at: input.now,
    });
    if (!consent) return Object.freeze({ admitted: false, reason: "no_active_consent" });

    const meter = getAgentRunMeter(db, delivery.tenantId, delivery.runId);
    const snapshotDigest = `sha256:${createHash("sha256")
      .update([delivery.tenantId, delivery.repositoryId, delivery.snapshotId, delivery.expectedBaseRevision].join("\0"), "utf8")
      .digest("hex")}`;

    return admitGovernedLearningOutcome({
      db,
      tenantId: delivery.tenantId,
      consentId: consent.id,
      residencyRegion: consent.residency_region,
      product: "fettler",
      sourceObjectType: "fettler_agent_run",
      sourceObjectId: run.id,
      repositoryId: delivery.repositoryId,
      taskType: "api_remediation",
      capability: "remediation_generation",
      specialization: {
        provider: null,
        framework: null,
        language: null,
        runtime: null,
        migrationFamily: "api_remediation",
        riskClass: maxRiskClass(reviewEvidence),
      },
      execution: {
        modelId: null,
        adapterId: null,
        routerDecisionId: `warden_route_${run.id}`,
        fallback: false,
      },
      predictionSummary: boundedLine(reviewEvidence.summary, 4000, "Apply the reviewed Warden repair."),
      outcome: {
        status: "corrected",
        summary: boundedLine(reviewEvidence.verification.summary, 4000, "The repair passed objective verification."),
        attribution: "model_behavior",
      },
      reviewerDecision: "accepted",
      correctionSubstantive: true,
      confidence: minConfidence(reviewEvidence),
      economics: {
        inputTokens: meter?.inputTokens ?? 0,
        outputTokens: meter?.outputTokens ?? 0,
        latencyMs: meter?.durationMs ?? 0,
        costUsd: meter?.costUsd ?? 0,
      },
      sourceClass: "design_partner_verified",
      provenanceQualifiers: ["deterministically_verified", "reviewer_accepted"],
      mayLeaveTenantBoundary: false,
      revision: delivery.expectedBaseRevision,
      snapshotDigest,
      scenarioId: null,
      syntheticFamilyId: null,
      reviewerPrincipalId: delivery.requesterPrincipalId,
      reviewRationale: boundedLine(delivery.rationale, 512, "Approved in Warden review."),
      observedAt: delivery.requestedAt,
      now: input.now,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ admitted: false, reason: `error:${message}` });
  }
}
