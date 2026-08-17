import { createHash, randomBytes } from "node:crypto";
import {
  appendDomainEvent,
  insertArtifactManifest,
  insertEvidenceRecord,
  verifyDomainEventIntegrity,
  type AppDb,
} from "@mendpoint/db";

export type PostTrainedEvaluationInput = Readonly<{
  tenantId: string;
  evaluationId: string;
  trainingJobId: string;
  adapterId: string;
  actorPrincipalId: string;
  idempotencyKey: string;
  requestedAt: string;
  baseline: Readonly<{ executorId: string; revision: string }>;
  evaluator: Readonly<{ harnessVersion: string; graderVersion: string }>;
  policy: Readonly<{
    minimumSuccessRate: number;
    maximumRegressionRate: number;
    maximumSecurityRegressions: number;
  }>;
}>;

export type PostTrainedEvaluationReport = Readonly<{
  candidateAdapterId: string;
  candidateArtifactDigest: string;
  baselineExecutorId: string;
  baselineRevision: string;
  cohortId: string;
  cohortRevision: string;
  cohortDigest: string;
  split: "holdout";
  harnessVersion: string;
  graderVersion: string;
  trainingDatasetId: string;
  trainingSplitManifestDigest: string;
  taskCount: number;
  successRate: number;
  regressionRate: number;
  securityRegressionCount: number;
  overlapCheck: Readonly<{ comparedScenarioCount: number; overlapCount: number }>;
  evidenceRefs: readonly string[];
}>;

export type PostTrainedEvaluationResult = Readonly<{
  status: "completed";
  report: PostTrainedEvaluationReport;
  completedAt: string;
}> | Readonly<{
  status: "failed";
  code: string;
  evidenceRefs: readonly string[];
  completedAt: string;
}> | Readonly<{ status: "pending" }> | Readonly<{ status: "safe_to_run" }>;

export type PostTrainedEvaluationReceipt = Readonly<{
  evaluationId: string;
  authorityId: string;
  requestDigest: string;
  outcome: PostTrainedEvaluationResult["status"];
  resultDigest: string;
  observedAt: string;
  signature: string;
}>;

export type PostTrainedEvaluationExchange = Readonly<{
  result: PostTrainedEvaluationResult;
  receipt: PostTrainedEvaluationReceipt;
}>;

export type PostTrainedEvaluationRequest = Readonly<{
  evaluationId: string;
  requestDigest: string;
  authorityId: string;
  candidate: Readonly<{ adapterId: string; artifactId: string; artifactDigest: string; contentBase64: string }>;
  baseline: PostTrainedEvaluationInput["baseline"];
  trainingDatasetId: string;
  trainingSplitManifestDigest: string;
  training: readonly Readonly<{ artifactId: string; sha256: string; content: string }>[];
  holdout: Readonly<{ artifactId: string; sha256: string; content: string }>;
  evaluator: PostTrainedEvaluationInput["evaluator"];
  policy: PostTrainedEvaluationInput["policy"];
  signal: AbortSignal;
}>;

export type PostTrainedEvaluationDependencies = Readonly<{
  enabled?: boolean;
  timeoutMs: number;
  leaseMs: number;
  workerId: string;
  authorityId: string;
  processingBoundary: "tenant_local" | "external";
  expected: Readonly<{ baseline: PostTrainedEvaluationInput["baseline"]; evaluator: PostTrainedEvaluationInput["evaluator"]; policy: PostTrainedEvaluationInput["policy"] }>;
  evaluator: Readonly<{
    evaluate(input: PostTrainedEvaluationRequest): Promise<PostTrainedEvaluationExchange>;
    reconcile(input: Readonly<{ evaluationId: string; requestDigest: string; authorityId: string; signal: AbortSignal }>): Promise<PostTrainedEvaluationExchange>;
  }>;
  verifyReceipt(receipt: PostTrainedEvaluationReceipt): boolean;
  authorizeDataset(input: Readonly<{ tenantId: string; datasetId: string; purpose: string; residencyRegion: string; trainingCorpusArtifactIds: readonly string[]; validationArtifactId: string; holdoutArtifactId: string; splitManifestDigest: string; processingBoundary: "tenant_local" | "external"; at: string }>): boolean;
}>;

