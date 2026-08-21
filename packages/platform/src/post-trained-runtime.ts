import { createHash } from "node:crypto";
import type { AdapterLifecycleRecord } from "./adapter-lifecycle.js";
import { ExecutorRegistry, type ExecutorDescriptor, type RouterTaskSpec } from "./router.js";

export type PostTrainedAdmissionErrorCode =
  | "post_trained_disabled"
  | "tenant_not_allowed"
  | "adapter_not_allowed"
  | "lifecycle_missing"
  | "lifecycle_not_servable"
  | "binding_mismatch"
  | "consent_inactive"
  | "consent_stale"
  | "evaluation_failed"
  | "canary_failed"
  | "infrastructure_unapproved"
  | "monitoring_window_inactive"
  | "rollback_missing"
  | "evidence_missing"
  | "executor_not_adapter"
  | "executor_unhealthy"
  | "health_evidence_missing"
  | "health_stale"
  | "task_not_eligible"
  | "task_mismatch"
  | "dispatch_mismatch";

export class PostTrainedAdmissionError extends Error {
  constructor(public readonly code: PostTrainedAdmissionErrorCode) {
    super(code);
    this.name = "PostTrainedAdmissionError";
  }
}

export type PostTrainedConsentSnapshot = Readonly<{
  tenantId: string;
  datasetId: string;
  revision: number;
  status: "active" | "denied" | "revoked" | "expired" | "missing";
  evidenceRefs: readonly string[];
  checkedAt: string;
  expiresAt?: string;
}>;

export type PostTrainedLifecycleSource = Readonly<{
  readLifecycle(tenantId: string, adapterId: string): AdapterLifecycleRecord | undefined;
  readConsent(tenantId: string, datasetId: string): PostTrainedConsentSnapshot | undefined;
}>;

export type PostTrainedExpectedBindings = Readonly<{
  lifecycleRevision: number;
  artifactDigest: string;
  servingRevision: string;
  baseModelId: string;
  datasetId: string;
  consentRevision: number;
}>;

export type PostTrainedRuntimeBindings = Readonly<{
  tenantId: string;
  adapterId: string;
}> & PostTrainedExpectedBindings;

export type ResolvePostTrainedExecutorInput = Readonly<{
  enabled?: boolean;
  now: Date;
  allowedTenantIds: readonly string[];
  allowedAdapterIds: readonly string[];
  adapterId: string;
  expected: PostTrainedExpectedBindings;
  task: RouterTaskSpec;
  descriptor: ExecutorDescriptor;
  source: PostTrainedLifecycleSource;
  clock?: () => Date;
  maximumConsentAgeMs?: number;
  maximumHealthAgeMs?: number;
}>;

export type PostTrainedDispatchIntent = Readonly<{
  task: RouterTaskSpec;
  executorId: string;
  executorKind: "adapter";
  executorVersion: string;
}>;

export type PostTrainedDispatchAuthorization = Readonly<{
  authorized: true;
  tenantId: string;
  adapterId: string;
  lifecycleRevision: number;
  consentRevision: number;
  artifactDigest: string;
  servingRevision: string;
  authorizedAt: string;
}>;

export type PostTrainedPreDispatchGuard = Readonly<{
  authorize(intent: PostTrainedDispatchIntent): PostTrainedDispatchAuthorization;
}>;

export type PostTrainedExecutorAdmission = Readonly<{
  executor: ExecutorDescriptor;
  bindings: PostTrainedRuntimeBindings;
  preDispatchGuard: PostTrainedPreDispatchGuard;
}>;

const DEFAULT_FRESHNESS_MS = 5 * 60_000;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const CLASSIFICATION_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;
const RISK_RANK = { low: 0, medium: 1, high: 2, critical: 3 } as const;

type AdmissionContext = Readonly<{
  tenantId: string;
  adapterId: string;
  expected: PostTrainedExpectedBindings;
  source: PostTrainedLifecycleSource;
  maximumConsentAgeMs: number;
  maximumHealthAgeMs: number;
  clock: () => Date;
}>;

