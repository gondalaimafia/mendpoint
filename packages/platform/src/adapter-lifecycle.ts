export const ADAPTER_LIFECYCLE_STATES = [
  "registered",
  "evaluated",
  "shadow",
  "canary",
  "promoted",
  "monitored",
  "rolled_back",
  "retired",
] as const;

export type AdapterLifecycleState =
  (typeof ADAPTER_LIFECYCLE_STATES)[number];

export type BaseModelBinding = Readonly<{
  modelId: string;
  license: string;
  evidenceRef: string;
}>;

export type TrainingDatasetBinding = Readonly<{
  datasetId: string;
  lineageRefs: readonly string[];
  consent: Readonly<{
    status: "granted" | "denied" | "revoked" | "missing";
    evidenceRefs: readonly string[];
  }>;
  sufficiency: Readonly<{
    representative: boolean;
    sampleCount: number;
    minimumSampleCount: number;
    evidenceRefs: readonly string[];
  }>;
}>;

export type HeldOutEvaluationBinding = Readonly<{
  reportRef: string;
  passed: boolean;
  successRate: number;
  regressionRate: number;
}>;

export type PromotionThresholdBinding = Readonly<{
  minimumSuccessRate: number;
  maximumRegressionRate: number;
}>;

export type ApprovedInfrastructureBinding = Readonly<{
  approved: boolean;
  marker: string;
  evidenceRef: string;
}>;

export type MonitoringWindowBinding = Readonly<{
  startsAt: string;
  endsAt: string;
}>;

export type RollbackTargetBinding = Readonly<{
  servingRevision: string;
  artifactDigest: string;
}>;

export type HumanApproverBinding = Readonly<{
  principalId: string;
  approvedAt: string;
  evidenceRef: string;
}>;

export type CanaryEvidenceBinding = Readonly<{
  passed: boolean;
  observedAt: string;
  evidenceRefs: readonly string[];
}>;

export type AdapterLifecycleEvent = Readonly<{
  revision: number;
  from: AdapterLifecycleState | null;
  to: AdapterLifecycleState;
  actorId: string;
  occurredAt: string;
  evidenceRefs: readonly string[];
}>;

export type AdapterLifecycleRecord = Readonly<{
  tenantId: string;
  adapterId: string;
  state: AdapterLifecycleState;
  revision: number;
  baseModel: BaseModelBinding;
  artifactDigest: string;
  trainingDataset: TrainingDatasetBinding;
  heldOutEvaluation?: HeldOutEvaluationBinding;
  promotionThresholds?: PromotionThresholdBinding;
  approvedInfrastructure?: ApprovedInfrastructureBinding;
  servingRevision?: string;
  monitoringWindow?: MonitoringWindowBinding;
  rollbackTarget?: RollbackTargetBinding;
  approver?: HumanApproverBinding;
  canaryEvidence?: CanaryEvidenceBinding;
  evidenceRefs: readonly string[];
  history: readonly AdapterLifecycleEvent[];
}>;

export type RegisterAdapterInput = Readonly<{
  tenantId: string;
  adapterId: string;
  baseModel: BaseModelBinding;
  artifactDigest: string;
  trainingDataset: TrainingDatasetBinding;
  actorId: string;
  occurredAt: string;
  evidenceRefs: readonly string[];
}>;

export type AdapterLifecycleBindings = Readonly<{
  heldOutEvaluation?: HeldOutEvaluationBinding;
  promotionThresholds?: PromotionThresholdBinding;
  approvedInfrastructure?: ApprovedInfrastructureBinding;
  servingRevision?: string;
  monitoringWindow?: MonitoringWindowBinding;
  rollbackTarget?: RollbackTargetBinding;
  approver?: HumanApproverBinding;
  canaryEvidence?: CanaryEvidenceBinding;
}>;

export type TransitionAdapterInput = Readonly<{
  tenantId: string;
  adapterId: string;
  to: AdapterLifecycleState;
  actorId: string;
  occurredAt: string;
  evidenceRefs: readonly string[];
  bindings?: AdapterLifecycleBindings;
}>;

