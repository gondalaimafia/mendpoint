import { createHash } from "node:crypto";
import {
  admitLearningRecord,
  addLearningDatasetMember,
  countLearningDatasetMembers,
  createLearningDatasetVersion,
  findActiveLearningConsent,
  getLatestLearningDatasetVersion,
  getLearningRecord,
  insertArtifactManifest,
  insertEvidenceRecord,
  insertReviewDecision,
  listAdmittableLearningRecords,
  listEligibleLearningDatasetMembers,
  sealLearningDatasetVersion,
  type AppDb,
  type LearningRecordRow,
} from "@mendpoint/db";
import {
  createGovernedLearningEvent,
  extractGovernedLesson,
  type GovernedLearningEventV1,
  type GovernedLearningLesson,
} from "./learning-event.js";

export type MaterializeGovernedLearningCorpusInput = Readonly<{
  tenantId: string;
  purpose: string;
  temporalCutoffAt: string;
  actorPrincipalId: string;
  idempotencyKey: string;
  createdAt: string;
}>;

export type MaterializedGovernedLearningCorpus = Readonly<{
  tenantId: string;
  purpose: string;
  residencyRegion: string;
  datasetVersionId: string;
  datasetVersion: number;
  memberCount: number;
  exampleCount: number;
  trainExampleCount: number;
  validationExampleCount: number;
  holdoutExampleCount: number;
  artifactId: string;
  artifactSha256: string;
  validationArtifactId: string;
  validationArtifactSha256: string;
  holdoutArtifactId: string;
  holdoutArtifactSha256: string;
  splitManifestDigest: string;
}>;

export type GovernedLearningCorpusAuthorizationInput = Readonly<{
  tenantId: string;
  datasetVersionId: string;
  purpose: string;
  residencyRegion: string;
  trainingArtifactIds: readonly string[];
  validationArtifactId: string;
  holdoutArtifactId: string;
  splitManifestDigest: string;
  processingBoundary: "tenant_local" | "external";
  at: string;
}>;

export type GovernedLearningAdmissionIds = Readonly<{
  sourceArtifactId: string;
  redactedArtifactId: string;
  verificationArtifactId: string;
  contaminationArtifactId: string;
  redactionEvidenceId: string;
  verificationEvidenceId: string;
  contaminationEvidenceId: string;
  reviewDecisionId: string;
  learningRecordId: string;
}>;

export type GovernedLearningAdmissionInput = Readonly<{
  tenantId: string;
  purpose: string;
  sourceObjectType: "fettler_agent_run" | "transformer_adaptive_candidate";
  sourceObjectId: string;
  event: GovernedLearningEventV1;
  actorPrincipalId: string;
  idempotencyKey: string;
  createdAt: string;
}>;

export type GovernedLearningOutcomeAuthority = Readonly<{
  resolve(input: Readonly<{
    tenantId: string;
    product: GovernedLearningEventV1["product"];
    sourceObjectType: GovernedLearningAdmissionInput["sourceObjectType"];
    sourceObjectId: string;
    eventId: string;
    eventDigest: string;
  }>): Readonly<{
    revision: string;
    snapshotDigest: string;
    scenarioId: string | null;
    syntheticFamilyId: string | null;
    outcomeAttribution: GovernedLearningEventV1["observedOutcome"]["attribution"];
    verificationVerdict: GovernedLearningEventV1["verification"]["verdict"];
    sourceClass: GovernedLearningEventV1["governance"]["sourceClass"];
    provenanceQualifiers: GovernedLearningEventV1["governance"]["provenanceQualifiers"];
    correctionSubstantive: boolean;
    reviewerPrincipalId: string;
    reviewRationale: string;
    contaminationFree: boolean;
  }>;
  redact(content: string): Readonly<
    | { ok: true; content: string; redactionCount: number }
    | { ok: false; reason: string }
  >;
}>;

export type AdmittedGovernedLearningEvent = Readonly<{
  eventId: string;
  eventDigest: string;
  learningRecordId: string;
  lesson: GovernedLearningLesson;
}>;

type DatasetSplit = "train" | "validation" | "holdout";

type StoredLearningDocument = Readonly<{
  schemaVersion: 1;
  kind: "governed_learning_lesson";
  event: GovernedLearningEventV1;
  eventDigest: string;
  lesson: GovernedLearningLesson;
  sourceAuthority: GovernedLearningSourceAuthority;
}>;

type GovernedLearningSourceAuthority = Readonly<{
  schemaVersion: 1;
  kind: "governed_learning_source";
  product: GovernedLearningEventV1["product"];
  repositoryId: string;
  revision: string;
  snapshotDigest: string;
  snapshotArtifactId: string;
  scenarioId: string | null;
  syntheticFamilyId: string | null;
  sourceClass: GovernedLearningEventV1["governance"]["sourceClass"];
  provenanceQualifiers: GovernedLearningEventV1["governance"]["provenanceQualifiers"];
}>;

type CorpusExample = Readonly<{
  schemaVersion: 1;
  sourceEventId: string;
  sourceEventDigest: string;
  sourceClass: GovernedLearningEventV1["governance"]["sourceClass"];
  provenanceQualifiers: GovernedLearningEventV1["governance"]["provenanceQualifiers"];
  product: GovernedLearningEventV1["product"];
  capability: string;
  taskType: string;
  specialization: GovernedLearningEventV1["specialization"];
  datasetSplit: DatasetSplit;
  task: Readonly<{
    missionId: string;
    repositoryId: string;
    graphContextArtifactId: string | null;
    inputArtifactId: string;
    sourceRevision: string;
    sourceDigest: string;
    scenarioId: string | null;
    syntheticFamilyId: string | null;
  }>;
  originalOutput: GovernedLearningEventV1["prediction"];
  verifiedOutcome: GovernedLearningEventV1["observedOutcome"];
  correction: GovernedLearningEventV1["correction"];
  verification: GovernedLearningEventV1["verification"];
  reviewerDecision: GovernedLearningEventV1["reviewerDecision"];
  routerContext: GovernedLearningEventV1["execution"];
  confidence: number | null;
  economics: GovernedLearningEventV1["economics"];
  provenance: Readonly<{
    tenantId: string;
    residencyRegion: string;
    consentId: string;
    learningRecordId: string;
    sourceObjectType: string;
    observedAt: string;
    mayLeaveTenantBoundary: boolean;
  }>;
}>;