export type PostTrainedEvaluationRecord = Readonly<{
  tenantId: string;
  evaluationId: string;
  trainingJobId: string;
  adapterId: string;
  status: "passed" | "failed";
  reportArtifactId: string;
  successRate: number;
  regressionRate: number;
  overlapCount: number;
  completedAt: string;
}>;

type EvaluationAuthority = Readonly<{
  candidate: Readonly<{ adapterId: string; artifactId: string; artifactDigest: string; contentBase64: string }>;
  trainingActorId: string;
  trainerAuthorityId: string;
  trainingDatasetId: string;
  purpose: string;
  residencyRegion: string;
  splitManifestDigest: string;
  validationArtifactId: string;
  training: readonly Readonly<{ artifactId: string; sha256: string; content: string; identities: readonly string[]; exampleCount: number }>[];
  holdout: Readonly<{ artifactId: string; sha256: string; content: string; identities: readonly string[]; exampleCount: number }>;
}>;

const PROCESS_ID = randomBytes(16).toString("hex");
const ACTIVE = new Set<string>();
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS post_trained_evaluation_effects (
  tenant_id TEXT NOT NULL, evaluation_id TEXT NOT NULL, request_digest TEXT NOT NULL,
  owner_id TEXT NOT NULL, lease_generation INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')), receipt_json TEXT,
  PRIMARY KEY (tenant_id, evaluation_id)
) STRICT`;

export async function runPostTrainedIndependentEvaluation(
  db: AppDb,
  input: PostTrainedEvaluationInput,
  dependencies: PostTrainedEvaluationDependencies,
): Promise<PostTrainedEvaluationRecord> {
  validateInput(input, dependencies);
  if (dependencies.enabled !== true) throw new Error("post_trained_evaluation_disabled");
  const replay = getPostTrainedEvaluation(db, input.tenantId, input.evaluationId);
  if (replay) return replay;
  const authority = readEvaluationAuthority(db, input);
  if (authority.trainingActorId === input.actorPrincipalId) {
    throw new Error("post_trained_evaluation_independence_required");
  }
  if (authority.trainerAuthorityId === dependencies.authorityId) throw new Error("post_trained_evaluation_independence_required");
  if (!dependencies.authorizeDataset({ tenantId: input.tenantId, datasetId: authority.trainingDatasetId, purpose: authority.purpose, residencyRegion: authority.residencyRegion, trainingCorpusArtifactIds: authority.training.map((item) => item.artifactId), validationArtifactId: authority.validationArtifactId, holdoutArtifactId: authority.holdout.artifactId, splitManifestDigest: authority.splitManifestDigest, processingBoundary: dependencies.processingBoundary, at: new Date().toISOString() })) throw new Error("post_trained_evaluation_dataset_unauthorized");
  const requestDigest = sha256(canonicalJson({ ...input, requestedAt: undefined, authority: {
    candidate: authority.candidate,
    trainingDatasetId: authority.trainingDatasetId,
    splitManifestDigest: authority.splitManifestDigest,
    training: authority.training.map(({ artifactId, sha256 }) => ({ artifactId, sha256 })),
    holdout: { artifactId: authority.holdout.artifactId, sha256: authority.holdout.sha256 },
  } }));
  const activeKey = `${input.tenantId}\0${input.evaluationId}\0${dependencies.workerId}`;
  if (ACTIVE.has(activeKey)) throw new Error("post_trained_evaluation_lease_held");
  ACTIVE.add(activeKey);
  try {
    appendRequestedEvent(db, input, requestDigest, authority, dependencies.authorityId);
    const ownerId = `${dependencies.workerId}:${PROCESS_ID}`;
    const claim = claimEffect(db, input, requestDigest, ownerId, dependencies.leaseMs);
    if (!claim.owned) throw new Error("post_trained_evaluation_lease_held");
    const exchange = claim.dispatch
      ? await bounded(dependencies.timeoutMs, (signal) => dependencies.evaluator.evaluate({
          evaluationId: input.evaluationId,
          requestDigest,
          authorityId: dependencies.authorityId,
          candidate: authority.candidate,
          baseline: input.baseline,
          trainingDatasetId: authority.trainingDatasetId,
          trainingSplitManifestDigest: authority.splitManifestDigest,
          training: authority.training.map(({ artifactId, sha256, content }) => ({ artifactId, sha256, content })),
          holdout: { artifactId: authority.holdout.artifactId, sha256: authority.holdout.sha256, content: authority.holdout.content },
          evaluator: input.evaluator,
          policy: input.policy,
          signal,
        }))
      : await bounded(dependencies.timeoutMs, (signal) => dependencies.evaluator.reconcile({ evaluationId: input.evaluationId, requestDigest, authorityId: dependencies.authorityId, signal }));
    let result = validateExchange(exchange, input, requestDigest, authority, dependencies); let receipt = exchange.receipt;
    if (result.status === "safe_to_run") {
      const retry = await bounded(dependencies.timeoutMs, (signal) => dependencies.evaluator.evaluate({ evaluationId: input.evaluationId, requestDigest, authorityId: dependencies.authorityId, candidate: authority.candidate, baseline: input.baseline, trainingDatasetId: authority.trainingDatasetId, trainingSplitManifestDigest: authority.splitManifestDigest, training: authority.training.map(({ artifactId, sha256, content }) => ({ artifactId, sha256, content })), holdout: { artifactId: authority.holdout.artifactId, sha256: authority.holdout.sha256, content: authority.holdout.content }, evaluator: input.evaluator, policy: input.policy, signal }));
      result = validateExchange(retry, input, requestDigest, authority, dependencies); receipt = retry.receipt;
    }
    if (result.status === "pending") throw new Error("post_trained_evaluation_outcome_unknown");
    if (result.status === "safe_to_run") throw new Error("post_trained_evaluation_result_invalid");
    if (result.status === "failed") return settleEvaluationFailure(db, input, requestDigest, ownerId, claim.generation, receipt, result);
    return settleEvaluation(db, input, requestDigest, ownerId, claim.generation, receipt, result, authority);
  } finally {
    ACTIVE.delete(activeKey);
  }
}

export function postTrainedEvaluationResultDigest(result: PostTrainedEvaluationResult): string {
  return sha256(canonicalJson(result));
}

export function postTrainedEvaluationReceiptSigningBytes(receipt: PostTrainedEvaluationReceipt): Buffer {
  return Buffer.from(canonicalJson({ ...receipt, signature: undefined }), "utf8");
}

function readEvaluationAuthority(db: AppDb, input: PostTrainedEvaluationInput): EvaluationAuthority {
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("post_trained_evaluation_event_integrity_invalid");
  const submittedRow = db.raw.prepare(
    `SELECT payload_json, actor_principal_id FROM domain_events
     WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ?
       AND event_type = 'post_trained_training.submitted' ORDER BY event_sequence LIMIT 1`,
  ).get(input.tenantId, input.trainingJobId) as { payload_json: string; actor_principal_id: string } | undefined;
  const completedRow = db.raw.prepare(
    `SELECT payload_json FROM domain_events
     WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ?
       AND event_type = 'post_trained_training.completed' ORDER BY event_sequence DESC LIMIT 1`,
  ).get(input.tenantId, input.trainingJobId) as { payload_json: string } | undefined;
  if (!submittedRow || !completedRow) throw new Error("post_trained_evaluation_training_missing");
  const submitted = JSON.parse(submittedRow.payload_json) as {
    requestDigest?: string; authorityId?: string; adapterId?: string; baseModelId?: string; datasetId?: string; purpose?: string; residencyRegion?: string; splitManifestDigest?: string;
    trainingCorpus?: Array<{ artifactId: string; sha256: string }>;
    validation?: { artifactId: string; sha256: string };
    holdout?: { artifactId: string; sha256: string };
  };
  const completed = JSON.parse(completedRow.payload_json) as {
    requestDigest?: string; authorityId?: string; artifactId?: string; adapterDigest?: string; datasetId?: string;
  };
  if (
    submitted.adapterId !== input.adapterId
    || completed.requestDigest !== submitted.requestDigest
    || completed.authorityId !== submitted.authorityId
    || typeof submitted.authorityId !== "string"
    || completed.datasetId !== submitted.datasetId
    || typeof submitted.datasetId !== "string"
    || !/^[a-f0-9]{64}$/u.test(submitted.splitManifestDigest ?? "")
    || !Array.isArray(submitted.trainingCorpus)
    || submitted.trainingCorpus.length === 0
    || !submitted.validation
    || !submitted.holdout
    || typeof submitted.purpose !== "string"
    || typeof submitted.residencyRegion !== "string"
    || typeof completed.artifactId !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(completed.adapterDigest ?? "")
  ) throw new Error("post_trained_evaluation_training_binding_mismatch");
  const adapterDigest = completed.adapterDigest as string;
  const datasetId = submitted.datasetId as string;
  const splitManifestDigest = submitted.splitManifestDigest as string;
  const candidate = readArtifact(db, input.tenantId, completed.artifactId, "post_trained_adapter_artifact");
  let candidateEnvelope: unknown;
  try { candidateEnvelope = JSON.parse(candidate.content); } catch { throw new Error("post_trained_evaluation_candidate_invalid"); }
  const wrapped = candidateEnvelope && typeof candidateEnvelope === "object" && !Array.isArray(candidateEnvelope) ? candidateEnvelope as { encoding?: unknown; bytes?: unknown; decodedSha256?: unknown } : undefined;
  if (wrapped?.encoding !== "base64" || typeof wrapped.bytes !== "string" || wrapped.decodedSha256 !== adapterDigest) throw new Error("post_trained_evaluation_candidate_invalid");
  const candidateBytes = Buffer.from(wrapped.bytes, "base64");
  if (!candidateBytes.length || candidateBytes.toString("base64") !== wrapped.bytes || `sha256:${createHash("sha256").update(candidateBytes).digest("hex")}` !== adapterDigest) throw new Error("post_trained_evaluation_candidate_invalid");
  const training = submitted.trainingCorpus.map((binding) => {
    const artifact = readArtifact(db, input.tenantId, binding.artifactId, "learning_dataset_corpus");
    if (artifact.sha256 !== binding.sha256) throw new Error("post_trained_evaluation_training_binding_mismatch");
    return artifact;
  });
  const validation = readArtifact(db, input.tenantId, submitted.validation.artifactId, "learning_dataset_validation");
  if (validation.sha256 !== submitted.validation.sha256) throw new Error("post_trained_evaluation_validation_binding_mismatch");
  const holdout = readArtifact(db, input.tenantId, submitted.holdout.artifactId, "learning_dataset_holdout");
  if (holdout.sha256 !== submitted.holdout.sha256) throw new Error("post_trained_evaluation_holdout_binding_mismatch");
  if (training.some((artifact) => artifact.exampleCount < 1 || artifact.identities.length !== artifact.exampleCount) || holdout.exampleCount < 1 || holdout.identities.length !== holdout.exampleCount) throw new Error("post_trained_evaluation_identity_manifest_invalid");
  const trainingIdentities = new Set(training.flatMap((artifact) => artifact.identities));
  if (holdout.identities.some((identity) => trainingIdentities.has(identity))) {
    throw new Error("post_trained_evaluation_overlap_detected");
  }
  return deepFreeze({
    candidate: { adapterId: input.adapterId, artifactId: candidate.artifactId, artifactDigest: adapterDigest, contentBase64: wrapped.bytes },
    trainingActorId: submittedRow.actor_principal_id,
    trainerAuthorityId: submitted.authorityId,
    trainingDatasetId: datasetId,
    purpose: submitted.purpose,
    residencyRegion: submitted.residencyRegion,
    splitManifestDigest,
    validationArtifactId: validation.artifactId,
    training,
    holdout,
  });
}

function readArtifact(db: AppDb, tenantId: string, artifactId: string, kind: string) {
  const row = db.raw.prepare(
    "SELECT id, kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, artifactId) as { id: string; kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
  if (!row?.content_text || row.kind !== kind || sha256(row.content_text) !== row.sha256 || Buffer.byteLength(row.content_text) !== row.size_bytes) {
    throw new Error("post_trained_evaluation_artifact_invalid");
  }
  const parsed = JSON.parse(row.content_text) as Record<string, unknown>;
  const examples = Array.isArray(parsed.examples) ? parsed.examples : [];
  const identities = examples.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const task = (value as Record<string, unknown>).task;
    if (!task || typeof task !== "object" || Array.isArray(task)) return [];
    const item = task as Record<string, unknown>;
    const fields = [item.scenarioId, item.sourceRevision, item.sourceDigest];
    if (!fields.every((entry): entry is string => typeof entry === "string" && entry.length > 0)) return [];
    return [fields.map((entry) => `${entry.length}:${entry}`).join("")];
  });
  return deepFreeze({ artifactId: row.id, sha256: row.sha256, content: row.content_text, identities, exampleCount: examples.length });
}

function validateExchange(
  exchange: PostTrainedEvaluationExchange,
  input: PostTrainedEvaluationInput,
  requestDigest: string,
  authority: EvaluationAuthority,
  dependencies: PostTrainedEvaluationDependencies,
): PostTrainedEvaluationResult {
  if (!exchange?.receipt || !exchange.result) throw new Error("post_trained_evaluation_receipt_invalid");
  const receipt = exchange.receipt;
  if (
    receipt.evaluationId !== input.evaluationId
    || receipt.requestDigest !== requestDigest
    || receipt.authorityId !== dependencies.authorityId
    || receipt.outcome !== exchange.result.status
    || receipt.resultDigest !== postTrainedEvaluationResultDigest(exchange.result)
    || new Date(receipt.observedAt).toISOString() !== receipt.observedAt
    || !dependencies.verifyReceipt(deepFreeze(structuredClone(receipt)))
  ) throw new Error("post_trained_evaluation_receipt_invalid");
  const result = deepFreeze(structuredClone(exchange.result));
  if (result.status === "failed") {
    if (!boundedCode(result.code) || !canonicalTime(result.completedAt) || Date.parse(result.completedAt) < Date.parse(input.requestedAt) || !validEvidenceRefs(result.evidenceRefs)) throw new Error("post_trained_evaluation_result_invalid");
    return result;
  }
  if (result.status !== "completed") return result;
  if (!canonicalTime(result.completedAt) || Date.parse(result.completedAt) < Date.parse(input.requestedAt)) throw new Error("post_trained_evaluation_result_invalid");
  const report = result.report;
  const expectedCohortRevision = authority.holdout.sha256.slice(0, 40);
  if (
    report.candidateAdapterId !== authority.candidate.adapterId
    || report.candidateArtifactDigest !== authority.candidate.artifactDigest
    || report.baselineExecutorId !== input.baseline.executorId
    || report.baselineRevision !== input.baseline.revision
    || report.cohortId !== authority.holdout.artifactId
    || report.cohortRevision !== expectedCohortRevision
    || report.cohortDigest !== `sha256:${authority.holdout.sha256}`
    || report.split !== "holdout"
    || report.harnessVersion !== input.evaluator.harnessVersion
    || report.graderVersion !== input.evaluator.graderVersion
    || report.trainingDatasetId !== authority.trainingDatasetId
    || report.trainingSplitManifestDigest !== authority.splitManifestDigest
  ) throw new Error("post_trained_evaluation_binding_mismatch");
  if (report.overlapCheck.overlapCount !== 0) throw new Error("post_trained_evaluation_overlap_detected");
  if (
    !Number.isSafeInteger(report.taskCount) || report.taskCount !== authority.holdout.exampleCount
    || report.overlapCheck.comparedScenarioCount < report.taskCount + authority.training.reduce((count, item) => count + item.exampleCount, 0)
    || !rate(report.successRate) || !rate(report.regressionRate)
    || !Number.isSafeInteger(report.securityRegressionCount) || report.securityRegressionCount < 0
    || !Array.isArray(report.evidenceRefs) || report.evidenceRefs.length === 0 || report.evidenceRefs.length > 128
    || report.evidenceRefs.some((value) => typeof value !== "string" || !value.trim() || value.length > 1_024)
  ) throw new Error("post_trained_evaluation_result_invalid");
  return result;
}

function settleEvaluation(
  db: AppDb,
  input: PostTrainedEvaluationInput,
  requestDigest: string,
  ownerId: string,
  generation: number,
  receipt: PostTrainedEvaluationReceipt,
  result: Extract<PostTrainedEvaluationResult, { status: "completed" }>,
  authority: EvaluationAuthority,
): PostTrainedEvaluationRecord {
  const passed = result.report.successRate >= input.policy.minimumSuccessRate
    && result.report.regressionRate <= input.policy.maximumRegressionRate
    && result.report.securityRegressionCount <= input.policy.maximumSecurityRegressions
    && result.report.overlapCheck.overlapCount === 0;
  const content = canonicalJson({ schemaVersion: 1, kind: "post_trained_independent_evaluation", evaluationId: input.evaluationId, requestDigest, evaluationAuthorityId: receipt.authorityId, trainingJobId: input.trainingJobId, candidate: { adapterId: authority.candidate.adapterId, artifactId: authority.candidate.artifactId, artifactDigest: authority.candidate.artifactDigest }, baseline: input.baseline, policy: input.policy, report: result.report, passed, completedAt: result.completedAt });
  const artifactId = `evaluation_${sha256(content)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLease(db, input, requestDigest, ownerId, generation);
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_independent_evaluation", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-evaluation+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: result.completedAt });
    insertEvidenceRecord(db, { id: `evidence_${sha256(`${input.evaluationId}\0${artifactId}`)}`, tenantId: input.tenantId, subjectType: "post_trained_evaluation", subjectId: input.evaluationId, artifactId, inputArtifactId: authority.candidate.artifactId, producerPrincipalId: input.actorPrincipalId, tool: "independent-post-trained-evaluator", toolVersion: input.evaluator.harnessVersion, verdict: passed ? "passed" : "failed", createdAt: result.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.evaluationId}\0completed`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_evaluation.completed", aggregateType: "post_trained_evaluation", aggregateId: input.evaluationId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-evaluation:${input.idempotencyKey}:completed`, payload: { requestDigest, evaluationAuthorityId: receipt.authorityId, artifactId, trainingJobId: input.trainingJobId, adapterId: input.adapterId, passed, successRate: result.report.successRate, regressionRate: result.report.regressionRate, overlapCount: result.report.overlapCheck.overlapCount, completedAt: result.completedAt }, createdAt: result.completedAt });
    const changed = db.raw.prepare("UPDATE post_trained_evaluation_effects SET phase = 'settled', receipt_json = ? WHERE tenant_id = ? AND evaluation_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched'").run(canonicalJson(receipt), input.tenantId, input.evaluationId, requestDigest, ownerId, generation).changes;
    if (changed !== 1) throw new Error("post_trained_evaluation_lease_lost");
    db.raw.exec("COMMIT");
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
  return getPostTrainedEvaluation(db, input.tenantId, input.evaluationId)!;
}

