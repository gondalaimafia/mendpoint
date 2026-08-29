export type Product = "fettler" | "regauge";
export type Cohort = "common" | "edge";
export type EvidenceState = "verified" | "refuted" | "unknown";

export interface LearningSource {
  id: string;
  kind:
    | "official_documentation"
    | "official_migration_guide"
    | "official_security_advisory"
    | "cve_record"
    | "official_incident_postmortem"
    | "upstream_issue"
    | "upstream_pull_request"
    | "public_repository_history";
  title: string;
  publisher: string;
  url: string;
  retrievedAt: string;
}

export interface LearningCase {
  schemaVersion: "mendpoint.learning-case.v1";
  id: string;
  product: Product;
  cohort: Cohort;
  datasetSplit: "development" | "holdout";
  title: string;
  importance: {
    statement: string;
    frequencyClaim: "not_claimed" | "source_supported";
    sourceIds: string[];
  };
  sources: LearningSource[];
  repository: {
    provenanceId: string;
    languages: string[];
    frameworks: string[];
    binding: {
      mode: "native" | "synthetic_substrate";
      originalResearchCandidate: string;
      rationale: string;
    };
  };
  pattern: {
    family: string;
    seededFailure: string;
    expectedImpactGraph: string[];
    evidenceState: EvidenceState;
  };
  expected: {
    diagnosis: string;
    repairOrMigration: string;
    oracleIds: string[];
    productionAcceptance: string[];
  };
  fixture: {
    manifestId: string;
    mutationId: string;
    allowedEditPaths: string[];
    rollbackId: string;
    cleanupId: string;
  };
  security: {
    tenantRisk: "none" | "bounded" | "high" | "critical";
    risks: string[];
    requiresDedicatedBenchmarkTenant: boolean;
  };
  planning: {
    requirementIds: string[];
  };
}

export interface RepositoryProvenance {
  schemaVersion: "mendpoint.repository-provenance.v1";
  id: string;
  repositoryUrl: string;
  immutableCommit: string;
  license: {
    spdxId: string;
    sourceUrl: string;
    textSha256: string;
    decision: "approved" | "rejected" | "pending";
    decidedAt: string;
    intendedUses: Array<"evaluation" | "governed_learning">;
  };
  languages: string[];
  frameworks: string[];
  dependencyLockfiles: string[];
  provenanceRetrievedAt: string;
  dataClassification: "public_source_code";
  contentScreening: {
    secrets: "not_detected" | "detected" | "unknown";
    personalData: "not_detected" | "detected" | "unknown";
    generatedCredentials: "not_detected" | "detected" | "unknown";
    customerData: "not_present" | "present" | "unknown";
  };
}

export interface ProductionExecutionReceipt {
  schemaVersion: "mendpoint.production-learning-receipt.v1";
  caseId: string;
  product: Product;
  productionRevision: string;
  tenantId: string;
  repositoryId: string;
  repositoryCommit: string;
  snapshotDigest: string;
  fixtureManifestDigest: string;
  graphVersion: string;
  policyVersion: string;
  model: { provider: string; modelId: string; requestId: string };
  routerVersion: string;
  recipeVersion: string | null;
  consent: {
    decision: "granted" | "denied" | "unknown";
    purpose: "evaluation" | "governed_learning";
    evidenceRef: string;
  };
  authorizationRef: string;
  sandbox: {
    kind: "dedicated_benchmark";
    receiptDigest: string;
    defaultDenyEgress: boolean;
  };
  executionDigest: string;
  budget: {
    maximumUsd: number;
    maximumLatencyMs: number;
    maximumAttempts: number;
  };
  delivery: {
    mode: "draft_pr_only";
    mergeAllowed: boolean;
    deploymentAllowed: boolean;
    openDraftCountForCase: number;
  };
  advisoryVerifier: {
    name: string;
    advisoryOnly: boolean;
    maySelectCandidate: boolean;
    mayMutateExecution: boolean;
    mayDeliver: boolean;
    mayMerge: boolean;
    mayDeploy: boolean;
  };
  evidence: {
    diagnosis: EvidenceState;
    repairOrMigration: EvidenceState;
    verification: EvidenceState;
    rollback: EvidenceState;
    production: EvidenceState;
  };
}

