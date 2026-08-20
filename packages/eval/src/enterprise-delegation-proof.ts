import { createHash } from "node:crypto";
import {
  verifySoftwareAttestation,
  type DsseEnvelope,
  type SoftwareAttestationArtifactInput,
  type SoftwareAttestationTrustPolicy,
} from "@mendpoint/contract";
import type { LiveModelProvenanceRecord } from "@mendpoint/agent";
import type { ExactDraftObservation } from "@mendpoint/github";
import { gradeLiveModelProvenance } from "./live-model-eval.js";

export const DELEGATED_PR_ACCEPTANCE_VERSION = "2026-08-18.v1" as const;

type Artifact = Readonly<{ artifactId: string; sha256: string }>;

export type DelegatedPrAcceptanceContract = Readonly<{
  schemaVersion: 1;
  product: "fettler" | "regauge";
  tenantId: string;
  mendpointRevision: string;
  authorityManifest: Artifact;
  taskArtifact: Artifact;
  repository: Readonly<{
    repositoryId: string;
    remoteRepositoryId: number;
    installationId: number;
    owner: string;
    name: string;
    baseBranch: string;
    sourceRevision: string;
    sourceArtifact: Artifact;
    snapshotArtifact: Artifact;
    treeDigest: string;
  }>;
  approvedModel: Readonly<{
    providerId: string;
    endpointHost: string;
    model: string;
    pricingDigest: string;
  }>;
  verification: Readonly<{
    executionAuthorityId: string;
    authorityId: string;
    authorityDigest: string;
    failToPassCommandDigest: string;
    passToPassCommandDigest: string;
    policyArtifact: Artifact;
    requiredCheckIdentities: readonly string[];
    failToPassIdentities: readonly string[];
    sandboxBackend: string;
  }>;
  attestationProducer: Readonly<{ principalId: string; service: string; trustedKeyIds: readonly string[] }>;
  workflow: Readonly<{
    repository: string;
    workflowPath: string;
    workflowRevision: string;
    environment: string;
  }>;
  requiredRepetitions: number;
  maximumTotalCostUsd: number;
  maximumTrialDurationMs: number;
  maximumProofAgeMs: number;
  allowedChangedPaths: readonly string[];
}>;

export type DelegatedPrProof = Readonly<{
  schemaVersion: 1;
  proofId: string;
  generatedAt: string;
  workflow: Readonly<{
    repository: string;
    workflowPath: string;
    workflowRevision: string;
    environment: string;
    runId: string;
    runAttempt: number;
  }>;
  trials: readonly Readonly<{
    trial: number;
    tenantId: string;
    runId: string;
    correlationId: string;
  }>[];
}>;

export type DelegatedPrVerificationExecution = Readonly<{
  artifact: Artifact;
  authorityId: string;
  authorityDigest: string;
  commandDigest: string;
  sourceDigest: string;
  candidateDigest: string;
  baselineExitCode: number;
  candidateExitCode: number;
  baselineVerdict: "test_failure" | "passed";
  failingCheckIdentities: readonly string[];
  sandboxBackend: string;
  logsDigest: string;
}>;

export type DelegatedPrTrialEvidence = Readonly<{
  trial: number;
  tenantId: string;
  runId: string;
  correlationId: string;
  jobId: string;
  workflow: Readonly<{
    repository: string;
    workflowPath: string;
    workflowRevision: string;
    environment: string;
    runId: string;
    runAttempt: number;
  }>;
  attestedArtifacts: Readonly<{
    workflow: Artifact;
    model: Artifact;
    accounting: Artifact;
    approvalAudit: Artifact;
    githubObservation: Artifact;
    verification: Artifact;
    cleanup: Artifact;
    timeline: Artifact;
    changedPaths: Artifact;
  }>;
  startedAt: string;
  executionCompletedAt: string;
  finalizedAt: string;
  source: Readonly<{
    repositoryId: string;
    remoteRepositoryId: number;
    installationId: number;
    owner: string;
    name: string;
    baseBranch: string;
    revision: string;
    sourceArtifact: Artifact;
    snapshotArtifact: Artifact;
    treeDigest: string;
    taskArtifact: Artifact;
  }>;
  model: Readonly<{
    provenance: readonly LiveModelProvenanceRecord[];
    plannerSources: readonly string[];
    scriptedPlannerInjected: boolean;
    pricingDigest: string;
    settledAt: string;
  }>;
  meter: Readonly<{
    costMeasured: boolean;
    costUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
  }>;
  candidate: Readonly<{
    artifact: Artifact;
    commitSha: string;
    treeDigest: string;
    changedPaths: readonly string[];
    createdAt: string;
  }>;
  verification: Readonly<{
    executionAuthorityId: string;
    failToPass: DelegatedPrVerificationExecution;
    passToPass: DelegatedPrVerificationExecution;
    completedAt: string;
  }>;
  approval: Readonly<{
    auditEventId: string;
    requestId: string;
    membershipEvidenceId: string;
    auditChainVerified: boolean;
    action: "agent.candidate.approved";
    principalId: string;
    principalKind: "human";
    authMethod: "oidc";
    apiKeyId: null;
    trustPrincipalId: string;
    candidateDigest: string;
    sealArtifact: Artifact;
    approvedAt: string;
  }>;
  delivery: Readonly<{
    provider: "github";
    publisher: "github_app";
    installationId: number;
    remoteRepositoryId: number;
    repositoryId: string;
    owner: string;
    name: string;
    baseBranch: string;
    headBranch: string;
    pullRequestNumber: number;
    candidateDigest: string;
    artifact: Artifact;
    changedPaths: readonly string[];
    treeDigest: string;
    matchingOpenDrafts: number;
    observedAt: string;
    observation: ExactDraftObservation;
  }>;
  cleanup: Readonly<{
    pullRequestState: "closed";
    branchState: "deleted" | "retained_exact";
    headRevision: string;
    baseRevision: string;
    openTrialPullRequests: number;
    rollbackArtifact: Artifact;
    observedAt: string;
    evidenceRefs: readonly string[];
  }>;
  attestation: DsseEnvelope;
}>;