const DOCUMENT_KEYS = new Set(["schemaVersion", "kind", "event", "eventDigest", "lesson"]);
const SPLIT_POLICY = Object.freeze({
  id: "split-group-sha256-80-10-10-v1",
  subject: "split_group_id" as const,
});
const AMBIENT_SAVEPOINT = "materialize_governed_learning_corpus";
const ADMISSION_SAVEPOINT = "admit_governed_learning_event";

export function governedLearningAdmissionIds(
  tenantId: string,
  eventId: string,
): GovernedLearningAdmissionIds {
  requireBoundedText(tenantId, "learning_admission_tenant_id_invalid");
  requireBoundedText(eventId, "learning_admission_event_id_invalid");
  const identity = sha256(`${tenantId}\0${eventId}`);
  return deepFreeze({
    sourceArtifactId: `learning_source_${identity}`,
    redactedArtifactId: `learning_redacted_${identity}`,
    verificationArtifactId: `learning_verification_${identity}`,
    contaminationArtifactId: `learning_contamination_${identity}`,
    redactionEvidenceId: `learning_redaction_evidence_${identity}`,
    verificationEvidenceId: `learning_verification_evidence_${identity}`,
    contaminationEvidenceId: `learning_contamination_evidence_${identity}`,
    reviewDecisionId: `learning_review_${identity}`,
    learningRecordId: `learning_record_${identity}`,
  });
}

export function admitGovernedLearningEvent(
  db: AppDb,
  input: GovernedLearningAdmissionInput,
  authority: GovernedLearningOutcomeAuthority,
): AdmittedGovernedLearningEvent {
  validateAdmissionInput(input);
  const ids = governedLearningAdmissionIds(input.tenantId, input.event.eventId);
  const original = createGovernedLearningEvent(input.event);
  const resolved = snapshotAdmissionAuthority(authority.resolve({
    tenantId: input.tenantId,
    product: original.event.product,
    sourceObjectType: input.sourceObjectType,
    sourceObjectId: input.sourceObjectId,
    eventId: original.event.eventId,
    eventDigest: original.digest,
  }));
  assertAdmissionBindings(input, original.event, ids, resolved);

  const redaction = authority.redact(canonicalJson(original.event));
  if (!redaction.ok) throw new Error("learning_admission_redaction_failed");
  if (
    typeof redaction.content !== "string"
    || Buffer.byteLength(redaction.content, "utf8") > 128 * 1024
    || !Number.isSafeInteger(redaction.redactionCount)
    || redaction.redactionCount < 0
  ) throw new Error("learning_admission_redaction_invalid");
  let redactedValue: unknown;
  try { redactedValue = JSON.parse(redaction.content); } catch {
    throw new Error("learning_admission_redaction_invalid");
  }
  const governed = createGovernedLearningEvent(redactedValue);
  assertAdmissionBindings(input, governed.event, ids, resolved);
  const lesson = extractGovernedLesson(governed);
  const document = canonicalJson({
    schemaVersion: 1,
    kind: "governed_learning_lesson",
    event: governed.event,
    eventDigest: governed.digest,
    lesson,
  });
  const sourceDocument = canonicalJson({
    schemaVersion: 1,
    kind: "governed_learning_source",
    product: governed.event.product,
    repositoryId: governed.event.repositoryId,
    revision: resolved.revision,
    snapshotDigest: resolved.snapshotDigest,
    snapshotArtifactId: ids.sourceArtifactId,
    scenarioId: resolved.scenarioId,
    syntheticFamilyId: resolved.syntheticFamilyId,
    sourceClass: resolved.sourceClass,
    provenanceQualifiers: resolved.provenanceQualifiers,
  });
  const verificationDocument = canonicalJson({
    schemaVersion: 1,
    kind: "governed_learning_verification",
    sourceId: input.sourceObjectId,
    outcomeAttribution: resolved.outcomeAttribution,
    verificationVerdict: resolved.verificationVerdict,
    sourceClass: resolved.sourceClass,
    provenanceQualifiers: resolved.provenanceQualifiers,
    correctionSubstantive: resolved.correctionSubstantive,
  });
  const contaminationDocument = canonicalJson({
    schemaVersion: 1,
    kind: "governed_learning_contamination_check",
    eventId: governed.event.eventId,
    contaminationFree: resolved.contaminationFree,
  });

  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  else db.raw.exec(`SAVEPOINT ${ADMISSION_SAVEPOINT}`);
  try {
    const consent = findActiveLearningConsent(db, {
      tenantId: input.tenantId,
      purpose: input.purpose,
      at: input.createdAt,
    });
    if (
      !consent
      || consent.id !== governed.event.governance.consentId
      || consent.residency_region !== governed.event.governance.residencyRegion
    ) throw new Error("learning_admission_active_consent_required");

    persistAdmissionArtifact(db, ids.sourceArtifactId, input, "learning-source", sourceDocument);
    persistAdmissionArtifact(db, ids.redactedArtifactId, input, "learning-redacted", document);
    persistAdmissionArtifact(db, ids.verificationArtifactId, input, "verification", verificationDocument);
    persistAdmissionArtifact(db, ids.contaminationArtifactId, input, "contamination", contaminationDocument);
    const subjectType = governed.event.product === "fettler" ? "fettler_outcome" : "regauge_outcome";
    insertEvidenceRecord(db, {
      id: ids.redactionEvidenceId,
      tenantId: input.tenantId,
      subjectType,
      subjectId: input.sourceObjectId,
      artifactId: ids.redactedArtifactId,
      inputArtifactId: ids.sourceArtifactId,
      producerPrincipalId: input.actorPrincipalId,
      tool: "learning-redaction",
      toolVersion: "1",
      verdict: "passed",
      createdAt: input.createdAt,
    });
    insertEvidenceRecord(db, {
      id: ids.verificationEvidenceId,
      tenantId: input.tenantId,
      subjectType,
      subjectId: input.sourceObjectId,
      artifactId: ids.verificationArtifactId,
      inputArtifactId: ids.redactedArtifactId,
      producerPrincipalId: input.actorPrincipalId,
      tool: "learning-verification",
      toolVersion: "1",
      verdict: "passed",
      createdAt: input.createdAt,
    });
    insertEvidenceRecord(db, {
      id: ids.contaminationEvidenceId,
      tenantId: input.tenantId,
      subjectType,
      subjectId: input.sourceObjectId,
      artifactId: ids.contaminationArtifactId,
      inputArtifactId: ids.redactedArtifactId,
      producerPrincipalId: input.actorPrincipalId,
      tool: "learning-contamination",
      toolVersion: "1",
      verdict: "passed",
      createdAt: input.createdAt,
    });
    persistAdmissionReview(db, input, ids, subjectType, resolved);
    const record = admitLearningRecord(db, {
      id: ids.learningRecordId,
      tenantId: input.tenantId,
      consentId: governed.event.governance.consentId!,
      sourceObjectType: input.sourceObjectType,
      sourceObjectId: input.sourceObjectId,
      sourceArtifactId: ids.sourceArtifactId,
      redactedArtifactId: ids.redactedArtifactId,
      redactionEvidenceId: ids.redactionEvidenceId,
      verificationEvidenceId: ids.verificationEvidenceId,
      acceptedReviewId: ids.reviewDecisionId,
      contaminationEvidenceId: ids.contaminationEvidenceId,
      observedAt: governed.event.createdAt,
      admittedByPrincipalId: input.actorPrincipalId,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    });
    if (record.id !== ids.learningRecordId || record.content_sha256 !== sha256(document)) {
      throw new Error("learning_admission_record_mismatch");
    }
    const result = deepFreeze({
      eventId: governed.event.eventId,
      eventDigest: governed.digest,
      learningRecordId: record.id,
      lesson,
    });
    if (ownsTransaction) db.raw.exec("COMMIT");
    else db.raw.exec(`RELEASE ${ADMISSION_SAVEPOINT}`);
    return result;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    else if (db.raw.isTransaction) {
      db.raw.exec(`ROLLBACK TO ${ADMISSION_SAVEPOINT}`);
      db.raw.exec(`RELEASE ${ADMISSION_SAVEPOINT}`);
    }
    throw error;
  }
}