export type AdapterLifecycleErrorCode =
  | "adapter_lifecycle_identity_required"
  | "adapter_lifecycle_conflict"
  | "adapter_lifecycle_not_found"
  | "adapter_lifecycle_terminal"
  | "adapter_lifecycle_transition_denied"
  | "adapter_lifecycle_artifact_digest_invalid"
  | "adapter_lifecycle_dataset_lineage_required"
  | "adapter_lifecycle_dataset_sufficiency_invalid"
  | "adapter_lifecycle_evidence_required"
  | "adapter_lifecycle_time_invalid"
  | "adapter_lifecycle_time_regressed"
  | "adapter_lifecycle_binding_invalid"
  | "adapter_promotion_consent_required"
  | "adapter_promotion_representative_data_required"
  | "adapter_promotion_infrastructure_approval_required"
  | "adapter_promotion_evaluation_required"
  | "adapter_promotion_evaluation_failed"
  | "adapter_promotion_thresholds_required"
  | "adapter_promotion_threshold_not_met"
  | "adapter_promotion_human_approval_required"
  | "adapter_promotion_canary_evidence_required"
  | "adapter_promotion_serving_revision_required"
  | "adapter_promotion_monitoring_window_required"
  | "adapter_promotion_rollback_target_required";

export class AdapterLifecycleError extends Error {
  constructor(readonly code: AdapterLifecycleErrorCode) {
    super(code);
    this.name = "AdapterLifecycleError";
  }
}

const ALLOWED_TRANSITIONS = {
  registered: ["evaluated", "retired"],
  evaluated: ["shadow", "retired"],
  shadow: ["canary", "retired"],
  canary: ["promoted", "rolled_back"],
  promoted: ["monitored", "rolled_back"],
  monitored: ["rolled_back", "retired"],
  rolled_back: ["retired"],
  retired: [],
} as const satisfies Readonly<
  Record<AdapterLifecycleState, readonly AdapterLifecycleState[]>
>;

/**
 * Tenant-scoped control-plane registry for trained adapter artifacts.
 *
 * This class records only caller-supplied evidence locators. It never creates,
 * infers, or treats missing external evidence as present.
 */
export class AdapterLifecycleRegistry {
  readonly #records = new Map<string, AdapterLifecycleRecord>();

  register(input: RegisterAdapterInput): AdapterLifecycleRecord {
    requireIdentity(input.tenantId, input.adapterId, input.actorId);
    requireTime(input.occurredAt);
    requireEvidence(input.evidenceRefs);
    validateBaseModel(input.baseModel);
    requireDigest(input.artifactDigest);
    validateDataset(input.trainingDataset);

    const key = registryKey(input.tenantId, input.adapterId);
    if (this.#records.has(key)) {
      throw new AdapterLifecycleError("adapter_lifecycle_conflict");
    }

    const event: AdapterLifecycleEvent = {
      revision: 1,
      from: null,
      to: "registered",
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      evidenceRefs: [...input.evidenceRefs],
    };
    const record = freezeRecord({
      tenantId: input.tenantId,
      adapterId: input.adapterId,
      state: "registered",
      revision: 1,
      baseModel: structuredClone(input.baseModel),
      artifactDigest: input.artifactDigest,
      trainingDataset: structuredClone(input.trainingDataset),
      evidenceRefs: unique(input.evidenceRefs),
      history: [event],
    });
    this.#records.set(key, record);
    return record;
  }

