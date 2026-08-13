import { createHash } from "node:crypto";
import { appendDomainEvent, insertArtifactManifest, verifyDomainEventIntegrity, type AppDb, type ArtifactManifestRow } from "@mendpoint/db";
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
  verifyEvidence?(tenantId: string, evidenceRefs: readonly string[], expected: Readonly<{ subjectTypes: readonly string[]; subjectId: string }>): boolean;
}>;

export function registerPostTrainedAdapter(db: AppDb, input: RegisterPostTrainedAdapterInput, config: PostTrainedApplicationConfig): PostTrainedAdapterManifest {
  requireEnabled(config);
  validateManifest(input);
  if (!db.raw.prepare("SELECT 1 FROM principals WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL").get(input.tenantId, input.actorPrincipalId)) throw new Error("post_trained_actor_invalid");
  const requestDigest = sha256(canonicalJson({ ...input, registeredAt: undefined }));
  const replay = replayRegistration(db, input.tenantId, input.idempotencyKey, requestDigest);
  if (replay) return replay;
  if (typeof config.readConsent !== "function") throw new Error("post_trained_consent_authority_missing");
  const authoritativeConsent = config.readConsent(input.tenantId, input.lifecycle.trainingDataset.datasetId, input.consent);
  if (!authoritativeConsent) throw new Error("post_trained_consent_not_active");
  const manifest: PostTrainedAdapterManifest = { tenantId: input.tenantId, adapterId: input.adapterId, trainingJobId: input.trainingJobId, lifecycle: input.lifecycle, consent: authoritativeConsent, descriptor: input.descriptor };
  assertTrainingCompletion(db, manifest);
  assertAuthoritativeEvidence(manifest, config);
  validateManifestAdmission(manifest, input.registeredAt);
  const content = canonicalJson(manifest);
  const artifactId = `artifact_${sha256(`post-trained\0${input.tenantId}\0${input.adapterId}\0${requestDigest}`)}`;
  db.raw.exec("BEGIN IMMEDIATE");
  try {
    const raced = replayRegistration(db, input.tenantId, input.idempotencyKey, requestDigest);
    if (raced) { db.raw.exec("COMMIT"); return raced; }
    const existing = latestManifestRow(db, input.tenantId, input.adapterId);
    if (existing) throw new Error("post_trained_adapter_already_registered");
    insertArtifactManifest(db, { id: artifactId, tenantId: input.tenantId, kind: "post_trained_adapter_manifest", schemaVersion: 1, sha256: sha256(content), mediaType: "application/vnd.mendpoint.post-trained-adapter+json", sizeBytes: Buffer.byteLength(content), storageRef: `sqlite://artifact_manifests/${artifactId}#content_text`, content, producerPrincipalId: input.actorPrincipalId, createdAt: input.registeredAt });
    appendDomainEvent(db, { id: `event_${sha256(`${artifactId}\0registered`)}`, tenantId: input.tenantId, schemaVersion: 1, eventType: "post_trained_adapter.registered", aggregateType: "post_trained_adapter", aggregateId: input.adapterId, actorPrincipalId: input.actorPrincipalId, correlationId: input.idempotencyKey, idempotencyKey: `post-trained-register:${input.idempotencyKey}`, payload: { artifactId, requestDigest, lifecycleRevision: input.lifecycle.revision, trainingJobId: input.trainingJobId, trainingArtifactDigest: input.lifecycle.artifactDigest }, createdAt: input.registeredAt });
    db.raw.exec("COMMIT");
  } catch (error) { db.raw.exec("ROLLBACK"); throw error; }
  return freezeManifest(manifest);
}

