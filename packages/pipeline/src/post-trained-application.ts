import { createHash } from "node:crypto";
import { appendDomainEvent, insertArtifactManifest, insertEvidenceRecord, verifyDomainEventIntegrity, type AppDb, type ArtifactManifestRow } from "@mendpoint/db";
import {
  ExecutorRegistry,
  PostTrainedAdmissionError,
  resolvePostTrainedExecutor,
  routeTask,
  type AdapterLifecycleRecord,
  type ExecutorDescriptor,
  type PostTrainedConsentSnapshot,
  type RouterPolicySnapshot,
  type RouterTaskSpec,
} from "@mendpoint/platform";

export type PostTrainedAdapterManifest = Readonly<{
  tenantId: string;
  adapterId: string;
  trainingJobId: string;
  lifecycle: AdapterLifecycleRecord;
  consent: PostTrainedConsentSnapshot;
  descriptor: ExecutorDescriptor;
}>;

export type RegisterPostTrainedAdapterInput = PostTrainedAdapterManifest & Readonly<{
  actorPrincipalId: string;
  idempotencyKey: string;
  registeredAt: string;
}>;

export type PostTrainedApplicationConfig = Readonly<{
  enabled?: boolean;
  readConsent?(tenantId: string, datasetId: string, stored: PostTrainedConsentSnapshot): PostTrainedConsentSnapshot | undefined;
  verifyEvidence?(tenantId: string, evidenceRefs: readonly string[], expected: Readonly<{ subjectTypes: readonly string[]; subjectId: string; artifactIds?: readonly string[] }>): boolean;
  authorizeHumanApprover?(tenantId: string, principalId: string): boolean;
}>;

