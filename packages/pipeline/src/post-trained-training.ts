import { createHash, randomBytes } from "node:crypto";
import { appendDomainEvent, insertArtifactManifest, insertEvidenceRecord, type AppDb } from "@mendpoint/db";

export type PostTrainedTrainingInput = Readonly<{
  tenantId: string; jobId: string; adapterId: string; actorPrincipalId: string;
  idempotencyKey: string; submittedAt: string; baseModelId: string;
  datasetId: string; purpose: string; residencyRegion: string;
  trainingCorpusArtifactIds: readonly string[];
  validationArtifactId: string;
  holdoutArtifactId: string;
  splitManifestDigest: string;
  recipe: Readonly<{ epochs: number; maximumExamples: number; seed: number }>;
}>;
export type PostTrainedTrainingCompletion = Readonly<{
  status: "completed"; adapterBase64: string;
  evidenceRefs: readonly string[]; completedAt: string;
}>;
export type PostTrainedTrainerResolution = PostTrainedTrainingCompletion
  | Readonly<{ status: "failed"; code: string; evidenceRefs: readonly string[]; completedAt: string }>
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "safe_to_run" }>;
export type PostTrainedReconciliationReceipt = Readonly<{
  tenantId: string; jobId: string; requestDigest: string; leaseGeneration: number;
  authorityId: string;
  outcome: PostTrainedTrainerResolution["status"]; resultDigest: string;
  observedAt: string; signature: string;
}>;
export type PostTrainedReconciliation = Readonly<{ receipt: PostTrainedReconciliationReceipt; result: PostTrainedTrainerResolution }>;
export type PostTrainedTrainer = Readonly<{
  train(input: Readonly<{ jobId: string; adapterId: string; tenantId: string; requestDigest: string; leaseGeneration: number; authorityId: string; baseModelId: string; corpus: readonly Readonly<{ artifactId: string; sha256: string; content: string }>[]; recipe: PostTrainedTrainingInput["recipe"]; signal: AbortSignal }>): Promise<PostTrainedReconciliation>;
  reconcile(input: Readonly<{ jobId: string; tenantId: string; requestDigest: string; leaseGeneration: number; authorityId: string; signal: AbortSignal }>): Promise<PostTrainedReconciliation>;
}>;
export type PostTrainedTrainingDependencies = Readonly<{
  enabled?: boolean; timeoutMs: number; leaseMs: number; workerId: string;
  processingBoundary: "tenant_local" | "external";
  authorityId: string;
  authorizeDataset(input: Readonly<{
    tenantId: string; datasetId: string; purpose: string; residencyRegion: string;
    trainingCorpusArtifactIds: readonly string[]; validationArtifactId: string;
    holdoutArtifactId: string; splitManifestDigest: string;
    processingBoundary: "tenant_local" | "external"; at: string;
  }>): boolean;
  verifyReconciliation(receipt: PostTrainedReconciliationReceipt): boolean;
  trainer: PostTrainedTrainer;
}>;
export type PostTrainedTrainingJob = Readonly<{ tenantId: string; jobId: string; adapterId: string; requestDigest: string; status: "submitted" | "completed" | "failed"; submittedAt: string; completedAt?: string; adapterArtifactId?: string; adapterDigest?: string; evidenceRefs?: readonly string[]; failureCode?: string }>;

