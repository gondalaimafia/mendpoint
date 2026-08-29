import type { Product } from "./schema.js";
import { verifySignedAuthorityEnvelope } from "./authority.js";
import type { SignedAuthorityEnvelope, TrustedAuthorityVerifierConfig } from "./authority.js";

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
    consent: {
      decision: "granted" | "denied" | "unknown";
      purpose: "governed_learning";
      evidenceRef: string;
    };
    license: {
      decision: "compatible" | "incompatible" | "unknown";
      intendedUse: "governed_learning";
      evidenceRef: string;
    };
    externalProvider: {
      decision: "allowed" | "denied";
      providerId: string | null;
      purpose: "case_execution" | null;
      sharedTrainingAllowed: false;
      repositoryContentAllowed: false;
      retention: "none";
    };
    containsRepositoryContent: false;
    containsCustomerData: false;
    containsPrivateReasoning: false;
    sealedDataset: boolean;
  };
  economics: { costUsd: number; latencyMs: number };
  createdAt: string;
}

export interface ExternalProviderTransmissionAuthorityPayload {
  schemaVersion: "mendpoint.external-provider-transmission-authority.v1";
  productionRevision: string;
  tenantId: string;
  repositoryId: string;
  repositoryCommit: string;
  repositorySnapshotDigest: string;
  providerId: string;
  purpose: "case_execution";
  consentEvidenceRef: string;
  licenseEvidenceRef: string;
  sharedTrainingAllowed: false;
  repositoryContentAllowed: false;
}

declare const VERIFIED_EXTERNAL_PROVIDER_AUTHORITY: unique symbol;
export type ExternalProviderTransmissionAuthority = Readonly<ExternalProviderTransmissionAuthorityPayload> & {
  readonly [VERIFIED_EXTERNAL_PROVIDER_AUTHORITY]: true;
};

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const PRODUCTS: readonly Product[] = ["fettler", "regauge"];
const OUTCOMES: readonly BenchmarkLearningOutcome[] = ["accepted", "rejected", "corrected", "failed", "rolled_back", "reviewer_modified"];
const FACT_CLASSES: readonly LearningFactClass[] = ["repository_fact", "organization_preference", "deterministic_transformation", "model_failure"];
const SINKS: readonly LearningSink[] = ["change_graph", "organization_memory", "deterministic_recipe", "sealed_evaluation"];
const EXTERNAL_PROVIDER_DECISIONS = ["allowed", "denied"] as const;
const EXPECTED_SINK: Record<LearningFactClass, LearningSink> = {
  repository_fact: "change_graph",
  organization_preference: "organization_memory",
  deterministic_transformation: "deterministic_recipe",
  model_failure: "sealed_evaluation",
};
const verifiedExternalProviderAuthorities = new WeakSet<object>();

