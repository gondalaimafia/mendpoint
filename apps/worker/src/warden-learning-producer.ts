import { createHash } from "node:crypto";
import {
  findActiveLearningConsent,
  getAgentRunMeter,
  type AgentRunRow,
  type AppDb,
  type WardenCandidateDeliveryRecord,
} from "@mendpoint/db";
import type { CandidateReviewEvidence } from "@mendpoint/shared";
import type {
  LearningProvenanceQualifier,
  LearningRiskClass,
  LearningSignalClass,
  LearningVerificationProducer,
} from "@mendpoint/pipeline";
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
 * Derive the verification VERDICT's authority from what the review evidence
 * actually records, rather than asserting `deterministically_verified` as a
 * literal. The verdict is HARD only when a deterministic command genuinely ran
 * and passed AND every reviewed edit was assessed by an independent verifier.
 *
 * `assessmentSource` is stamped by the runtime and cannot be self-attributed by a
 * planner (packages/agent/src/types.ts): "verifier" is the only value meaning an
 * independent verifier graded the edit. "planner" (the model grading its own
 * work), "unavailable", and "heuristic" are soft. Fail closed: a single
 * non-verifier edit makes the whole event soft even when the commands passed, so
 * a model's own opinion can never be laundered into a deterministic label.
 */
export function deriveWardenVerificationAuthority(review: CandidateReviewEvidence): Readonly<{
  signalClass: LearningSignalClass;
  producedBy: LearningVerificationProducer;
  producerModelId: string | null;
}> {
  const deterministic = review.verification.commands.length > 0
    && review.verification.commands.every((command) => command.ok === true && command.exitCode === 0);
  const independentlyAssessed = review.edits.length > 0
    && review.edits.every((edit) => edit.assessmentSource === "verifier");
  if (deterministic && independentlyAssessed) {
    return Object.freeze({ signalClass: "hard" as const, producedBy: "sandbox_command" as const, producerModelId: null });
  }
  return Object.freeze({ signalClass: "soft" as const, producedBy: "model_verifier" as const, producerModelId: null });
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
  // Terminal-outcome gate. A delivered draft PR has no verified outcome yet, so
  // admitting a "corrected/accepted" record at delivery fabricates an outcome the
  // reviewer never gave — and learning_records is append-only, so it could never
  // be retracted when the PR is later closed unmerged. Admit only a genuinely
  // merged outcome. A null outcome is "pending" (no decision yet); a
  // closed_unmerged/reverted outcome is a negative result. Both are structurally
  // distinct and neither is a positive training signal.
  //
  // NOTE: this producer runs at the delivery seam, where `outcome` is always null,
  // so it now no-ops until admission is re-invoked at outcome resolution. That
  // re-invocation belongs to the corpus pipeline (see the PR body) and is not
  // wired here.
  if (delivery.outcome !== "merged") {
    return Object.freeze({
      admitted: false,
      reason: delivery.outcome === null ? "outcome_pending" : `outcome_${delivery.outcome}`,
    });
  }
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

    const authority = deriveWardenVerificationAuthority(reviewEvidence);
    // Derive `deterministically_verified` from the recorded authority instead of
    // asserting it: a soft verdict keeps only `reviewer_accepted`.
    const provenanceQualifiers: readonly LearningProvenanceQualifier[] = authority.signalClass === "hard"
      ? ["deterministically_verified", "reviewer_accepted"]
      : ["reviewer_accepted"];

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
      verificationAuthority: authority,
      economics: {
        inputTokens: meter?.inputTokens ?? 0,
        outputTokens: meter?.outputTokens ?? 0,
        latencyMs: meter?.durationMs ?? 0,
        costUsd: meter?.costUsd ?? 0,
      },
      sourceClass: "design_partner_verified",
      provenanceQualifiers,
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