export function getPostTrainedAdapterStatus(db: AppDb, tenantId: string, adapterId: string, config: PostTrainedApplicationConfig): PostTrainedAdapterManifest {
  requireEnabled(config);
  const row = latestManifestRow(db, tenantId, adapterId);
  if (!row?.content_text || sha256(row.content_text) !== row.sha256) throw new Error(row ? "post_trained_manifest_corrupt" : "post_trained_adapter_not_found");
  const manifest = JSON.parse(row.content_text) as PostTrainedAdapterManifest;
  validateManifest(manifest);
  return freezeManifest(manifest);
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
  assertAuthoritativeEvidence(manifest, config);
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
  const submitted = JSON.parse(submittedEvent.payload_json) as { adapterId?: string; baseModelId?: string };
  if (submitted.adapterId !== manifest.adapterId || submitted.baseModelId !== manifest.lifecycle.baseModel.modelId) throw new Error("post_trained_training_completion_mismatch");
  const payload = JSON.parse(event.payload_json) as { artifactId?: string; adapterDigest?: string; datasetId?: string; evaluation?: unknown; canary?: unknown };
  if (!payload.artifactId || payload.adapterDigest !== manifest.lifecycle.artifactDigest || payload.datasetId !== manifest.lifecycle.trainingDataset.datasetId
    || canonicalJson(payload.evaluation) !== canonicalJson(manifest.lifecycle.heldOutEvaluation)
    || canonicalJson(payload.canary) !== canonicalJson(manifest.lifecycle.canaryEvidence)) throw new Error("post_trained_training_completion_mismatch");
  const artifact = db.raw.prepare("SELECT kind, sha256, size_bytes, content_text FROM artifact_manifests WHERE tenant_id = ? AND id = ?").get(manifest.tenantId, payload.artifactId) as { kind: string; sha256: string; size_bytes: number; content_text: string | null } | undefined;
  if (!artifact?.content_text || artifact.kind !== "post_trained_adapter_artifact" || sha256(artifact.content_text) !== artifact.sha256 || Buffer.byteLength(artifact.content_text) !== artifact.size_bytes) throw new Error("post_trained_training_artifact_invalid");
  let encoded: unknown; try { encoded = JSON.parse(artifact.content_text); } catch { throw new Error("post_trained_training_artifact_invalid"); }
  if (!encoded || typeof encoded !== "object") throw new Error("post_trained_training_artifact_invalid");
  const wrapper = encoded as { encoding?: unknown; bytes?: unknown; decodedSha256?: unknown };
  if (wrapper.encoding !== "base64" || typeof wrapper.bytes !== "string" || typeof wrapper.decodedSha256 !== "string" || wrapper.decodedSha256 !== payload.adapterDigest || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(wrapper.bytes)) throw new Error("post_trained_training_artifact_invalid");
  const bytes = Buffer.from(wrapper.bytes, "base64");
  if (!bytes.length || bytes.toString("base64") !== wrapper.bytes || `sha256:${createHash("sha256").update(bytes).digest("hex")}` !== wrapper.decodedSha256) throw new Error("post_trained_training_artifact_invalid");
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
function assertAuthoritativeEvidence(manifest: PostTrainedAdapterManifest, config: PostTrainedApplicationConfig): void {
  if (typeof config.verifyEvidence !== "function") throw new Error("post_trained_evidence_authority_missing");
  const lifecycle = manifest.lifecycle;
  const groups = [
    { refs: [...lifecycle.evidenceRefs, ...lifecycle.history.flatMap((event) => event.evidenceRefs)], subjectTypes: ["post_trained_adapter_lifecycle"], subjectId: manifest.adapterId },
    { refs: [...lifecycle.trainingDataset.lineageRefs, ...lifecycle.trainingDataset.sufficiency.evidenceRefs], subjectTypes: ["learning_dataset", "learning_dataset_version"], subjectId: lifecycle.trainingDataset.datasetId },
    { refs: [...lifecycle.trainingDataset.consent.evidenceRefs, ...manifest.consent.evidenceRefs], subjectTypes: ["learning_consent"], subjectId: lifecycle.trainingDataset.datasetId },
    { refs: [lifecycle.baseModel.evidenceRef], subjectTypes: ["base_model", "model_artifact"], subjectId: lifecycle.baseModel.modelId },
    { refs: [lifecycle.heldOutEvaluation?.reportRef, ...(lifecycle.canaryEvidence?.evidenceRefs ?? [])], subjectTypes: ["post_trained_training_job"], subjectId: manifest.trainingJobId },
    { refs: [lifecycle.approvedInfrastructure?.evidenceRef], subjectTypes: ["post_trained_infrastructure"], subjectId: manifest.adapterId },
    { refs: [lifecycle.approver?.evidenceRef], subjectTypes: ["post_trained_approval"], subjectId: manifest.adapterId },
    { refs: [manifest.descriptor.health.evidenceRef], subjectTypes: ["post_trained_health"], subjectId: manifest.descriptor.executorId },
  ];
  for (const group of groups) {
    const refs = Object.freeze([...new Set(group.refs.filter((value): value is string => typeof value === "string" && value.length > 0))].sort());
    if (!refs.length || !config.verifyEvidence(manifest.tenantId, refs, { subjectTypes: Object.freeze(group.subjectTypes), subjectId: group.subjectId })) throw new Error("post_trained_evidence_not_authoritative");
  }
}
function requireEnabled(config: PostTrainedApplicationConfig): void { if (config.enabled !== true) throw new Error("post_trained_application_disabled"); }
function freezeManifest(value: PostTrainedAdapterManifest): PostTrainedAdapterManifest { return deepFreeze(structuredClone(value)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child); Object.freeze(value); } return value; }
function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function canonicalJson(value: unknown): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`; const record = value as Record<string, unknown>; return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`; }
