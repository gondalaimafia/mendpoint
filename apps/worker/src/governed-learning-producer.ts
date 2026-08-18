import { createHash } from "node:crypto";
import { getLearningRecord, type AppDb } from "@mendpoint/db";
import {
  admitGovernedLearningEvent,
  governedLearningAdmissionIds,
  type GovernedLearningEventV1,
  type GovernedLearningOutcomeAuthority,
  type LearningOutcomeAttribution,
  type LearningOutcomeStatus,
  type LearningProduct,
  type LearningProvenanceQualifier,
  type LearningRiskClass,
  type LearningSignalClass,
  type LearningSourceClass,
  type LearningVerificationProducer,
} from "@mendpoint/pipeline";
import { redactSourceForModel } from "@mendpoint/shared";

/**
 * The single consent purpose the governed learning flywheel writes under. It is
 * DISTINCT from every legacy Transformer purpose
 * (`transformer-adaptive-repair`, `transformer-adaptive-training-content`,
 * `transformer-adaptive-rejected-outcomes`) so the legacy corpus exporter, which
 * scopes strictly by (tenant, purpose, residency), never resolves a
 * `governed_learning_lesson` document and can never mis-classify one. Both
 * products (Fettler/Warden and ReGauge/Transformer) emit under this one purpose so
 * a single {@link materializeGovernedLearningCorpus} call receives both.
 */
export const GOVERNED_LEARNING_PURPOSE = "governed-adapter-training";

/**
 * Redaction cap for the governed event document. A governed event is bounded at
 * 128 KiB by the event schema; this leaves generous headroom while staying inside
 * the redaction machinery's hard ceiling.
 */
const EVENT_REDACTION_CAP = 200_000;

export type GovernedLearningAdmissionResult = Readonly<{
  admitted: boolean;
  reason: string;
  recordId?: string;
  eventId?: string;
}>;

/**
 * Product-agnostic outcome facts. A product producer (Warden or Transformer)
 * gathers its real reviewed, verified outcome into this shape; every reference,
 * evidence, and governance value the governed admission requires is derived here
 * from the deterministic admission ids, so callers never invent ids.
 */
export type GovernedLearningOutcomeFacts = Readonly<{
  db: AppDb;
  tenantId: string;
  consentId: string;
  residencyRegion: string;
  product: LearningProduct;
  sourceObjectType: "fettler_agent_run" | "transformer_adaptive_candidate";
  sourceObjectId: string;
  repositoryId: string;
  taskType: string;
  capability: string;
  specialization: Readonly<{
    provider: string | null;
    framework: string | null;
    language: string | null;
    runtime: string | null;
    migrationFamily: string;
    riskClass: LearningRiskClass;
  }>;
  execution: Readonly<{
    modelId: string | null;
    adapterId: string | null;
    routerDecisionId: string;
    fallback: boolean;
  }>;
  predictionSummary: string;
  outcome: Readonly<{
    status: LearningOutcomeStatus;
    summary: string;
    attribution: LearningOutcomeAttribution;
  }>;
  /**
   * Provenance of the verification VERDICT, derived by the product producer from
   * what actually ran (a deterministic command, a compiler, a human reviewer, or
   * a model verifier). Recorded verbatim on the event so `strength()` and the
   * weight-training admission gate can enforce hard-over-soft precedence instead
   * of trusting the caller-asserted provenance qualifiers.
   */
  verificationAuthority: Readonly<{
    signalClass: LearningSignalClass;
    producedBy: LearningVerificationProducer;
    producerModelId: string | null;
  }>;
  reviewerDecision: "accepted" | "modified" | "merged";
  correctionSubstantive: boolean;
  confidence: number | null;
  economics: Readonly<{
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    costUsd: number;
  }>;
  sourceClass: LearningSourceClass;
  provenanceQualifiers: readonly LearningProvenanceQualifier[];
  mayLeaveTenantBoundary: boolean;
  /** 40-64 hex source revision (a git commit SHA satisfies this). */
  revision: string;
  /** `sha256:<64 hex>` snapshot content digest. */
  snapshotDigest: string;
  scenarioId: string | null;
  syntheticFamilyId: string | null;
  reviewerPrincipalId: string;
  reviewRationale: string;
  observedAt: string;
  now: string;
  purpose?: string;
}>;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Fail-closed redaction of the serialized governed event with the same secret
 * scrubber every model-bound path uses. An excluded (ambiguous), truncated, or
 * non-parseable result yields no admission rather than a record with a weaker
 * scrub. The event carries only structured, bounded evidence (never raw source),
 * so a clean event passes through unchanged; a summary that smuggled a secret is
 * caught here.
 */
function redactEventDocument(content: string): ReturnType<GovernedLearningOutcomeAuthority["redact"]> {
  const result = redactSourceForModel(content, EVENT_REDACTION_CAP);
  if (result.excluded) {
    return Object.freeze({ ok: false as const, reason: `redaction_excluded:${result.exclusionReason ?? "unknown"}` });
  }
  if (result.truncated) {
    return Object.freeze({ ok: false as const, reason: "redaction_truncated" });
  }
  try {
    JSON.parse(result.text);
  } catch {
    return Object.freeze({ ok: false as const, reason: "redaction_unparseable" });
  }
  return Object.freeze({ ok: true as const, content: result.text, redactionCount: result.counts.total });
}

