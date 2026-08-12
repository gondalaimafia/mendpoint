import { createHash } from "node:crypto";
import { appendDomainEvent, insertArtifactManifest, insertEvidenceRecord, type AppDb } from "@mendpoint/db";

export type PostTrainedTrainingInput = Readonly<{
  tenantId: string; jobId: string; adapterId: string; actorPrincipalId: string;
  idempotencyKey: string; submittedAt: string; baseModelId: string;
  datasetId: string; purpose: string; residencyRegion: string;
  corpusArtifactIds: readonly string[];
  recipe: Readonly<{ epochs: number; maximumExamples: number; seed: number }>;
}>;
export type PostTrainedTrainingCompletion = Readonly<{
  status: "completed"; adapterBase64: string;
  evaluation: Readonly<{ passed: boolean; successRate: number; regressionRate: number; reportRef: string }>;
  canary: Readonly<{ passed: boolean; observedAt: string; evidenceRefs: readonly string[] }>;
  evidenceRefs: readonly string[]; completedAt: string;
}>;
export type PostTrainedTrainerResolution = PostTrainedTrainingCompletion
  | Readonly<{ status: "failed"; code: string; evidenceRefs: readonly string[]; completedAt: string }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "safe_to_run" }>;
export type PostTrainedReconciliationReceipt = Readonly<{
  tenantId: string; jobId: string; requestDigest: string; leaseGeneration: number;
  outcome: PostTrainedTrainerResolution["status"]; resultDigest: string;
  observedAt: string; signature: string;
}>;
export type PostTrainedReconciliation = Readonly<{ receipt: PostTrainedReconciliationReceipt; result: PostTrainedTrainerResolution }>;
export type PostTrainedTrainer = Readonly<{
  train(input: Readonly<{ jobId: string; adapterId: string; tenantId: string; requestDigest: string; leaseGeneration: number; baseModelId: string; corpus: readonly Readonly<{ artifactId: string; sha256: string; content: string }>[]; recipe: PostTrainedTrainingInput["recipe"]; signal: AbortSignal }>): Promise<PostTrainedReconciliation>;
  reconcile(input: Readonly<{ jobId: string; tenantId: string; requestDigest: string; leaseGeneration: number; signal: AbortSignal }>): Promise<PostTrainedReconciliation>;
}>;
export type PostTrainedTrainingDependencies = Readonly<{
  enabled?: boolean; timeoutMs: number; leaseMs: number; workerId: string;
  verifyEvidence(tenantId: string, evidenceRefs: readonly string[], expected: Readonly<{ subjectTypes: readonly string[]; subjectId: string; artifactIds?: readonly string[] }>): boolean;
  authorizeDataset(input: Readonly<{ tenantId: string; datasetId: string; purpose: string; residencyRegion: string; corpusArtifactIds: readonly string[]; at: string }>): boolean;
  verifyReconciliation(receipt: PostTrainedReconciliationReceipt): boolean;
  trainer: PostTrainedTrainer;
}>;
export type PostTrainedTrainingJob = Readonly<{ tenantId: string; jobId: string; adapterId: string; requestDigest: string; status: "submitted" | "completed" | "failed"; submittedAt: string; completedAt?: string; adapterArtifactId?: string; adapterDigest?: string; evaluation?: PostTrainedTrainingCompletion["evaluation"]; canary?: PostTrainedTrainingCompletion["canary"]; evidenceRefs?: readonly string[]; failureCode?: string }>;