export interface StagedControlArm {
  caseId: string;
  repositoryPath: string;
  inputArtifactRefs: string[];
  expectedOutcome?: string;
  answerKeyRefs?: string[];
}

const GIT_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function required(value: string, path: string, errors: string[]): void {
  if (value.trim().length === 0) errors.push(`${path} must be a non-empty string`);
}

function requireSha(value: string, path: string, expression: RegExp, label: string, errors: string[]): void {
  if (!expression.test(value)) errors.push(`${path} must be a ${label}`);
}

function requireHttps(value: string, path: string, errors: string[]): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") errors.push(`${path} must use https`);
  } catch {
    errors.push(`${path} must be a valid https URL`);
  }
}

function validateCase(value: LearningCase): string[] {
  const errors: string[] = [];
  const prefix = value.product === "fettler" ? "FET" : "REG";
  const cohortCode = value.cohort === "common" ? "C" : "E";
  const expectedId = new RegExp(`^${prefix}-${cohortCode}\\d{3}$`);

  if (value.schemaVersion !== "mendpoint.learning-case.v1") {
    errors.push(`${value.id} schemaVersion must be mendpoint.learning-case.v1`);
  }
  if (!expectedId.test(value.id)) {
    errors.push(`${value.id} must match its product and cohort`);
  }
  required(value.title, `${value.id} title`, errors);
  required(value.importance.statement, `${value.id} importance.statement`, errors);
  if (!(["not_claimed", "source_supported"] as string[]).includes(value.importance.frequencyClaim)) {
    errors.push(`${value.id} importance.frequencyClaim must be not_claimed or source_supported`);
  }
  if (value.importance.sourceIds.length === 0) {
    errors.push(`${value.id} importance.sourceIds must contain at least one source id`);
  }
  if (value.sources.length === 0) errors.push(`${value.id} sources must contain at least one primary source`);

  const sourceIds = new Set<string>();
  for (const source of value.sources) {
    if (sourceIds.has(source.id)) errors.push(`${value.id} duplicate source id: ${source.id}`);
    sourceIds.add(source.id);
    requireHttps(source.url, `${value.id} source ${source.id} url`, errors);
    if (!UTC_TIMESTAMP.test(source.retrievedAt)) {
      errors.push(`${value.id} source ${source.id} retrievedAt must be a UTC timestamp`);
    }
    required(source.title, `${value.id} source ${source.id} title`, errors);
    required(source.publisher, `${value.id} source ${source.id} publisher`, errors);
  }
  for (const sourceId of value.importance.sourceIds) {
    if (!sourceIds.has(sourceId)) errors.push(`${value.id} importance source id not found: ${sourceId}`);
  }
  if (value.importance.frequencyClaim === "source_supported" && value.importance.sourceIds.length === 0) {
    errors.push(`${value.id} source_supported frequency requires cited source evidence`);
  }

  required(value.repository.provenanceId, `${value.id} repository.provenanceId`, errors);
  if (value.repository.languages.length === 0) errors.push(`${value.id} repository.languages must not be empty`);
  if (!(value.repository.binding.mode === "native" || value.repository.binding.mode === "synthetic_substrate")) {
    errors.push(`${value.id} repository.binding.mode must be native or synthetic_substrate`);
  }
  required(value.repository.binding.originalResearchCandidate, `${value.id} repository.binding.originalResearchCandidate`, errors);
  required(value.repository.binding.rationale, `${value.id} repository.binding.rationale`, errors);
  required(value.pattern.family, `${value.id} pattern.family`, errors);
  required(value.pattern.seededFailure, `${value.id} pattern.seededFailure`, errors);
  if (value.pattern.expectedImpactGraph.length === 0) {
    errors.push(`${value.id} pattern.expectedImpactGraph must not be empty`);
  }
  if (!(["verified", "refuted", "unknown"] as string[]).includes(value.pattern.evidenceState)) {
    errors.push(`${value.id} pattern.evidenceState must preserve verified, refuted, or unknown`);
  }
  required(value.expected.diagnosis, `${value.id} expected.diagnosis`, errors);
  required(value.expected.repairOrMigration, `${value.id} expected.repairOrMigration`, errors);
  if (value.expected.oracleIds.length === 0) errors.push(`${value.id} expected.oracleIds must not be empty`);
  if (value.expected.productionAcceptance.length === 0) {
    errors.push(`${value.id} expected.productionAcceptance must not be empty`);
  }
  if (value.fixture.allowedEditPaths.length === 0) {
    errors.push(`${value.id} fixture.allowedEditPaths must not be empty`);
  }
  required(value.fixture.manifestId, `${value.id} fixture.manifestId`, errors);
  required(value.fixture.mutationId, `${value.id} fixture.mutationId`, errors);
  required(value.fixture.rollbackId, `${value.id} fixture.rollbackId`, errors);
  required(value.fixture.cleanupId, `${value.id} fixture.cleanupId`, errors);
  if (!value.security.requiresDedicatedBenchmarkTenant) {
    errors.push(`${value.id} must require a dedicated benchmark tenant`);
  }
  if (value.security.risks.length === 0) errors.push(`${value.id} security.risks must not be empty`);
  if (value.planning.requirementIds.length === 0) errors.push(`${value.id} planning.requirementIds must not be empty`);
  for (const requirementId of value.planning.requirementIds) {
    required(requirementId, `${value.id} planning.requirementIds entry`, errors);
  }
  return errors;
}

