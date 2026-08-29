import type { Product } from "./schema.js";

export type BenchmarkLearningOutcome =
  | "accepted"
  | "rejected"
  | "corrected"
  | "failed"
  | "rolled_back"
  | "reviewer_modified";

export type LearningFactClass =
  | "repository_fact"
  | "organization_preference"
  | "deterministic_transformation"
  | "model_failure";

export type LearningSink =
  | "change_graph"
  | "organization_memory"
  | "deterministic_recipe"
  | "sealed_evaluation";

export interface BenchmarkLearningEvent {
  schemaVersion: "mendpoint.benchmark-learning-event.v1";
  eventId: string;
  idempotencyKey: string;
  caseId: string;
  product: Product;
  outcome: BenchmarkLearningOutcome;
  factClass: LearningFactClass;
  sink: LearningSink;
  lineage: {
    productionRevision: string;
    executionDigest: string;
    receiptDigest: string;
    repositoryId: string;
    repositoryCommit: string;
    repositorySnapshotDigest: string;
    licenseDecisionRef: string;
    provenanceRef: string;
    graphVersion: string;
    policyVersion: string;
    modelId: string;
    routerVersion: string;
    recipeVersion: string | null;
    deterministicVerificationRef: string;
    parentEventId: string | null;
  };
  governance: {
    tenantId: string;
    consentDecisionRef: string;
    consentGranted: boolean;
    licenseCompatible: boolean;
    externalProviderAllowed: boolean;
    containsRepositoryContent: false;
    containsCustomerData: false;
    containsPrivateReasoning: false;
    sealedDataset: boolean;
  };
  economics: { costUsd: number; latencyMs: number };
  createdAt: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const EXPECTED_SINK: Record<LearningFactClass, LearningSink> = {
  repository_fact: "change_graph",
  organization_preference: "organization_memory",
  deterministic_transformation: "deterministic_recipe",
  model_failure: "sealed_evaluation",
};

function nonEmpty(value: string, path: string, errors: string[]): void {
  if (value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

export function validateBenchmarkLearningEvent(event: BenchmarkLearningEvent): string[] {
  const errors: string[] = [];
  if (event.schemaVersion !== "mendpoint.benchmark-learning-event.v1") {
    errors.push("schemaVersion must be mendpoint.benchmark-learning-event.v1");
  }
  for (const [path, value] of [
    ["eventId", event.eventId],
    ["idempotencyKey", event.idempotencyKey],
    ["caseId", event.caseId],
    ["lineage.receiptDigest", event.lineage.receiptDigest],
    ["lineage.repositoryId", event.lineage.repositoryId],
    ["lineage.licenseDecisionRef", event.lineage.licenseDecisionRef],
    ["lineage.provenanceRef", event.lineage.provenanceRef],
    ["lineage.graphVersion", event.lineage.graphVersion],
    ["lineage.policyVersion", event.lineage.policyVersion],
    ["lineage.modelId", event.lineage.modelId],
    ["lineage.routerVersion", event.lineage.routerVersion],
    ["lineage.deterministicVerificationRef", event.lineage.deterministicVerificationRef],
    ["governance.tenantId", event.governance.tenantId],
    ["governance.consentDecisionRef", event.governance.consentDecisionRef],
  ] as const) nonEmpty(value, path, errors);
  if (!GIT_SHA.test(event.lineage.productionRevision)) {
    errors.push("lineage.productionRevision must be a 40 character lowercase git sha");
  }
  if (!GIT_SHA.test(event.lineage.repositoryCommit)) {
    errors.push("lineage.repositoryCommit must be a 40 character lowercase git sha");
  }
  for (const [path, value] of [
    ["lineage.executionDigest", event.lineage.executionDigest],
    ["lineage.repositorySnapshotDigest", event.lineage.repositorySnapshotDigest],
  ] as const) {
    if (!SHA256.test(value)) errors.push(`${path} must be a 64 character lowercase sha256`);
  }
  if (event.sink !== EXPECTED_SINK[event.factClass]) {
    errors.push(`${event.factClass} must route only to ${EXPECTED_SINK[event.factClass]}`);
  }
  if (!event.governance.tenantId.startsWith("benchmark-tenant-")) {
    errors.push("governance.tenantId must identify a dedicated benchmark tenant");
  }
  if (!event.governance.consentGranted) errors.push("governance consent must be granted");
  if (!event.governance.licenseCompatible) errors.push("governance license must be compatible");
  if (event.governance.containsRepositoryContent !== false) {
    errors.push("governance must not carry repository content in the learning event");
  }
  if (event.governance.containsCustomerData !== false) {
    errors.push("governance must not carry customer data");
  }
  if (event.governance.containsPrivateReasoning !== false) {
    errors.push("governance must not carry private reasoning");
  }
  if (event.factClass === "model_failure" && !event.governance.sealedDataset) {
    errors.push("model failures must enter a sealed evaluation dataset");
  }
  if (event.factClass !== "model_failure" && event.governance.sealedDataset) {
    errors.push("only model failures may enter the sealed evaluation sink");
  }
  if (!Number.isFinite(event.economics.costUsd) || event.economics.costUsd < 0) {
    errors.push("economics.costUsd must be a non-negative finite number");
  }
  if (!Number.isFinite(event.economics.latencyMs) || event.economics.latencyMs < 0) {
    errors.push("economics.latencyMs must be a non-negative finite number");
  }
  if (!UTC_TIMESTAMP.test(event.createdAt)) errors.push("createdAt must be a UTC timestamp");
  return errors;
}

export function assertExternalProviderTransmissionAllowed(event: BenchmarkLearningEvent): void {
  const errors = validateBenchmarkLearningEvent(event);
  if (errors.length > 0) throw new Error(`learning_event_invalid:${errors.join("|")}`);
  if (!event.governance.externalProviderAllowed) {
    throw new Error("external_provider_transmission_not_authorized");
  }
  if (!event.governance.consentGranted || !event.governance.licenseCompatible) {
    throw new Error("external_provider_license_or_consent_missing");
  }
}
