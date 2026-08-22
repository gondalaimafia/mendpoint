import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitLearningRecord,
  computeRetrievalContextGaps,
  createDb,
  deleteLearningRecord,
  grantLearningConsent,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertPrincipal,
  insertReviewDecision,
  insertTenant,
  revokeLearningConsent,
  type AppDb,
} from "@mendpoint/db";
import { createGovernedLearningEvent, extractGovernedLesson } from "./learning-event.js";
import {
  admitGovernedLearningEvent,
  authorizeGovernedLearningCorpus,
  getGovernedLearningStatus,
  governedLearningAdmissionIds,
  governedLearningSplit,
  materializeGovernedLearningCorpus,
} from "./learning-operations.js";

const roots: string[] = [];
const dbs: AppDb[] = [];
const CREATED_AT = "2026-08-14T20:00:00.000Z";
const OBSERVED_AT = "2026-08-14T19:00:00.000Z";
const CUTOFF_AT = "2026-08-14T19:30:00.000Z";
const PURPOSE = "fettler-api-engineering";

afterEach(() => {
  while (dbs.length) dbs.pop()!.raw.close();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture(): AppDb {
  const root = mkdtempSync(join(tmpdir(), "mendpoint-learning-operation-"));
  roots.push(root);
  const db = createDb(join(root, "app.sqlite"));
  dbs.push(db);
  insertTenant(db, { id: "tenant-a", slug: "tenant-a", name: "Tenant A", createdAt: CREATED_AT });
  insertPrincipal(db, {
    id: "human-a",
    tenantId: "tenant-a",
    kind: "human",
    subject: "reviewer-a",
    displayName: "Reviewer A",
    createdAt: CREATED_AT,
  });
  return db;
}

function artifact(
  db: AppDb,
  id: string,
  kind: string,
  content: string,
) {
  return insertArtifactManifest(db, {
    id,
    tenantId: "tenant-a",
    kind,
    schemaVersion: 1,
    sha256: sha256(content),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content),
    storageRef: `sqlite://${id}`,
    content,
    producerPrincipalId: "human-a",
    createdAt: CREATED_AT,
  }).row;
}

function admitReviewedOutcome(
  db: AppDb,
  options: Readonly<{
    missionId?: string;
    sourceObjectId?: string;
    predictionEvidenceRef?: string;
    mayLeaveTenantBoundary?: boolean;
    splitGroupId?: string;
    verificationSubjectType?: string;
    verificationArtifactId?: string;
    verificationInputArtifactId?: string;
    reviewCandidateArtifactId?: string;
    sourceObjectType?: string;
    proposedActionArtifactId?: string;
    suffix?: string;
    eventId?: string;
    repositoryId?: string;
    migrationFamily?: string;
    outcomeAttribution?: "model_behavior" | "parser";
    authoritativeAttribution?: "model_behavior" | "parser";
    signalClass?: "hard" | "soft";
  }> = {},
): void {
  const suffix = options.suffix ?? "a";
  const sourceId = `source-${suffix}`;
  const redactedId = `redacted-${suffix}`;
  const verificationArtifactId = `verification-${suffix}`;
  const contaminationArtifactId = `contamination-${suffix}`;
  const redactionEvidenceId = `redaction-evidence-${suffix}`;
  const verificationEvidenceId = `verification-evidence-${suffix}`;
  const contaminationEvidenceId = `contamination-evidence-${suffix}`;
  const reviewId = `review-${suffix}`;
  const recordId = `record-${suffix}`;
  const sourceObjectId = options.sourceObjectId ?? `run-${suffix}`;
  grantLearningConsent(db, {
    id: "consent-a",
    tenantId: "tenant-a",
    consentVersion: 1,
    purpose: PURPOSE,
    residencyRegion: "us-central",
    authorizedByPrincipalId: "human-a",
    effectiveAt: "2026-08-14T18:00:00.000Z",
    reason: "Train on approved API engineering outcomes.",
    idempotencyKey: "consent-a",
    createdAt: CREATED_AT,
  });
  const governed = createGovernedLearningEvent({
    schemaVersion: 1,
    eventId: options.eventId ?? (suffix === "a" ? "learning-event-2" : `learning-event-${suffix}`),
    product: "fettler",
    missionId: options.missionId ?? sourceObjectId,
    repositoryId: options.repositoryId ?? "repository-a",
    taskType: "api_remediation",
    capability: "remediation_generation",
    specialization: {
      provider: "stripe",
      framework: "hono",
      language: "typescript",
      runtime: "node-20",
      migrationFamily: options.migrationFamily ?? "response-field-replacement",
      riskClass: "medium",
      splitGroupId: options.splitGroupId ?? "repository-a:response-field-replacement",
    },
    execution: { modelId: "model-a", adapterId: null, routerDecisionId: "router-a", fallback: false },
    references: {
      graphContextArtifactId: null,
      inputArtifactId: sourceId,
      proposedActionArtifactId: options.proposedActionArtifactId ?? redactedId,
    },
    prediction: {
      summary: "Use the replacement API field.",
      evidenceRefs: [options.predictionEvidenceRef ?? redactionEvidenceId],
    },
    observedOutcome: {
      status: "corrected",
      summary: "The reviewer corrected the replacement field and verification passed.",
      attribution: options.outcomeAttribution ?? "model_behavior",
      evidenceRefs: [verificationEvidenceId],
    },
    verification: { verdict: "passed", evidenceRefs: [verificationEvidenceId], authority: { signalClass: options.signalClass ?? "hard", producedBy: options.signalClass === "soft" ? "model_verifier" : "test_runner", producerModelId: null } },
    reviewerDecision: { decision: "modified", evidenceRefs: [reviewId] },
    correction: { artifactId: redactedId, substantive: true },
    confidence: 0.94,
    economics: { inputTokens: 1200, outputTokens: 240, latencyMs: 1500, costUsd: 0.012 },
    governance: {
      tenantId: "tenant-a",
      residencyRegion: "us-central",
      consentId: "consent-a",
      sourceClass: "production_verified",
      provenanceQualifiers: ["human_corrected", "deterministically_verified"],
      mayLeaveTenantBoundary: options.mayLeaveTenantBoundary ?? false,
    },
    createdAt: OBSERVED_AT,
  });
  const lesson = extractGovernedLesson(governed);
  const outcome = JSON.stringify({
    schemaVersion: 1,
    kind: "governed_learning_lesson",
    event: governed.event,
    eventDigest: governed.digest,
    lesson,
  });
  const source = artifact(db, sourceId, "learning-source", JSON.stringify({
    schemaVersion: 1,
    kind: "governed_learning_source",
    product: "fettler",
    repositoryId: "repository-a",
    revision: "a".repeat(40),
    snapshotDigest: `sha256:${sha256(`snapshot-${suffix}`)}`,
    snapshotArtifactId: sourceId,
    scenarioId: null,
    syntheticFamilyId: null,
    sourceClass: governed.event.governance.sourceClass,
    provenanceQualifiers: governed.event.governance.provenanceQualifiers,
  }));
  const redacted = artifact(db, redactedId, "learning-redacted", outcome);
  const verification = artifact(db, verificationArtifactId, "verification", JSON.stringify({ schemaVersion: 1, kind: "governed_learning_verification", sourceId: suffix, outcomeAttribution: options.authoritativeAttribution ?? "model_behavior", verificationVerdict: "passed", sourceClass: governed.event.governance.sourceClass, provenanceQualifiers: governed.event.governance.provenanceQualifiers, correctionSubstantive: true }));
  const contamination = artifact(db, contaminationArtifactId, "contamination", JSON.stringify({ suffix }));
  insertEvidenceRecord(db, {
    id: redactionEvidenceId, tenantId: "tenant-a", subjectType: "fettler_outcome",
    subjectId: sourceObjectId, artifactId: redacted.id, inputArtifactId: source.id,
    producerPrincipalId: "human-a", tool: "learning-redaction", toolVersion: "1",
    verdict: "passed", createdAt: CREATED_AT,
  });
  insertEvidenceRecord(db, {
    id: verificationEvidenceId, tenantId: "tenant-a", subjectType: options.verificationSubjectType ?? "fettler_outcome",
    subjectId: sourceObjectId, artifactId: options.verificationArtifactId ?? verification.id,
    inputArtifactId: options.verificationInputArtifactId ?? redacted.id,
    producerPrincipalId: "human-a", tool: "learning-verification", toolVersion: "1",
    verdict: "passed", createdAt: CREATED_AT,
  });
  insertEvidenceRecord(db, {
    id: contaminationEvidenceId, tenantId: "tenant-a", subjectType: "fettler_outcome",
    subjectId: sourceObjectId, artifactId: contamination.id, inputArtifactId: redacted.id,
    producerPrincipalId: "human-a", tool: "learning-contamination", toolVersion: "1",
    verdict: "passed", createdAt: CREATED_AT,
  });
  insertReviewDecision(db, {
    id: reviewId, tenantId: "tenant-a", subjectType: "fettler_outcome", subjectId: sourceObjectId,
    candidateArtifactId: options.reviewCandidateArtifactId ?? redacted.id, reviewerPrincipalId: "human-a", decision: "approve",
    rationale: "Admit the redacted verified outcome.", createdAt: CREATED_AT,
  });
  admitLearningRecord(db, {
    id: recordId, tenantId: "tenant-a", consentId: "consent-a",
    sourceObjectType: options.sourceObjectType ?? "fettler_agent_run", sourceObjectId,
    sourceArtifactId: source.id, redactedArtifactId: redacted.id,
    redactionEvidenceId, verificationEvidenceId,
    acceptedReviewId: reviewId, contaminationEvidenceId,
    observedAt: OBSERVED_AT, admittedByPrincipalId: "human-a", idempotencyKey: recordId,
    createdAt: CREATED_AT,
  });
  expect(redacted.sha256).toHaveLength(64);
}

describe("governed learning operations", () => {
  it("admits one authority-derived redacted lesson and replays it exactly", () => {
    const db = fixture();
    grantLearningConsent(db, {
      id: "consent-admission", tenantId: "tenant-a", consentVersion: 1, purpose: PURPOSE,
      residencyRegion: "us-central", authorizedByPrincipalId: "human-a",
      effectiveAt: "2026-08-14T18:00:00.000Z", reason: "Govern verified outcomes.",
      idempotencyKey: "consent-admission", createdAt: CREATED_AT,
    });
    const ids = governedLearningAdmissionIds("tenant-a", "event-admission");
    const event = {
      schemaVersion: 1, eventId: "event-admission", product: "fettler", missionId: "run-admission",
      repositoryId: "repository-a", taskType: "api_remediation", capability: "remediation_generation",
      specialization: { provider: "stripe", framework: "hono", language: "typescript", runtime: "node-20", migrationFamily: "response-field-replacement", riskClass: "medium", splitGroupId: "repository-a:response-field-replacement" },
      execution: { modelId: "model-a", adapterId: null, routerDecisionId: "router-a", fallback: false },
      references: { graphContextArtifactId: null, inputArtifactId: ids.sourceArtifactId, proposedActionArtifactId: ids.redactedArtifactId },
      prediction: { summary: "Use the replacement API field.", evidenceRefs: [ids.redactionEvidenceId] },
      observedOutcome: { status: "corrected", summary: "The reviewer corrected the field and tests passed.", attribution: "model_behavior", evidenceRefs: [ids.verificationEvidenceId] },
      verification: { verdict: "passed", evidenceRefs: [ids.verificationEvidenceId], authority: { signalClass: "hard", producedBy: "test_runner", producerModelId: null } },
      reviewerDecision: { decision: "modified", evidenceRefs: [ids.reviewDecisionId] },
      correction: { artifactId: ids.redactedArtifactId, substantive: true }, confidence: 0.91,
      economics: { inputTokens: 1000, outputTokens: 200, latencyMs: 1200, costUsd: 0.01 },
      governance: { tenantId: "tenant-a", residencyRegion: "us-central", consentId: "consent-admission", sourceClass: "production_verified", provenanceQualifiers: ["human_corrected", "deterministically_verified"], mayLeaveTenantBoundary: false },
      createdAt: OBSERVED_AT,
    } as const;
    const input = {
      tenantId: "tenant-a", purpose: PURPOSE, sourceObjectType: "fettler_agent_run", sourceObjectId: "run-admission",
      event, actorPrincipalId: "human-a", idempotencyKey: "admit-event", createdAt: CREATED_AT,
    } as const;
    const authority = {
      resolve: () => ({ revision: "a".repeat(40), snapshotDigest: `sha256:${sha256("snapshot-admission")}`, scenarioId: null, syntheticFamilyId: null, outcomeAttribution: "model_behavior" as const, verificationVerdict: "passed" as const, sourceClass: "production_verified" as const, provenanceQualifiers: ["human_corrected", "deterministically_verified"] as const, correctionSubstantive: true, reviewerPrincipalId: "human-a", reviewRationale: "Verified correction.", contaminationFree: true }),
      redact: (content: string) => ({ ok: true as const, content, redactionCount: 0 }),
    };
    const first = admitGovernedLearningEvent(db, input, authority);
    expect(admitGovernedLearningEvent(db, input, authority)).toEqual(first);
    expect(first).toMatchObject({ eventId: "event-admission", learningRecordId: ids.learningRecordId, lesson: { eligibleForModelTraining: true } });
    expect(db.raw.prepare("SELECT COUNT(*) c FROM learning_records WHERE tenant_id = ?").get("tenant-a")).toEqual({ c: 1 });

    // The learning status surfaces lesson-routing observability so the drop is seen
    // on the live operator surface. This lesson is admitted DIRECTLY with a
    // substantive model_behavior correction (not via the production producers, which
    // always emit `none`), so it exercises the `model_weight` sink: it reached a sink
    // and none went nowhere. The attribution half reports its narrow measure —
    // `effectivelyConstant: false` because no producer hardcodes a same literal —
    // which does NOT imply the producers discriminate. Two destinations now have a
    // sink (`model_weight` and `retrieval`); nothing routes to either in production
    // today because every producer-emitted lesson is attributed `none`.
    const status = getGovernedLearningStatus(db, "tenant-a", CREATED_AT);
    expect(status.lessonRouting.lessons).toEqual({
      classified: 1,
      reachedSink: 1,
      terminalNoAction: 0,
      wentNowhere: 0,
    });
    // Regression guard for the narrow check: if a producer slid back to a hardcoded
    // same literal, assessProductionAttributionDiscrimination would report
    // effectivelyConstant true and this assertion would fail.
    expect(status.lessonRouting.attribution).toMatchObject({
      effectivelyConstant: false,
      constant: null,
    });
    expect(status.lessonRouting.destinations.sinkConsumes).toBe(2);
    expect(status.lessonRouting.destinations.terminalNoAction).toBe(1);
    expect(status.lessonRouting.destinations.unrouted).toBe(status.lessonRouting.destinations.unroutedDestinations.length);
    expect(status.lessonRouting.destinations.unroutedDestinations).toContain("organization_memory");
    expect(status.lessonRouting.destinations.total).toBe(
      status.lessonRouting.destinations.sinkConsumes
        + status.lessonRouting.destinations.terminalNoAction
        + status.lessonRouting.destinations.unrouted,
    );
  });

  it("admits a retrieval-attributed lesson into the retrieval context-gap sink", () => {
    const db = fixture();
    grantLearningConsent(db, {
      id: "consent-retrieval", tenantId: "tenant-a", consentVersion: 1, purpose: PURPOSE,
      residencyRegion: "us-central", authorizedByPrincipalId: "human-a",
      effectiveAt: "2026-08-14T18:00:00.000Z", reason: "Govern verified outcomes.",
      idempotencyKey: "consent-retrieval", createdAt: CREATED_AT,
    });
    const ids = governedLearningAdmissionIds("tenant-a", "event-retrieval");
    // A retrieval lesson, admitted DIRECTLY with attribution `retrieval` to exercise
    // the sink. No production producer emits `retrieval` today (both pass
    // `not_verified`, so the deriver returns `none` — see Count 2); this test drives
    // the admission path with the attribution the deriver WILL emit once a `failed`
    // verification with context `recorded_absent` (spec 17.4.2) becomes observable,
    // proving the sink consumes it rather than dropping it. The governed event's
    // verification.verdict is `passed` — that field carries whether the learning
    // SIGNAL is authoritative (a hard authority), which is what lets `classify` emit
    // the `retrieval` destination; the failed migration is the observedOutcome.status.
    const event = {
      schemaVersion: 1, eventId: "event-retrieval", product: "fettler", missionId: "run-retrieval",
      repositoryId: "repository-a", taskType: "api_remediation", capability: "remediation_generation",
      specialization: { provider: "stripe", framework: "hono", language: "typescript", runtime: "node-20", migrationFamily: "response-field-replacement", riskClass: "medium", splitGroupId: "repository-a:response-field-replacement" },
      execution: { modelId: "model-a", adapterId: null, routerDecisionId: "router-a", fallback: false },
      references: { graphContextArtifactId: null, inputArtifactId: ids.sourceArtifactId, proposedActionArtifactId: ids.redactedArtifactId },
      prediction: { summary: "Use the replacement API field.", evidenceRefs: [ids.redactionEvidenceId] },
      observedOutcome: { status: "failed", summary: "Required context was not supplied to the model.", attribution: "retrieval", evidenceRefs: [ids.verificationEvidenceId] },
      verification: { verdict: "passed", evidenceRefs: [ids.verificationEvidenceId], authority: { signalClass: "hard", producedBy: "test_runner", producerModelId: null } },
      reviewerDecision: { decision: "modified", evidenceRefs: [ids.reviewDecisionId] },
      correction: { artifactId: ids.redactedArtifactId, substantive: true }, confidence: 0.9,
      economics: { inputTokens: 1000, outputTokens: 200, latencyMs: 1200, costUsd: 0.01 },
      governance: { tenantId: "tenant-a", residencyRegion: "us-central", consentId: "consent-retrieval", sourceClass: "production_verified", provenanceQualifiers: ["human_corrected", "deterministically_verified"], mayLeaveTenantBoundary: false },
      createdAt: OBSERVED_AT,
    } as const;
    const input = {
      tenantId: "tenant-a", purpose: PURPOSE, sourceObjectType: "fettler_agent_run", sourceObjectId: "run-retrieval",
      event, actorPrincipalId: "human-a", idempotencyKey: "admit-retrieval", createdAt: CREATED_AT,
    } as const;
    const authority = {
      resolve: () => ({ revision: "a".repeat(40), snapshotDigest: `sha256:${sha256("snapshot-retrieval")}`, scenarioId: null, syntheticFamilyId: null, outcomeAttribution: "retrieval" as const, verificationVerdict: "passed" as const, sourceClass: "production_verified" as const, provenanceQualifiers: ["human_corrected", "deterministically_verified"] as const, correctionSubstantive: true, reviewerPrincipalId: "human-a", reviewRationale: "Context missing.", contaminationFree: true }),
      redact: (content: string) => ({ ok: true as const, content, redactionCount: 0 }),
    };
    const admitted = admitGovernedLearningEvent(db, input, authority);
    // The retrieval lesson does not train weights (only model_weight does), but it
    // now reaches a real sink instead of being dropped.
    expect(admitted.lesson.destinations).toEqual([
      { destination: "retrieval", rationale: "required_context_not_retrieved" },
    ]);
    expect(admitted.lesson.eligibleForModelTraining).toBe(false);

    // DELETE-THE-CHECK TARGET. This is the single assertion that proves the sink
    // genuinely consumes: the admitted retrieval lesson is projected into the store
    // and read back by computeRetrievalContextGaps. Remove the recordRetrievalContextGap
    // call in admitGovernedLearningEvent, or gut computeRetrievalContextGaps, and
    // this line fails — the disposition flip to `sink_consumes` would be a lie.
    const gaps = computeRetrievalContextGaps(db, { tenantId: "tenant-a" });
    expect(gaps.totalGaps).toBe(1);
    expect(gaps.byCapability).toEqual([{ key: "remediation_generation", gaps: 1 }]);
    expect(gaps.byMigrationFamily).toEqual([{ key: "response-field-replacement", gaps: 1 }]);
    expect(gaps.recent[0]).toMatchObject({
      learningRecordId: admitted.learningRecordId,
      eventId: "event-retrieval",
      product: "fettler",
    });

    // Idempotent re-admission does not double count the gap.
    expect(admitGovernedLearningEvent(db, input, authority)).toEqual(admitted);
    expect(computeRetrievalContextGaps(db, { tenantId: "tenant-a" }).totalGaps).toBe(1);
  });

  it("does not record a retrieval gap for a model_behavior lesson", () => {
    const db = fixture();
    grantLearningConsent(db, {
      id: "consent-model", tenantId: "tenant-a", consentVersion: 1, purpose: PURPOSE,
      residencyRegion: "us-central", authorizedByPrincipalId: "human-a",
      effectiveAt: "2026-08-14T18:00:00.000Z", reason: "Govern verified outcomes.",
      idempotencyKey: "consent-model", createdAt: CREATED_AT,
    });
    const ids = governedLearningAdmissionIds("tenant-a", "event-model");
    const event = {
      schemaVersion: 1, eventId: "event-model", product: "fettler", missionId: "run-model",
      repositoryId: "repository-a", taskType: "api_remediation", capability: "remediation_generation",
      specialization: { provider: "stripe", framework: "hono", language: "typescript", runtime: "node-20", migrationFamily: "response-field-replacement", riskClass: "medium", splitGroupId: "repository-a:response-field-replacement" },
      execution: { modelId: "model-a", adapterId: null, routerDecisionId: "router-a", fallback: false },
      references: { graphContextArtifactId: null, inputArtifactId: ids.sourceArtifactId, proposedActionArtifactId: ids.redactedArtifactId },
      prediction: { summary: "Use the replacement API field.", evidenceRefs: [ids.redactionEvidenceId] },
      observedOutcome: { status: "corrected", summary: "The reviewer corrected the field and tests passed.", attribution: "model_behavior", evidenceRefs: [ids.verificationEvidenceId] },
      verification: { verdict: "passed", evidenceRefs: [ids.verificationEvidenceId], authority: { signalClass: "hard", producedBy: "test_runner", producerModelId: null } },
      reviewerDecision: { decision: "modified", evidenceRefs: [ids.reviewDecisionId] },
      correction: { artifactId: ids.redactedArtifactId, substantive: true }, confidence: 0.91,
      economics: { inputTokens: 1000, outputTokens: 200, latencyMs: 1200, costUsd: 0.01 },
      governance: { tenantId: "tenant-a", residencyRegion: "us-central", consentId: "consent-model", sourceClass: "production_verified", provenanceQualifiers: ["human_corrected", "deterministically_verified"], mayLeaveTenantBoundary: false },
      createdAt: OBSERVED_AT,
    } as const;
    const authority = {
      resolve: () => ({ revision: "a".repeat(40), snapshotDigest: `sha256:${sha256("snapshot-model")}`, scenarioId: null, syntheticFamilyId: null, outcomeAttribution: "model_behavior" as const, verificationVerdict: "passed" as const, sourceClass: "production_verified" as const, provenanceQualifiers: ["human_corrected", "deterministically_verified"] as const, correctionSubstantive: true, reviewerPrincipalId: "human-a", reviewRationale: "Verified correction.", contaminationFree: true }),
      redact: (content: string) => ({ ok: true as const, content, redactionCount: 0 }),
    };
    admitGovernedLearningEvent(db, {
      tenantId: "tenant-a", purpose: PURPOSE, sourceObjectType: "fettler_agent_run", sourceObjectId: "run-model",
      event, actorPrincipalId: "human-a", idempotencyKey: "admit-model", createdAt: CREATED_AT,
    }, authority);
    // A model_behavior lesson reaches the model_weight sink, not the retrieval sink.
    expect(computeRetrievalContextGaps(db, { tenantId: "tenant-a" }).totalGaps).toBe(0);
  });

  it("rejects forged attribution before writing any learning authority", () => {
    const db = fixture();
    grantLearningConsent(db, { id: "consent-forged", tenantId: "tenant-a", consentVersion: 1, purpose: PURPOSE, residencyRegion: "us-central", authorizedByPrincipalId: "human-a", effectiveAt: "2026-08-14T18:00:00.000Z", reason: "Govern verified outcomes.", idempotencyKey: "consent-forged", createdAt: CREATED_AT });
    const ids = governedLearningAdmissionIds("tenant-a", "event-forged");
    const event = {
      schemaVersion: 1, eventId: "event-forged", product: "fettler", missionId: "run-forged", repositoryId: "repository-a", taskType: "api_remediation", capability: "remediation_generation",
      specialization: { provider: "stripe", framework: null, language: "typescript", runtime: "node-20", migrationFamily: "field-replacement", riskClass: "low", splitGroupId: "repository-a:field-replacement" },
      execution: { modelId: "model-a", adapterId: null, routerDecisionId: "router-a", fallback: false }, references: { graphContextArtifactId: null, inputArtifactId: ids.sourceArtifactId, proposedActionArtifactId: ids.redactedArtifactId },
      prediction: { summary: "Replace field.", evidenceRefs: [ids.redactionEvidenceId] }, observedOutcome: { status: "corrected", summary: "Parser missed the field.", attribution: "model_behavior", evidenceRefs: [ids.verificationEvidenceId] }, verification: { verdict: "passed", evidenceRefs: [ids.verificationEvidenceId], authority: { signalClass: "hard", producedBy: "test_runner", producerModelId: null } },
      reviewerDecision: { decision: "modified", evidenceRefs: [ids.reviewDecisionId] }, correction: { artifactId: ids.redactedArtifactId, substantive: true }, confidence: 0.8,
      economics: { inputTokens: 1, outputTokens: 1, latencyMs: 1, costUsd: 0 }, governance: { tenantId: "tenant-a", residencyRegion: "us-central", consentId: "consent-forged", sourceClass: "production_verified", provenanceQualifiers: ["human_corrected"], mayLeaveTenantBoundary: false }, createdAt: OBSERVED_AT,
    } as const;
    expect(() => admitGovernedLearningEvent(db, { tenantId: "tenant-a", purpose: PURPOSE, sourceObjectType: "fettler_agent_run", sourceObjectId: "run-forged", event, actorPrincipalId: "human-a", idempotencyKey: "admit-forged", createdAt: CREATED_AT }, {
      resolve: () => ({ revision: "b".repeat(40), snapshotDigest: `sha256:${sha256("snapshot-forged")}`, scenarioId: null, syntheticFamilyId: null, outcomeAttribution: "parser" as const, verificationVerdict: "passed" as const, sourceClass: "production_verified" as const, provenanceQualifiers: ["human_corrected"] as const, correctionSubstantive: true, reviewerPrincipalId: "human-a", reviewRationale: "Parser defect.", contaminationFree: true }),
      redact: (content: string) => ({ ok: true as const, content, redactionCount: 0 }),
    })).toThrow("learning_admission_authority_mismatch");
    expect(db.raw.prepare("SELECT COUNT(*) c FROM learning_records").get()).toEqual({ c: 0 });
  });

  it("exports a corpus materialization operation from the pipeline", async () => {
    const pipeline = await import("./index.js") as Record<string, unknown>;

    expect(typeof pipeline.materializeGovernedLearningCorpus).toBe("function");
  }, 15_000);

  it("seals eligible reviewed outcomes and materializes one immutable replayable corpus", () => {
    const db = fixture();
    admitReviewedOutcome(db);

    const input = {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-a",
      createdAt: CREATED_AT,
    } as const;
    const first = materializeGovernedLearningCorpus(db, input);
    const replay = materializeGovernedLearningCorpus(db, input);

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      tenantId: "tenant-a",
      purpose: PURPOSE,
      residencyRegion: "us-central",
      datasetVersion: 1,
      memberCount: 1,
      exampleCount: 1,
      trainExampleCount: 1,
      validationExampleCount: 0,
      holdoutExampleCount: 0,
      artifactId: expect.stringMatching(/^learning_corpus_/),
      artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const row = db.raw.prepare(
      "SELECT kind, sha256, content_text FROM artifact_manifests WHERE id = ? AND tenant_id = ?",
    ).get(first.artifactId, "tenant-a") as { kind: string; sha256: string; content_text: string };
    expect(row.kind).toBe("learning_dataset_corpus");
    expect(sha256(row.content_text)).toBe(row.sha256);
    expect(JSON.parse(row.content_text)).toMatchObject({
      tenantId: "tenant-a",
      datasetVersionId: first.datasetVersionId,
      splitPolicy: {
        id: "split-group-sha256-80-10-10-v1",
        subject: "split_group_id",
      },
      splitManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      examples: [{
        sourceEventId: "learning-event-2",
        sourceClass: "production_verified",
        product: "fettler",
        capability: "remediation_generation",
        datasetSplit: "train",
        specialization: {
          splitGroupId: "repository-a:response-field-replacement",
        },
        provenance: {
          mayLeaveTenantBoundary: false,
        },
      }],
      externalProcessingAllowed: false,
    });
  });

  it("rejects a soft-only event from the weight-training corpus by the existing gate", () => {
    const db = fixture();
    // A genuinely hard record and a soft (model-verifier) record, identical in
    // every other respect. Both admit, but only the hard one is authoritative
    // enough for the weight-training corpus; the soft one is filtered by the same
    // eligibility gate that filters an ineligible destination.
    admitReviewedOutcome(db, { suffix: "hard", eventId: "learning-event-hard" });
    admitReviewedOutcome(db, { suffix: "soft", eventId: "learning-event-soft", signalClass: "soft" });

    const result = materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-soft-gate",
      createdAt: CREATED_AT,
    });

    // Exactly one member: the soft event never enters the corpus.
    expect(result.memberCount).toBe(1);
    expect(result.exampleCount).toBe(1);
    const members = db.raw
      .prepare("SELECT learning_record_id AS id FROM learning_dataset_members WHERE tenant_id = ? AND dataset_version_id = ?")
      .all("tenant-a", result.datasetVersionId) as Array<{ id: string }>;
    expect(members.map((row) => row.id)).toEqual(["record-hard"]);
  });

  it("assigns every variant in an immutable split group to one partition", () => {
    expect(governedLearningSplit("repository-a:response-field-replacement"))
      .toBe(governedLearningSplit("repository-a:response-field-replacement"));
    expect(governedLearningSplit("repository-a:response-field-replacement"))
      .toBe("train");
  });

  it("preserves the most restrictive tenant boundary in every corpus artifact", () => {
    const db = fixture();
    admitReviewedOutcome(db, { mayLeaveTenantBoundary: false });
    const result = materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-boundary",
      createdAt: CREATED_AT,
    });
    for (const artifactId of [result.artifactId, result.validationArtifactId, result.holdoutArtifactId]) {
      const row = db.raw.prepare("SELECT content_text FROM artifact_manifests WHERE id = ?").get(artifactId) as { content_text: string };
      expect(JSON.parse(row.content_text)).toMatchObject({ externalProcessingAllowed: false });
    }
  });

  it("requires distinct nonempty partitions and revokes corpus authority after deletion", () => {
    const db = fixture();
    admitReviewedOutcome(db);
    admitReviewedOutcome(db, { suffix: "b", migrationFamily: "family-7", splitGroupId: "repository-a:family-7" });
    admitReviewedOutcome(db, { suffix: "c", migrationFamily: "family-3", splitGroupId: "repository-a:family-3" });
    const result = materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-authority",
      createdAt: CREATED_AT,
    });
    const authority = {
      tenantId: "tenant-a",
      datasetVersionId: result.datasetVersionId,
      purpose: PURPOSE,
      residencyRegion: "us-central",
      trainingArtifactIds: [result.artifactId],
      validationArtifactId: result.validationArtifactId,
      holdoutArtifactId: result.holdoutArtifactId,
      splitManifestDigest: result.splitManifestDigest,
      processingBoundary: "tenant_local" as const,
      at: CREATED_AT,
    };
    expect(result).toMatchObject({ trainExampleCount: 1, validationExampleCount: 1, holdoutExampleCount: 1 });
    expect(authorizeGovernedLearningCorpus(db, authority)).toBe(true);

    deleteLearningRecord(db, {
      id: "delete-b",
      tenantId: "tenant-a",
      learningRecordId: "record-b",
      reason: "Remove the source outcome from future training.",
      requestedByPrincipalId: "human-a",
      idempotencyKey: "delete-b",
      createdAt: "2026-08-14T20:01:00.000Z",
    });
    expect(authorizeGovernedLearningCorpus(db, { ...authority, at: "2026-08-14T20:02:00.000Z" })).toBe(false);
  });

  it("does not let a replacement grant reauthorize a corpus sealed under a revoked grant", () => {
    const db = fixture();
    admitReviewedOutcome(db);
    admitReviewedOutcome(db, { suffix: "b", migrationFamily: "family-7", splitGroupId: "repository-a:family-7" });
    admitReviewedOutcome(db, { suffix: "c", migrationFamily: "family-3", splitGroupId: "repository-a:family-3" });
    const result = materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a", purpose: PURPOSE, temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a", idempotencyKey: "corpus-revocation", createdAt: CREATED_AT,
    });
    const authority = {
      tenantId: "tenant-a", datasetVersionId: result.datasetVersionId, purpose: PURPOSE,
      residencyRegion: "us-central", trainingArtifactIds: [result.artifactId],
      validationArtifactId: result.validationArtifactId, holdoutArtifactId: result.holdoutArtifactId,
      splitManifestDigest: result.splitManifestDigest, processingBoundary: "tenant_local" as const,
      at: CREATED_AT,
    };
    revokeLearningConsent(db, {
      id: "consent-revoked", tenantId: "tenant-a", consentId: "consent-a", consentVersion: 2,
      authorizedByPrincipalId: "human-a", reason: "Stop model training.",
      idempotencyKey: "consent-revoked", createdAt: "2026-08-14T20:01:00.000Z",
    });
    grantLearningConsent(db, {
      id: "consent-replacement", tenantId: "tenant-a", consentVersion: 3, purpose: PURPOSE,
      residencyRegion: "us-central", authorizedByPrincipalId: "human-a", supersedesConsentId: "consent-revoked",
      effectiveAt: "2026-08-14T20:02:00.000Z", reason: "Authorize only future outcomes.",
      idempotencyKey: "consent-replacement", createdAt: "2026-08-14T20:02:00.000Z",
    });
    expect(authorizeGovernedLearningCorpus(db, { ...authority, at: "2026-08-14T20:03:00.000Z" })).toBe(false);
  });

  it("rolls back its own work when an ambient transaction catches a failure", () => {
    const db = fixture();
    admitReviewedOutcome(db, { missionId: "different-run", sourceObjectId: "run-a" });
    db.raw.exec("BEGIN IMMEDIATE");
    expect(() => materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-ambient-failure",
      createdAt: CREATED_AT,
    })).toThrow("learning_corpus_mission_binding_mismatch");
    db.raw.exec("COMMIT");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_members").get() as { count: number }).count).toBe(0);
  });

  it("refuses a lesson whose mission does not match its admitted source authority", () => {
    const db = fixture();
    admitReviewedOutcome(db, { missionId: "different-run", sourceObjectId: "run-a" });

    expect(() => materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-mission-mismatch",
      createdAt: CREATED_AT,
    })).toThrow("learning_corpus_mission_binding_mismatch");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
  });

  it("refuses forged event evidence even when the outer learning record is valid", () => {
    const db = fixture();
    admitReviewedOutcome(db, { predictionEvidenceRef: "forged-evidence" });

    expect(() => materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-forged-evidence",
      createdAt: CREATED_AT,
    })).toThrow("learning_corpus_evidence_binding_mismatch");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
  });

  it("refuses a model learning attribution contradicted by authoritative verification taxonomy", () => {
    const db = fixture();
    admitReviewedOutcome(db, { outcomeAttribution: "model_behavior", authoritativeAttribution: "parser" });
    expect(() => materializeGovernedLearningCorpus(db, { tenantId: "tenant-a", purpose: PURPOSE, temporalCutoffAt: CUTOFF_AT, actorPrincipalId: "human-a", idempotencyKey: "corpus-attribution-mismatch", createdAt: CREATED_AT })).toThrow("learning_corpus_verification_authority_mismatch");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
  });

  it.each([
    ["wrong evidence subject type", { verificationSubjectType: "regauge_outcome" }],
    ["wrong verification artifact", { verificationArtifactId: "contamination-a" }],
    ["wrong proposed action", { proposedActionArtifactId: "source-a" }],
    ["cross product source", { sourceObjectType: "transformer_adaptive_candidate" }],
    ["wrong repository", { repositoryId: "repository-other" }],
  ])("refuses %s even when every referenced row exists", (_name, options) => {
    const db = fixture();
    admitReviewedOutcome(db, options);
    expect(() => materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: `corpus-authority-${_name}`,
      createdAt: CREATED_AT,
    })).toThrow(/learning_corpus_(?:artifact|evidence|review|product|source)_binding_mismatch/);
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
  });

  it("revalidates the admitted redacted artifact before materializing it", () => {
    const db = fixture();
    admitReviewedOutcome(db);
    const tampered = JSON.stringify({ schemaVersion: 1, kind: "governed_learning_lesson" });
    db.raw.exec("DROP TRIGGER artifact_manifests_append_only_update");
    db.raw.prepare(
      "UPDATE artifact_manifests SET content_text = ? WHERE id = 'redacted-a'",
    ).run(tampered);

    expect(() => materializeGovernedLearningCorpus(db, {
      tenantId: "tenant-a",
      purpose: PURPOSE,
      temporalCutoffAt: CUTOFF_AT,
      actorPrincipalId: "human-a",
      idempotencyKey: "corpus-tampered",
      createdAt: CREATED_AT,
    })).toThrow("learning_corpus_content_integrity_mismatch");
    expect((db.raw.prepare("SELECT COUNT(*) AS count FROM learning_dataset_versions").get() as { count: number }).count).toBe(0);
  });
});