const MAX_ADAPTER_BYTES = 16 * 1024 * 1024;
const MAX_CORPUS_ARTIFACTS = 32;
const MAX_CORPUS_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CORPUS_BYTES = 64 * 1024 * 1024;
const CORPUS_KINDS = new Set(["learning_dataset_corpus", "learning_dataset_version", "post_trained_training_corpus"]);
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS post_trained_training_effects (
  tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, request_digest TEXT NOT NULL,
  owner_id TEXT NOT NULL, lease_generation INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')), receipt_json TEXT,
  PRIMARY KEY (tenant_id, job_id)
) STRICT`;

export async function runPostTrainedTrainingJob(db: AppDb, input: PostTrainedTrainingInput, deps: PostTrainedTrainingDependencies): Promise<PostTrainedTrainingJob> {
  if (deps.enabled !== true) throw new Error("post_trained_training_disabled");
  validateInput(input, deps);
  if (typeof deps.trainer?.train !== "function" || typeof deps.trainer?.reconcile !== "function" || typeof deps.verifyReconciliation !== "function") throw new Error("post_trained_trainer_invalid");
  const requestDigest = sha256(canonicalJson({ ...input, submittedAt: undefined }));
  let current = getPostTrainedTrainingJob(db, input.tenantId, input.jobId);
  if (current && current.requestDigest !== requestDigest) throw new Error("post_trained_training_idempotency_conflict");
  if (current?.status === "completed" || current?.status === "failed") return current;
  const corpus = resolveCorpus(db, input);
  if (!deps.authorizeDataset({ tenantId: input.tenantId, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, corpusArtifactIds: Object.freeze([...input.corpusArtifactIds]), at: new Date().toISOString() })) throw new Error("post_trained_training_dataset_unauthorized");
  if (!deps.verifyEvidence(input.tenantId, Object.freeze(corpus.map((item) => item.artifactId)), { subjectTypes: Object.freeze(["learning_dataset", "learning_dataset_version"]), subjectId: input.datasetId, artifactIds: Object.freeze(corpus.map((item) => item.artifactId)) })) throw new Error("post_trained_training_evidence_not_authoritative");
  if (!current) {
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0submitted`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.submitted", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:submitted`, payload: { requestDigest, adapterId: input.adapterId, submittedAt: input.submittedAt, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, corpus: corpus.map(({ artifactId, sha256 }) => ({ artifactId, sha256 })), baseModelId: input.baseModelId, recipe: input.recipe }, createdAt: input.submittedAt });
    current = getPostTrainedTrainingJob(db, input.tenantId, input.jobId)!;
  }
  const claim = claimEffect(db, input.tenantId, input.jobId, requestDigest, deps.workerId, deps.leaseMs);
  if (!claim.owned) throw new Error("post_trained_training_lease_held");
  let exchange: PostTrainedReconciliation;
  if (claim.dispatch) {
    exchange = await bounded(deps.timeoutMs, (signal) => deps.trainer.train({ jobId: input.jobId, adapterId: input.adapterId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, baseModelId: input.baseModelId, corpus, recipe: input.recipe, signal }));
  } else {
    exchange = await bounded(deps.timeoutMs, (signal) => deps.trainer.reconcile({ jobId: input.jobId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, signal }));
  }
  let resolution = validateExchange(exchange, input, requestDigest, claim.generation, deps);
  let receipt = exchange.receipt;
  if (resolution.status === "safe_to_run") {
    const retry = await bounded(deps.timeoutMs, (signal) => deps.trainer.train({ jobId: input.jobId, adapterId: input.adapterId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, baseModelId: input.baseModelId, corpus, recipe: input.recipe, signal }));
    resolution = validateExchange(retry, input, requestDigest, claim.generation, deps);
    receipt = retry.receipt;
  }
  if (resolution.status === "pending") throw new Error("post_trained_training_outcome_unknown");
  if (resolution.status === "safe_to_run") throw new Error("post_trained_training_result_invalid");
  const evidenceRefs = resolution.status === "completed"
    ? Object.freeze([...new Set([...resolution.evidenceRefs, ...resolution.canary.evidenceRefs, resolution.evaluation.reportRef])])
    : resolution.evidenceRefs;
  if (!deps.verifyEvidence(input.tenantId, evidenceRefs, { subjectTypes: Object.freeze(["post_trained_training_job"]), subjectId: input.jobId })) throw new Error("post_trained_training_evidence_not_authoritative");
  if (resolution.status === "failed") return settleFailure(db, input, requestDigest, claim.generation, deps.workerId, receipt, resolution);
  validateCompletion(resolution);
  return settleCompletion(db, input, requestDigest, claim.generation, deps.workerId, receipt, resolution, corpus);
}