const MAX_ADAPTER_BYTES = 16 * 1024 * 1024;
const MAX_CORPUS_ARTIFACTS = 32;
const MAX_CORPUS_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_CORPUS_BYTES = 64 * 1024 * 1024;
const ACTIVE_EFFECTS = new Set<string>();
const PROCESS_INSTANCE_ID = randomBytes(16).toString("hex");
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS post_trained_training_effects (
  tenant_id TEXT NOT NULL, job_id TEXT NOT NULL, request_digest TEXT NOT NULL,
  owner_id TEXT NOT NULL, lease_generation INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')), receipt_json TEXT,
  PRIMARY KEY (tenant_id, job_id)
) STRICT`;

export async function runPostTrainedTrainingJob(db: AppDb, input: PostTrainedTrainingInput, deps: PostTrainedTrainingDependencies): Promise<PostTrainedTrainingJob> {
  const effectOwnerId = `${deps.workerId}:${PROCESS_INSTANCE_ID}`;
  const activeKey = `${input.tenantId}\0${input.jobId}\0${effectOwnerId}`;
  if (ACTIVE_EFFECTS.has(activeKey)) throw new Error("post_trained_training_lease_held");
  ACTIVE_EFFECTS.add(activeKey);
  try { return await runPostTrainedTrainingJobOwned(db, input, deps, effectOwnerId); }
  finally { ACTIVE_EFFECTS.delete(activeKey); }
}

async function runPostTrainedTrainingJobOwned(db: AppDb, input: PostTrainedTrainingInput, deps: PostTrainedTrainingDependencies, effectOwnerId: string): Promise<PostTrainedTrainingJob> {
  if (deps.enabled !== true) throw new Error("post_trained_training_disabled");
  validateInput(input, deps);
  if (typeof deps.trainer?.train !== "function" || typeof deps.trainer?.reconcile !== "function" || typeof deps.verifyReconciliation !== "function") throw new Error("post_trained_trainer_invalid");
  const requestDigest = sha256(canonicalJson({ ...input, submittedAt: undefined }));
  let current = getPostTrainedTrainingJob(db, input.tenantId, input.jobId);
  if (current && current.requestDigest !== requestDigest) throw new Error("post_trained_training_idempotency_conflict");
  if (current?.status === "completed" || current?.status === "failed") return current;
  const authority = resolveDatasetAuthority(db, input);
  const corpus = authority.training;
  if (!deps.authorizeDataset({ tenantId: input.tenantId, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, trainingCorpusArtifactIds: Object.freeze([...input.trainingCorpusArtifactIds]), validationArtifactId: input.validationArtifactId, holdoutArtifactId: input.holdoutArtifactId, splitManifestDigest: input.splitManifestDigest, processingBoundary: deps.processingBoundary, at: new Date().toISOString() })) throw new Error("post_trained_training_dataset_unauthorized");
  if (!current) {
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0submitted`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.submitted", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:submitted`, payload: { requestDigest, authorityId: deps.authorityId, adapterId: input.adapterId, submittedAt: input.submittedAt, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, trainingCorpus: corpus.map(({ artifactId, sha256 }) => ({ artifactId, sha256 })), validation: { artifactId: authority.validation.artifactId, sha256: authority.validation.sha256 }, holdout: { artifactId: authority.holdout.artifactId, sha256: authority.holdout.sha256 }, splitManifestDigest: input.splitManifestDigest, baseModelId: input.baseModelId, recipe: input.recipe }, createdAt: input.submittedAt });
    current = getPostTrainedTrainingJob(db, input.tenantId, input.jobId)!;
  }
  const claim = claimEffect(db, input.tenantId, input.jobId, requestDigest, effectOwnerId, deps.leaseMs);
  if (!claim.owned) throw new Error("post_trained_training_lease_held");
  let exchange: PostTrainedReconciliation;
  if (claim.dispatch) {
    exchange = await bounded(deps.timeoutMs, (signal) => deps.trainer.train({ jobId: input.jobId, adapterId: input.adapterId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, authorityId: deps.authorityId, baseModelId: input.baseModelId, corpus, recipe: input.recipe, signal }));
  } else {
    exchange = await bounded(deps.timeoutMs, (signal) => deps.trainer.reconcile({ jobId: input.jobId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, authorityId: deps.authorityId, signal }));
  }
  let resolution = validateExchange(exchange, input, requestDigest, claim.generation, deps);
  let receipt = exchange.receipt;
  if (resolution.status === "safe_to_run") {
    const retry = await bounded(deps.timeoutMs, (signal) => deps.trainer.train({ jobId: input.jobId, adapterId: input.adapterId, tenantId: input.tenantId, requestDigest, leaseGeneration: claim.generation, authorityId: deps.authorityId, baseModelId: input.baseModelId, corpus, recipe: input.recipe, signal }));
    resolution = validateExchange(retry, input, requestDigest, claim.generation, deps);
    receipt = retry.receipt;
  }
  if (resolution.status === "pending") throw new Error("post_trained_training_outcome_unknown");
  if (resolution.status === "safe_to_run") throw new Error("post_trained_training_result_invalid");
  if (resolution.status === "failed") return settleFailure(db, input, requestDigest, claim.generation, effectOwnerId, receipt, resolution);
  validateCompletion(resolution, input.submittedAt);
  return settleCompletion(db, input, requestDigest, claim.generation, effectOwnerId, receipt, resolution, corpus);
}