/**
 * Admit ONE reviewed, verified product outcome as a governed learning event.
 *
 * Strictly best-effort: any failure (temporal contamination, redaction failure,
 * missing consent, binding mismatch) returns a non-admission result and never
 * throws. Idempotent per (tenant, source object) via the deterministic learning
 * record id. Consent, redaction, verification/contamination evidence, and the
 * raw-source-never-stored guarantee are all ENFORCED inside
 * {@link admitGovernedLearningEvent}; this producer satisfies them, it does not
 * re-implement them.
 */
export function admitGovernedLearningOutcome(
  facts: GovernedLearningOutcomeFacts,
): GovernedLearningAdmissionResult {
  const purpose = facts.purpose ?? GOVERNED_LEARNING_PURPOSE;
  try {
    // Honest temporal / contamination attestation: the outcome must have been
    // observed no later than admission time (no future leakage).
    if (!(Date.parse(facts.observedAt) <= Date.parse(facts.now))) {
      return Object.freeze({ admitted: false, reason: "contamination_temporal" });
    }

    const eventId = `governed_learning_${sha256Hex(`${facts.tenantId}\0${facts.sourceObjectType}\0${facts.sourceObjectId}`)}`;
    const ids = governedLearningAdmissionIds(facts.tenantId, eventId);

    // Idempotent: if this outcome was already admitted, do nothing further.
    if (getLearningRecord(facts.db, facts.tenantId, ids.learningRecordId)) {
      return Object.freeze({ admitted: true, reason: "already_admitted", recordId: ids.learningRecordId, eventId });
    }

    const splitGroupId = facts.sourceClass === "synthetic_ground_truth"
      ? `${facts.syntheticFamilyId}:${facts.specialization.migrationFamily}`
      : `${facts.repositoryId}:${facts.specialization.migrationFamily}`;

    const event: GovernedLearningEventV1 = {
      schemaVersion: 1,
      eventId,
      product: facts.product,
      missionId: facts.sourceObjectId,
      repositoryId: facts.repositoryId,
      taskType: facts.taskType,
      capability: facts.capability,
      specialization: {
        provider: facts.specialization.provider,
        framework: facts.specialization.framework,
        language: facts.specialization.language,
        runtime: facts.specialization.runtime,
        migrationFamily: facts.specialization.migrationFamily,
        riskClass: facts.specialization.riskClass,
        splitGroupId,
      },
      execution: {
        modelId: facts.execution.modelId,
        adapterId: facts.execution.adapterId,
        routerDecisionId: facts.execution.routerDecisionId,
        fallback: facts.execution.fallback,
      },
      references: {
        graphContextArtifactId: null,
        inputArtifactId: ids.sourceArtifactId,
        proposedActionArtifactId: ids.redactedArtifactId,
      },
      prediction: {
        summary: facts.predictionSummary,
        evidenceRefs: [ids.redactionEvidenceId],
      },
      observedOutcome: {
        status: facts.outcome.status,
        summary: facts.outcome.summary,
        attribution: facts.outcome.attribution,
        evidenceRefs: [ids.verificationEvidenceId],
      },
      verification: {
        verdict: "passed",
        evidenceRefs: [ids.verificationEvidenceId],
        authority: facts.verificationAuthority,
      },
      reviewerDecision: {
        decision: facts.reviewerDecision,
        evidenceRefs: [ids.reviewDecisionId],
      },
      correction: { artifactId: ids.redactedArtifactId, substantive: facts.correctionSubstantive },
      confidence: facts.confidence,
      economics: {
        inputTokens: facts.economics.inputTokens,
        outputTokens: facts.economics.outputTokens,
        latencyMs: facts.economics.latencyMs,
        costUsd: facts.economics.costUsd,
      },
      governance: {
        tenantId: facts.tenantId,
        residencyRegion: facts.residencyRegion,
        consentId: facts.consentId,
        sourceClass: facts.sourceClass,
        provenanceQualifiers: facts.provenanceQualifiers,
        mayLeaveTenantBoundary: facts.mayLeaveTenantBoundary,
      },
      createdAt: facts.observedAt,
    };

    const authority: GovernedLearningOutcomeAuthority = {
      resolve: () => ({
        revision: facts.revision,
        snapshotDigest: facts.snapshotDigest,
        scenarioId: facts.scenarioId,
        syntheticFamilyId: facts.syntheticFamilyId,
        outcomeAttribution: facts.outcome.attribution,
        verificationVerdict: "passed",
        sourceClass: facts.sourceClass,
        provenanceQualifiers: facts.provenanceQualifiers,
        correctionSubstantive: facts.correctionSubstantive,
        reviewerPrincipalId: facts.reviewerPrincipalId,
        reviewRationale: facts.reviewRationale,
        contaminationFree: true,
      }),
      redact: redactEventDocument,
    };

    const admitted = admitGovernedLearningEvent(facts.db, {
      tenantId: facts.tenantId,
      purpose,
      sourceObjectType: facts.sourceObjectType,
      sourceObjectId: facts.sourceObjectId,
      event,
      actorPrincipalId: facts.reviewerPrincipalId,
      idempotencyKey: eventId,
      createdAt: facts.now,
    }, authority);
    return Object.freeze({ admitted: true, reason: "admitted", recordId: admitted.learningRecordId, eventId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({ admitted: false, reason: `error:${message}` });
  }
}