function settleEvaluationFailure(db: AppDb, input: PostTrainedEvaluationInput, requestDigest: string, ownerId: string, generation: number, receipt: PostTrainedEvaluationReceipt, result: Extract<PostTrainedEvaluationResult, { status: "failed" }>): PostTrainedEvaluationRecord {
  const content = canonicalJson({ schemaVersion: 1, kind: "post_trained_independent_evaluation_failure", evaluationId: input.evaluationId, requestDigest, code: result.code, evidenceRefs: result.evidenceRefs, completedAt: result.completedAt });
  const artifactId = `evaluation_${sha256(content)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLease(db, input, requestDigest, ownerId, generation);
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_independent_evaluation_failure", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-evaluation-failure+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: result.completedAt });
    insertEvidenceRecord(db, { id: `evidence_${sha256(`${input.evaluationId}\0${artifactId}`)}`, tenantId: input.tenantId, subjectType: "post_trained_evaluation", subjectId: input.evaluationId, artifactId, producerPrincipalId: input.actorPrincipalId, tool: "independent-post-trained-evaluator", toolVersion: input.evaluator.harnessVersion, verdict: "failed", createdAt: result.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.evaluationId}\0failed`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_evaluation.completed", aggregateType: "post_trained_evaluation", aggregateId: input.evaluationId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-evaluation:${input.idempotencyKey}:completed`, payload: { requestDigest, artifactId, trainingJobId: input.trainingJobId, adapterId: input.adapterId, passed: false, successRate: 0, regressionRate: 1, overlapCount: 0, failureCode: result.code, completedAt: result.completedAt }, createdAt: result.completedAt });
    const changed = db.raw.prepare("UPDATE post_trained_evaluation_effects SET phase = 'settled', receipt_json = ? WHERE tenant_id = ? AND evaluation_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched'").run(canonicalJson(receipt), input.tenantId, input.evaluationId, requestDigest, ownerId, generation).changes;
    if (changed !== 1) throw new Error("post_trained_evaluation_lease_lost"); db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedEvaluation(db, input.tenantId, input.evaluationId)!;
}