export type DelegatedPrAcceptanceAuthority = Readonly<{
  loadTrial(input: Readonly<{
    tenantId: string;
    runId: string;
    correlationId: string;
    trial: number;
  }>): Promise<DelegatedPrTrialEvidence | null>;
  manifest(): Promise<Artifact>;
  now(): Promise<string>;
}>;

export type DelegatedPrAcceptanceFinding = Readonly<{
  code: string;
  severity: "P0" | "P1";
  trial: number | null;
}>;

export type DelegatedPrAcceptanceReport = Readonly<{
  schemaVersion: 1;
  contractVersion: typeof DELEGATED_PR_ACCEPTANCE_VERSION;
  delegatedPrAccepted: boolean;
  proofDigest: string | null;
  contractDigest: string;
  evidenceDigest: string | null;
  acceptanceDigest: string;
  verifiedAt: string | null;
  signerKeyIds: readonly string[];
  scope: Readonly<{
    product: "fettler" | "regauge";
    tenantId: string;
    repositoryId: string;
    sourceRevision: string;
    mendpointRevision: string;
  }>;
  trialCount: number;
  totalCostUsd: number;
  totalDurationMs: number;
  allTrialsAccepted: boolean;
  findings: readonly DelegatedPrAcceptanceFinding[];
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^[a-f0-9]{40}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const EVIDENCE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@/#-]{0,999}$/;
const PATH_SEGMENT = /^(?!\.{1,2}$)[^\u0000-\u001f\\/:]+$/;
const MAX_SNAPSHOT_NODES = 50_000;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonical(child)]));
  }
  return value;
}

function snapshotPlain<T>(value: T, code: string): T {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_SNAPSHOT_NODES || depth > 32) throw new Error(code);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(code);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 2_000) throw new Error(code);
      seen.add(current);
      const copy = current.map((entry) => visit(entry, depth + 1));
      seen.delete(current);
      return copy;
    }
    if (typeof current !== "object" || current === undefined) throw new Error(code);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
    if (seen.has(current)) throw new Error(code);
    seen.add(current);
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current)).sort(([a], [b]) => compareCodeUnits(a, b))) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(code);
      result[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return result;
  };
  return visit(value, 0) as T;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function artifactEqual(left: Artifact, right: Artifact): boolean {
  return left.artifactId === right.artifactId && left.sha256 === right.sha256;
}

function timestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function validPath(value: string): boolean {
  return value.length > 0 && value.length <= 1_000 && !value.startsWith("/") && !value.endsWith("/") &&
    !value.includes("//") && !value.includes("\\") && value.split("/").every((part) => PATH_SEGMENT.test(part));
}

function artifact(value: Artifact): boolean {
  return ID.test(value.artifactId) && SHA256.test(value.sha256);
}

export function delegatedPrAttestedArtifactClaims(evidence: DelegatedPrTrialEvidence): Readonly<
  Record<keyof DelegatedPrTrialEvidence["attestedArtifacts"], unknown>