export function materializeGovernedLearningCorpus(
  db: AppDb,
  input: MaterializeGovernedLearningCorpusInput,
): MaterializedGovernedLearningCorpus {
  validateInput(input);
  const ownsTransaction = !db.raw.isTransaction;
  if (ownsTransaction) db.raw.exec("BEGIN IMMEDIATE");
  else db.raw.exec(`SAVEPOINT ${AMBIENT_SAVEPOINT}`);
  try {
    const consent = findActiveLearningConsent(db, {
      tenantId: input.tenantId,
      purpose: input.purpose,
      at: input.createdAt,
    });
    if (!consent) throw new Error("learning_corpus_active_consent_required");

    const datasetId = `learning_dataset_${sha256([
      input.tenantId,
      input.purpose,
      consent.residency_region,
      input.idempotencyKey,
    ].join("\0"))}`;
    const existing = db.raw.prepare(
      "SELECT version FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?",
    ).get(datasetId, input.tenantId) as { version: number } | undefined;
    const latest = getLatestLearningDatasetVersion(db, {
      tenantId: input.tenantId,
      purpose: input.purpose,
      residencyRegion: consent.residency_region,
    });
    const dataset = createLearningDatasetVersion(db, {
      id: datasetId,
      tenantId: input.tenantId,
      purpose: input.purpose,
      residencyRegion: consent.residency_region,
      version: existing?.version ?? (latest?.version ?? 0) + 1,
      temporalCutoffAt: input.temporalCutoffAt,
      createdByPrincipalId: input.actorPrincipalId,
      idempotencyKey: `learning-corpus:${input.idempotencyKey}:dataset`,
      createdAt: input.createdAt,
    });

    if (dataset.status === "draft") {
      const seenEventDigests = new Map<string, string>();
      const seenContent = new Set<string>();
      const records = listAdmittableLearningRecords(db, {
        tenantId: input.tenantId,
        purpose: input.purpose,
        residencyRegion: consent.residency_region,
        before: input.temporalCutoffAt,
      });
      for (const record of records) {
        if (seenContent.has(record.content_sha256)) continue;
        const document = readEligibleDocument(db, record, input, consent.id, consent.residency_region);
        if (!document) continue;
        const priorDigest = seenEventDigests.get(document.event.eventId);
        if (priorDigest && priorDigest !== document.eventDigest) {
          throw new Error("learning_corpus_event_identity_conflict");
        }
        seenEventDigests.set(document.event.eventId, document.eventDigest);
        seenContent.add(record.content_sha256);
        addLearningDatasetMember(db, {
          tenantId: input.tenantId,
          datasetVersionId: dataset.id,
          learningRecordId: record.id,
          idempotencyKey: `learning-corpus:${input.idempotencyKey}:member:${record.id}`,
          createdAt: input.createdAt,
        });
      }
      sealLearningDatasetVersion(db, {
        tenantId: input.tenantId,
        datasetVersionId: dataset.id,
        sealedByPrincipalId: input.actorPrincipalId,
        sealedAt: input.createdAt,
      });
    }

    const sealed = db.raw.prepare(
      "SELECT id, version, dataset_sha256 FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?",
    ).get(dataset.id, input.tenantId) as { id: string; version: number; dataset_sha256: string };
    const members = listEligibleLearningDatasetMembers(db, {
      tenantId: input.tenantId,
      datasetVersionId: dataset.id,
      at: input.createdAt,
    });
    const examples: CorpusExample[] = [];
    const memberAuthority: Array<{
      consentId: string; contentSha256: string; learningRecordId: string; memberId: string;
    }> = [];
    for (const member of members) {
      const record = getLearningRecord(db, input.tenantId, member.learning_record_id);
      if (!record) throw new Error("learning_corpus_record_missing");
      const document = readEligibleDocument(db, record, input, consent.id, consent.residency_region);
      if (!document) throw new Error("learning_corpus_member_invalid");
      examples.push(toExample(document, record));
      memberAuthority.push({
        consentId: record.consent_id,
        contentSha256: member.content_sha256,
        learningRecordId: record.id,
        memberId: member.id,
      });
    }
    examples.sort((left, right) => codeUnitCompare(left.sourceEventId, right.sourceEventId));
    memberAuthority.sort((left, right) =>
      codeUnitCompare(left.contentSha256, right.contentSha256)
      || codeUnitCompare(left.memberId, right.memberId));

    const memberEligibilityDigest = sha256(canonicalJson(memberAuthority));
    const consentIds = Object.freeze([...new Set(examples.map((example) => example.provenance.consentId))]
      .sort(codeUnitCompare));

    const train = examples.filter((example) => example.datasetSplit === "train");
    const validation = examples.filter((example) => example.datasetSplit === "validation");
    const holdout = examples.filter((example) => example.datasetSplit === "holdout");
    if (train.length === 0) throw new Error("learning_corpus_training_empty");

    const splitManifestDigest = sha256(canonicalJson({
      policy: SPLIT_POLICY,
      assignments: examples.map(({ sourceEventId, sourceEventDigest, specialization, datasetSplit }) => ({
        sourceEventId,
        sourceEventDigest,
        splitGroupId: specialization.splitGroupId,
        datasetSplit,
      })),
    }));

    const externalProcessingAllowed = examples.length > 0
      && examples.every((example) => example.provenance.mayLeaveTenantBoundary);
    const trainArtifact = persistSplitArtifact(db, input, sealed, consent.residency_region, "train", train, splitManifestDigest, externalProcessingAllowed, memberEligibilityDigest, consentIds);
    const validationArtifact = persistSplitArtifact(db, input, sealed, consent.residency_region, "validation", validation, splitManifestDigest, externalProcessingAllowed, memberEligibilityDigest, consentIds);
    const holdoutArtifact = persistSplitArtifact(db, input, sealed, consent.residency_region, "holdout", holdout, splitManifestDigest, externalProcessingAllowed, memberEligibilityDigest, consentIds);
    const result = deepFreeze({
      tenantId: input.tenantId,
      purpose: input.purpose,
      residencyRegion: consent.residency_region,
      datasetVersionId: dataset.id,
      datasetVersion: sealed.version,
      memberCount: countLearningDatasetMembers(db, { tenantId: input.tenantId, datasetVersionId: dataset.id }),
      exampleCount: examples.length,
      trainExampleCount: train.length,
      validationExampleCount: validation.length,
      holdoutExampleCount: holdout.length,
      artifactId: trainArtifact.id,
      artifactSha256: trainArtifact.sha256,
      validationArtifactId: validationArtifact.id,
      validationArtifactSha256: validationArtifact.sha256,
      holdoutArtifactId: holdoutArtifact.id,
      holdoutArtifactSha256: holdoutArtifact.sha256,
      splitManifestDigest,
    });
    if (ownsTransaction) db.raw.exec("COMMIT");
    else db.raw.exec(`RELEASE ${AMBIENT_SAVEPOINT}`);
    return result;
  } catch (error) {
    if (ownsTransaction && db.raw.isTransaction) db.raw.exec("ROLLBACK");
    else if (db.raw.isTransaction) {
      db.raw.exec(`ROLLBACK TO ${AMBIENT_SAVEPOINT}`);
      db.raw.exec(`RELEASE ${AMBIENT_SAVEPOINT}`);
    }
    throw error;
  }
}