function appendRequestedEvent(db: AppDb, input: PostTrainedEvaluationInput, requestDigest: string, authority: EvaluationAuthority, evaluationAuthorityId: string): void {
  const existing = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?").get(input.tenantId, `post-trained-evaluation:${input.idempotencyKey}:requested`) as { payload_json: string } | undefined;
  if (existing) {
    if ((JSON.parse(existing.payload_json) as { requestDigest?: string }).requestDigest !== requestDigest) throw new Error("post_trained_evaluation_idempotency_conflict");
    return;
  }
  appendDomainEvent(db, { id: `event_${sha256(`${input.evaluationId}\0requested`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_evaluation.requested", aggregateType: "post_trained_evaluation", aggregateId: input.evaluationId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-evaluation:${input.idempotencyKey}:requested`, payload: { requestDigest, trainerAuthorityId: authority.trainerAuthorityId, evaluationAuthorityId, trainingJobId: input.trainingJobId, adapterId: input.adapterId, candidate: { adapterId: authority.candidate.adapterId, artifactId: authority.candidate.artifactId, artifactDigest: authority.candidate.artifactDigest }, baseline: input.baseline, datasetId: authority.trainingDatasetId, splitManifestDigest: authority.splitManifestDigest, holdoutArtifactId: authority.holdout.artifactId, evaluator: input.evaluator, policy: input.policy, requestedAt: input.requestedAt }, createdAt: input.requestedAt });
}