export function getPostTrainedTrainingJob(db: AppDb, tenantId: string, jobId: string): PostTrainedTrainingJob | undefined {
  const events = db.raw.prepare("SELECT event_type, payload_json, created_at FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ? ORDER BY event_sequence").all(tenantId, jobId) as Array<{ event_type: string; payload_json: string; created_at: string }>;
  if (!events.length) return undefined;
  const submitted = JSON.parse(events[0]!.payload_json) as { requestDigest: string; adapterId: string; submittedAt: string };
  const latest = events.at(-1)!; const payload = JSON.parse(latest.payload_json) as Record<string, unknown>;
  if (latest.event_type.endsWith(".completed")) return deepFreeze({ tenantId, jobId, adapterId: submitted.adapterId, requestDigest: submitted.requestDigest, status: "completed", submittedAt: submitted.submittedAt, completedAt: String(payload.completedAt), adapterArtifactId: String(payload.artifactId), adapterDigest: String(payload.adapterDigest), evaluation: payload.evaluation as PostTrainedTrainingCompletion["evaluation"], canary: payload.canary as PostTrainedTrainingCompletion["canary"], evidenceRefs: payload.evidenceRefs as string[] });
  if (latest.event_type.endsWith(".failed")) return deepFreeze({ tenantId, jobId, adapterId: submitted.adapterId, requestDigest: submitted.requestDigest, status: "failed", submittedAt: submitted.submittedAt, completedAt: String(payload.completedAt), failureCode: String(payload.code), evidenceRefs: payload.evidenceRefs as string[] });
  return deepFreeze({ tenantId, jobId, adapterId: submitted.adapterId, requestDigest: submitted.requestDigest, status: "submitted", submittedAt: submitted.submittedAt });
}

export function postTrainedReconciliationResultDigest(result: PostTrainedTrainerResolution): string { return sha256(canonicalJson(result)); }
export function postTrainedReconciliationSigningBytes(receipt: PostTrainedReconciliationReceipt): Uint8Array {
  return Buffer.from(canonicalJson({ ...receipt, signature: undefined }), "utf8");
}

function claimEffect(db: AppDb, tenantId: string, jobId: string, requestDigest: string, workerId: string, leaseMs: number): { owned: boolean; dispatch: boolean; generation: number } {
  db.raw.exec(EFFECT_TABLE);
  if (db.raw.isTransaction) throw new Error("post_trained_training_ambient_transaction");
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const now = sqliteNow(db); const row = db.raw.prepare("SELECT request_digest, owner_id, lease_generation, lease_expires_at_ms, phase FROM post_trained_training_effects WHERE tenant_id = ? AND job_id = ?").get(tenantId, jobId) as { request_digest: string; owner_id: string; lease_generation: number; lease_expires_at_ms: number; phase: string } | undefined;
    if (!row) {
      db.raw.prepare("INSERT INTO post_trained_training_effects (tenant_id, job_id, request_digest, owner_id, lease_generation, lease_expires_at_ms, phase) VALUES (?, ?, ?, ?, 1, ?, 'dispatched')").run(tenantId, jobId, requestDigest, workerId, now + leaseMs);
      db.raw.exec("COMMIT"); return { owned: true, dispatch: true, generation: 1 };
    }
    if (row.request_digest !== requestDigest) throw new Error("post_trained_training_idempotency_conflict");
    if (row.phase === "settled") { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; }
    if (row.owner_id === workerId && row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation: row.lease_generation }; }
    if (row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; }
    const generation = row.lease_generation + 1;
    const changed = db.raw.prepare("UPDATE post_trained_training_effects SET owner_id = ?, lease_generation = ?, lease_expires_at_ms = ? WHERE tenant_id = ? AND job_id = ? AND request_digest = ? AND phase = 'dispatched' AND lease_generation = ? AND lease_expires_at_ms <= ?").run(workerId, generation, now + leaseMs, tenantId, jobId, requestDigest, row.lease_generation, now).changes;
    if (changed !== 1) throw new Error("post_trained_training_checkpoint_conflict");
    db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation };
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
}