function readEligibleDocument(
  db: AppDb,
  record: LearningRecordRow,
  input: MaterializeGovernedLearningCorpusInput,
  consentId: string,
  residencyRegion: string,
): StoredLearningDocument | undefined {
  const artifact = db.raw.prepare(
    `SELECT a.content_text AS content, a.sha256 AS artifact_sha256
     FROM learning_records r
     JOIN artifact_manifests a
       ON a.id = r.redacted_artifact_id AND a.tenant_id = r.tenant_id
     WHERE r.id = ? AND r.tenant_id = ?`,
  ).get(record.id, input.tenantId) as { content: string | null; artifact_sha256: string } | undefined;
  if (!artifact || artifact.content === null) return undefined;
  const content = artifact.content;
  const contentDigest = sha256(content);
  if (contentDigest !== artifact.artifact_sha256 || contentDigest !== record.content_sha256) {
    throw new Error("learning_corpus_content_integrity_mismatch");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => !DOCUMENT_KEYS.has(key)) || DOCUMENT_KEYS.size !== Object.keys(value).length) {
    return undefined;
  }
  if (value.schemaVersion !== 1 || value.kind !== "governed_learning_lesson") return undefined;
  const governed = createGovernedLearningEvent(value.event);
  if (value.eventDigest !== governed.digest) throw new Error("learning_corpus_event_digest_mismatch");
  const lesson = extractGovernedLesson(governed);
  if (canonicalJson(value.lesson) !== canonicalJson(lesson)) {
    throw new Error("learning_corpus_lesson_digest_mismatch");
  }
  if (!lesson.eligibleForModelTraining || !lesson.destinations.some(({ destination }) => destination === "model_weight")) {
    return undefined;
  }
  if (
    governed.event.governance.tenantId !== input.tenantId
    || governed.event.governance.residencyRegion !== residencyRegion
    || governed.event.governance.consentId !== consentId
    || record.consent_id !== consentId
  ) {
    throw new Error("learning_corpus_governance_mismatch");
  }
  if (governed.event.createdAt !== record.observed_at) {
    throw new Error("learning_corpus_observation_time_mismatch");
  }
  if (governed.event.missionId !== record.source_object_id) {
    throw new Error("learning_corpus_mission_binding_mismatch");
  }
  const sourceAuthority = assertEventAuthority(db, governed.event, record);
  return deepFreeze({ schemaVersion: 1, kind: "governed_learning_lesson", event: governed.event, eventDigest: governed.digest, lesson, sourceAuthority });
}