  transition(input: TransitionAdapterInput): AdapterLifecycleRecord {
    requireIdentity(input.tenantId, input.adapterId, input.actorId);
    requireTime(input.occurredAt);
    requireEvidence(input.evidenceRefs);

    const key = registryKey(input.tenantId, input.adapterId);
    const current = this.#records.get(key);
    if (!current) {
      throw new AdapterLifecycleError("adapter_lifecycle_not_found");
    }
    if (current.state === "retired") {
      throw new AdapterLifecycleError("adapter_lifecycle_terminal");
    }
    const allowed = ALLOWED_TRANSITIONS[current.state] as readonly AdapterLifecycleState[];
    if (!allowed.includes(input.to)) {
      throw new AdapterLifecycleError("adapter_lifecycle_transition_denied");
    }

    const priorTime = Date.parse(
      current.history[current.history.length - 1]!.occurredAt,
    );
    if (Date.parse(input.occurredAt) < priorTime) {
      throw new AdapterLifecycleError("adapter_lifecycle_time_regressed");
    }

    validateBindings(input.bindings);
    const candidate = {
      ...current,
      ...(input.bindings ? structuredClone(input.bindings) : {}),
      state: input.to,
      revision: current.revision + 1,
      evidenceRefs: unique([...current.evidenceRefs, ...input.evidenceRefs]),
      history: [
        ...current.history,
        {
          revision: current.revision + 1,
          from: current.state,
          to: input.to,
          actorId: input.actorId,
          occurredAt: input.occurredAt,
          evidenceRefs: [...input.evidenceRefs],
        },
      ],
    } satisfies AdapterLifecycleRecord;

    if (input.to === "promoted") assertPromotionReady(candidate);

    const next = freezeRecord(candidate);
    this.#records.set(key, next);
    return next;
  }

  get(tenantId: string, adapterId: string): AdapterLifecycleRecord | undefined {
    requireIdentity(tenantId, adapterId);
    return this.#records.get(registryKey(tenantId, adapterId));
  }