export function getPostTrainedEvaluation(db: AppDb, tenantId: string, evaluationId: string): PostTrainedEvaluationRecord | undefined {
  const row = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_evaluation' AND aggregate_id = ? AND event_type = 'post_trained_evaluation.completed' ORDER BY event_sequence DESC LIMIT 1").get(tenantId, evaluationId) as { payload_json: string } | undefined;
  if (!row) return undefined;
  const payload = JSON.parse(row.payload_json) as { artifactId: string; trainingJobId: string; adapterId: string; passed: boolean; successRate: number; regressionRate: number; overlapCount: number; completedAt: string };
  return deepFreeze({ tenantId, evaluationId, trainingJobId: payload.trainingJobId, adapterId: payload.adapterId, status: payload.passed ? "passed" : "failed", reportArtifactId: payload.artifactId, successRate: payload.successRate, regressionRate: payload.regressionRate, overlapCount: payload.overlapCount, completedAt: payload.completedAt });
}

function claimEffect(db: AppDb, input: PostTrainedEvaluationInput, requestDigest: string, ownerId: string, leaseMs: number) {
  db.raw.exec(EFFECT_TABLE);
  if (db.raw.isTransaction) throw new Error("post_trained_evaluation_ambient_transaction");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const now = sqliteNow(db);
    const row = db.raw.prepare("SELECT request_digest, owner_id, lease_generation, lease_expires_at_ms, phase FROM post_trained_evaluation_effects WHERE tenant_id = ? AND evaluation_id = ?").get(input.tenantId, input.evaluationId) as { request_digest: string; owner_id: string; lease_generation: number; lease_expires_at_ms: number; phase: string } | undefined;
    if (!row) {
      db.raw.prepare("INSERT INTO post_trained_evaluation_effects (tenant_id, evaluation_id, request_digest, owner_id, lease_generation, lease_expires_at_ms, phase) VALUES (?, ?, ?, ?, 1, ?, 'dispatched')").run(input.tenantId, input.evaluationId, requestDigest, ownerId, now + leaseMs);
      db.raw.exec("COMMIT"); return { owned: true, dispatch: true, generation: 1 };
    }
    if (row.request_digest !== requestDigest) throw new Error("post_trained_evaluation_idempotency_conflict");
    if (row.phase === "settled") { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; }
    if (row.owner_id === ownerId && row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation: row.lease_generation }; }
    if (row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; }
    const generation = row.lease_generation + 1;
    const changed = db.raw.prepare("UPDATE post_trained_evaluation_effects SET owner_id = ?, lease_generation = ?, lease_expires_at_ms = ? WHERE tenant_id = ? AND evaluation_id = ? AND request_digest = ? AND phase = 'dispatched' AND lease_generation = ? AND lease_expires_at_ms <= ?").run(ownerId, generation, now + leaseMs, input.tenantId, input.evaluationId, requestDigest, row.lease_generation, now).changes;
    if (changed !== 1) throw new Error("post_trained_evaluation_lease_lost");
    db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation };
  } catch (error) {
    if (db.raw.isTransaction) db.raw.exec("ROLLBACK");
    throw error;
  }
}