function assertEventAuthority(db: AppDb, event: GovernedLearningEventV1, record: LearningRecordRow): GovernedLearningSourceAuthority {
  if (event.references.inputArtifactId !== record.source_artifact_id) {
    throw new Error("learning_corpus_input_binding_mismatch");
  }
  if (
    event.references.proposedActionArtifactId !== record.redacted_artifact_id
    || event.correction?.artifactId !== record.redacted_artifact_id
  ) {
    throw new Error("learning_corpus_artifact_binding_mismatch");
  }
  const productForSource = record.source_object_type === "fettler_agent_run"
    ? "fettler"
    : record.source_object_type === "transformer_adaptive_candidate"
      ? "regauge"
      : null;
  if (productForSource !== event.product) throw new Error("learning_corpus_product_binding_mismatch");
  const sourceArtifact = db.raw.prepare(
    `SELECT kind, sha256, size_bytes, content_text FROM artifact_manifests
     WHERE id = ? AND tenant_id = ?`,
  ).get(record.source_artifact_id, event.governance.tenantId) as {
    kind: string; sha256: string; size_bytes: number; content_text: string | null;
  } | undefined;
  if (
    !sourceArtifact?.content_text
    || sourceArtifact.kind !== "learning-source"
    || sha256(sourceArtifact.content_text) !== sourceArtifact.sha256
    || Buffer.byteLength(sourceArtifact.content_text, "utf8") !== sourceArtifact.size_bytes
  ) throw new Error("learning_corpus_source_binding_mismatch");
  let source: unknown;
  try { source = JSON.parse(sourceArtifact.content_text); } catch {
    throw new Error("learning_corpus_source_binding_mismatch");
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("learning_corpus_source_binding_mismatch");
  }
  const sourceValue = source as Record<string, unknown>;
  if (
    sourceValue.schemaVersion !== 1
    || sourceValue.kind !== "governed_learning_source"
    || sourceValue.product !== event.product
    || sourceValue.repositoryId !== event.repositoryId
    || typeof sourceValue.revision !== "string"
    || !/^[a-f0-9]{40,64}$/u.test(sourceValue.revision)
    || typeof sourceValue.snapshotDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(sourceValue.snapshotDigest)
    || sourceValue.snapshotArtifactId !== record.source_artifact_id
    || !(sourceValue.scenarioId === null || typeof sourceValue.scenarioId === "string")
    || !(sourceValue.syntheticFamilyId === null || typeof sourceValue.syntheticFamilyId === "string")
    || sourceValue.sourceClass !== event.governance.sourceClass
    || canonicalJson(sourceValue.provenanceQualifiers) !== canonicalJson(event.governance.provenanceQualifiers)
  ) throw new Error("learning_corpus_source_binding_mismatch");
  const expectedSplitGroup = event.governance.sourceClass === "synthetic_ground_truth"
    ? `${sourceValue.syntheticFamilyId}:${event.specialization.migrationFamily}`
    : `${event.repositoryId}:${event.specialization.migrationFamily}`;
  if (
    event.specialization.splitGroupId !== expectedSplitGroup
    || (event.governance.sourceClass === "synthetic_ground_truth" && !sourceValue.syntheticFamilyId)
  ) throw new Error("learning_corpus_source_binding_mismatch");
  const expectedSubjectType = event.product === "fettler" ? "fettler_outcome" : "regauge_outcome";
  const artifactRefs = [
    event.references.inputArtifactId,
    event.references.graphContextArtifactId,
    event.references.proposedActionArtifactId,
    event.correction?.artifactId ?? null,
  ].filter((value): value is string => value !== null);
  for (const artifactId of artifactRefs) {
    const artifact = db.raw.prepare(
      "SELECT id FROM artifact_manifests WHERE id = ? AND tenant_id = ?",
    ).get(artifactId, event.governance.tenantId);
    if (!artifact) throw new Error("learning_corpus_artifact_binding_mismatch");
  }

  const evidenceRefs = [
    ...event.prediction.evidenceRefs,
    ...event.observedOutcome.evidenceRefs,
    ...event.verification.evidenceRefs,
  ];
  if (!event.verification.evidenceRefs.includes(record.verification_evidence_id)) {
    throw new Error("learning_corpus_verification_binding_mismatch");
  }
  for (const evidenceId of evidenceRefs) {
    const evidence = db.raw.prepare(
      `SELECT id FROM evidence_records
       WHERE id = ? AND tenant_id = ? AND subject_type = ? AND subject_id = ? AND verdict = 'passed'`,
    ).get(evidenceId, event.governance.tenantId, expectedSubjectType, record.source_object_id);
    if (!evidence) throw new Error("learning_corpus_evidence_binding_mismatch");
  }

  const redaction = db.raw.prepare(
    `SELECT artifact_id, input_artifact_id, tool FROM evidence_records
     WHERE id = ? AND tenant_id = ?`,
  ).get(record.redaction_evidence_id, event.governance.tenantId) as {
    artifact_id: string; input_artifact_id: string | null; tool: string;
  } | undefined;
  if (
    !redaction
    || redaction.artifact_id !== record.redacted_artifact_id
    || redaction.input_artifact_id !== record.source_artifact_id
    || redaction.tool !== "learning-redaction"
  ) throw new Error("learning_corpus_evidence_binding_mismatch");

  const verification = db.raw.prepare(
    `SELECT e.artifact_id, e.input_artifact_id, e.tool, a.kind AS artifact_kind, a.content_text AS artifact_content
     FROM evidence_records e
     JOIN artifact_manifests a ON a.id = e.artifact_id AND a.tenant_id = e.tenant_id
     WHERE e.id = ? AND e.tenant_id = ?`,
  ).get(record.verification_evidence_id, event.governance.tenantId) as {
    artifact_id: string; input_artifact_id: string | null; tool: string; artifact_kind: string; artifact_content: string | null;
  } | undefined;
  if (
    !verification
    || verification.input_artifact_id !== record.redacted_artifact_id
    || verification.tool !== "learning-verification"
    || verification.artifact_kind !== "verification"
  ) throw new Error("learning_corpus_evidence_binding_mismatch");
  let verificationAuthority: unknown;
  try { verificationAuthority = JSON.parse(verification.artifact_content ?? ""); } catch { throw new Error("learning_corpus_verification_authority_mismatch"); }
  const typed = verificationAuthority && typeof verificationAuthority === "object" && !Array.isArray(verificationAuthority) ? verificationAuthority as Record<string, unknown> : undefined;
  if (
    typed?.schemaVersion !== 1
    || typed.kind !== "governed_learning_verification"
    || typed.outcomeAttribution !== event.observedOutcome.attribution
    || typed.verificationVerdict !== event.verification.verdict
    || typed.sourceClass !== event.governance.sourceClass
    || canonicalJson(typed.provenanceQualifiers) !== canonicalJson(event.governance.provenanceQualifiers)
    || typed.correctionSubstantive !== (event.correction?.substantive ?? false)
  ) throw new Error("learning_corpus_verification_authority_mismatch");

  const contamination = db.raw.prepare(
    `SELECT input_artifact_id, tool FROM evidence_records
     WHERE id = ? AND tenant_id = ?`,
  ).get(record.contamination_evidence_id, event.governance.tenantId) as {
    input_artifact_id: string | null; tool: string;
  } | undefined;
  if (
    !contamination
    || contamination.input_artifact_id !== record.redacted_artifact_id
    || contamination.tool !== "learning-contamination"
  ) throw new Error("learning_corpus_evidence_binding_mismatch");

  if (!event.reviewerDecision?.evidenceRefs.includes(record.accepted_review_id)) {
    throw new Error("learning_corpus_review_binding_mismatch");
  }
  for (const reviewId of event.reviewerDecision.evidenceRefs) {
    const review = db.raw.prepare(
      `SELECT id FROM review_decisions
       WHERE id = ? AND tenant_id = ? AND subject_type = ? AND subject_id = ?
         AND candidate_artifact_id = ? AND decision = 'approve'`,
    ).get(
      reviewId,
      event.governance.tenantId,
      expectedSubjectType,
      record.source_object_id,
      record.redacted_artifact_id,
    );
    if (!review) throw new Error("learning_corpus_review_binding_mismatch");
  }
  return deepFreeze(sourceValue as GovernedLearningSourceAuthority);
}

