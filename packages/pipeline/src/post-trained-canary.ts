import { createHash, randomBytes } from "node:crypto";
import { appendDomainEvent, insertArtifactManifest, insertEvidenceRecord, verifyDomainEventIntegrity, type AppDb } from "@mendpoint/db";

export type PostTrainedCanaryInput = Readonly<{
  tenantId: string; canaryId: string; adapterId: string; trainingJobId: string; evaluationId: string;
  actorPrincipalId: string; idempotencyKey: string; requestedAt: string; servingRevision: string;
  mode: "shadow" | "canary"; allocationPercent: number;
  policy: Readonly<{ minimumSuccessRate: number; maximumErrorRate: number; maximumPolicyViolations: number; maximumP95LatencyMs: number; maximumCostUsd: number }>;
}>;
export type PostTrainedCanaryReport = Readonly<{
  adapterId: string; adapterDigest: string; evaluationArtifactId: string; servingRevision: string;
  mode: "shadow" | "canary"; allocationPercent: number; sampleCount: number; successRate: number;
  errorRate: number; policyViolationCount: number; p95LatencyMs: number; costUsd: number; evidenceRefs: readonly string[];
}>;
export type PostTrainedCanaryResult = Readonly<{ status: "completed"; report: PostTrainedCanaryReport; completedAt: string }> | Readonly<{ status: "failed"; code: string; evidenceRefs: readonly string[]; completedAt: string }> | Readonly<{ status: "pending" }> | Readonly<{ status: "safe_to_run" }>;
export type PostTrainedCanaryReceipt = Readonly<{ canaryId: string; authorityId: string; requestDigest: string; outcome: PostTrainedCanaryResult["status"]; resultDigest: string; observedAt: string; signature: string }>;
export type PostTrainedCanaryExchange = Readonly<{ result: PostTrainedCanaryResult; receipt: PostTrainedCanaryReceipt }>;
export type PostTrainedCanaryRequest = Readonly<{
  canaryId: string; requestDigest: string; authorityId: string; adapter: Readonly<{ adapterId: string; artifactId: string; artifactDigest: string; contentBase64: string }>;
  evaluation: Readonly<{ evaluationId: string; artifactId: string }>; servingRevision: string; mode: "shadow" | "canary";
  allocationPercent: number; policy: PostTrainedCanaryInput["policy"]; signal: AbortSignal;
}>;
export type PostTrainedCanaryDependencies = Readonly<{
  enabled?: boolean; workerId: string; authorityId: string; timeoutMs: number; leaseMs: number;
  expected: Readonly<{ servingRevision: string; mode: PostTrainedCanaryInput["mode"]; allocationPercent: number; policy: PostTrainedCanaryInput["policy"] }>;
  runner: Readonly<{ run(input: PostTrainedCanaryRequest): Promise<PostTrainedCanaryExchange>; reconcile(input: Readonly<{ canaryId: string; requestDigest: string; authorityId: string; signal: AbortSignal }>): Promise<PostTrainedCanaryExchange> }>;
  verifyReceipt(receipt: PostTrainedCanaryReceipt): boolean;
}>;
export type PostTrainedCanaryRecord = Readonly<{ tenantId: string; canaryId: string; adapterId: string; servingRevision: string; mode: "shadow" | "canary"; status: "passed" | "failed"; observedAt: string; evidenceRefs: readonly string[] }>;

const PROCESS_ID = randomBytes(16).toString("hex");
const ACTIVE = new Set<string>();
const EFFECT_TABLE = `CREATE TABLE IF NOT EXISTS post_trained_canary_effects (
  tenant_id TEXT NOT NULL, canary_id TEXT NOT NULL, request_digest TEXT NOT NULL, owner_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL, lease_expires_at_ms INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('dispatched','settled')), receipt_json TEXT,
  PRIMARY KEY (tenant_id, canary_id)
) STRICT`;