  list(tenantId: string): readonly AdapterLifecycleRecord[] {
    requireIdentity(tenantId);
    return Object.freeze(
      [...this.#records.values()]
        .filter((record) => record.tenantId === tenantId)
        .sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
    );
  }
}

function assertPromotionReady(record: AdapterLifecycleRecord): void {
  const dataset = record.trainingDataset;
  if (
    dataset.consent.status !== "granted" ||
    dataset.consent.evidenceRefs.length === 0
  ) {
    throw new AdapterLifecycleError("adapter_promotion_consent_required");
  }
  if (
    !dataset.sufficiency.representative ||
    dataset.sufficiency.sampleCount < dataset.sufficiency.minimumSampleCount ||
    dataset.sufficiency.evidenceRefs.length === 0
  ) {
    throw new AdapterLifecycleError(
      "adapter_promotion_representative_data_required",
    );
  }
  if (
    !record.approvedInfrastructure?.approved ||
    !hasText(record.approvedInfrastructure.marker) ||
    !hasText(record.approvedInfrastructure.evidenceRef)
  ) {
    throw new AdapterLifecycleError(
      "adapter_promotion_infrastructure_approval_required",
    );
  }
  if (!record.heldOutEvaluation) {
    throw new AdapterLifecycleError("adapter_promotion_evaluation_required");
  }
  if (!record.heldOutEvaluation.passed) {
    throw new AdapterLifecycleError("adapter_promotion_evaluation_failed");
  }
  if (!record.approver) {
    throw new AdapterLifecycleError("adapter_promotion_human_approval_required");
  }
  if (
    !record.canaryEvidence?.passed ||
    record.canaryEvidence.evidenceRefs.length === 0
  ) {
    throw new AdapterLifecycleError(
      "adapter_promotion_canary_evidence_required",
    );
  }
  if (!hasText(record.servingRevision)) {
    throw new AdapterLifecycleError(
      "adapter_promotion_serving_revision_required",
    );
  }
  if (!record.monitoringWindow) {
    throw new AdapterLifecycleError(
      "adapter_promotion_monitoring_window_required",
    );
  }
  if (!record.rollbackTarget) {
    throw new AdapterLifecycleError(
      "adapter_promotion_rollback_target_required",
    );
  }
  if (!record.promotionThresholds) {
    throw new AdapterLifecycleError("adapter_promotion_thresholds_required");
  }
  if (
    record.heldOutEvaluation.successRate <
      record.promotionThresholds.minimumSuccessRate ||
    record.heldOutEvaluation.regressionRate >
      record.promotionThresholds.maximumRegressionRate
  ) {
    throw new AdapterLifecycleError("adapter_promotion_threshold_not_met");
  }
}

function validateBaseModel(binding: BaseModelBinding): void {
  if (
    !hasText(binding.modelId) ||
    !hasText(binding.license) ||
    !hasText(binding.evidenceRef)
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
}

function validateDataset(dataset: TrainingDatasetBinding): void {
  if (!hasText(dataset.datasetId) || !hasEvidence(dataset.lineageRefs)) {
    throw new AdapterLifecycleError(
      "adapter_lifecycle_dataset_lineage_required",
    );
  }
  if (
    !Number.isInteger(dataset.sufficiency.sampleCount) ||
    dataset.sufficiency.sampleCount < 0 ||
    !Number.isInteger(dataset.sufficiency.minimumSampleCount) ||
    dataset.sufficiency.minimumSampleCount < 1
  ) {
    throw new AdapterLifecycleError(
      "adapter_lifecycle_dataset_sufficiency_invalid",
    );
  }
  if (
    !Array.isArray(dataset.consent.evidenceRefs) ||
    !Array.isArray(dataset.sufficiency.evidenceRefs) ||
    !dataset.consent.evidenceRefs.every(hasText) ||
    !dataset.sufficiency.evidenceRefs.every(hasText)
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
}

function validateBindings(bindings: AdapterLifecycleBindings | undefined): void {
  if (!bindings) return;
  const evaluation = bindings.heldOutEvaluation;
  if (
    evaluation &&
    (!hasText(evaluation.reportRef) ||
      !rate(evaluation.successRate) ||
      !rate(evaluation.regressionRate))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const thresholds = bindings.promotionThresholds;
  if (
    thresholds &&
    (!rate(thresholds.minimumSuccessRate) ||
      !rate(thresholds.maximumRegressionRate))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const infrastructure = bindings.approvedInfrastructure;
  if (
    infrastructure &&
    (!hasText(infrastructure.marker) || !hasText(infrastructure.evidenceRef))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  if (
    bindings.servingRevision !== undefined &&
    !hasText(bindings.servingRevision)
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const window = bindings.monitoringWindow;
  if (
    window &&
    (!validTime(window.startsAt) ||
      !validTime(window.endsAt) ||
      Date.parse(window.endsAt) <= Date.parse(window.startsAt))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const rollback = bindings.rollbackTarget;
  if (
    rollback &&
    (!hasText(rollback.servingRevision) || !isDigest(rollback.artifactDigest))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const approver = bindings.approver;
  if (
    approver &&
    (!hasText(approver.principalId) ||
      !validTime(approver.approvedAt) ||
      !hasText(approver.evidenceRef))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
  const canary = bindings.canaryEvidence;
  if (
    canary &&
    (!validTime(canary.observedAt) || !Array.isArray(canary.evidenceRefs) ||
      !canary.evidenceRefs.every(hasText))
  ) {
    throw new AdapterLifecycleError("adapter_lifecycle_binding_invalid");
  }
}

function registryKey(tenantId: string, adapterId: string): string {
  return `${tenantId.length}:${tenantId}${adapterId}`;
}

function requireIdentity(...values: Array<string | undefined>): void {
  if (!values.every((value) => value === undefined || hasText(value))) {
    throw new AdapterLifecycleError("adapter_lifecycle_identity_required");
  }
}

function requireEvidence(values: readonly string[]): void {
  if (!hasEvidence(values)) {
    throw new AdapterLifecycleError("adapter_lifecycle_evidence_required");
  }
}

function requireTime(value: string): void {
  if (!validTime(value)) {
    throw new AdapterLifecycleError("adapter_lifecycle_time_invalid");
  }
}

function requireDigest(value: string): void {
  if (!isDigest(value)) {
    throw new AdapterLifecycleError(
      "adapter_lifecycle_artifact_digest_invalid",
    );
  }
}

function validTime(value: string): boolean {
  return hasText(value) && Number.isFinite(Date.parse(value));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasEvidence(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length > 0 && values.every(hasText);
}

function isDigest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function rate(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function freezeRecord(record: AdapterLifecycleRecord): AdapterLifecycleRecord {
  return deepFreeze(record);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