function toExample(document: StoredLearningDocument, record: LearningRecordRow): CorpusExample {
  const event = document.event;
  return deepFreeze({
    schemaVersion: 1 as const,
    sourceEventId: event.eventId,
    sourceEventDigest: document.eventDigest,
    sourceClass: event.governance.sourceClass,
    provenanceQualifiers: event.governance.provenanceQualifiers,
    product: event.product,
    capability: event.capability,
    taskType: event.taskType,
    specialization: event.specialization,
    datasetSplit: governedLearningSplit(event.specialization.splitGroupId),
    task: {
      missionId: event.missionId,
      repositoryId: event.repositoryId,
      graphContextArtifactId: event.references.graphContextArtifactId,
      inputArtifactId: event.references.inputArtifactId,
      sourceRevision: document.sourceAuthority.revision,
      sourceDigest: document.sourceAuthority.snapshotDigest,
      scenarioId: document.sourceAuthority.scenarioId,
      syntheticFamilyId: document.sourceAuthority.syntheticFamilyId,
    },
    originalOutput: event.prediction,
    verifiedOutcome: event.observedOutcome,
    correction: event.correction,
    verification: event.verification,
    reviewerDecision: event.reviewerDecision,
    routerContext: event.execution,
    confidence: event.confidence,
    economics: event.economics,
    provenance: {
      tenantId: event.governance.tenantId,
      residencyRegion: event.governance.residencyRegion,
      consentId: event.governance.consentId!,
      learningRecordId: record.id,
      sourceObjectType: record.source_object_type,
      observedAt: record.observed_at,
      mayLeaveTenantBoundary: event.governance.mayLeaveTenantBoundary,
    },
  });
}

export function governedLearningSplit(splitGroupId: string): DatasetSplit {
  if (typeof splitGroupId !== "string" || !splitGroupId.trim()) {
    throw new Error("learning_corpus_split_group_invalid");
  }
  const digest = sha256(splitGroupId);
  const bucket = Number.parseInt(digest.slice(0, 8), 16) % 100;
  return bucket < 80 ? "train" : bucket < 90 ? "validation" : "holdout";
}

export function authorizeGovernedLearningCorpus(
  db: AppDb,
  input: GovernedLearningCorpusAuthorizationInput,
): boolean {
  try {
    if (
      !input.trainingArtifactIds.length
      || new Set(input.trainingArtifactIds).size !== input.trainingArtifactIds.length
      || new Set([...input.trainingArtifactIds, input.validationArtifactId, input.holdoutArtifactId]).size
        !== input.trainingArtifactIds.length + 2
      || !/^[a-f0-9]{64}$/u.test(input.splitManifestDigest)
      || new Date(input.at).toISOString() !== input.at
    ) return false;
    const dataset = db.raw.prepare(
      `SELECT status, purpose, residency_region, dataset_sha256
       FROM learning_dataset_versions WHERE id = ? AND tenant_id = ?`,
    ).get(input.datasetVersionId, input.tenantId) as {
      status: string; purpose: string; residency_region: string; dataset_sha256: string | null;
    } | undefined;
    if (
      !dataset
      || dataset.status !== "sealed"
      || dataset.purpose !== input.purpose
      || dataset.residency_region !== input.residencyRegion
      || !dataset.dataset_sha256
    ) return false;

    const artifacts = [
      ...input.trainingArtifactIds.map((artifactId) => readAuthorizedCorpusArtifact(db, input, artifactId, "train", "learning_dataset_corpus")),
      readAuthorizedCorpusArtifact(db, input, input.validationArtifactId, "validation", "learning_dataset_validation"),
      readAuthorizedCorpusArtifact(db, input, input.holdoutArtifactId, "holdout", "learning_dataset_holdout"),
    ];
    if (artifacts.some((artifact) => !artifact)) return false;
    const resolved = artifacts as AuthorizedCorpusArtifact[];
    if (resolved.some((artifact) => artifact.examples.length === 0)) return false;
    if (input.processingBoundary === "external" && resolved.some((artifact) => !artifact.externalProcessingAllowed)) {
      return false;
    }

    const examples = resolved.flatMap((artifact) => artifact.examples);
    const eventIds = new Set<string>();
    const groups = new Map<string, DatasetSplit>();
    for (const example of examples) {
      if (eventIds.has(example.sourceEventId)) return false;
      eventIds.add(example.sourceEventId);
      const prior = groups.get(example.splitGroupId);
      if (prior && prior !== example.datasetSplit) return false;
      groups.set(example.splitGroupId, example.datasetSplit);
      if (governedLearningSplit(example.splitGroupId) !== example.datasetSplit) return false;
    }
    const manifestDigest = sha256(canonicalJson({
      policy: SPLIT_POLICY,
      assignments: [...examples].sort((left, right) => codeUnitCompare(left.sourceEventId, right.sourceEventId))
        .map(({ sourceEventId, sourceEventDigest, splitGroupId, datasetSplit }) => ({
          sourceEventId, sourceEventDigest, splitGroupId, datasetSplit,
        })),
    }));
    if (manifestDigest !== input.splitManifestDigest) return false;

    const members = db.raw.prepare(
      `SELECT m.id, m.content_sha256, m.learning_record_id, r.consent_id
       FROM learning_dataset_members m
       JOIN learning_records r ON r.id = m.learning_record_id AND r.tenant_id = m.tenant_id
       WHERE m.tenant_id = ? AND m.dataset_version_id = ?
       ORDER BY m.content_sha256, m.id`,
    ).all(input.tenantId, input.datasetVersionId) as Array<{
      id: string; content_sha256: string; learning_record_id: string; consent_id: string;
    }>;
    const eligible = listEligibleLearningDatasetMembers(db, {
      tenantId: input.tenantId,
      datasetVersionId: input.datasetVersionId,
      at: input.at,
    });
    if (eligible.length !== members.length) return false;
    const memberDigest = sha256(canonicalJson(members.map((member) => ({
      consentId: member.consent_id,
      contentSha256: member.content_sha256,
      learningRecordId: member.learning_record_id,
      memberId: member.id,
    }))));
    const consentIds = [...new Set(members.map((member) => member.consent_id))].sort(codeUnitCompare);
    return resolved.every((artifact) =>
      artifact.memberEligibilityDigest === memberDigest
      && canonicalJson(artifact.consentIds) === canonicalJson(consentIds)
      && artifact.datasetSha256 === dataset.dataset_sha256);
  } catch {
    return false;
  }
}