> {
  const { artifact: _deliveryArtifact, ...deliveryClaims } = evidence.delivery;
  return freeze({
    workflow: evidence.workflow,
    model: evidence.model,
    accounting: evidence.meter,
    approvalAudit: evidence.approval,
    githubObservation: deliveryClaims,
    verification: evidence.verification,
    cleanup: evidence.cleanup,
    timeline: {
      startedAt: evidence.startedAt,
      modelSettledAt: evidence.model.settledAt,
      candidateCreatedAt: evidence.candidate.createdAt,
      verificationCompletedAt: evidence.verification.completedAt,
      approvedAt: evidence.approval.approvedAt,
      deliveredAt: evidence.delivery.observedAt,
      cleanedAt: evidence.cleanup.observedAt,
      executionCompletedAt: evidence.executionCompletedAt,
      finalizedAt: evidence.finalizedAt,
    },
    changedPaths: evidence.candidate.changedPaths,
  });
}

function attestedArtifactsValid(evidence: DelegatedPrTrialEvidence): boolean {
  const expected = delegatedPrAttestedArtifactClaims(evidence);
  return Object.entries(expected).every(([key, value]) => {
    const entry = evidence.attestedArtifacts[key as keyof typeof expected];
    return artifact(entry) && entry.sha256 === sha256(value).slice("sha256:".length);
  });
}

function add(
  findings: DelegatedPrAcceptanceFinding[], condition: boolean, code: string,
  severity: "P0" | "P1", trial: number | null,
): void {
  if (!condition && !findings.some((entry) => entry.code === code && entry.trial === trial)) {
    findings.push({ code, severity, trial });
  }
}

export function assertDelegatedPrAcceptanceContract(contract: DelegatedPrAcceptanceContract): void {
  const paths = [...contract.allowedChangedPaths];
  const valid = contract.schemaVersion === 1 && (contract.product === "fettler" || contract.product === "regauge") &&
    ID.test(contract.tenantId) && REVISION.test(contract.mendpointRevision) && artifact(contract.authorityManifest) &&
    artifact(contract.taskArtifact) &&
    ID.test(contract.repository.repositoryId) && Number.isSafeInteger(contract.repository.remoteRepositoryId) &&
    contract.repository.remoteRepositoryId > 0 && Number.isSafeInteger(contract.repository.installationId) &&
    contract.repository.installationId > 0 && ID.test(contract.repository.owner) && ID.test(contract.repository.name) &&
    ID.test(contract.repository.baseBranch) && REVISION.test(contract.repository.sourceRevision) &&
    artifact(contract.repository.sourceArtifact) && artifact(contract.repository.snapshotArtifact) &&
    DIGEST.test(contract.repository.treeDigest) && ID.test(contract.approvedModel.providerId) &&
    contract.approvedModel.endpointHost.length > 0 && !contract.approvedModel.endpointHost.includes("/") &&
    ID.test(contract.approvedModel.model) && DIGEST.test(contract.approvedModel.pricingDigest) &&
    ID.test(contract.verification.executionAuthorityId) && ID.test(contract.verification.authorityId) &&
    contract.verification.executionAuthorityId !== contract.verification.authorityId &&
    DIGEST.test(contract.verification.authorityDigest) &&
    DIGEST.test(contract.verification.failToPassCommandDigest) &&
    DIGEST.test(contract.verification.passToPassCommandDigest) && artifact(contract.verification.policyArtifact) &&
    contract.verification.requiredCheckIdentities.length > 0 &&
    contract.verification.requiredCheckIdentities.every((identity) => ID.test(identity)) &&
    new Set(contract.verification.requiredCheckIdentities).size === contract.verification.requiredCheckIdentities.length &&
    contract.verification.failToPassIdentities.length > 0 &&
    contract.verification.failToPassIdentities.every((identity) => ID.test(identity)) &&
    new Set(contract.verification.failToPassIdentities).size === contract.verification.failToPassIdentities.length &&
    ID.test(contract.verification.sandboxBackend) &&
    ID.test(contract.attestationProducer.principalId) && ID.test(contract.attestationProducer.service) &&
    contract.attestationProducer.trustedKeyIds.length > 0 &&
    contract.attestationProducer.trustedKeyIds.every((keyId) => ID.test(keyId)) &&
    new Set(contract.attestationProducer.trustedKeyIds).size === contract.attestationProducer.trustedKeyIds.length &&
    ID.test(contract.workflow.repository) && contract.workflow.workflowPath.startsWith(".github/workflows/") &&
    REVISION.test(contract.workflow.workflowRevision) && ID.test(contract.workflow.environment) &&
    Number.isSafeInteger(contract.requiredRepetitions) && contract.requiredRepetitions >= 3 &&
    Number.isFinite(contract.maximumTotalCostUsd) && contract.maximumTotalCostUsd > 0 &&
    Number.isSafeInteger(contract.maximumTrialDurationMs) && contract.maximumTrialDurationMs > 0 &&
    Number.isSafeInteger(contract.maximumProofAgeMs) && contract.maximumProofAgeMs > 0 &&
    paths.length > 0 && paths.every(validPath) && new Set(paths).size === paths.length &&
    paths.every((path, index) => index === 0 || compareCodeUnits(paths[index - 1]!, path) < 0);
  if (!valid) throw new Error("delegated_pr_acceptance_contract_invalid");
}