export function resolvePostTrainedExecutor(input: ResolvePostTrainedExecutorInput): PostTrainedExecutorAdmission {
  if (input.enabled !== true) deny("post_trained_disabled");
  if (!input.allowedTenantIds.includes(input.task.tenantId)) deny("tenant_not_allowed");
  if (!input.allowedAdapterIds.includes(input.adapterId)) deny("adapter_not_allowed");
  const lifecycleReader = input.source.readLifecycle.bind(input.source);
  const consentReader = input.source.readConsent.bind(input.source);
  const clock = input.clock ?? (() => new Date());
  const context: AdmissionContext = Object.freeze({
    tenantId: input.task.tenantId,
    adapterId: input.adapterId,
    expected: Object.freeze({ ...input.expected }),
    source: Object.freeze({ readLifecycle: lifecycleReader, readConsent: consentReader }),
    maximumConsentAgeMs: input.maximumConsentAgeMs ?? DEFAULT_FRESHNESS_MS,
    maximumHealthAgeMs: input.maximumHealthAgeMs ?? DEFAULT_FRESHNESS_MS,
    clock,
  });
  const nowMs = validTime(input.now);
  const snapshot = readAndValidate(context, nowMs);
  const executor = validateExecutor(input.descriptor, input.task, snapshot.lifecycle, nowMs, context.maximumHealthAgeMs);
  const bindings = freezeBindings(context.tenantId, context.adapterId, context.expected);
  const taskFingerprint = fingerprint(input.task);
  const preDispatchGuard: PostTrainedPreDispatchGuard = Object.freeze({
    authorize(intent): PostTrainedDispatchAuthorization {
      if (fingerprint(intent.task) !== taskFingerprint) deny("task_mismatch");
      if (
        intent.executorId !== executor.executorId ||
        intent.executorKind !== "adapter" ||
        intent.executorVersion !== executor.version
      ) deny("dispatch_mismatch");
      const freshNowMs = validTime(context.clock());
      const fresh = readAndValidate(context, freshNowMs);
      validateExecutor(executor, intent.task, fresh.lifecycle, freshNowMs, context.maximumHealthAgeMs);
      return Object.freeze({
        authorized: true,
        tenantId: bindings.tenantId,
        adapterId: bindings.adapterId,
        lifecycleRevision: fresh.lifecycle.revision,
        consentRevision: fresh.consent.revision,
        artifactDigest: fresh.lifecycle.artifactDigest,
        servingRevision: fresh.lifecycle.servingRevision!,
        authorizedAt: new Date(freshNowMs).toISOString(),
      });
    },
  });
  return Object.freeze({ executor, bindings, preDispatchGuard });
}

function readAndValidate(context: AdmissionContext, nowMs: number): { lifecycle: AdapterLifecycleRecord; consent: PostTrainedConsentSnapshot } {
  const lifecycle = context.source.readLifecycle(context.tenantId, context.adapterId);
  if (!lifecycle) deny("lifecycle_missing");
  if (lifecycle.tenantId !== context.tenantId || lifecycle.adapterId !== context.adapterId) deny("binding_mismatch");
  if (lifecycle.state !== "promoted" && lifecycle.state !== "monitored") deny("lifecycle_not_servable");
  assertLifecycleBindings(lifecycle, context.expected);
  assertPromotionEvidence(lifecycle, nowMs);
  const consent = context.source.readConsent(context.tenantId, lifecycle.trainingDataset.datasetId);
  if (!consent || consent.status !== "active" || consent.tenantId !== context.tenantId || consent.datasetId !== lifecycle.trainingDataset.datasetId || !hasEvidence(consent.evidenceRefs)) deny("consent_inactive");
  if (!Number.isSafeInteger(consent.revision) || consent.revision < 1 || consent.revision !== context.expected.consentRevision) deny("binding_mismatch");
  const checkedAt = Date.parse(consent.checkedAt);
  const expiresAt = consent.expiresAt === undefined ? undefined : Date.parse(consent.expiresAt);
  if (!Number.isFinite(checkedAt) || checkedAt > nowMs || nowMs - checkedAt > context.maximumConsentAgeMs || (expiresAt !== undefined && (!Number.isFinite(expiresAt) || expiresAt <= nowMs))) deny("consent_stale");
  return { lifecycle, consent };
}

function assertLifecycleBindings(record: AdapterLifecycleRecord, expected: PostTrainedExpectedBindings): void {
  if (
    record.revision !== expected.lifecycleRevision ||
    record.artifactDigest !== expected.artifactDigest ||
    record.servingRevision !== expected.servingRevision ||
    record.baseModel.modelId !== expected.baseModelId ||
    record.trainingDataset.datasetId !== expected.datasetId
  ) deny("binding_mismatch");
}