type AuthorizedCorpusArtifact = Readonly<{
  datasetSha256: string;
  externalProcessingAllowed: boolean;
  memberEligibilityDigest: string;
  consentIds: readonly string[];
  examples: readonly Readonly<{
    sourceEventId: string;
    sourceEventDigest: string;
    splitGroupId: string;
    datasetSplit: DatasetSplit;
  }>[];
}>;

function readAuthorizedCorpusArtifact(
  db: AppDb,
  input: GovernedLearningCorpusAuthorizationInput,
  artifactId: string,
  split: DatasetSplit,
  kind: string,
): AuthorizedCorpusArtifact | undefined {
  const row = db.raw.prepare(
    `SELECT kind, sha256, size_bytes, content_text FROM artifact_manifests
     WHERE id = ? AND tenant_id = ?`,
  ).get(artifactId, input.tenantId) as {
    kind: string; sha256: string; size_bytes: number; content_text: string | null;
  } | undefined;
  if (
    !row?.content_text
    || row.kind !== kind
    || Buffer.byteLength(row.content_text, "utf8") !== row.size_bytes
    || sha256(row.content_text) !== row.sha256
  ) return undefined;
  const parsed = JSON.parse(row.content_text) as Record<string, unknown>;
  if (
    parsed.schemaVersion !== 1
    || parsed.kind !== "governed_learning_corpus"
    || parsed.tenantId !== input.tenantId
    || parsed.purpose !== input.purpose
    || parsed.residencyRegion !== input.residencyRegion
    || parsed.datasetVersionId !== input.datasetVersionId
    || parsed.datasetSplit !== split
    || parsed.splitManifestDigest !== input.splitManifestDigest
    || typeof parsed.datasetSha256 !== "string"
    || typeof parsed.externalProcessingAllowed !== "boolean"
    || typeof parsed.memberEligibilityDigest !== "string"
    || !Array.isArray(parsed.consentIds)
    || !Array.isArray(parsed.examples)
  ) return undefined;
  const examples: AuthorizedCorpusArtifact["examples"] = [];
  for (const value of parsed.examples) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const example = value as Record<string, unknown>;
    const specialization = example.specialization as Record<string, unknown> | undefined;
    if (
      typeof example.sourceEventId !== "string"
      || typeof example.sourceEventDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(example.sourceEventDigest)
      || example.datasetSplit !== split
      || !specialization
      || typeof specialization.splitGroupId !== "string"
    ) return undefined;
    (examples as Array<AuthorizedCorpusArtifact["examples"][number]>).push({
      sourceEventId: example.sourceEventId,
      sourceEventDigest: example.sourceEventDigest,
      splitGroupId: specialization.splitGroupId,
      datasetSplit: split,
    });
  }
  const consentIds = parsed.consentIds;
  if (consentIds.some((value) => typeof value !== "string") || new Set(consentIds).size !== consentIds.length) {
    return undefined;
  }
  return deepFreeze({
    datasetSha256: parsed.datasetSha256,
    externalProcessingAllowed: parsed.externalProcessingAllowed,
    memberEligibilityDigest: parsed.memberEligibilityDigest,
    consentIds: [...consentIds].sort(codeUnitCompare) as string[],
    examples,
  });
}

function persistSplitArtifact(
  db: AppDb,
  input: MaterializeGovernedLearningCorpusInput,
  dataset: { id: string; version: number; dataset_sha256: string },
  residencyRegion: string,
  split: DatasetSplit,
  examples: readonly CorpusExample[],
  splitManifestDigest: string,
  externalProcessingAllowed: boolean,
  memberEligibilityDigest: string,
  consentIds: readonly string[],
): { id: string; sha256: string } {
  const content = canonicalJson({
    schemaVersion: 1,
    kind: "governed_learning_corpus",
    tenantId: input.tenantId,
    purpose: input.purpose,
    residencyRegion,
    datasetVersionId: dataset.id,
    datasetVersion: dataset.version,
    datasetSha256: dataset.dataset_sha256,
    datasetSplit: split,
    splitPolicy: SPLIT_POLICY,
    splitManifestDigest,
    externalProcessingAllowed,
    memberEligibilityDigest,
    consentIds,
    examples,
  });
  const digest = sha256(content);
  const kind = split === "train" ? "learning_dataset_corpus" : split === "validation" ? "learning_dataset_validation" : "learning_dataset_holdout";
  const prefix = split === "train" ? "learning_corpus" : `learning_${split}`;
  const id = `${prefix}_${sha256(`${dataset.id}\0${split}\0${digest}`)}`;
  const artifact = insertArtifactManifest(db, {
    id,
    tenantId: input.tenantId,
    kind,
    schemaVersion: 1,
    sha256: digest,
    mediaType: "application/vnd.mendpoint.governed-learning-corpus+json",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${id}#content_text`,
    content,
    producerPrincipalId: input.actorPrincipalId,
    createdAt: input.createdAt,
  }).row;
  if (examples.length > 0) {
    insertEvidenceRecord(db, {
      id: `evidence_${sha256(`${id}\0${dataset.id}`)}`,
      tenantId: input.tenantId,
      subjectType: "learning_dataset_version",
      subjectId: dataset.id,
      artifactId: artifact.id,
      producerPrincipalId: input.actorPrincipalId,
      tool: "governed-learning-corpus",
      toolVersion: "1",
      verdict: "passed",
      createdAt: input.createdAt,
    });
  }
  return { id: artifact.id, sha256: artifact.sha256 };
}

type ResolvedAdmissionAuthority = ReturnType<typeof snapshotAdmissionAuthority>;

function snapshotAdmissionAuthority(value: ReturnType<GovernedLearningOutcomeAuthority["resolve"]>) {
  const qualifiers = [...value.provenanceQualifiers].sort(codeUnitCompare);
  const result = {
    revision: value.revision,
    snapshotDigest: value.snapshotDigest,
    scenarioId: value.scenarioId,
    syntheticFamilyId: value.syntheticFamilyId,
    outcomeAttribution: value.outcomeAttribution,
    verificationVerdict: value.verificationVerdict,
    sourceClass: value.sourceClass,
    provenanceQualifiers: qualifiers,
    correctionSubstantive: value.correctionSubstantive,
    reviewerPrincipalId: value.reviewerPrincipalId,
    reviewRationale: value.reviewRationale,
    contaminationFree: value.contaminationFree,
  } as const;
  if (
    !/^[a-f0-9]{40,64}$/u.test(result.revision)
    || !/^sha256:[a-f0-9]{64}$/u.test(result.snapshotDigest)
    || !(result.scenarioId === null || isBoundedText(result.scenarioId))
    || !(result.syntheticFamilyId === null || isBoundedText(result.syntheticFamilyId))
    || !isBoundedText(result.reviewerPrincipalId)
    || !isBoundedText(result.reviewRationale)
    || typeof result.correctionSubstantive !== "boolean"
    || result.contaminationFree !== true
    || new Set(result.provenanceQualifiers).size !== result.provenanceQualifiers.length
  ) throw new Error("learning_admission_authority_invalid");
  return deepFreeze(result);
}