export function validateCaseCatalog(cases: LearningCase[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const learningCase of cases) {
    if (seen.has(learningCase.id)) errors.push(`duplicate case id: ${learningCase.id}`);
    seen.add(learningCase.id);
    errors.push(...validateCase(learningCase));
  }

  const expectedCounts: Array<[Product, Cohort, number]> = [
    ["fettler", "common", 50],
    ["fettler", "edge", 25],
    ["regauge", "common", 50],
    ["regauge", "edge", 25],
  ];
  for (const [product, cohort, expected] of expectedCounts) {
    const actual = cases.filter((item) => item.product === product && item.cohort === cohort).length;
    if (actual !== expected) errors.push(`${product} ${cohort} count must be exactly ${expected}; received ${actual}`);
  }
  if (cases.length !== 150) errors.push(`catalog count must be exactly 150; received ${cases.length}`);
  return errors;
}

export function validateRepositoryProvenance(value: RepositoryProvenance): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== "mendpoint.repository-provenance.v1") {
    errors.push("schemaVersion must be mendpoint.repository-provenance.v1");
  }
  required(value.id, "id", errors);
  requireHttps(value.repositoryUrl, "repositoryUrl", errors);
  requireSha(value.immutableCommit, "immutableCommit", GIT_SHA, "40 character lowercase git sha", errors);
  required(value.license.spdxId, "license.spdxId", errors);
  requireHttps(value.license.sourceUrl, "license.sourceUrl", errors);
  requireSha(value.license.textSha256, "license.textSha256", SHA256, "64 character lowercase sha256", errors);
  if (value.license.decision !== "approved") errors.push("license decision must be approved");
  if (!value.license.intendedUses.includes("evaluation")) {
    errors.push("license intendedUses must explicitly include evaluation");
  }
  if (!value.license.intendedUses.includes("governed_learning")) {
    errors.push("license intendedUses must explicitly include governed_learning");
  }
  if (!UTC_TIMESTAMP.test(value.license.decidedAt)) errors.push("license.decidedAt must be a UTC timestamp");
  if (!UTC_TIMESTAMP.test(value.provenanceRetrievedAt)) {
    errors.push("provenanceRetrievedAt must be a UTC timestamp");
  }
  if (value.dataClassification !== "public_source_code") {
    errors.push("dataClassification must be public_source_code");
  }
  if (value.languages.length === 0) errors.push("languages must not be empty");
  if (value.contentScreening.secrets !== "not_detected") {
    errors.push("content screening must not report detected secrets");
  }
  if (value.contentScreening.personalData !== "not_detected") {
    errors.push("content screening must not report detected or unknown personal data");
  }
  if (value.contentScreening.generatedCredentials !== "not_detected") {
    errors.push("content screening must not report detected or unknown generated credentials");
  }
  if (value.contentScreening.customerData !== "not_present") {
    errors.push("content screening must prove customer data is not present");
  }
  return errors;
}