function settleFailure(db: AppDb, input: PostTrainedTrainingInput, requestDigest: string, generation: number, workerId: string, receipt: PostTrainedReconciliationReceipt, resolution: Extract<PostTrainedTrainerResolution, { status: "failed" }>): PostTrainedTrainingJob {
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLeaseCurrent(db, input, requestDigest, generation, workerId);
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0failed\0${resolution.code}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.failed", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:failed`, payload: { requestDigest, code: resolution.code, evidenceRefs: resolution.evidenceRefs, completedAt: resolution.completedAt }, createdAt: resolution.completedAt });
    settleEffect(db, input, requestDigest, generation, workerId, receipt);
    db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedTrainingJob(db, input.tenantId, input.jobId)!;
}

function settleCompletion(db: AppDb, input: PostTrainedTrainingInput, requestDigest: string, generation: number, workerId: string, receipt: PostTrainedReconciliationReceipt, resolution: PostTrainedTrainingCompletion, corpus: readonly { artifactId: string; sha256: string }[]): PostTrainedTrainingJob {
  const adapterBytes = decodeCanonicalBase64(resolution.adapterBase64);
  const adapterDigest = `sha256:${createHash("sha256").update(adapterBytes).digest("hex")}`;
  const artifactContent = canonicalJson({ encoding: "base64", bytes: resolution.adapterBase64, decodedSha256: adapterDigest });
  const artifactId = `artifact_${sha256(`${input.tenantId}\0${input.jobId}\0${adapterDigest}`)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    assertLeaseCurrent(db, input, requestDigest, generation, workerId);
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_adapter_artifact", schemaVersion: 1, sha256: sha256(artifactContent), mediaType: "application/vnd.mendpoint.post-trained-adapter-bytes+json", sizeBytes: Buffer.byteLength(artifactContent), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content: artifactContent, producerPrincipalId: input.actorPrincipalId, createdAt: resolution.completedAt });
    insertEvidenceRecord(db, { id: `evidence_${sha256(`${input.jobId}\0training`)}`, tenantId: input.tenantId, subjectType: "post_trained_training_job", subjectId: input.jobId, artifactId, inputArtifactId: corpus[0]?.artifactId, producerPrincipalId: input.actorPrincipalId, tool: "post-trained-trainer", toolVersion: "1", verdict: "passed", createdAt: resolution.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0completed\0${adapterDigest}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.completed", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:completed`, payload: { requestDigest, artifactId, adapterDigest, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, evaluation: resolution.evaluation, canary: resolution.canary, evidenceRefs: resolution.evidenceRefs, completedAt: resolution.completedAt }, createdAt: resolution.completedAt });
    settleEffect(db, input, requestDigest, generation, workerId, receipt);
    db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedTrainingJob(db, input.tenantId, input.jobId)!;
}