export async function runPostTrainedCanary(db: AppDb, input: PostTrainedCanaryInput, dependencies: PostTrainedCanaryDependencies): Promise<PostTrainedCanaryRecord> {
  validateInput(input, dependencies); if (dependencies.enabled !== true) throw new Error("post_trained_canary_disabled");
  const replay = getPostTrainedCanary(db, input.tenantId, input.canaryId); if (replay) return replay;
  const authority = readAuthority(db, input);
  const requestDigest = sha256(canonicalJson({ ...input, requestedAt: undefined, authority }));
  appendRequested(db, input, requestDigest, authority, dependencies.authorityId);
  const activeKey = `${input.tenantId}\0${input.canaryId}\0${dependencies.workerId}`;
  if (ACTIVE.has(activeKey)) throw new Error("post_trained_canary_lease_held"); ACTIVE.add(activeKey);
  try {
    const ownerId = `${dependencies.workerId}:${PROCESS_ID}`; const claim = claimEffect(db, input, requestDigest, ownerId, dependencies.leaseMs);
    if (!claim.owned) throw new Error("post_trained_canary_lease_held");
    const request = (signal: AbortSignal): PostTrainedCanaryRequest => ({ canaryId: input.canaryId, requestDigest, authorityId: dependencies.authorityId, adapter: authority.adapter, evaluation: authority.evaluation, servingRevision: input.servingRevision, mode: input.mode, allocationPercent: input.allocationPercent, policy: input.policy, signal });
    const exchange = claim.dispatch
      ? await bounded(dependencies.timeoutMs, (signal) => dependencies.runner.run(request(signal)))
      : await bounded(dependencies.timeoutMs, (signal) => dependencies.runner.reconcile({ canaryId: input.canaryId, requestDigest, authorityId: dependencies.authorityId, signal }));
    let result = validateExchange(exchange, input, requestDigest, authority, dependencies); let receipt = exchange.receipt;
    if (result.status === "safe_to_run") {
      const retry = await bounded(dependencies.timeoutMs, (signal) => dependencies.runner.run(request(signal)));
      result = validateExchange(retry, input, requestDigest, authority, dependencies); receipt = retry.receipt;
    }
    if (result.status === "pending") throw new Error("post_trained_canary_outcome_unknown");
    if (result.status === "safe_to_run") throw new Error("post_trained_canary_result_invalid");
    if (result.status === "failed") return settleFailure(db, input, requestDigest, ownerId, claim.generation, receipt, result);
    return settle(db, input, requestDigest, ownerId, claim.generation, receipt, result, authority);
  } finally { ACTIVE.delete(activeKey); }
}

export function getPostTrainedCanary(db: AppDb, tenantId: string, canaryId: string): PostTrainedCanaryRecord | undefined {
  const row = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_canary_run' AND aggregate_id = ? AND event_type = 'post_trained_canary_run.completed' ORDER BY event_sequence DESC LIMIT 1").get(tenantId, canaryId) as { payload_json: string } | undefined;
  if (!row) return undefined; const payload = JSON.parse(row.payload_json) as Omit<PostTrainedCanaryRecord, "tenantId" | "canaryId">;
  return deepFreeze({ tenantId, canaryId, ...payload });
}
export function postTrainedCanaryResultDigest(result: PostTrainedCanaryResult): string { return sha256(canonicalJson(result)); }
export function postTrainedCanaryReceiptSigningBytes(receipt: PostTrainedCanaryReceipt): Buffer { return Buffer.from(canonicalJson({ ...receipt, signature: undefined }), "utf8"); }