function validateProof(proof: DelegatedPrProof, contract: DelegatedPrAcceptanceContract): void {
  if (proof.schemaVersion !== 1 || !ID.test(proof.proofId) || timestamp(proof.generatedAt) === null ||
      proof.workflow.repository !== contract.workflow.repository || proof.workflow.workflowPath !== contract.workflow.workflowPath ||
      proof.workflow.workflowRevision !== contract.workflow.workflowRevision || proof.workflow.environment !== contract.workflow.environment ||
      !ID.test(proof.workflow.runId) || !Number.isSafeInteger(proof.workflow.runAttempt) || proof.workflow.runAttempt < 1 ||
      proof.trials.length !== contract.requiredRepetitions || proof.trials.some((trial, index) =>
        trial.trial !== index + 1 || trial.tenantId !== contract.tenantId || !ID.test(trial.runId) || !ID.test(trial.correlationId)) ||
      new Set(proof.trials.map((trial) => trial.runId)).size !== proof.trials.length ||
      new Set(proof.trials.map((trial) => trial.correlationId)).size !== proof.trials.length) {
    throw new Error("delegated_pr_acceptance_proof_invalid");
  }
}

function verificationValid(
  execution: DelegatedPrVerificationExecution, contract: DelegatedPrAcceptanceContract,
  candidateDigest: string, commandDigest: string, failToPass: boolean,
): boolean {
  return artifact(execution.artifact) && execution.authorityId === contract.verification.authorityId &&
    execution.authorityDigest === contract.verification.authorityDigest && execution.commandDigest === commandDigest &&
    execution.sourceDigest === contract.repository.treeDigest && execution.candidateDigest === candidateDigest &&
    DIGEST.test(execution.logsDigest) && execution.sandboxBackend === contract.verification.sandboxBackend &&
    Number.isSafeInteger(execution.baselineExitCode) && Number.isSafeInteger(execution.candidateExitCode) &&
    execution.baselineExitCode !== 126 && execution.candidateExitCode !== 126 && (failToPass
      ? execution.baselineVerdict === "test_failure" && execution.baselineExitCode > 0 &&
        ![124, 125, 126, 127, 128, 130, 137, 143].includes(execution.baselineExitCode) &&
        JSON.stringify([...execution.failingCheckIdentities].sort(compareCodeUnits)) ===
          JSON.stringify([...contract.verification.failToPassIdentities].sort(compareCodeUnits)) &&
        execution.candidateExitCode === 0
      : execution.baselineVerdict === "passed" && execution.failingCheckIdentities.length === 0 &&
        execution.baselineExitCode === 0 && execution.candidateExitCode === 0);
}

export function delegatedPrAttestationScope(
  contract: DelegatedPrAcceptanceContract,
  evidence: DelegatedPrTrialEvidence,
) {
  return {
    tenantId: contract.tenantId, repositoryId: contract.repository.repositoryId, runId: evidence.runId,
    correlationId: evidence.correlationId,
    sourceArtifacts: [contract.authorityManifest, contract.taskArtifact, contract.repository.sourceArtifact,
      evidence.attestedArtifacts.workflow, evidence.attestedArtifacts.model, evidence.attestedArtifacts.accounting,
      evidence.attestedArtifacts.approvalAudit, evidence.attestedArtifacts.githubObservation,
      evidence.attestedArtifacts.verification, evidence.attestedArtifacts.cleanup,
      evidence.attestedArtifacts.timeline, evidence.attestedArtifacts.changedPaths,
      evidence.approval.sealArtifact] as SoftwareAttestationArtifactInput[],
    snapshotArtifact: contract.repository.snapshotArtifact, candidateArtifact: evidence.candidate.artifact,
    verificationArtifacts: [evidence.verification.failToPass.artifact, evidence.verification.passToPass.artifact] as SoftwareAttestationArtifactInput[],
    policyArtifact: contract.verification.policyArtifact, deliveryArtifact: evidence.delivery.artifact,
    rollbackArtifact: evidence.cleanup.rollbackArtifact, waiverArtifact: null,
  };
}