function assertLeaseCurrent(db: AppDb, input: PostTrainedTrainingInput, requestDigest: string, generation: number, workerId: string): void {
  const now = sqliteNow(db);
  const row = db.raw.prepare("SELECT 1 FROM post_trained_training_effects WHERE tenant_id = ? AND job_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched' AND lease_expires_at_ms > ?").get(input.tenantId, input.jobId, requestDigest, workerId, generation, now);
  if (!row) throw new Error("post_trained_training_lease_lost");
}
function settleEffect(db: AppDb, input: PostTrainedTrainingInput, requestDigest: string, generation: number, workerId: string, receipt: PostTrainedReconciliationReceipt): void {
  const changed = db.raw.prepare("UPDATE post_trained_training_effects SET phase = 'settled', receipt_json = ? WHERE tenant_id = ? AND job_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched'").run(canonicalJson(receipt), input.tenantId, input.jobId, requestDigest, workerId, generation).changes;
  if (changed !== 1) throw new Error("post_trained_training_checkpoint_conflict");
}
function sqliteNow(db: AppDb): number { return (db.raw.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms").get() as { now_ms: number }).now_ms; }

function validateExchange(exchange: PostTrainedReconciliation, input: PostTrainedTrainingInput, requestDigest: string, generation: number, deps: PostTrainedTrainingDependencies): PostTrainedTrainerResolution {
  if (!exchange || typeof exchange !== "object" || !exchange.receipt || !exchange.result) throw new Error("post_trained_training_receipt_invalid");
  const receipt = exchange.receipt;
  if (receipt.tenantId !== input.tenantId || receipt.jobId !== input.jobId || receipt.requestDigest !== requestDigest || receipt.leaseGeneration !== generation || receipt.outcome !== exchange.result.status || receipt.resultDigest !== postTrainedReconciliationResultDigest(exchange.result) || !Number.isFinite(Date.parse(receipt.observedAt)) || typeof receipt.signature !== "string" || !receipt.signature.trim() || !deps.verifyReconciliation(deepFreeze(structuredClone(receipt)))) throw new Error("post_trained_training_receipt_invalid");
  return deepFreeze(structuredClone(exchange.result));
}

function resolveCorpus(db: AppDb, input: PostTrainedTrainingInput) {
  let totalBytes = 0; let totalExamples = 0;
  const corpus = input.corpusArtifactIds.map((artifactId) => {
    const row = db.raw.prepare("SELECT id, kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(input.tenantId, artifactId) as { id: string; kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
    const actualBytes = row?.content_text ? Buffer.byteLength(row.content_text) : 0;
    if (!row?.content_text || !CORPUS_KINDS.has(row.kind) || actualBytes !== row.size_bytes || actualBytes > MAX_CORPUS_ARTIFACT_BYTES || sha256(row.content_text) !== row.sha256) throw new Error("post_trained_training_corpus_not_authoritative");
    totalBytes += actualBytes;
    let parsed: unknown; try { parsed = JSON.parse(row.content_text); } catch { throw new Error("post_trained_training_corpus_invalid"); }
    const samples = parsed && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).samples) ? (parsed as { samples: unknown[] }).samples.length : 0;
    if (samples < 1) throw new Error("post_trained_training_corpus_invalid"); totalExamples += samples;
    return Object.freeze({ artifactId: row.id, sha256: row.sha256, content: row.content_text });
  });
  if (totalBytes > MAX_CORPUS_BYTES || totalExamples > input.recipe.maximumExamples) throw new Error("post_trained_training_corpus_limit_exceeded");
  return Object.freeze(corpus);
}
function validateInput(input: PostTrainedTrainingInput, deps: PostTrainedTrainingDependencies) {
  for (const value of [input.tenantId, input.jobId, input.adapterId, input.actorPrincipalId, input.idempotencyKey, input.baseModelId, input.datasetId, input.purpose, input.residencyRegion, deps.workerId]) if (!value?.trim()) throw new Error("post_trained_training_input_invalid");
  if (!Number.isFinite(Date.parse(input.submittedAt)) || !input.corpusArtifactIds.length || input.corpusArtifactIds.length > MAX_CORPUS_ARTIFACTS || new Set(input.corpusArtifactIds).size !== input.corpusArtifactIds.length || !Number.isSafeInteger(input.recipe.epochs) || input.recipe.epochs < 1 || input.recipe.epochs > 100 || !Number.isSafeInteger(input.recipe.maximumExamples) || input.recipe.maximumExamples < 1 || input.recipe.maximumExamples > 1_000_000 || !Number.isSafeInteger(input.recipe.seed) || !Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 300_000 || !Number.isSafeInteger(deps.leaseMs) || deps.leaseMs < deps.timeoutMs * 2 || deps.leaseMs > 3_600_000) throw new Error("post_trained_training_input_invalid");
}
function validateCompletion(value: PostTrainedTrainingCompletion) {
  decodeCanonicalBase64(value.adapterBase64);
  if (!value.evaluation.passed || !value.canary.passed || !Number.isFinite(Date.parse(value.completedAt)) || !Number.isFinite(Date.parse(value.canary.observedAt)) || Date.parse(value.canary.observedAt) > Date.parse(value.completedAt) || !value.evaluation.reportRef?.trim() || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || !Array.isArray(value.canary.evidenceRefs) || !value.canary.evidenceRefs.length || ![value.evaluation.successRate, value.evaluation.regressionRate].every((number) => Number.isFinite(number) && number >= 0 && number <= 1)) throw new Error("post_trained_training_result_invalid");
}
function decodeCanonicalBase64(value: string): Buffer { if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("post_trained_training_result_invalid"); const bytes = Buffer.from(value, "base64"); if (bytes.length < 1 || bytes.length > MAX_ADAPTER_BYTES || bytes.toString("base64") !== value) throw new Error("post_trained_training_result_invalid"); return bytes; }
async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("post_trained_training_timeout")); }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