function assertPromotionEvidence(record: AdapterLifecycleRecord, nowMs: number): void {
  if (!DIGEST.test(record.artifactDigest)) deny("binding_mismatch");
  const lastEvent = record.history.at(-1);
  if (!Number.isSafeInteger(record.revision) || record.revision < 1 || !lastEvent || lastEvent.revision !== record.revision || lastEvent.to !== record.state || !validIso(lastEvent.occurredAt) || Date.parse(lastEvent.occurredAt) > nowMs) deny("binding_mismatch");
  const evaluation = record.heldOutEvaluation;
  const thresholds = record.promotionThresholds;
  if (!evaluation?.passed || !hasText(evaluation.reportRef) || !thresholds || !rate(evaluation.successRate) || !rate(evaluation.regressionRate) || !rate(thresholds.minimumSuccessRate) || !rate(thresholds.maximumRegressionRate) || evaluation.successRate < thresholds.minimumSuccessRate || evaluation.regressionRate > thresholds.maximumRegressionRate) deny("evaluation_failed");
  if (!record.canaryEvidence?.passed || !hasEvidence(record.canaryEvidence.evidenceRefs) || !validIso(record.canaryEvidence.observedAt) || Date.parse(record.canaryEvidence.observedAt) > nowMs) deny("canary_failed");
  if (!record.approvedInfrastructure?.approved || !hasText(record.approvedInfrastructure.marker) || !hasText(record.approvedInfrastructure.evidenceRef)) deny("infrastructure_unapproved");
  if (!record.rollbackTarget || !hasText(record.rollbackTarget.servingRevision) || !DIGEST.test(record.rollbackTarget.artifactDigest)) deny("rollback_missing");
  const windowStart = Date.parse(record.monitoringWindow?.startsAt ?? "");
  const windowEnd = Date.parse(record.monitoringWindow?.endsAt ?? "");
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd) || nowMs < windowStart || nowMs >= windowEnd) deny("monitoring_window_inactive");
  if (
    record.trainingDataset.consent.status !== "granted" ||
    !hasEvidence(record.trainingDataset.consent.evidenceRefs) ||
    !record.trainingDataset.sufficiency.representative ||
    record.trainingDataset.sufficiency.sampleCount < record.trainingDataset.sufficiency.minimumSampleCount ||
    !hasEvidence(record.trainingDataset.sufficiency.evidenceRefs) ||
    !hasEvidence(record.trainingDataset.lineageRefs) ||
    !record.approver ||
    !hasText(record.approver.principalId) ||
    !hasText(record.approver.evidenceRef) ||
    !validIso(record.approver.approvedAt) ||
    Date.parse(record.approver.approvedAt) > nowMs ||
    !hasText(record.baseModel.evidenceRef) ||
    !hasEvidence(record.evidenceRefs) ||
    !hasEvidence(record.history.at(-1)?.evidenceRefs ?? [])
  ) deny("evidence_missing");
}

function validateExecutor(descriptor: ExecutorDescriptor, task: RouterTaskSpec, lifecycle: AdapterLifecycleRecord, nowMs: number, maximumHealthAgeMs: number): ExecutorDescriptor {
  if (descriptor.kind !== "adapter") deny("executor_not_adapter");
  if (descriptor.version !== lifecycle.servingRevision || descriptor.license.id !== lifecycle.baseModel.license) deny("binding_mismatch");
  if (descriptor.health.status !== "healthy") deny("executor_unhealthy");
  if (!hasText(descriptor.health.evidenceRef)) deny("health_evidence_missing");
  const healthTime = Date.parse(descriptor.health.checkedAt);
  if (!Number.isFinite(healthTime) || healthTime > nowMs || nowMs - healthTime > maximumHealthAgeMs) deny("health_stale");
  try {
    const registry = new ExecutorRegistry();
    registry.register(descriptor);
  } catch {
    deny("task_not_eligible");
  }
  if (
    !hasText(task.taskId) ||
    !hasText(task.idempotencyKey) ||
    task.requiredCapabilities.some((capability) => !descriptor.capabilities.includes(capability)) ||
    // An undeclared tool requirement is unverifiable, so admission fails closed
    // rather than treating the absent claim as a pass (mirrors the router gate).
    task.allowedTools === undefined ||
    task.allowedTools.some((tool) => !descriptor.tools.includes(tool)) ||
    task.context.estimatedInputTokens > descriptor.limits.maximumInputTokens ||
    task.context.maximumOutputTokens > descriptor.limits.maximumOutputTokens ||
    (task.privacy.requiredRegion !== undefined && !descriptor.regions.includes(task.privacy.requiredRegion)) ||
    CLASSIFICATION_RANK[task.privacy.classification] > CLASSIFICATION_RANK[descriptor.maximumDataClassification] ||
    RISK_RANK[task.risk] > RISK_RANK[descriptor.maximumRisk] ||
    descriptor.qualityScore < task.quality.minimumScore ||
    descriptor.estimatedLatencyMs > task.latency.maximumMs ||
    descriptor.estimatedCostUsd > task.budget.maximumUsd ||
    !descriptor.license.commercialUse
  ) deny("task_not_eligible");
  return freezeExecutor(descriptor);
}

function freezeExecutor(value: ExecutorDescriptor): ExecutorDescriptor {
  return Object.freeze({
    ...value,
    capabilities: Object.freeze([...value.capabilities]),
    tools: Object.freeze([...value.tools]),
    regions: Object.freeze([...value.regions]),
    price: Object.freeze({ ...value.price }),
    limits: Object.freeze({ ...value.limits }),
    health: Object.freeze({ ...value.health }),
    license: Object.freeze({ ...value.license }),
  });
}

function freezeBindings(tenantId: string, adapterId: string, expected: PostTrainedExpectedBindings): PostTrainedRuntimeBindings {
  return Object.freeze({ tenantId, adapterId, ...expected });
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function hasText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function hasEvidence(value: readonly string[]): boolean { return Array.isArray(value) && value.length > 0 && value.every(hasText); }
function validIso(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function rate(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 1; }
function validTime(value: Date): number { const time = value.getTime(); if (!Number.isFinite(time)) deny("binding_mismatch"); return time; }
function deny(code: PostTrainedAdmissionErrorCode): never { throw new PostTrainedAdmissionError(code); }