export function registerPostTrainedAdapter(db: AppDb, input: RegisterPostTrainedAdapterInput, config: PostTrainedApplicationConfig): PostTrainedAdapterManifest {
  requireEnabled(config);
  validateManifest(input);
  if (!db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_actor_invalid");
  if (typeof config.authorizeHumanApprover !== "function" || !config.authorizeHumanApprover(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_human_approval_required");
  const candidateLifecycle = { ...input.lifecycle, approver: undefined };
  const requestDigest = sha256(canonicalJson({ ...input, registeredAt: undefined, lifecycle: candidateLifecycle }));
  const replay = replayRegistration(db, input.tenantId, input.idempotencyKey, requestDigest);
  if (replay) return replay;
  if (typeof config.readConsent !== "function") throw new Error("post_trained_consent_authority_missing");
  const authoritativeConsent = config.readConsent(input.tenantId, input.lifecycle.trainingDataset.datasetId, input.consent);
  if (!authoritativeConsent) throw new Error("post_trained_consent_not_active");
  const candidate: PostTrainedAdapterManifest = { tenantId: input.tenantId, adapterId: input.adapterId, trainingJobId: input.trainingJobId, lifecycle: candidateLifecycle, consent: authoritativeConsent, descriptor: input.descriptor };
  assertTrainingCompletion(db, candidate);
  const evaluationId = assertIndependentEvaluation(db, candidate);
  assertCanaryEvidence(db, candidate);
  assertAuthoritativeEvidence(candidate, config, evaluationId);
  const approvalContent = canonicalJson({ schemaVersion: 1, kind: "post_trained_human_approval", tenantId: input.tenantId, adapterId: input.adapterId, trainingJobId: input.trainingJobId, candidateDigest: sha256(canonicalJson(candidate)), approverPrincipalId: input.actorPrincipalId, approvedAt: input.registeredAt });
  const approvalArtifactId = `approval_${sha256(approvalContent)}`;
  const approvalEvidenceId = `evidence_${sha256(`${input.tenantId}\0${input.adapterId}\0${approvalArtifactId}`)}`;
  const manifest: PostTrainedAdapterManifest = { ...candidate, lifecycle: { ...candidateLifecycle, approver: { principalId: input.actorPrincipalId, approvedAt: input.registeredAt, evidenceRef: approvalEvidenceId } } };
  validateManifestAdmission(manifest, input.registeredAt);
  const content = canonicalJson(manifest);
  const artifactId = `artifact_${sha256(`post-trained\0${input.tenantId}\0${input.adapterId}\0${requestDigest}`)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const raced = replayRegistration(db, input.tenantId, input.idempotencyKey, requestDigest);
    if (raced) { db.raw.exec("COMMIT"); return raced; }
    const existing = latestManifestRow(db, input.tenantId, input.adapterId);
    if (existing) throw new Error("post_trained_adapter_already_registered");
    insertArtifactManifest(db, { id: approvalArtifactId, tenantId: input.tenantId, kind: "post_trained_human_approval", schemaVersion: 1, sha256: sha256(approvalContent), mediaType: "application/vnd.mendpoint.post-trained-approval+json", sizeBytes: Buffer.byteLength(approvalContent), storageRef: `sqlite://artifact_manifests/${approvalArtifactId}#content_text`, content: approvalContent, producerPrincipalId: input.actorPrincipalId, createdAt: input.registeredAt });
    insertEvidenceRecord(db, { id: approvalEvidenceId, tenantId: input.tenantId, subjectType: "post_trained_approval", subjectId: input.adapterId, artifactId: approvalArtifactId, producerPrincipalId: input.actorPrincipalId, tool: "post-trained-human-promotion", toolVersion: "1", verdict: "passed", createdAt: input.registeredAt });
    appendDomainEvent(db, { id: `event_${sha256(`${approvalArtifactId}\0approved`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_adapter.approved", aggregateType: "post_trained_adapter", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-approve:${input.idempotencyKey}`, payload: { approvalArtifactId, approvalEvidenceId, candidateDigest: sha256(canonicalJson(candidate)), approvedAt: input.registeredAt }, createdAt: input.registeredAt });
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_adapter_manifest", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-adapter+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: input.registeredAt });
    appendDomainEvent(db, { id: `event_${sha256(`${artifactId}\0registered`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_adapter.registered", aggregateType: "post_trained_adapter", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-register:${input.idempotencyKey}`, payload: { artifactId, requestDigest, lifecycleRevision: input.lifecycle.revision, trainingJobId: input.trainingJobId, trainingArtifactDigest: input.lifecycle.artifactDigest }, createdAt: input.registeredAt });
    db.raw.exec("COMMIT");
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
  return freezeManifest(manifest);
}

export function rollbackPostTrainedAdapter(db: AppDb, input: Readonly<{ tenantId: string; adapterId: string; actorPrincipalId: string; expectedArtifactDigest: string; reason: string; idempotencyKey: string; rolledBackAt: string }>, config: PostTrainedApplicationConfig): PostTrainedAdapterManifest {
  requireEnabled(config);
  if (!input.reason.trim() || input.reason.length > 2_000 || new Date(input.rolledBackAt).toISOString() !== input.rolledBackAt || typeof config.authorizeHumanApprover !== "function" || !config.authorizeHumanApprover(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_human_approval_required");
  if (!db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_actor_invalid");
  const manifest = getPostTrainedAdapterStatus(db, input.tenantId, input.adapterId, { enabled: true });
  if (manifest.lifecycle.artifactDigest !== input.expectedArtifactDigest) throw new Error("post_trained_rollback_binding_mismatch");
  const requestDigest = sha256(canonicalJson({ ...input, rolledBackAt: undefined }));
  const key = `post-trained-rollback:${input.idempotencyKey}`;
  if (manifest.lifecycle.state === "rolled_back") {
    const existing = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ? AND aggregate_type = 'post_trained_adapter' AND aggregate_id = ? AND event_type = 'post_trained_adapter.rolled_back'").get(input.tenantId, key, input.adapterId) as { payload_json: string } | undefined;
    if (!existing || (JSON.parse(existing.payload_json) as { requestDigest?: string }).requestDigest !== requestDigest) throw new Error("post_trained_rollback_replay_mismatch");
    return manifest;
  }
  const rollbackContent = canonicalJson({ schemaVersion: 1, kind: "post_trained_human_rollback", tenantId: input.tenantId, adapterId: input.adapterId, expectedArtifactDigest: input.expectedArtifactDigest, reason: input.reason, actorPrincipalId: input.actorPrincipalId, rolledBackAt: input.rolledBackAt });
  const rollbackArtifactId = `rollback_${sha256(rollbackContent)}`;
  const rollbackEvidenceId = `evidence_${sha256(`${input.tenantId}\0${input.adapterId}\0${rollbackArtifactId}`)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?").get(input.tenantId, key) as { payload_json: string } | undefined;
    if (existing) {
      if ((JSON.parse(existing.payload_json) as { requestDigest?: string }).requestDigest !== requestDigest) throw new Error("post_trained_idempotency_conflict");
      db.raw.exec("COMMIT");
      return getPostTrainedAdapterStatus(db, input.tenantId, input.adapterId, { enabled: true });
    }
    insertArtifactManifest(db, { id: rollbackArtifactId, tenantId: input.tenantId, kind: "post_trained_human_rollback", schemaVersion: 1, sha256: sha256(rollbackContent), mediaType: "application/vnd.mendpoint.post-trained-rollback+json", sizeBytes: Buffer.byteLength(rollbackContent), storageRef: `sqlite://artifact_manifests/${rollbackArtifactId}#content_text`, content: rollbackContent, producerPrincipalId: input.actorPrincipalId, createdAt: input.rolledBackAt });
    insertEvidenceRecord(db, { id: rollbackEvidenceId, tenantId: input.tenantId, subjectType: "post_trained_rollback", subjectId: input.adapterId, artifactId: rollbackArtifactId, producerPrincipalId: input.actorPrincipalId, tool: "post-trained-human-rollback", toolVersion: "1", verdict: "passed", createdAt: input.rolledBackAt });
    appendDomainEvent(db, { id: `event_${sha256(`${input.tenantId}\0${input.adapterId}\0${key}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_adapter.rolled_back", aggregateType: "post_trained_adapter", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: key, payload: { requestDigest, expectedArtifactDigest: input.expectedArtifactDigest, reason: input.reason, rolledBackAt: input.rolledBackAt, rollbackArtifactId, rollbackEvidenceId }, createdAt: input.rolledBackAt });
    db.raw.exec("COMMIT");
  } catch (error) { if (db.raw.isTransaction) db.raw.exec("ROLLBACK"); throw error; }
  return getPostTrainedAdapterStatus(db, input.tenantId, input.adapterId, { enabled: true });
}

export function getPostTrainedAdapterStatus(db: AppDb, tenantId: string, adapterId: string, config: PostTrainedApplicationConfig): PostTrainedAdapterManifest {
  requireEnabled(config);
  const row = latestManifestRow(db, tenantId, adapterId);
  if (!row?.content_text || sha256(row.content_text) !== row.sha256) throw new Error(row ? "post_trained_manifest_corrupt" : "post_trained_adapter_not_found");
  const manifest = JSON.parse(row.content_text) as PostTrainedAdapterManifest;
  validateManifest(manifest);
  const rollback = db.raw.prepare("SELECT payload_json, actor_principal_id FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_adapter' AND aggregate_id = ? AND event_type = 'post_trained_adapter.rolled_back' ORDER BY event_sequence DESC LIMIT 1").get(tenantId, adapterId) as { payload_json: string; actor_principal_id: string } | undefined;
  if (!rollback) return freezeManifest(manifest);
  const payload = JSON.parse(rollback.payload_json) as { expectedArtifactDigest?: string; reason?: string; rolledBackAt?: string; rollbackArtifactId?: string; rollbackEvidenceId?: string };
  if (payload.expectedArtifactDigest !== manifest.lifecycle.artifactDigest || typeof payload.reason !== "string" || typeof payload.rolledBackAt !== "string" || typeof payload.rollbackArtifactId !== "string" || typeof payload.rollbackEvidenceId !== "string") throw new Error("post_trained_rollback_binding_mismatch");
  const artifact = db.raw.prepare("SELECT sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ? AND kind = 'post_trained_human_rollback'").get(tenantId, payload.rollbackArtifactId) as { sha256: string; size_bytes: number; content_text: string | null } | undefined;
  const evidence = db.raw.prepare("SELECT artifact_id, producer_principal_id, verdict FROM evidence_records WHERE tenant_id = ? AND id = ? AND subject_type = 'post_trained_rollback' AND subject_id = ?").get(tenantId, payload.rollbackEvidenceId, adapterId) as { artifact_id: string | null; producer_principal_id: string; verdict: string } | undefined;
  if (!artifact?.content_text || sha256(artifact.content_text) !== artifact.sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes || evidence?.artifact_id !== payload.rollbackArtifactId || evidence.producer_principal_id !== rollback.actor_principal_id || evidence.verdict !== "passed") throw new Error("post_trained_rollback_evidence_invalid");
  const authority = JSON.parse(artifact.content_text) as { tenantId?: string; adapterId?: string; expectedArtifactDigest?: string; reason?: string; actorPrincipalId?: string; rolledBackAt?: string };
  if (authority.tenantId !== tenantId || authority.adapterId !== adapterId || authority.expectedArtifactDigest !== manifest.lifecycle.artifactDigest || authority.reason !== payload.reason || authority.actorPrincipalId !== rollback.actor_principal_id || authority.rolledBackAt !== payload.rolledBackAt) throw new Error("post_trained_rollback_evidence_invalid");
  return freezeManifest({ ...manifest, lifecycle: { ...manifest.lifecycle, state: "rolled_back", revision: manifest.lifecycle.revision + 1, history: [...manifest.lifecycle.history, { revision: manifest.lifecycle.revision + 1, from: manifest.lifecycle.state, to: "rolled_back", actorId: rollback.actor_principal_id, occurredAt: payload.rolledBackAt, evidenceRefs: [payload.rollbackEvidenceId] }] } });
}

export function getPostTrainedAdapterEligibility(db: AppDb, input: Readonly<{ tenantId: string; adapterId: string; task: RouterTaskSpec; now: Date }>, config: PostTrainedApplicationConfig) {
  requireEnabled(config);
  try {
    const { manifest, admission } = admissionFor(db, input, config);
    return Object.freeze({ eligible: true as const, adapterId: manifest.adapterId, bindings: admission.bindings, executor: admission.executor });
  } catch (error) {
    if (error instanceof PostTrainedAdmissionError) return Object.freeze({ eligible: false as const, adapterId: input.adapterId, reason: error.code });
    throw error;
  }
}

export type PostTrainedLifecycleProofCheckpoint = Readonly<{
  eligible: true;
  adapterId: string;
  inputDigest: string;
  eligibilityRequestDigest: string;
  eligibilityObservationDigest: string;
  rollbackRequestDigest: string;
  eventId: string;
  eventHash: string;
  eventSequence: number;
  observedAt: string;
}>;

export function recordPostTrainedLifecycleProofCheckpoint(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    adapterId: string;
    actorPrincipalId: string;
    idempotencyKey: string;
    inputDigest: string;
    task: RouterTaskSpec;
    rollback: Readonly<{ expectedArtifactDigest: string; reason: string; idempotencyKey: string }>;
    observedAt: string;
  }>,
  config: PostTrainedApplicationConfig,
): PostTrainedLifecycleProofCheckpoint {
  requireEnabled(config);
  const task = input.task as RouterTaskSpec | undefined;
  const rollback = input.rollback as { expectedArtifactDigest?: unknown; reason?: unknown; idempotencyKey?: unknown } | undefined;
  const observedAt = Date.parse(input.observedAt);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.inputDigest) || !input.idempotencyKey.trim() || input.idempotencyKey.length > 200 || /[\r\n]/u.test(input.idempotencyKey) ||
      !rollback || typeof rollback.expectedArtifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(rollback.expectedArtifactDigest) ||
      typeof rollback.idempotencyKey !== "string" || !rollback.idempotencyKey.trim() || rollback.idempotencyKey.length > 200 || /[\r\n]/u.test(rollback.idempotencyKey) ||
      typeof rollback.reason !== "string" || !rollback.reason.trim() || rollback.reason.length > 2_000 || /[\r\n]/u.test(rollback.reason) ||
      !task || task.tenantId !== input.tenantId || !Number.isFinite(observedAt) || new Date(observedAt).toISOString() !== input.observedAt) {
    throw new Error("post_trained_proof_checkpoint_invalid");
  }
  if (!db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_actor_invalid");
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("post_trained_proof_checkpoint_integrity_invalid");
  const key = `post-trained-proof-checkpoint:${input.idempotencyKey}`;
  const eligibilityRequestDigest = `sha256:${sha256(canonicalJson({ task }))}`;
  const rollbackRequestDigest = `sha256:${sha256(canonicalJson(rollback))}`;
  const existing = db.raw.prepare("SELECT id, event_sequence, event_hash, actor_principal_id, payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ? AND aggregate_type = 'post_trained_lifecycle_proof' AND aggregate_id = ? AND event_type = 'post_trained_lifecycle_proof.eligibility_observed'").get(input.tenantId, key, input.adapterId) as { id: string; event_sequence: number; event_hash: string; actor_principal_id: string; payload_json: string } | undefined;
  if (existing) {
    if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("post_trained_proof_checkpoint_integrity_invalid");
    const payload = JSON.parse(existing.payload_json) as Record<string, unknown>;
    if (existing.actor_principal_id !== input.actorPrincipalId || payload.inputDigest !== input.inputDigest || payload.eligibilityRequestDigest !== eligibilityRequestDigest || payload.rollbackRequestDigest !== rollbackRequestDigest || payload.adapterId !== input.adapterId || payload.eligible !== true || typeof payload.eligibilityObservationDigest !== "string" || typeof payload.observedAt !== "string") throw new Error("post_trained_proof_checkpoint_replay_mismatch");
    return Object.freeze({ eligible: true, adapterId: input.adapterId, inputDigest: input.inputDigest, eligibilityRequestDigest, eligibilityObservationDigest: payload.eligibilityObservationDigest, rollbackRequestDigest, eventId: existing.id, eventHash: existing.event_hash, eventSequence: existing.event_sequence, observedAt: payload.observedAt });
  }
  const eligibility = getPostTrainedAdapterEligibility(db, { tenantId: input.tenantId, adapterId: input.adapterId, task, now: new Date(input.observedAt) }, config);
  if (eligibility.eligible !== true) throw new Error("post_trained_adapter_not_eligible");
  const eligibilityObservationDigest = `sha256:${sha256(canonicalJson(eligibility))}`;
  const payload = { adapterId: input.adapterId, eligible: true, inputDigest: input.inputDigest, eligibilityRequestDigest, eligibilityObservationDigest, rollbackRequestDigest, observedAt: input.observedAt };
  const event = appendDomainEvent(db, { id: `event_${sha256(`${input.tenantId}\0${input.adapterId}\0${key}`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_lifecycle_proof.eligibility_observed", aggregateType: "post_trained_lifecycle_proof", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: key, payload, createdAt: input.observedAt }).row;
  if (!verifyDomainEventIntegrity(db, input.tenantId).ok) throw new Error("post_trained_proof_checkpoint_integrity_invalid");
  return Object.freeze({ eligible: true, adapterId: input.adapterId, inputDigest: input.inputDigest, eligibilityRequestDigest, eligibilityObservationDigest, rollbackRequestDigest, eventId: event.id, eventHash: event.event_hash, eventSequence: event.event_sequence, observedAt: input.observedAt });
}

export function routePostTrainedAdapterDryRun(db: AppDb, input: Readonly<{ tenantId: string; adapterId: string; task: RouterTaskSpec; policy: RouterPolicySnapshot; remainingBudgetUsd: number; now: Date }>, config: PostTrainedApplicationConfig) {
  requireEnabled(config);
  const { admission } = admissionFor(db, input, config);
  const registry = new ExecutorRegistry(); registry.register(admission.executor);
  const outcome = routeTask({ task: input.task, policy: input.policy, registry, circuitBreaker: { allows: () => true }, remainingBudgetUsd: input.remainingBudgetUsd, decidedAt: input.now });
  if (outcome.action !== "execute" || outcome.plan.primary.executorId !== admission.executor.executorId) throw new Error("post_trained_route_not_eligible");
  const authorization = admission.preDispatchGuard.authorize({ task: input.task, executorId: outcome.plan.primary.executorId, executorKind: "adapter", executorVersion: outcome.plan.primary.executorVersion });
  return Object.freeze({ action: "execute" as const, dryRun: true as const, plan: outcome.plan, decision: outcome.decision, authorization });
}

function admissionFor(db: AppDb, input: Readonly<{ tenantId: string; adapterId: string; task: RouterTaskSpec; now: Date }>, config: PostTrainedApplicationConfig) {
  if (input.task.tenantId !== input.tenantId) throw new Error("post_trained_task_tenant_mismatch");
  const manifest = getPostTrainedAdapterStatus(db, input.tenantId, input.adapterId, config);
  if (manifest.lifecycle.state === "rolled_back") throw new PostTrainedAdmissionError("lifecycle_not_servable");
  const evaluationId = assertIndependentEvaluation(db, manifest);
  assertCanaryEvidence(db, manifest);
  assertAuthoritativeEvidence(manifest, config, evaluationId);
  if (typeof config.readConsent !== "function") throw new Error("post_trained_consent_authority_missing");
  const consentReader = config.readConsent;
  const source = {
    readLifecycle: (tenantId: string, adapterId: string) => tenantId === manifest.tenantId && adapterId === manifest.adapterId ? manifest.lifecycle : undefined,
    readConsent: (tenantId: string, datasetId: string) => consentReader(tenantId, datasetId, manifest.consent),
  };
  const expected = { lifecycleRevision: manifest.lifecycle.revision, artifactDigest: manifest.lifecycle.artifactDigest, servingRevision: manifest.lifecycle.servingRevision ?? "", baseModelId: manifest.lifecycle.baseModel.modelId, datasetId: manifest.lifecycle.trainingDataset.datasetId, consentRevision: manifest.consent.revision };
  const admission = resolvePostTrainedExecutor({ enabled: true, now: input.now, allowedTenantIds: [input.tenantId], allowedAdapterIds: [input.adapterId], adapterId: input.adapterId, expected, task: input.task, descriptor: manifest.descriptor, source, clock: () => input.now });
  return { manifest, admission };
}

function latestManifestRow(db: AppDb, tenantId: string, adapterId: string): ArtifactManifestRow | undefined {
  const event = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_adapter' AND aggregate_id = ? AND event_type = 'post_trained_adapter.registered' ORDER BY event_sequence DESC LIMIT 1").get(tenantId, adapterId) as { payload_json: string } | undefined;
  if (!event) return undefined;
  const artifactId = (JSON.parse(event.payload_json) as { artifactId?: string }).artifactId;
  return typeof artifactId === "string" ? db.raw.prepare("SELECT * FROM artifact_manifests WHERE tenant_id = ? AND id = ? AND kind = 'post_trained_adapter_manifest'").get(tenantId, artifactId) as ArtifactManifestRow | undefined : undefined;
}

function replayRegistration(db: AppDb, tenantId: string, key: string, digest: string): PostTrainedAdapterManifest | undefined {
  const event = db.raw.prepare("SELECT aggregate_id, payload_json FROM domain_events WHERE tenant_id = ? AND idempotency_key = ?").get(tenantId, `post-trained-register:${key}`) as { aggregate_id: string; payload_json: string } | undefined;
  if (!event) return undefined;
  const payload = JSON.parse(event.payload_json) as { requestDigest?: string };
  if (payload.requestDigest !== digest) throw new Error("post_trained_idempotency_conflict");
  return getPostTrainedAdapterStatus(db, tenantId, event.aggregate_id, { enabled: true });
}

function validateManifest(input: PostTrainedAdapterManifest): void {
  if (!input || !input.tenantId?.trim() || !input.adapterId?.trim() || !input.trainingJobId?.trim() || input.lifecycle?.tenantId !== input.tenantId || input.lifecycle?.adapterId !== input.adapterId || input.consent?.tenantId !== input.tenantId || input.consent?.datasetId !== input.lifecycle.trainingDataset.datasetId || input.descriptor?.kind !== "adapter") throw new Error("post_trained_manifest_invalid");
}

function assertTrainingCompletion(db: AppDb, manifest: PostTrainedAdapterManifest): void {
  if (!verifyDomainEventIntegrity(db, manifest.tenantId).ok) throw new Error("post_trained_training_event_integrity_invalid");
  const submittedEvent = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ? AND event_type = 'post_trained_training.submitted' ORDER BY event_sequence LIMIT 1").get(manifest.tenantId, manifest.trainingJobId) as { payload_json: string } | undefined;
  const event = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_training_job' AND aggregate_id = ? AND event_type = 'post_trained_training.completed' ORDER BY event_sequence DESC LIMIT 1").get(manifest.tenantId, manifest.trainingJobId) as { payload_json: string } | undefined;
  if (!submittedEvent || !event) throw new Error("post_trained_training_completion_missing");
  const submitted = JSON.parse(submittedEvent.payload_json) as { requestDigest?: string; adapterId?: string; baseModelId?: string; datasetId?: string; splitManifestDigest?: string };
  if (submitted.adapterId !== manifest.adapterId || submitted.baseModelId !== manifest.lifecycle.baseModel.modelId) throw new Error("post_trained_training_completion_mismatch");
  const payload = JSON.parse(event.payload_json) as { requestDigest?: string; artifactId?: string; adapterDigest?: string; datasetId?: string };
  if (!payload.artifactId || payload.requestDigest !== submitted.requestDigest || payload.adapterDigest !== manifest.lifecycle.artifactDigest || payload.datasetId !== submitted.datasetId || payload.datasetId !== manifest.lifecycle.trainingDataset.datasetId) throw new Error("post_trained_training_completion_mismatch");
  const artifact = db.raw.prepare("SELECT kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(manifest.tenantId, payload.artifactId) as { kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
  if (!artifact?.content_text || artifact.kind !== "post_trained_adapter_artifact" || sha256(artifact.content_text) !== artifact.sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) throw new Error("post_trained_training_artifact_invalid");
  let encoded: unknown; try { encoded = JSON.parse(artifact.content_text); } catch { throw new Error("post_trained_training_artifact_invalid"); }
  if (!encoded || typeof encoded !== "object") throw new Error("post_trained_training_artifact_invalid");
  const wrapper = encoded as { encoding?: unknown; bytes?: unknown; decodedSha256?: unknown };
  if (wrapper.encoding !== "base64" || typeof wrapper.bytes !== "string" || typeof wrapper.decodedSha256 !== "string" || wrapper.decodedSha256 !== payload.adapterDigest || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wrapper.bytes)) throw new Error("post_trained_training_artifact_invalid");
  const bytes = Buffer.from(wrapper.bytes, "base64");
  if (!bytes.length || bytes.toString("base64") !== wrapper.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== wrapper.decodedSha256) throw new Error("post_trained_training_artifact_invalid");
}
function assertIndependentEvaluation(db: AppDb, manifest: PostTrainedAdapterManifest): string {
  const binding = manifest.lifecycle.heldOutEvaluation;
  if (!binding?.reportRef) throw new Error("post_trained_independent_evaluation_missing");
  const artifact = db.raw.prepare("SELECT sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ? AND kind = 'post_trained_independent_evaluation'").get(manifest.tenantId, binding.reportRef) as { sha256: string; size_bytes: number; content_text: string | null } | undefined;
  if (!artifact?.content_text || sha256(artifact.content_text) !== artifact.sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) throw new Error("post_trained_independent_evaluation_invalid");
  const value = JSON.parse(artifact.content_text) as {
    schemaVersion?: number; kind?: string; evaluationId?: string; trainingJobId?: string;
    candidate?: { adapterId?: string; artifactDigest?: string }; passed?: boolean;
    report?: { successRate?: number; regressionRate?: number };
  };
  if (
    value.schemaVersion !== 1
    || value.kind !== "post_trained_independent_evaluation"
    || typeof value.evaluationId !== "string"
    || value.trainingJobId !== manifest.trainingJobId
    || value.candidate?.adapterId !== manifest.adapterId
    || value.candidate?.artifactDigest !== manifest.lifecycle.artifactDigest
    || value.passed !== binding.passed
    || value.report?.successRate !== binding.successRate
    || value.report?.regressionRate !== binding.regressionRate
  ) throw new Error("post_trained_independent_evaluation_mismatch");
  const event = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_evaluation' AND aggregate_id = ? AND event_type = 'post_trained_evaluation.completed' ORDER BY event_sequence DESC LIMIT 1").get(manifest.tenantId, value.evaluationId) as { payload_json: string } | undefined;
  const payload = event ? JSON.parse(event.payload_json) as { artifactId?: string; trainingJobId?: string; adapterId?: string; passed?: boolean } : undefined;
  if (!payload || payload.artifactId !== binding.reportRef || payload.trainingJobId !== manifest.trainingJobId || payload.adapterId !== manifest.adapterId || payload.passed !== true) throw new Error("post_trained_independent_evaluation_mismatch");
  return value.evaluationId;
}

function assertCanaryEvidence(db: AppDb, manifest: PostTrainedAdapterManifest): void {
  const canary = manifest.lifecycle.canaryEvidence;
  if (!canary) throw new Error("post_trained_canary_missing");
  const event = db.raw.prepare("SELECT payload_json FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'post_trained_canary' AND aggregate_id = ? AND event_type = 'post_trained_canary.completed' ORDER BY event_sequence DESC LIMIT 1").get(manifest.tenantId, manifest.adapterId) as { payload_json: string } | undefined;
  const payload = event ? JSON.parse(event.payload_json) as { adapterDigest?: string; servingRevision?: string; passed?: boolean; observedAt?: string; evidenceRefs?: readonly string[] } : undefined;
  if (!payload || payload.adapterDigest !== manifest.lifecycle.artifactDigest || payload.servingRevision !== manifest.lifecycle.servingRevision || payload.passed !== canary.passed || payload.observedAt !== canary.observedAt || canonicalJson(payload.evidenceRefs) !== canonicalJson(canary.evidenceRefs)) throw new Error("post_trained_canary_mismatch");
}
function validateManifestAdmission(manifest: PostTrainedAdapterManifest, registeredAt: string): void {
  const descriptor = manifest.descriptor;
  const task: RouterTaskSpec = {
    taskId: `registration:${manifest.adapterId}`,
    tenantId: manifest.tenantId,
    kind: "post_trained_registration_probe",
    goal: "Validate adapter registration authority",
    idempotencyKey: `registration:${manifest.adapterId}:${manifest.lifecycle.revision}`,
    inputArtifactIds: [],
    requiredCapabilities: [...descriptor.capabilities],
    allowedTools: [...descriptor.tools],
    context: { estimatedInputTokens: 1, maximumOutputTokens: 1 },
    verification: { requiredChecks: [], requireAll: true, onFailure: "human_handoff" },
    fallbackPolicy: { enabled: false, maxAttempts: 1, sameExecutorRetries: 0, retryableFailures: [], fallbackFailures: [] },
    privacy: { classification: "public", requiredRegion: descriptor.regions[0] },
    risk: "low",
    quality: { minimumScore: 0 },
    latency: { maximumMs: Math.max(1, descriptor.estimatedLatencyMs) },
    budget: { maximumUsd: Math.max(0, descriptor.estimatedCostUsd) },
  };
  resolvePostTrainedExecutor({ enabled: true, now: new Date(registeredAt), allowedTenantIds: [manifest.tenantId], allowedAdapterIds: [manifest.adapterId], adapterId: manifest.adapterId, expected: { lifecycleRevision: manifest.lifecycle.revision, artifactDigest: manifest.lifecycle.artifactDigest, servingRevision: manifest.lifecycle.servingRevision ?? "", baseModelId: manifest.lifecycle.baseModel.modelId, datasetId: manifest.lifecycle.trainingDataset.datasetId, consentRevision: manifest.consent.revision }, task, descriptor, source: { readLifecycle: () => manifest.lifecycle, readConsent: () => manifest.consent }, clock: () => new Date(registeredAt) });
}
function assertAuthoritativeEvidence(manifest: PostTrainedAdapterManifest, config: PostTrainedApplicationConfig, evaluationId: string): void {
  if (typeof config.verifyEvidence !== "function") throw new Error("post_trained_evidence_authority_missing");
  const lifecycle = manifest.lifecycle;
  const groups = [
    { refs: [...lifecycle.evidenceRefs, ...lifecycle.history.flatMap((event) => event.evidenceRefs)], subjectTypes: ["post_trained_adapter_lifecycle"], subjectId: manifest.adapterId },
    { refs: [...lifecycle.trainingDataset.lineageRefs, ...lifecycle.trainingDataset.sufficiency.evidenceRefs], subjectTypes: ["learning_dataset", "learning_dataset_version"], subjectId: lifecycle.trainingDataset.datasetId },
    { refs: [...lifecycle.trainingDataset.consent.evidenceRefs, ...manifest.consent.evidenceRefs], subjectTypes: ["learning_consent"], subjectId: lifecycle.trainingDataset.datasetId },
    { refs: [lifecycle.baseModel.evidenceRef], subjectTypes: ["base_model", "model_artifact"], subjectId: lifecycle.baseModel.modelId },
    { refs: [lifecycle.heldOutEvaluation?.reportRef], subjectTypes: ["post_trained_evaluation"], subjectId: evaluationId, artifactIds: [lifecycle.heldOutEvaluation?.reportRef].filter((value): value is string => Boolean(value)) },
    { refs: [...(lifecycle.canaryEvidence?.evidenceRefs ?? [])], subjectTypes: ["post_trained_canary"], subjectId: manifest.adapterId },
    { refs: [lifecycle.approvedInfrastructure?.evidenceRef], subjectTypes: ["post_trained_infrastructure"], subjectId: manifest.adapterId },
    { refs: [manifest.descriptor.health.evidenceRef], subjectTypes: ["post_trained_health"], subjectId: manifest.descriptor.executorId },
  ];
  for (const group of groups) {
    const refs = Object.freeze([...new Set(group.refs.filter((value): value is string => typeof value === "string" && value.length > 0))].sort());
    if (!refs.length || !config.verifyEvidence(manifest.tenantId, refs, { subjectTypes: Object.freeze(group.subjectTypes), subjectId: group.subjectId, ...(group.artifactIds ? { artifactIds: Object.freeze(group.artifactIds) } : {}) })) throw new Error("post_trained_evidence_not_authoritative");
  }
}
function requireEnabled(config: PostTrainedApplicationConfig): void { if (config.enabled !== true) throw new Error("post_trained_application_disabled"); }
function freezeManifest(value: PostTrainedAdapterManifest): PostTrainedAdapterManifest { return deepFreeze(structuredClone(value)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