export async function evaluateDelegatedPrAcceptance(input: Readonly<{
  proof: DelegatedPrProof | null | undefined;
  contract: DelegatedPrAcceptanceContract;
  authority: DelegatedPrAcceptanceAuthority;
  trustPolicy: SoftwareAttestationTrustPolicy;
}>): Promise<DelegatedPrAcceptanceReport> {
  const contract = snapshotPlain(input.contract, "delegated_pr_acceptance_contract_invalid");
  assertDelegatedPrAcceptanceContract(contract);
  const contractDigest = sha256(contract);
  const scope = freeze({ product: contract.product, tenantId: contract.tenantId,
    repositoryId: contract.repository.repositoryId, sourceRevision: contract.repository.sourceRevision,
    mendpointRevision: contract.mendpointRevision });
  if (!input.proof) {
    const findings = [{ code: "delegated_pr_proof_missing", severity: "P0" as const, trial: null }];
    return freeze({ schemaVersion: 1, contractVersion: DELEGATED_PR_ACCEPTANCE_VERSION, delegatedPrAccepted: false,
      proofDigest: null, contractDigest, evidenceDigest: null, trialCount: 0, totalCostUsd: 0, totalDurationMs: 0,
      allTrialsAccepted: false, scope, verifiedAt: null, signerKeyIds: [],
      acceptanceDigest: sha256({ domain: "mendpoint.delegated-pr-acceptance", schemaVersion: 1,
        contractVersion: DELEGATED_PR_ACCEPTANCE_VERSION, contractDigest, evidenceDigest: null, findings,
        proofDigest: null, scope, verifiedAt: null, signerKeyIds: [] }), findings });
  }
  const proof = snapshotPlain(input.proof, "delegated_pr_acceptance_proof_invalid");
  validateProof(proof, contract);
  const authorityManifest = snapshotPlain(await input.authority.manifest(), "delegated_pr_authority_invalid");
  if (!artifactEqual(authorityManifest, contract.authorityManifest)) {
    throw new Error("delegated_pr_authority_manifest_mismatch");
  }
  const verifiedAt = await input.authority.now();
  const verifiedAtMs = timestamp(verifiedAt);
  if (verifiedAtMs === null) throw new Error("delegated_pr_acceptance_verified_at_invalid");
  const generatedAtMs = timestamp(proof.generatedAt)!;
  if (generatedAtMs > verifiedAtMs || verifiedAtMs - generatedAtMs > contract.maximumProofAgeMs) {
    throw new Error("delegated_pr_acceptance_proof_invalid");
  }
  const findings: DelegatedPrAcceptanceFinding[] = [];
  const requestIds = new Set<string>();
  const pullRequests = new Set<string>();
  const jobIds = new Set<string>();
  const approvalIds = new Set<string>();
  const approvalSeals = new Set<string>();
  const failArtifacts = new Set<string>();
  const passArtifacts = new Set<string>();
  const rollbackArtifacts = new Set<string>();
  const attestations = new Set<string>();
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  const evidenceDigests: string[] = [];
  const signerKeyIds = new Set<string>();

  for (const ref of proof.trials) {
    const loaded = await input.authority.loadTrial(freeze(snapshotPlain(ref, "delegated_pr_acceptance_proof_invalid")));
    if (!loaded) { add(findings, false, "delegated_pr_authority_missing", "P0", ref.trial); continue; }
    const evidence = snapshotPlain(loaded, "delegated_pr_authority_invalid");
    evidenceDigests.push(sha256(evidence));
    const trial = ref.trial;
    add(findings, evidence.trial === trial && evidence.tenantId === ref.tenantId && evidence.runId === ref.runId &&
      evidence.correlationId === ref.correlationId && ID.test(evidence.jobId) &&
      evidence.workflow.repository === proof.workflow.repository &&
      evidence.workflow.workflowPath === proof.workflow.workflowPath &&
      evidence.workflow.workflowRevision === proof.workflow.workflowRevision &&
      evidence.workflow.environment === proof.workflow.environment &&
      evidence.workflow.runId === proof.workflow.runId && evidence.workflow.runAttempt === proof.workflow.runAttempt,
    "delegated_pr_authority_binding_mismatch", "P0", trial);
    add(findings, attestedArtifactsValid(evidence), "delegated_pr_attested_artifact_mismatch", "P0", trial);
    const independent: Array<readonly [Set<string>, string]> = [
      [jobIds, evidence.jobId], [approvalIds, evidence.approval.auditEventId],
      [approvalSeals, `${evidence.approval.sealArtifact.artifactId}:${evidence.approval.sealArtifact.sha256}`],
      [failArtifacts, `${evidence.verification.failToPass.artifact.artifactId}:${evidence.verification.failToPass.artifact.sha256}`],
      [passArtifacts, `${evidence.verification.passToPass.artifact.artifactId}:${evidence.verification.passToPass.artifact.sha256}`],
      [rollbackArtifacts, `${evidence.cleanup.rollbackArtifact.artifactId}:${evidence.cleanup.rollbackArtifact.sha256}`],
      [attestations, sha256(evidence.attestation)],
    ];
    for (const [set, identity] of independent) {
      if (set.has(identity)) add(findings, false, "delegated_pr_replay_identity_conflict", "P0", trial);
      set.add(identity);
    }
    add(findings, evidence.source.repositoryId === contract.repository.repositoryId &&
      evidence.source.remoteRepositoryId === contract.repository.remoteRepositoryId &&
      evidence.source.installationId === contract.repository.installationId && evidence.source.owner === contract.repository.owner &&
      evidence.source.name === contract.repository.name && evidence.source.baseBranch === contract.repository.baseBranch &&
      evidence.source.revision === contract.repository.sourceRevision &&
      artifactEqual(evidence.source.sourceArtifact, contract.repository.sourceArtifact) &&
      artifactEqual(evidence.source.snapshotArtifact, contract.repository.snapshotArtifact) &&
      evidence.source.treeDigest === contract.repository.treeDigest && artifactEqual(evidence.source.taskArtifact, contract.taskArtifact),
    "delegated_pr_source_binding_mismatch", "P0", trial);

    const start = timestamp(evidence.startedAt); const modelSettled = timestamp(evidence.model.settledAt);
    const candidateCreated = timestamp(evidence.candidate.createdAt); const verified = timestamp(evidence.verification.completedAt);
    const approved = timestamp(evidence.approval.approvedAt); const delivered = timestamp(evidence.delivery.observedAt);
    const cleaned = timestamp(evidence.cleanup.observedAt); const executionCompleted = timestamp(evidence.executionCompletedAt);
    const finalized = timestamp(evidence.finalizedAt);
    const timeline = [start, modelSettled, candidateCreated, verified, approved, delivered, cleaned, executionCompleted, finalized];
    const temporal = timeline.every((value) => value !== null) && timeline.every((value, index) =>
      index === 0 || (value as number) >= (timeline[index - 1] as number));
    add(findings, temporal && finalized !== null && finalized <= generatedAtMs,
      "delegated_pr_timeline_invalid", "P1", trial);
    add(findings, finalized !== null && finalized <= verifiedAtMs &&
      verifiedAtMs - finalized <= contract.maximumProofAgeMs,
    "delegated_pr_trial_stale", "P1", trial);
    const duration = start !== null && finalized !== null ? finalized - start : 0;
    add(findings, duration >= 0 && duration <= contract.maximumTrialDurationMs, "delegated_pr_duration_exceeded", "P1", trial);
    if (duration >= 0) totalDurationMs += duration;

    const liveGrade = gradeLiveModelProvenance({
      approved: { host: contract.approvedModel.endpointHost, model: contract.approvedModel.model },
      provenance: evidence.model.provenance, plannerSources: evidence.model.plannerSources,
      scriptedPlannerInjected: evidence.model.scriptedPlannerInjected,
    });
    add(findings, liveGrade.passed && evidence.model.pricingDigest === contract.approvedModel.pricingDigest &&
      evidence.model.provenance.every((record, index) => record.providerId === contract.approvedModel.providerId &&
        Number.isFinite(record.monotonicTimestampMs) && record.monotonicTimestampMs >= 0 &&
        (index === 0 || record.monotonicTimestampMs >= evidence.model.provenance[index - 1]!.monotonicTimestampMs)),
    "delegated_pr_live_model_invalid", "P0", trial);
    const modelNumbersValid = evidence.model.provenance.every((record) =>
      Number.isSafeInteger(record.promptTokens) && record.promptTokens > 0 &&
      Number.isSafeInteger(record.completionTokens) && record.completionTokens > 0 &&
      Number.isSafeInteger(record.totalTokens) && record.totalTokens > 0 &&
      typeof record.costUsd === "number" && Number.isFinite(record.costUsd) && record.costUsd > 0);
    const modelCost = evidence.model.provenance.reduce((sum, record) => sum + (record.costUsd ?? 0), 0);
    const inputTokens = evidence.model.provenance.reduce((sum, record) => sum + record.promptTokens, 0);
    const outputTokens = evidence.model.provenance.reduce((sum, record) => sum + record.completionTokens, 0);
    add(findings, modelNumbersValid && evidence.meter.costMeasured && typeof evidence.meter.costUsd === "number" &&
      Number.isFinite(evidence.meter.costUsd) && evidence.meter.costUsd > 0 &&
      Number.isSafeInteger(evidence.meter.inputTokens) && (evidence.meter.inputTokens ?? 0) > 0 &&
      Number.isSafeInteger(evidence.meter.outputTokens) && (evidence.meter.outputTokens ?? 0) > 0 &&
      Number.isSafeInteger(evidence.meter.durationMs) && (evidence.meter.durationMs ?? 0) > 0 &&
      (evidence.meter.durationMs ?? 0) <= duration &&
      Math.abs(evidence.meter.costUsd - modelCost) < 1e-9 && evidence.meter.inputTokens === inputTokens &&
      evidence.meter.outputTokens === outputTokens,
    "delegated_pr_accounting_mismatch", "P0", trial);
    totalCostUsd += evidence.meter.costUsd ?? 0;
    for (const record of evidence.model.provenance) {
      const ids = [...new Set([record.bodyRequestId, record.headerRequestId]
        .filter((value): value is string => Boolean(value)))];
      if (ids.length === 0) add(findings, false, "delegated_pr_replay_identity_conflict", "P0", trial);
      for (const requestId of ids) {
        if (requestIds.has(requestId)) add(findings, false, "delegated_pr_replay_identity_conflict", "P0", trial);
        requestIds.add(requestId);
      }
    }

    const changedPaths = [...evidence.candidate.changedPaths];
    add(findings, artifact(evidence.candidate.artifact) && REVISION.test(evidence.candidate.commitSha) &&
      DIGEST.test(evidence.candidate.treeDigest) && changedPaths.length > 0 &&
      changedPaths.every(validPath) && new Set(changedPaths).size === changedPaths.length &&
      changedPaths.every((path) => contract.allowedChangedPaths.includes(path)), "delegated_pr_candidate_invalid", "P0", trial);
    add(findings, evidence.verification.executionAuthorityId === contract.verification.executionAuthorityId &&
      verificationValid(evidence.verification.failToPass, contract, evidence.candidate.treeDigest,
      contract.verification.failToPassCommandDigest, true) && verificationValid(evidence.verification.passToPass, contract,
      evidence.candidate.treeDigest, contract.verification.passToPassCommandDigest, false),
    "delegated_pr_verification_invalid", "P0", trial);
    add(findings, evidence.approval.auditChainVerified && evidence.approval.action === "agent.candidate.approved" &&
      ID.test(evidence.approval.auditEventId) && ID.test(evidence.approval.requestId) &&
      ID.test(evidence.approval.membershipEvidenceId) && evidence.approval.principalKind === "human" &&
      evidence.approval.authMethod === "oidc" && evidence.approval.apiKeyId === null &&
      evidence.approval.principalId === evidence.approval.trustPrincipalId &&
      evidence.approval.candidateDigest === evidence.candidate.treeDigest && artifact(evidence.approval.sealArtifact),
    "delegated_pr_approval_invalid", "P0", trial);

    const observation = evidence.delivery.observation;
    const remotePaths = [...evidence.delivery.changedPaths];
    const remotePathsValid = remotePaths.length > 0 && remotePaths.every(validPath) &&
      new Set(remotePaths).size === remotePaths.length;
    add(findings, evidence.delivery.provider === "github" && evidence.delivery.publisher === "github_app" &&
      evidence.delivery.installationId === contract.repository.installationId &&
      evidence.delivery.remoteRepositoryId === contract.repository.remoteRepositoryId &&
      evidence.delivery.repositoryId === contract.repository.repositoryId && evidence.delivery.owner === contract.repository.owner &&
      evidence.delivery.name === contract.repository.name && evidence.delivery.baseBranch === contract.repository.baseBranch &&
      evidence.delivery.candidateDigest === evidence.candidate.treeDigest && artifact(evidence.delivery.artifact) &&
      Number.isSafeInteger(evidence.delivery.pullRequestNumber) && evidence.delivery.pullRequestNumber > 0 &&
      evidence.delivery.matchingOpenDrafts === 1 && observation.state === "draft" &&
      observation.baseRevision === contract.repository.sourceRevision && observation.headRevision === evidence.candidate.commitSha &&
      observation.checkRevision === evidence.candidate.commitSha && observation.checks === "success" &&
      remotePathsValid && evidence.delivery.treeDigest === evidence.candidate.treeDigest &&
      JSON.stringify(remotePaths.sort(compareCodeUnits)) === JSON.stringify([...changedPaths].sort(compareCodeUnits)) &&
      ID.test(evidence.delivery.headBranch) && observation.evidenceRefs.length > 0 &&
      observation.evidenceRefs.every((reference) => typeof reference === "string" && EVIDENCE_REF.test(reference)) &&
      JSON.stringify([...observation.checkIdentities].sort(compareCodeUnits)) ===
        JSON.stringify([...contract.verification.requiredCheckIdentities].sort(compareCodeUnits)) &&
      observation.checkResults.length === contract.verification.requiredCheckIdentities.length &&
      new Set(observation.checkResults.map((result) => result.identity)).size === observation.checkResults.length &&
      JSON.stringify(observation.checkResults.map((result) => result.identity).sort(compareCodeUnits)) ===
        JSON.stringify([...contract.verification.requiredCheckIdentities].sort(compareCodeUnits)) &&
      observation.checkResults.every((result) => result.state === "success"),
    "delegated_pr_delivery_invalid", "P0", trial);
    const pullIdentity = `${evidence.delivery.remoteRepositoryId}:${evidence.delivery.pullRequestNumber}`;
    if (pullRequests.has(pullIdentity)) add(findings, false, "delegated_pr_replay_identity_conflict", "P0", trial);
    pullRequests.add(pullIdentity);
    add(findings, evidence.cleanup.pullRequestState === "closed" &&
      (evidence.cleanup.branchState === "deleted" || evidence.cleanup.branchState === "retained_exact") &&
      evidence.cleanup.headRevision === evidence.candidate.commitSha &&
      evidence.cleanup.baseRevision === contract.repository.sourceRevision && evidence.cleanup.openTrialPullRequests === 0 &&
      artifact(evidence.cleanup.rollbackArtifact) && evidence.cleanup.evidenceRefs.length > 0 &&
      evidence.cleanup.evidenceRefs.every((reference) => EVIDENCE_REF.test(reference)),
    "delegated_pr_cleanup_invalid", "P0", trial);
    try {
      const verifiedAttestation = await verifySoftwareAttestation({ envelope: evidence.attestation,
        trustPolicy: input.trustPolicy, expectedScope: delegatedPrAttestationScope(contract, evidence), verifiedAt });
      add(findings, verifiedAttestation.statement.predicate.outcome === "passed" &&
        timestamp(verifiedAttestation.statement.predicate.issuedAt) !== null && cleaned !== null && finalized !== null &&
        executionCompleted !== null && Date.parse(verifiedAttestation.statement.predicate.issuedAt) >= executionCompleted &&
        Date.parse(verifiedAttestation.statement.predicate.issuedAt) === finalized &&
        verifiedAttestation.statement.predicate.producer.principalId === contract.attestationProducer.principalId &&
        verifiedAttestation.statement.predicate.producer.service === contract.attestationProducer.service &&
        verifiedAttestation.statement.predicate.producer.version === contract.mendpointRevision &&
        verifiedAttestation.keys.every((key) => contract.attestationProducer.trustedKeyIds.includes(key.keyId)),
      "delegated_pr_attestation_invalid", "P0", trial);
      for (const key of verifiedAttestation.keys) signerKeyIds.add(key.keyId);
    } catch { add(findings, false, "delegated_pr_attestation_invalid", "P0", trial); }
  }

  add(findings, totalCostUsd <= contract.maximumTotalCostUsd, "delegated_pr_budget_exceeded", "P0", null);
  findings.sort((left, right) => compareCodeUnits(`${left.trial ?? 0}:${left.code}`, `${right.trial ?? 0}:${right.code}`));
  const proofDigest = sha256(proof);
  const evidenceDigest = sha256(evidenceDigests.sort(compareCodeUnits));
  const orderedSignerKeyIds = [...signerKeyIds].sort(compareCodeUnits);
  const acceptanceDigest = sha256({ domain: "mendpoint.delegated-pr-acceptance", schemaVersion: 1,
    contractVersion: DELEGATED_PR_ACCEPTANCE_VERSION, contractDigest, evidenceDigest, findings, proofDigest, scope,
    verifiedAt, signerKeyIds: orderedSignerKeyIds });
  return freeze({ schemaVersion: 1, contractVersion: DELEGATED_PR_ACCEPTANCE_VERSION,
    delegatedPrAccepted: findings.length === 0 && proof.trials.length === contract.requiredRepetitions,
    proofDigest, contractDigest, evidenceDigest, acceptanceDigest, scope, verifiedAt,
    signerKeyIds: orderedSignerKeyIds, trialCount: proof.trials.length,
    totalCostUsd, totalDurationMs, allTrialsAccepted: findings.length === 0, findings });
}