function readAuthority(db: AppDb, input: PostTrainedCanaryInput) {
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("post_trained_canary_event_integrity_invalid");
  const training = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ? AND event_type = 'post_trained_training.completed' ORDER BY event_sequence DESC LIMIT 1").get(input.tenantId, input.trainingJobId) as { payload_json: string } | undefined;
  const evaluation = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_evaluation' AND aggregate_id = ? AND event_type = 'post_trained_evaluation.completed' ORDER BY event_sequence DESC LIMIT 1").get(input.tenantId, input.evaluationId) as { payload_json: string } | undefined;
  if (!training || !evaluation) throw new Error("post_trained_canary_authority_missing");
  const trained = JSON.parse(training.payload_json) as { artifactId?: string; adapterDigest?: string };
  const evaluated = JSON.parse(evaluation.payload_json) as { artifactId?: string; trainingJobId?: string; adapterId?: string; passed?: boolean; overlapCount?: number };
  if (!trained.artifactId || !/^sha256:[a-f0-9]{64}$/u.test(trained.adapterDigest ?? "") || !evaluated.artifactId || evaluated.trainingJobId !== input.trainingJobId || evaluated.adapterId !== input.adapterId || evaluated.passed !== true || evaluated.overlapCount !== 0) throw new Error("post_trained_canary_authority_invalid");
  const adapter = exactArtifact(db, input.tenantId, trained.artifactId, "post_trained_adapter_artifact");
  const report = exactArtifact(db, input.tenantId, evaluated.artifactId, "post_trained_independent_evaluation");
  let envelope: unknown; try { envelope = JSON.parse(adapter.content_text!); } catch { throw new Error("post_trained_canary_adapter_invalid"); }
  const wrapped = envelope && typeof envelope === "object" && !Array.isArray(envelope) ? envelope as { encoding?: unknown; bytes?: unknown; decodedSha256?: unknown } : undefined;
  if (wrapped?.encoding !== "base64" || typeof wrapped.bytes !== "string" || wrapped.decodedSha256 !== trained.adapterDigest) throw new Error("post_trained_canary_adapter_invalid");
  const bytes = Buffer.from(wrapped.bytes, "base64");
  if (!bytes.length || bytes.toString("base64") !== wrapped.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== trained.adapterDigest) throw new Error("post_trained_canary_adapter_invalid");
  return deepFreeze({ adapter: { adapterId: input.adapterId, artifactId: adapter.id, artifactDigest: trained.adapterDigest!, contentBase64: wrapped.bytes }, evaluation: { evaluationId: input.evaluationId, artifactId: report.id } });
}
function exactArtifact(db: AppDb, tenantId: string, id: string, kind: string) { const row = db.raw.prepare("SELECT id, kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(tenantId, id) as { id: string; kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined; if (!row?.content_text || row.kind !== kind || sha256(row.content_text) !== row.sha256 || Buffer.byteLength(row.content_text) !== row.size_bytes) throw new Error("post_trained_canary_artifact_invalid"); return row; }
function validateExchange(exchange: PostTrainedCanaryExchange, input: PostTrainedCanaryInput, requestDigest: string, authority: ReturnType<typeof readAuthority>, deps: PostTrainedCanaryDependencies): PostTrainedCanaryResult {
  if (!exchange?.receipt || !exchange.result) throw new Error("post_trained_canary_receipt_invalid"); const receipt = exchange.receipt;
  if (receipt.canaryId !== input.canaryId || receipt.authorityId !== deps.authorityId || receipt.requestDigest !== requestDigest || receipt.outcome !== exchange.result.status || receipt.resultDigest !== postTrainedCanaryResultDigest(exchange.result) || new Date(receipt.observedAt).toISOString() !== receipt.observedAt || !deps.verifyReceipt(deepFreeze(structuredClone(receipt)))) throw new Error("post_trained_canary_receipt_invalid");
  const result = deepFreeze(structuredClone(exchange.result)); if (result.status !== "completed") return result; const report = result.report;
  if (report.adapterId !== input.adapterId || report.adapterDigest !== authority.adapter.artifactDigest || report.evaluationArtifactId !== authority.evaluation.artifactId || report.servingRevision !== input.servingRevision || report.mode !== input.mode || report.allocationPercent !== input.allocationPercent) throw new Error("post_trained_canary_binding_mismatch");
  if (!Number.isSafeInteger(report.sampleCount) || report.sampleCount < 1 || !rate(report.successRate) || !rate(report.errorRate) || !Number.isSafeInteger(report.policyViolationCount) || report.policyViolationCount < 0 || !Number.isFinite(report.p95LatencyMs) || report.p95LatencyMs < 0 || !Number.isFinite(report.costUsd) || report.costUsd < 0 || !Array.isArray(report.evidenceRefs) || !report.evidenceRefs.length || report.evidenceRefs.length > 128 || report.evidenceRefs.some((value) => typeof value !== "string" || !value.trim() || value.length > 1_024)) throw new Error("post_trained_canary_result_invalid"); return result;
}
function settle(db: AppDb, input: PostTrainedCanaryInput, requestDigest: string, ownerId: string, generation: number, receipt: PostTrainedCanaryReceipt, result: Extract<PostTrainedCanaryResult, { status: "completed" }>, authority: ReturnType<typeof readAuthority>): PostTrainedCanaryRecord {
  const passed = result.report.successRate >= input.policy.minimumSuccessRate && result.report.errorRate <= input.policy.maximumErrorRate && result.report.policyViolationCount <= input.policy.maximumPolicyViolations && result.report.p95LatencyMs <= input.policy.maximumP95LatencyMs && result.report.costUsd <= input.policy.maximumCostUsd;
  const content = canonicalJson({ schemaVersion: 1, kind: "post_trained_canary_report", canaryId: input.canaryId, requestDigest, canaryAuthorityId: receipt.authorityId, authority: { adapter: { adapterId: authority.adapter.adapterId, artifactId: authority.adapter.artifactId, artifactDigest: authority.adapter.artifactDigest }, evaluation: authority.evaluation }, policy: input.policy, report: result.report, passed, completedAt: result.completedAt }); const artifactId = `canary_${sha256(content)}`; const evidenceId = `evidence_${sha256(`${input.canaryId}\0${artifactId}`)}`;
  db.raw.exec("BEGIN IMMEDIATE"); try {
    assertLease(db, input, requestDigest, ownerId, generation);
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_canary_report", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-canary+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: result.completedAt });
    insertEvidenceRecord(db, { id: evidenceId, tenantId: input.tenantId, subjectType: "post_trained_canary", subjectId: input.adapterId, artifactId, inputArtifactId: authority.evaluation.artifactId, producerPrincipalId: input.actorPrincipalId, tool: "post-trained-canary-runner", toolVersion: "1", verdict: passed ? "passed" : "failed", createdAt: result.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.canaryId}\0run-completed`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_canary_run.completed", aggregateType: "post_trained_canary_run", aggregateId: input.canaryId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-canary:${input.idempotencyKey}:run-completed`, payload: { adapterId: input.adapterId, servingRevision: input.servingRevision, mode: input.mode, status: passed ? "passed" : "failed", observedAt: result.completedAt, evidenceRefs: [evidenceId] }, createdAt: result.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.canaryId}\0adapter-completed`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_canary.completed", aggregateType: "post_trained_canary", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-canary:${input.idempotencyKey}:adapter-completed`, payload: { canaryId: input.canaryId, adapterDigest: authority.adapter.artifactDigest, servingRevision: input.servingRevision, passed, observedAt: result.completedAt, evidenceRefs: [evidenceId] }, createdAt: result.completedAt });
    const changed = db.raw.prepare("UPDATE post_trained_canary_effects SET phase = 'settled', receipt_json = ? WHERE tenant_id = ? AND canary_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched'").run(canonicalJson(receipt), input.tenantId, input.canaryId, requestDigest, ownerId, generation).changes; if (changed !== 1) throw new Error("post_trained_canary_lease_lost"); db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedCanary(db, input.tenantId, input.canaryId)!;
}
function settleFailure(db: AppDb, input: PostTrainedCanaryInput, requestDigest: string, ownerId: string, generation: number, receipt: PostTrainedCanaryReceipt, result: Extract<PostTrainedCanaryResult, { status: "failed" }>): PostTrainedCanaryRecord {
  const content = canonicalJson({ schemaVersion: 1, kind: "post_trained_canary_failure", canaryId: input.canaryId, requestDigest, canaryAuthorityId: receipt.authorityId, code: result.code, evidenceRefs: result.evidenceRefs, completedAt: result.completedAt });
  const artifactId = `canary_${sha256(content)}`; const evidenceId = `evidence_${sha256(`${input.canaryId}\0${artifactId}`)}`;
  db.raw.exec("BEGIN IMMEDIATE"); try {
    assertLease(db, input, requestDigest, ownerId, generation);
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_canary_failure", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-canary-failure+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: result.completedAt });
    insertEvidenceRecord(db, { id: evidenceId, tenantId: input.tenantId, subjectType: "post_trained_canary", subjectId: input.adapterId, artifactId, producerPrincipalId: input.actorPrincipalId, tool: "post-trained-canary-runner", toolVersion: "1", verdict: "failed", createdAt: result.completedAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.canaryId}\0run-failed`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_canary_run.completed", aggregateType: "post_trained_canary_run", aggregateId: input.canaryId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-canary:${input.idempotencyKey}:run-completed`, payload: { adapterId: input.adapterId, servingRevision: input.servingRevision, mode: input.mode, status: "failed", observedAt: result.completedAt, evidenceRefs: [evidenceId] }, createdAt: result.completedAt });
    const changed = db.raw.prepare("UPDATE post_trained_canary_effects SET phase = 'settled', receipt_json = ? WHERE tenant_id = ? AND canary_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched'").run(canonicalJson(receipt), input.tenantId, input.canaryId, requestDigest, ownerId, generation).changes; if (changed !== 1) throw new Error("post_trained_canary_lease_lost"); db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedCanary(db, input.tenantId, input.canaryId)!;
}
function appendRequested(db: AppDb, input: PostTrainedCanaryInput, requestDigest: string, authority: ReturnType<typeof readAuthority>, authorityId: string) { const key = `post-trained-canary:${input.idempotencyKey}:requested`; const existing = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?").get(input.tenantId, key) as { payload_json: string } | undefined; if (existing) { if ((JSON.parse(existing.payload_json) as { requestDigest?: string }).requestDigest !== requestDigest) throw new Error("post_trained_canary_idempotency_conflict"); return; } appendDomainEvent(db, { id: `event_${sha256(`${input.canaryId}\0requested`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_canary.requested", aggregateType: "post_trained_canary_run", aggregateId: input.canaryId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: key, payload: { requestDigest, canaryAuthorityId: authorityId, authority: { adapter: { adapterId: authority.adapter.adapterId, artifactId: authority.adapter.artifactId, artifactDigest: authority.adapter.artifactDigest }, evaluation: authority.evaluation }, servingRevision: input.servingRevision, mode: input.mode, allocationPercent: input.allocationPercent, policy: input.policy, requestedAt: input.requestedAt }, createdAt: input.requestedAt }); }
function claimEffect(db: AppDb, input: PostTrainedCanaryInput, requestDigest: string, ownerId: string, leaseMs: number) { db.raw.exec(EFFECT_TABLE); if (db.raw.isTransaction) throw new Error("post_trained_canary_ambient_transaction"); db.raw.exec("BEGIN IMMEDIATE"); try { const now = sqliteNow(db); const row = db.raw.prepare("SELECT request_digest, owner_id, lease_generation, lease_expires_at_ms, phase FROM post_trained_canary_effects WHERE tenant_id = ? AND canary_id = ?").get(input.tenantId, input.canaryId) as { request_digest: string; owner_id: string; lease_generation: number; lease_expires_at_ms: number; phase: string } | undefined; if (!row) { db.raw.prepare("INSERT INTO post_trained_canary_effects (tenant_id, canary_id, request_digest, owner_id, lease_generation, lease_expires_at_ms, phase) VALUES (?, ?, ?, ?, 1, ?, 'dispatched')").run(input.tenantId, input.canaryId, requestDigest, ownerId, now + leaseMs); db.raw.exec("COMMIT"); return { owned: true, dispatch: true, generation: 1 }; } if (row.request_digest !== requestDigest) throw new Error("post_trained_canary_idempotency_conflict"); if (row.phase === "settled") { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; } if (row.owner_id === ownerId && row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation: row.lease_generation }; } if (row.lease_expires_at_ms > now) { db.raw.exec("COMMIT"); return { owned: false, dispatch: false, generation: row.lease_generation }; } const generation = row.lease_generation + 1; const changed = db.raw.prepare("UPDATE post_trained_canary_effects SET owner_id = ?, lease_generation = ?, lease_expires_at_ms = ? WHERE tenant_id = ? AND canary_id = ? AND request_digest = ? AND phase = 'dispatched' AND lease_generation = ? AND lease_expires_at_ms <= ?").run(ownerId, generation, now + leaseMs, input.tenantId, input.canaryId, requestDigest, row.lease_generation, now).changes; if (changed !== 1) throw new Error("post_trained_canary_lease_lost"); db.raw.exec("COMMIT"); return { owned: true, dispatch: false, generation }; } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; } }
function assertLease(db: AppDb, input: PostTrainedCanaryInput, requestDigest: string, ownerId: string, generation: number) { if (!db.raw.prepare("SELECT 1 FROM post_trained_canary_effects WHERE tenant_id = ? AND canary_id = ? AND request_digest = ? AND owner_id = ? AND lease_generation = ? AND phase = 'dispatched' AND lease_expires_at_ms > ?").get(input.tenantId, input.canaryId, requestDigest, ownerId, generation, sqliteNow(db))) throw new Error("post_trained_canary_lease_lost"); }
function validateInput(input: PostTrainedCanaryInput, deps: PostTrainedCanaryDependencies) { for (const value of [input.tenantId, input.canaryId, input.adapterId, input.trainingJobId, input.evaluationId, input.actorPrincipalId, input.idempotencyKey, input.servingRevision, deps.workerId, deps.authorityId]) if (typeof value !== "string" || !value.trim()) throw new Error("post_trained_canary_input_invalid"); if (new Date(input.requestedAt).toISOString() !== input.requestedAt || !["shadow", "canary"].includes(input.mode) || !Number.isFinite(input.allocationPercent) || input.allocationPercent <= 0 || input.allocationPercent > (input.mode === "shadow" ? 100 : 25) || canonicalJson({ servingRevision: input.servingRevision, mode: input.mode, allocationPercent: input.allocationPercent, policy: input.policy }) !== canonicalJson(deps.expected) || !rate(input.policy.minimumSuccessRate) || !rate(input.policy.maximumErrorRate) || !Number.isSafeInteger(input.policy.maximumPolicyViolations) || input.policy.maximumPolicyViolations < 0 || !Number.isFinite(input.policy.maximumP95LatencyMs) || input.policy.maximumP95LatencyMs <= 0 || !Number.isFinite(input.policy.maximumCostUsd) || input.policy.maximumCostUsd < 0 || !Number.isSafeInteger(deps.timeoutMs) || deps.timeoutMs < 1 || !Number.isSafeInteger(deps.leaseMs) || deps.leaseMs < deps.timeoutMs * 2 || typeof deps.runner?.run !== "function" || typeof deps.runner?.reconcile !== "function" || typeof deps.verifyReceipt !== "function") throw new Error("post_trained_canary_input_invalid"); }
async function bounded<T>(timeoutMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> { const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([operation(controller.signal), new Promise<T>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("post_trained_canary_timeout")); }, timeoutMs); })]); } finally { if (timer) clearTimeout(timer); } }
function rate(value: number) { return Number.isFinite(value) && value >= 0 && value <= 1; }
function sqliteNow(db: AppDb) { return (db.raw.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms").get() as { now_ms: number }).now_ms; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