function assertLease(db: AppDb, input: PostTrainedEvaluationInput, requestDigest: string, ownerId: string, generation: number): void {
  const row = db.raw.prepare("SELECT 1 FROM post_trained_evaluation_effects WHERE tenant_id = ? AND evaluation_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched' AND lease_expires_at_ms > ?").get(input.tenantId, input.evaluationId, requestDigest, ownerId, generation, sqliteNow(db));
  if (!row) throw new Error("post_trained_evaluation_lease_lost");
}

function validateInput(input: PostTrainedEvaluationInput, dependencies: PostTrainedEvaluationDependencies): void {
  for (const value of [input.tenantId, input.evaluationId, input.trainingJobId, input.adapterId, input.actorPrincipalId, input.idempotencyKey, input.baseline.executorId, input.evaluator.harnessVersion, input.evaluator.graderVersion, dependencies.workerId, dependencies.authorityId]) {
    if (typeof value !== "string" || !value.trim()) throw new Error("post_trained_evaluation_input_invalid");
  }
  if (!/^[a-f0-9]{40}$/u.test(input.baseline.revision) || new Date(input.requestedAt).toISOString() !== input.requestedAt || !rate(input.policy.minimumSuccessRate) || !rate(input.policy.maximumRegressionRate) || !Number.isSafeInteger(input.policy.maximumSecurityRegressions) || input.policy.maximumSecurityRegressions < 0 || !["tenant_local", "external"].includes(dependencies.processingBoundary) || canonicalJson(input.baseline) !== canonicalJson(dependencies.expected?.baseline) || canonicalJson(input.evaluator) !== canonicalJson(dependencies.expected?.evaluator) || canonicalJson(input.policy) !== canonicalJson(dependencies.expected?.policy) || !Number.isSafeInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || !Number.isSafeInteger(dependencies.leaseMs) || dependencies.leaseMs < dependencies.timeoutMs * 2 || typeof dependencies.evaluator?.evaluate !== "function" || typeof dependencies.evaluator?.reconcile !== "function" || typeof dependencies.verifyReceipt !== "function" || typeof dependencies.authorizeDataset !== "function") throw new Error("post_trained_evaluation_input_invalid");
}

function rate(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function boundedCode(value: unknown): value is string { return typeof value === "string" && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value); }
function validEvidenceRefs(value: unknown): value is readonly string[] { return Array.isArray(value) && value.length > 0 && value.length <= 128 && new Set(value).size === value.length && value.every((reference) => typeof reference === "string" && reference.length <= 1_024 && reference.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(reference)); }
function canonicalTime(value: unknown): value is string { if (typeof value !== "string") return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function sqliteNow(db: AppDb): number { return (db.raw.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms").get() as { now_ms: number }).now_ms; }
async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("post_trained_evaluation_timeout")); }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