export function getPostTrainedTrainingJob(db: AppDb, tenantId: string, jobId: string): PostTrainedTrainingJob | undefined {
  const events = db.raw.prepare("SELECT event_type, payload_json, created_at FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ? ORDER BY event_sequence").all(tenantId, jobId) as Array<{ event_type: string; payload_json: string; created_at: string }>;
  if (!events.length) return undefined;
  const submitted = JSON.parse(events[0]!.payload_json) as { requestDigest: string; adapterId: string; submittedAt: string };
  const latest = events.at(-1)!; const payload = JSON.parse(latest.payload_json) as Record<string, unknown>;
  if (latest.event_type.endsWith(".completed")) return deepFreeze({ tenantId, jobId, adapterId: submitted.adapterId, requestDigest: submitted.requestDigest, status: "completed", submittedAt: submitted.submittedAt, completedAt: String(payload.completedAt), adapterArtifactId: String(payload.artifactId), adapterDigest: String(payload.adapterDigest), evidenceRefs: payload.evidenceRefs as string[] });
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
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0failed\0${resolution.code}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.failed", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:failed`, payload: { requestDigest, authorityId: receipt.authorityId, code: resolution.code, evidenceRefs: resolution.evidenceRefs, completedAt: resolution.completedAt }, createdAt: resolution.completedAt });
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
    appendDomainEvent(db, { id: `event_${sha256(`${input.jobId}\0completed\0${adapterDigest}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_training.completed", aggregateType: "post_trained_training_job", aggregateId: input.jobId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-training:${input.idempotencyKey}:completed`, payload: { requestDigest, authorityId: receipt.authorityId, artifactId, adapterDigest, datasetId: input.datasetId, purpose: input.purpose, residencyRegion: input.residencyRegion, evidenceRefs: resolution.evidenceRefs, completedAt: resolution.completedAt }, createdAt: resolution.completedAt });
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
  if (receipt.tenantId !== input.tenantId || receipt.jobId !== input.jobId || receipt.requestDigest !== requestDigest || receipt.leaseGeneration !== generation || receipt.authorityId !== deps.authorityId || receipt.outcome !== exchange.result.status || receipt.resultDigest !== postTrainedReconciliationResultDigest(exchange.result) || !canonicalTime(receipt.observedAt) || typeof receipt.signature !== "string" || !receipt.signature.trim() || !deps.verifyReconciliation(deepFreeze(structuredClone(receipt)))) throw new Error("post_trained_training_receipt_invalid");
  return deepFreeze(structuredClone(exchange.result));
}

type ResolvedCorpusArtifact = Readonly<{ artifactId: string; sha256: string; content: string; exampleIds: readonly string[] }>;

function resolveDatasetAuthority(db: AppDb, input: PostTrainedTrainingInput): Readonly<{
  training: readonly ResolvedCorpusArtifact[];
  validation: ResolvedCorpusArtifact;
  holdout: ResolvedCorpusArtifact;
}> {
  let totalBytes = 0; let totalExamples = 0;
  const resolve = (artifactId: string, expectedKind: string, expectedSplit: "train" | "validation" | "holdout", errorCode: string): ResolvedCorpusArtifact => {
    const row = db.raw.prepare("SELECT id, kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(input.tenantId, artifactId) as { id: string; kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
    const actualBytes = row?.content_text ? Buffer.byteLength(row.content_text) : 0;
    if (!row?.content_text || row.kind !== expectedKind || actualBytes !== row.size_bytes || actualBytes > MAX_CORPUS_ARTIFACT_BYTES || sha256(row.content_text) !== row.sha256) throw new Error(errorCode);
    totalBytes += actualBytes;
    let parsed: unknown; try { parsed = JSON.parse(row.content_text); } catch { throw new Error("post_trained_training_corpus_invalid"); }
    const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    const examples = object && Array.isArray(object.examples) ? object.examples : object && Array.isArray(object.samples) ? object.samples : [];
    if (examples.length < 1 || object?.datasetSplit !== expectedSplit || object?.splitManifestDigest !== input.splitManifestDigest) throw new Error(errorCode);
    const exampleIds = examples.map((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${expectedSplit}:${index}`;
      const candidate = (value as Record<string, unknown>).sourceEventId;
      return typeof candidate === "string" && candidate ? candidate : `${expectedSplit}:${index}`;
    });
    totalExamples += examples.length;
    return Object.freeze({ artifactId: row.id, sha256: row.sha256, content: row.content_text, exampleIds: Object.freeze(exampleIds) });
  };
  const corpus = input.trainingCorpusArtifactIds.map((artifactId) =>
    resolve(artifactId, "learning_dataset_corpus", "train", "post_trained_training_corpus_not_authoritative"));
  const validation = resolve(input.validationArtifactId, "learning_dataset_validation", "validation", "post_trained_training_validation_not_authoritative");
  const holdout = resolve(input.holdoutArtifactId, "learning_dataset_holdout", "holdout", "post_trained_training_holdout_not_authoritative");
  if (totalBytes > MAX_CORPUS_BYTES || totalExamples > input.recipe.maximumExamples) throw new Error("post_trained_training_corpus_limit_exceeded");
  const allIds = [...corpus.flatMap((artifact) => artifact.exampleIds), ...validation.exampleIds, ...holdout.exampleIds];
  if (new Set(allIds).size !== allIds.length) throw new Error("post_trained_training_split_overlap");
  return deepFreeze({ training: corpus, validation, holdout });
}
function validateInput(input: PostTrainedTrainingInput, deps: PostTrainedTrainingDependencies) {
  for (const value of [input.tenantId, input.jobId, input.adapterId, input.actorPrincipalId, input.idempotencyKey, input.baseModelId, input.datasetId, input.purpose, input.residencyRegion, deps.workerId]) if (!value?.trim()) throw new Error("post_trained_training_input_invalid");
  const artifactIds = [...(input.trainingCorpusArtifactIds ?? []), input.validationArtifactId, input.holdoutArtifactId];
  if (!canonicalTime(input.submittedAt) || !deps.authorityId?.trim() || !Array.isArray(input.trainingCorpusArtifactIds) || !input.trainingCorpusArtifactIds.length || input.trainingCorpusArtifactIds.length > MAX_CORPUS_ARTIFACTS || artifactIds.some((value) => typeof value !== "string" || !value.trim()) || new Set(artifactIds).size !== artifactIds.length || !/^[a-f0-9]{64}$/u.test(input.splitManifestDigest) || !["tenant_local", "external"].includes(deps.processingBoundary) || !Number.isSafeInteger(input.recipe.epochs) || input.recipe.epochs < 1 || input.recipe.epochs > 100 || !Number.isSafeInteger(input.recipe.maximumExamples) || input.recipe.maximumExamples < 1 || input.recipe.maximumExamples > 1_000_000 || !Number.isSafeInteger(input.recipe.seed) || !Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1 || deps.timeoutMs > 300_000 || !Number.isSafeInteger(deps.leaseMs) || deps.leaseMs < deps.timeoutMs * 2 || deps.leaseMs > 3_600_000) throw new Error("post_trained_training_input_invalid");
}
function validateCompletion(value: PostTrainedTrainingCompletion, submittedAt: string) {
  decodeCanonicalBase64(value.adapterBase64);
  if (!canonicalTime(value.completedAt) || Date.parse(value.completedAt) < Date.parse(submittedAt) || !Array.isArray(value.evidenceRefs) || !value.evidenceRefs.length || value.evidenceRefs.some((reference) => typeof reference !== "string" || !reference.trim())) throw new Error("post_trained_training_result_invalid");
}
function canonicalTime(value: unknown): value is string { if (typeof value !== "string") return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function decodeCanonicalBase64(value: string): Buffer { if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("post_trained_training_result_invalid"); const bytes = Buffer.from(value, "base64"); if (bytes.length < 1 || bytes.length > MAX_ADAPTER_BYTES || bytes.toString("base64") !== value) throw new Error("post_trained_training_result_invalid"); return bytes; }
async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("post_trained_training_timeout")); }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