function assertAdmissionBindings(
  input: GovernedLearningAdmissionInput,
  event: GovernedLearningEventV1,
  ids: GovernedLearningAdmissionIds,
  authority: ResolvedAdmissionAuthority,
): void {
  const expectedProduct = input.sourceObjectType === "fettler_agent_run" ? "fettler" : "regauge";
  const expectedSplitGroup = authority.sourceClass === "synthetic_ground_truth"
    ? `${authority.syntheticFamilyId}:${event.specialization.migrationFamily}`
    : `${event.repositoryId}:${event.specialization.migrationFamily}`;
  const bindings: ReadonlyArray<readonly [string, boolean]> = [
    ["tenant", event.governance.tenantId === input.tenantId],
    ["product", event.product === expectedProduct],
    ["mission", event.missionId === input.sourceObjectId],
    ["source_artifact", event.references.inputArtifactId === ids.sourceArtifactId],
    ["redacted_artifact", event.references.proposedActionArtifactId === ids.redactedArtifactId],
    ["correction_artifact", event.correction?.artifactId === ids.redactedArtifactId],
    ["redaction_evidence", event.prediction.evidenceRefs.includes(ids.redactionEvidenceId)],
    ["outcome_evidence", event.observedOutcome.evidenceRefs.includes(ids.verificationEvidenceId)],
    ["verification_evidence", event.verification.evidenceRefs.includes(ids.verificationEvidenceId)],
    ["review_evidence", event.reviewerDecision?.evidenceRefs.includes(ids.reviewDecisionId) === true],
    ["review_decision", event.reviewerDecision !== null && ["accepted", "modified", "merged"].includes(event.reviewerDecision.decision)],
    ["attribution", event.observedOutcome.attribution === authority.outcomeAttribution],
    ["verification_verdict", event.verification.verdict === authority.verificationVerdict],
    ["source_class", event.governance.sourceClass === authority.sourceClass],
    ["provenance", canonicalJson(event.governance.provenanceQualifiers) === canonicalJson(authority.provenanceQualifiers)],
    ["correction", (event.correction?.substantive ?? false) === authority.correctionSubstantive],
    ["split_group", event.specialization.splitGroupId === expectedSplitGroup],
    ["synthetic_family", authority.sourceClass !== "synthetic_ground_truth" || Boolean(authority.syntheticFamilyId)],
  ];
  const mismatch = bindings.find(([, matches]) => !matches);
  if (mismatch) throw new Error(`learning_admission_authority_mismatch:${mismatch[0]}`);
}

function persistAdmissionArtifact(
  db: AppDb,
  id: string,
  input: GovernedLearningAdmissionInput,
  kind: string,
  content: string,
): void {
  const inserted = insertArtifactManifest(db, {
    id,
    tenantId: input.tenantId,
    kind,
    schemaVersion: 1,
    sha256: sha256(content),
    mediaType: "application/json",
    sizeBytes: Buffer.byteLength(content, "utf8"),
    storageRef: `sqlite://artifact_manifests/${id}#content_text`,
    content,
    producerPrincipalId: input.actorPrincipalId,
    createdAt: input.createdAt,
  }).row;
  if (inserted.id !== id || inserted.content_text !== content) {
    throw new Error("learning_admission_artifact_mismatch");
  }
}

function persistAdmissionReview(
  db: AppDb,
  input: GovernedLearningAdmissionInput,
  ids: GovernedLearningAdmissionIds,
  subjectType: string,
  authority: ResolvedAdmissionAuthority,
): void {
  const existing = db.raw.prepare(
    `SELECT tenant_id, subject_type, subject_id, candidate_artifact_id,
            reviewer_principal_id, decision, rationale, created_at
     FROM review_decisions WHERE id = ?`,
  ).get(ids.reviewDecisionId) as {
    tenant_id: string; subject_type: string; subject_id: string; candidate_artifact_id: string;
    reviewer_principal_id: string; decision: string; rationale: string; created_at: string;
  } | undefined;
  if (existing) {
    if (canonicalJson(existing) !== canonicalJson({
      tenant_id: input.tenantId,
      subject_type: subjectType,
      subject_id: input.sourceObjectId,
      candidate_artifact_id: ids.redactedArtifactId,
      reviewer_principal_id: authority.reviewerPrincipalId,
      decision: "approve",
      rationale: authority.reviewRationale,
      created_at: input.createdAt,
    })) throw new Error("learning_admission_review_mismatch");
    return;
  }
  insertReviewDecision(db, {
    id: ids.reviewDecisionId,
    tenantId: input.tenantId,
    subjectType,
    subjectId: input.sourceObjectId,
    candidateArtifactId: ids.redactedArtifactId,
    reviewerPrincipalId: authority.reviewerPrincipalId,
    decision: "approve",
    rationale: authority.reviewRationale,
    createdAt: input.createdAt,
  });
}

function validateAdmissionInput(input: GovernedLearningAdmissionInput): void {
  requireBoundedText(input.tenantId, "learning_admission_tenant_id_invalid");
  requireBoundedText(input.purpose, "learning_admission_purpose_invalid");
  requireBoundedText(input.sourceObjectId, "learning_admission_source_id_invalid");
  requireBoundedText(input.actorPrincipalId, "learning_admission_actor_invalid");
  requireBoundedText(input.idempotencyKey, "learning_admission_idempotency_key_invalid");
  const parsed = Date.parse(input.createdAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== input.createdAt) {
    throw new Error("learning_admission_created_at_invalid");
  }
}

function requireBoundedText(value: string, code: string): void {
  if (!isBoundedText(value)) throw new Error(code);
}

function isBoundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 512;
}

function validateInput(input: MaterializeGovernedLearningCorpusInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > 512) {
      throw new Error(`learning_corpus_${name}_invalid`);
    }
  }
  for (const [name, value] of [["temporalCutoffAt", input.temporalCutoffAt], ["createdAt", input.createdAt]] as const) {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
      throw new Error(`learning_corpus_${name}_invalid`);
    }
  }
  if (Date.parse(input.temporalCutoffAt) >= Date.parse(input.createdAt)) throw new Error("learning_corpus_cutoff_invalid");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort(codeUnitCompare).map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