function nonEmpty(value: string, path: string, errors: string[]): void {
  if (value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

export function validateBenchmarkLearningEvent(event: BenchmarkLearningEvent): string[] {
  const errors: string[] = [];
  if (event.schemaVersion !== "mendpoint.benchmark-learning-event.v1") {
    errors.push("schemaVersion must be mendpoint.benchmark-learning-event.v1");
  }
  if (!(PRODUCTS as readonly string[]).includes(event.product)) errors.push("product must be fettler or regauge");
  if (!(OUTCOMES as readonly string[]).includes(event.outcome)) errors.push("outcome is invalid");
  if (!(FACT_CLASSES as readonly string[]).includes(event.factClass)) errors.push("factClass is invalid");
  if (!(SINKS as readonly string[]).includes(event.sink)) errors.push("sink is invalid");
  if (!(EXTERNAL_PROVIDER_DECISIONS as readonly string[]).includes(event.governance.externalProvider.decision)) {
    errors.push("external provider decision is invalid");
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
    ["governance.consent.evidenceRef", event.governance.consent.evidenceRef],
    ["governance.license.evidenceRef", event.governance.license.evidenceRef],
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
  const expectedSink = EXPECTED_SINK[event.factClass];
  if (expectedSink !== undefined && event.sink !== expectedSink) {
    errors.push(`${event.factClass} must route only to ${expectedSink}`);
  }
  if (!event.governance.tenantId.startsWith("benchmark-tenant-")) {
    errors.push("governance.tenantId must identify a dedicated benchmark tenant");
  }
  if (event.governance.consent.decision !== "granted") errors.push("governance consent must be granted");
  if (event.governance.consent.purpose !== "governed_learning") {
    errors.push("governance consent purpose must be governed_learning");
  }
  if (event.governance.license.decision !== "compatible") errors.push("governance license must be compatible");
  if (event.governance.license.intendedUse !== "governed_learning") {
    errors.push("governance license intended use must be governed_learning");
  }
  if (event.governance.externalProvider.sharedTrainingAllowed !== false) {
    errors.push("external provider shared training must be exactly denied");
  }
  if (event.governance.externalProvider.repositoryContentAllowed !== false) {
    errors.push("external provider repository content must be exactly denied in learning events");
  }
  if (event.governance.externalProvider.retention !== "none") {
    errors.push("external provider retention must be none");
  }
  if (event.governance.externalProvider.decision === "allowed") {
    if (event.governance.externalProvider.providerId === null || event.governance.externalProvider.providerId.trim() === "") {
      errors.push("allowed external provider transmission requires provider identity");
    }
    if (event.governance.externalProvider.purpose !== "case_execution") {
      errors.push("allowed external provider transmission requires case_execution purpose");
    }
  } else if (event.governance.externalProvider.decision === "denied" && (event.governance.externalProvider.providerId !== null || event.governance.externalProvider.purpose !== null)) {
    errors.push("denied external provider transmission must not carry provider authority");
  }
  if (event.governance.containsRepositoryContent !== false) {
    errors.push("governance must not carry repository content in the learning event");
  }
  if (event.governance.containsCustomerData !== false) {
    errors.push("governance must not carry customer data");
  }
  if (event.governance.containsPrivateReasoning !== false) {
    errors.push("governance must not carry private reasoning");
  }
  if (typeof event.governance.sealedDataset !== "boolean") {
    errors.push("governance.sealedDataset must be boolean");
  } else if (event.factClass === "model_failure" && event.governance.sealedDataset !== true) {
    errors.push("model failures must enter a sealed evaluation dataset");
  } else if (event.factClass !== "model_failure" && event.governance.sealedDataset !== false) {
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

export function verifyExternalProviderTransmissionAuthority(
  envelope: SignedAuthorityEnvelope<ExternalProviderTransmissionAuthorityPayload>,
  config: TrustedAuthorityVerifierConfig,
): ExternalProviderTransmissionAuthority {
  const payload = verifySignedAuthorityEnvelope(envelope, config);
  const errors: string[] = [];
  if (payload.schemaVersion !== "mendpoint.external-provider-transmission-authority.v1") {
    errors.push("external authority schemaVersion must be mendpoint.external-provider-transmission-authority.v1");
  }
  for (const [path, value] of [
    ["tenantId", payload.tenantId],
    ["repositoryId", payload.repositoryId],
    ["providerId", payload.providerId],
    ["consentEvidenceRef", payload.consentEvidenceRef],
    ["licenseEvidenceRef", payload.licenseEvidenceRef],
  ] as const) nonEmpty(value, `external authority ${path}`, errors);
  if (!GIT_SHA.test(payload.productionRevision)) errors.push("external authority productionRevision must be a 40 character lowercase git sha");
  if (!GIT_SHA.test(payload.repositoryCommit)) errors.push("external authority repositoryCommit must be a 40 character lowercase git sha");
  if (!SHA256.test(payload.repositorySnapshotDigest)) errors.push("external authority repositorySnapshotDigest must be a 64 character lowercase sha256");
  if (payload.purpose !== "case_execution") errors.push("external authority purpose must be case_execution");
  if (payload.sharedTrainingAllowed !== false) errors.push("external authority sharedTrainingAllowed must be exactly false");
  if (payload.repositoryContentAllowed !== false) errors.push("external authority repositoryContentAllowed must be exactly false");
  if (errors.length > 0) throw new Error(`external_provider_authority_invalid:${errors.join("|")}`);
  const token = payload as ExternalProviderTransmissionAuthority;
  verifiedExternalProviderAuthorities.add(token);
  return token;
}

export function assertExternalProviderTransmissionAllowed(
  event: BenchmarkLearningEvent,
  authority: ExternalProviderTransmissionAuthority,
): void {
  if (!verifiedExternalProviderAuthorities.has(authority)) throw new Error("external_provider_authority_not_verified");
  const errors = validateBenchmarkLearningEvent(event);
  if (errors.length > 0) throw new Error(`learning_event_invalid:${errors.join("|")}`);
  if (event.governance.externalProvider.decision !== "allowed") {
    throw new Error("external_provider_transmission_not_authorized");
  }
  const bindings: Array<[string, unknown, unknown]> = [
    ["productionRevision", event.lineage.productionRevision, authority.productionRevision],
    ["tenant", event.governance.tenantId, authority.tenantId],
    ["repository", event.lineage.repositoryId, authority.repositoryId],
    ["commit", event.lineage.repositoryCommit, authority.repositoryCommit],
    ["snapshot", event.lineage.repositorySnapshotDigest, authority.repositorySnapshotDigest],
    ["provider", event.governance.externalProvider.providerId, authority.providerId],
    ["purpose", event.governance.externalProvider.purpose, authority.purpose],
    ["consent", event.governance.consent.evidenceRef, authority.consentEvidenceRef],
    ["license", event.governance.license.evidenceRef, authority.licenseEvidenceRef],
    ["sharedTraining", event.governance.externalProvider.sharedTrainingAllowed, authority.sharedTrainingAllowed],
    ["repositoryContent", event.governance.externalProvider.repositoryContentAllowed, authority.repositoryContentAllowed],
  ];
  for (const [field, actual, expected] of bindings) {
    if (actual !== expected) throw new Error(`external_provider_authority_mismatch:${field}`);
  }
}