export function validateStagedControlArm(value: StagedControlArm): string[] {
  const errors: string[] = [];
  required(value.caseId, "caseId", errors);
  required(value.repositoryPath, "repositoryPath", errors);
  if (value.inputArtifactRefs.length === 0) errors.push("inputArtifactRefs must not be empty");
  if (value.expectedOutcome !== undefined) errors.push("modeled control arm must not contain expectedOutcome");
  if (value.answerKeyRefs !== undefined) errors.push("modeled control arm must not contain answerKeyRefs");
  return errors;
}

export function validateExecutionReceipt(value: ProductionExecutionReceipt): string[] {
  const errors: string[] = [];
  if (value.schemaVersion !== "mendpoint.production-learning-receipt.v1") {
    errors.push("schemaVersion must be mendpoint.production-learning-receipt.v1");
  }
  required(value.caseId, "caseId", errors);
  requireSha(value.productionRevision, "productionRevision", GIT_SHA, "40 character lowercase git sha", errors);
  required(value.tenantId, "tenantId", errors);
  required(value.repositoryId, "repositoryId", errors);
  requireSha(value.repositoryCommit, "repositoryCommit", GIT_SHA, "40 character lowercase git sha", errors);
  requireSha(value.snapshotDigest, "snapshotDigest", SHA256, "64 character lowercase sha256", errors);
  requireSha(value.fixtureManifestDigest, "fixtureManifestDigest", SHA256, "64 character lowercase sha256", errors);
  required(value.graphVersion, "graphVersion", errors);
  required(value.policyVersion, "policyVersion", errors);
  required(value.model.provider, "model.provider", errors);
  required(value.model.modelId, "model.modelId", errors);
  required(value.model.requestId, "model.requestId", errors);
  required(value.routerVersion, "routerVersion", errors);
  if (value.consent.decision !== "granted") errors.push("consent decision must be granted");
  if (!(value.consent.purpose === "evaluation" || value.consent.purpose === "governed_learning")) {
    errors.push("consent purpose must be evaluation or governed_learning");
  }
  required(value.consent.evidenceRef, "consent.evidenceRef", errors);
  required(value.authorizationRef, "authorizationRef", errors);
  if (value.sandbox.kind !== "dedicated_benchmark") errors.push("sandbox kind must be dedicated_benchmark");
  requireSha(value.sandbox.receiptDigest, "sandbox.receiptDigest", SHA256, "64 character lowercase sha256", errors);
  if (value.sandbox.defaultDenyEgress !== true) errors.push("sandbox defaultDenyEgress must be exactly true");
  requireSha(value.executionDigest, "executionDigest", SHA256, "64 character lowercase sha256", errors);
  if (!(value.budget.maximumUsd > 0)) errors.push("budget maximumUsd must be greater than 0");
  if (!(value.budget.maximumLatencyMs > 0)) errors.push("budget maximumLatencyMs must be greater than 0");
  if (!(Number.isInteger(value.budget.maximumAttempts) && value.budget.maximumAttempts > 0)) {
    errors.push("budget maximumAttempts must be a positive integer");
  }
  if (value.delivery.mode !== "draft_pr_only") errors.push("delivery mode must be draft_pr_only");
  if (value.delivery.mergeAllowed !== false) errors.push("delivery mergeAllowed must be exactly false");
  if (value.delivery.deploymentAllowed !== false) errors.push("delivery deploymentAllowed must be exactly false");
  if (value.delivery.openDraftCountForCase !== 0) {
    errors.push("delivery openDraftCountForCase must be 0 before delivery");
  }
  required(value.advisoryVerifier.name, "advisoryVerifier.name", errors);
  if (value.advisoryVerifier.advisoryOnly !== true) errors.push("advisory verifier advisoryOnly must be exactly true");
  if (value.recipeVersion !== null) required(value.recipeVersion, "recipeVersion", errors);
  const deniedAuthorities: Array<keyof ProductionExecutionReceipt["advisoryVerifier"]> = [
    "maySelectCandidate",
    "mayMutateExecution",
    "mayDeliver",
    "mayMerge",
    "mayDeploy",
  ];
  for (const authority of deniedAuthorities) {
    if (value.advisoryVerifier[authority] !== false) {
      errors.push(`advisory verifier ${authority} must be exactly false`);
    }
  }
  for (const [field, state] of Object.entries(value.evidence)) {
    if (!(state === "verified" || state === "refuted" || state === "unknown")) {
      errors.push(`evidence ${field} must preserve verified, refuted, or unknown`);
    }
  }
  return errors;
}
