import { createHash } from "node:crypto";
import {
  verifyDomainEventIntegrity,
  type AppDb,
  type ArtifactManifestRow,
  type DomainEventRow,
  type EvidenceRecordRow,
  type PrincipalRow,
} from "@mendpoint/db";
import {
  verifySoftwareAttestation,
  type SoftwareAttestationArtifactInput,
  type SoftwareAttestationTrustPolicy,
} from "@mendpoint/contract";
import {
  assertDelegatedPrAcceptanceContract,
  delegatedPrAttestedArtifactClaims,
  delegatedPrAttestationScope,
  type DelegatedPrAcceptanceAuthority,
  type DelegatedPrAcceptanceContract,
  type DelegatedPrTrialEvidence,
} from "./enterprise-delegation-proof.js";
import {
  getVerifiedFettlerDelegationEvidence,
  type VerifiedFettlerDelegationEvidence,
} from "@mendpoint/pipeline";

export const DELEGATED_PR_TRIAL_BUNDLE_KIND = "delegated_pr_trial_bundle" as const;
export const DELEGATED_PR_TRIAL_BUNDLE_MEDIA_TYPE =
  "application/vnd.mendpoint.delegated-pr-trial+json" as const;
export const DELEGATED_PR_TRIAL_ASSEMBLER = "mendpoint-delegated-trial-assembler" as const;

export type StoredDelegatedPrTrialAuthorityConfig = Readonly<{
  contract: DelegatedPrAcceptanceContract;
  producerPrincipalId: string;
  producerService: string;
  producerVersion: string;
  verifiedAt: string;
  maximumCleanupAgeMs?: number;
  cleanupTrustPolicy: SoftwareAttestationTrustPolicy;
  trialTrustPolicy: SoftwareAttestationTrustPolicy;
}>;

export type DelegatedPrTrialBundleV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof DELEGATED_PR_TRIAL_BUNDLE_KIND;
  bundleId: string;
  trialDigest: string;
  assembledAt: string;
  trial: DelegatedPrTrialEvidence;
}>;

const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_BYTES = 4 * 1024 * 1024;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function contentDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function snapshotPlain<T>(value: T, code: string): T {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > 50_000 || depth > 32) throw new Error(code);
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error(code);
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current) || current.length > 2_000) throw new Error(code);
      seen.add(current);
      const copy = current.map((child) => visit(child, depth + 1));
      seen.delete(current);
      return copy;
    }
    if (typeof current !== "object" || current === undefined) throw new Error(code);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
    if (seen.has(current)) throw new Error(code);
    seen.add(current);
    const copy: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))
      .sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
        throw new Error(code);
      }
      copy[key] = visit(descriptor.value, depth + 1);
    }
    seen.delete(current);
    return copy;
  };
  return deepFreeze(visit(value, 0) as T);
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseObject(value: string, code: string): Record<string, unknown> {
  try {
    const parsed = object(JSON.parse(value));
    if (!parsed) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
}

function parsePlainJson(value: string, code: string): unknown {
  try {
    return snapshotPlain(JSON.parse(value), code);
  } catch {
    throw new Error(code);
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const expected = [...keys].sort(compareCodeUnits);
  if (canonical(actual) !== canonical(expected)) throw new Error(code);
}

function artifactEqual(
  left: Readonly<{ artifactId: string; sha256: string }>,
  right: Readonly<{ artifactId: string; sha256: string }>,
): boolean {
  return left.artifactId === right.artifactId && left.sha256 === right.sha256;
}

function captureTrustPolicy(policy: SoftwareAttestationTrustPolicy): SoftwareAttestationTrustPolicy {
  const receiver = policy;
  const resolve = policy.resolve;
  const candidates = policy.candidates;
  return Object.freeze({
    threshold: policy.threshold,
    ...(resolve ? { resolve: (keyId: string) => Reflect.apply(resolve, receiver, [keyId]) } : {}),
    ...(candidates ? { candidates: () => Reflect.apply(candidates, receiver, []) } : {}),
  });
}

function observed<T>(
  evidence: { status: "observed"; value: T } | { status: "not_observed"; reason: string },
  code: string,
): T {
  if (evidence.status !== "observed") throw new Error(code);
  return evidence.value;
}

function normalizeSha(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function exactGitHubPullUrl(
  value: string | null,
  owner: string,
  repo: string,
  pullRequestNumber: number,
): boolean {
  if (value === null) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && !url.username && !url.password &&
      !url.search && !url.hash &&
      url.pathname.toLowerCase() === `/${owner}/${repo}/pull/${pullRequestNumber}`.toLowerCase();
  } catch {
    return false;
  }
}

function trialSubject(runId: string, trial: number): string {
  return `${runId}:${trial}`;
}

export function delegatedPrTrialBundleId(input: Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  trial: number;
  trialDigest: string;
}>): string {
  if (!ID.test(input.tenantId) || !ID.test(input.runId) || !ID.test(input.correlationId) ||
      !Number.isSafeInteger(input.trial) || input.trial < 1 || !DIGEST.test(input.trialDigest)) {
    throw new Error("delegated_pr_trial_bundle_identity_invalid");
  }
  return `trial_bundle_${createHash("sha256").update(
    `${input.tenantId}\0${input.runId}\0${input.correlationId}\0${input.trial}\0${input.trialDigest}`,
    "utf8",
  ).digest("hex")}`;
}

function loadManifest(db: AppDb, tenantId: string, artifactId: string): ArtifactManifestRow | undefined {
  return db.raw.prepare(
    "SELECT * FROM artifact_manifests WHERE tenant_id = ? AND id = ?",
  ).get(tenantId, artifactId) as ArtifactManifestRow | undefined;
}

function verifiedArtifactContent(
  db: AppDb,
  tenantId: string,
  artifact: Readonly<{ artifactId: string; sha256: string }>,
  code: string,
): Record<string, unknown> {
  const row = loadManifest(db, tenantId, artifact.artifactId);
  if (!row?.content_text || row.sha256 !== artifact.sha256 || !SHA256.test(row.sha256) ||
      row.size_bytes !== Buffer.byteLength(row.content_text, "utf8") ||
      row.sha256 !== contentDigest(row.content_text)) {
    throw new Error(code);
  }
  return parseObject(row.content_text, code);
}

function withoutArtifact(
  value: DelegatedPrTrialEvidence["verification"]["failToPass"],
): Omit<typeof value, "artifact"> {
  const { artifact: _artifact, ...claims } = value;
  return claims;
}

function assertVerificationAuthority(
  db: AppDb,
  trial: DelegatedPrTrialEvidence,
  contract: DelegatedPrAcceptanceContract,
): void {
  for (const [role, execution] of [
    ["fail_to_pass", trial.verification.failToPass],
    ["pass_to_pass", trial.verification.passToPass],
  ] as const) {
    const claims = verifiedArtifactContent(
      db,
      trial.tenantId,
      execution.artifact,
      "delegated_pr_trial_verification_artifact_invalid",
    );
    const expected = {
      schemaVersion: 1,
      kind: "delegated_pr_verification_execution",
      role,
      tenantId: trial.tenantId,
      runId: trial.runId,
      candidateArtifact: trial.candidate.artifact,
      execution: withoutArtifact(execution),
    };
    if (canonical(claims) !== canonical(expected)) {
      throw new Error("delegated_pr_trial_verification_artifact_invalid");
    }
    const rows = db.raw.prepare(
      `SELECT * FROM evidence_records WHERE tenant_id = ? AND subject_type = 'delegated_pr_verification'
         AND subject_id = ? ORDER BY created_at, id`,
    ).all(trial.tenantId, `${trial.runId}:${role}`) as EvidenceRecordRow[];
    if (rows.length !== 1) throw new Error("delegated_pr_trial_verification_evidence_invalid");
    const evidence = rows[0]!;
    if (evidence.artifact_id !== execution.artifact.artifactId ||
        evidence.input_artifact_id !== trial.candidate.artifact.artifactId || evidence.verdict !== "passed" ||
        evidence.producer_principal_id !== contract.verification.authorityId ||
        evidence.tool !== "mendpoint-independent-verifier" ||
        evidence.tool_version !== contract.verification.authorityDigest ||
        evidence.commit_sha !== contract.mendpointRevision) {
      throw new Error("delegated_pr_trial_verification_evidence_invalid");
    }
    const producer = db.raw.prepare(
      `SELECT * FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'`,
    ).get(trial.tenantId, contract.verification.authorityId) as PrincipalRow | undefined;
    if (!producer || producer.created_at > evidence.created_at ||
        producer.revoked_at && producer.revoked_at <= evidence.created_at ||
        producer.expires_at && producer.expires_at <= evidence.created_at) {
      throw new Error("delegated_pr_trial_verification_evidence_invalid");
    }
  }
}

function assertClaimArtifacts(
  db: AppDb,
  trial: DelegatedPrTrialEvidence,
  producerPrincipalId: string,
): void {
  const claims = delegatedPrAttestedArtifactClaims(trial);
  for (const [key, value] of Object.entries(claims)) {
    const ref = trial.attestedArtifacts[key as keyof typeof trial.attestedArtifacts];
    const row = loadManifest(db, trial.tenantId, ref.artifactId);
    if (!row?.content_text || row.kind !== "delegated_pr_attested_claim" || row.schema_version !== 1 ||
        row.media_type !== "application/json" || row.producer_principal_id !== producerPrincipalId ||
        row.sha256 !== ref.sha256 || row.size_bytes !== Buffer.byteLength(row.content_text, "utf8") ||
        contentDigest(row.content_text) !== row.sha256 || canonical(parsePlainJson(row.content_text,
          "delegated_pr_trial_claim_artifact_invalid")) !== canonical(value)) {
      throw new Error("delegated_pr_trial_claim_artifact_invalid");
    }
  }
}

function assertDeliveryObservation(
  db: AppDb,
  trial: DelegatedPrTrialEvidence,
  inventory: VerifiedFettlerDelegationEvidence,
): void {
  const ci = observed(inventory.ci, "delegated_pr_trial_ci_not_observed");
  const matches = ci.flatMap((entry) => entry.observations).filter((entry) =>
    entry.evidenceArtifactId === trial.delivery.artifact.artifactId &&
    normalizeSha(entry.evidenceDigest) === trial.delivery.artifact.sha256 &&
    entry.headSha === trial.candidate.commitSha && entry.verdict === "success" &&
    entry.observedAt === trial.delivery.observedAt);
  if (matches.length !== 1) throw new Error("delegated_pr_trial_delivery_observation_invalid");
  const claims = verifiedArtifactContent(
    db,
    trial.tenantId,
    trial.delivery.artifact,
    "delegated_pr_trial_delivery_observation_invalid",
  );
  if (canonical(claims) !== canonical(trial.delivery.observation)) {
    throw new Error("delegated_pr_trial_delivery_observation_invalid");
  }
}

function requireManifest(
  db: AppDb,
  tenantId: string,
  artifact: Readonly<{ artifactId: string; sha256: string }>,
  producerPrincipalId: string,
): ArtifactManifestRow {
  const row = loadManifest(db, tenantId, artifact.artifactId);
  if (!row?.content_text || row.sha256 !== artifact.sha256 || !SHA256.test(row.sha256) ||
      contentDigest(row.content_text) !== row.sha256 || Buffer.byteLength(row.content_text, "utf8") !== row.size_bytes ||
      row.producer_principal_id !== producerPrincipalId) {
    throw new Error("delegated_pr_trial_authority_manifest_invalid");
  }
  return row;
}

function exactArtifactSet(
  values: readonly SoftwareAttestationArtifactInput[],
): Set<string> {
  return new Set(values.map((entry) => `${entry.artifactId}:${entry.sha256}`));
}

function assertCleanupScope(
  trial: DelegatedPrTrialEvidence,
  inventory: VerifiedFettlerDelegationEvidence,
  contract: DelegatedPrAcceptanceContract,
): void {
  const cleanup = observed(inventory.cleanup, "delegated_pr_trial_cleanup_not_observed");
  const scope = cleanup.attestationScope;
  const sourceArtifacts = exactArtifactSet(scope.sourceArtifacts);
  const verificationArtifacts = exactArtifactSet(scope.verificationArtifacts);
  if (!scope.deliveryArtifact || !scope.rollbackArtifact ||
      !artifactEqual(trial.source.snapshotArtifact, scope.snapshotArtifact) ||
      !artifactEqual(trial.candidate.artifact, scope.candidateArtifact) ||
      !artifactEqual(trial.delivery.artifact, scope.deliveryArtifact) ||
      !artifactEqual(trial.cleanup.rollbackArtifact, scope.rollbackArtifact) ||
      !verificationArtifacts.has(`${trial.verification.failToPass.artifact.artifactId}:${trial.verification.failToPass.artifact.sha256}`) ||
      !verificationArtifacts.has(`${trial.verification.passToPass.artifact.artifactId}:${trial.verification.passToPass.artifact.sha256}`) ||
      !artifactEqual(scope.policyArtifact, contract.verification.policyArtifact) ||
      !sourceArtifacts.has(`${contract.authorityManifest.artifactId}:${contract.authorityManifest.sha256}`) ||
      !sourceArtifacts.has(`${contract.taskArtifact.artifactId}:${contract.taskArtifact.sha256}`) ||
      !sourceArtifacts.has(`${trial.source.sourceArtifact.artifactId}:${trial.source.sourceArtifact.sha256}`)) {
    throw new Error("delegated_pr_trial_cleanup_scope_mismatch");
  }
}

function assertDurableBindings(
  db: AppDb,
  trial: DelegatedPrTrialEvidence,
  inventory: VerifiedFettlerDelegationEvidence,
  contract: DelegatedPrAcceptanceContract,
): void {
  if (!inventory.auditIntegrity.ok) throw new Error("delegated_pr_trial_audit_invalid");
  const run = observed(inventory.agentRun, "delegated_pr_trial_run_not_observed");
  const job = observed(inventory.job, "delegated_pr_trial_job_not_observed");
  const trajectory = observed(inventory.trajectory, "delegated_pr_trial_trajectory_not_observed");
  const reservations = observed(inventory.modelReservations, "delegated_pr_trial_model_not_observed");
  observed(inventory.routingLedger, "delegated_pr_trial_routing_not_observed");
  const meter = observed(inventory.runMeter, "delegated_pr_trial_meter_not_observed");
  const approval = observed(inventory.approval, "delegated_pr_trial_approval_not_observed");
  const delivered = observed(inventory.candidateDelivery, "delegated_pr_trial_delivery_not_observed");
  const ci = observed(inventory.ci, "delegated_pr_trial_ci_not_observed");
  const terminal = observed(inventory.terminalOutcome, "delegated_pr_trial_terminal_not_observed");
  const cleanup = observed(inventory.cleanup, "delegated_pr_trial_cleanup_not_observed");
  if (job.id !== trial.jobId || run.job_id !== job.id || delivered.auditReason !== null ||
      delivered.auditEvents.length !== 1 || ci.length !== 1 || terminal.outcome !== "closed_unmerged") {
    throw new Error("delegated_pr_trial_durable_binding_mismatch");
  }

  if (typeof run.result_json !== "string" || typeof run.files_changed_json !== "string") {
    throw new Error("delegated_pr_trial_run_corrupt");
  }
  const result = parseObject(run.result_json, "delegated_pr_trial_run_corrupt");
  const artifacts = object(result.artifacts);
  const agent = object(result.agent);
  const metrics = object(agent?.metrics);
  const model = object(metrics?.model);
  const provenance = model?.provenance;
  const changedPaths = JSON.parse(run.files_changed_json) as unknown;
  const plannerSources = trajectory.steps
    .filter((step) => step.stepKind === "model_call")
    .map((step) => step.plannerSource)
    .filter((value): value is string => value !== null);
  const latestSettlement = reservations.map((row) => row.settled_at).filter((value): value is string => value !== null)
    .sort(compareCodeUnits).at(-1);
  if (!Array.isArray(provenance) || !Array.isArray(changedPaths) || !latestSettlement ||
      canonical(trial.model.provenance) !== canonical(provenance) ||
      canonical(trial.model.plannerSources) !== canonical(plannerSources) || trial.model.scriptedPlannerInjected ||
      trial.model.settledAt !== latestSettlement || trial.model.pricingDigest !== contract.approvedModel.pricingDigest ||
      trial.meter.costMeasured !== meter.costMeasured || trial.meter.costUsd !== meter.costUsd ||
      trial.meter.inputTokens !== meter.inputTokens || trial.meter.outputTokens !== meter.outputTokens ||
      trial.meter.durationMs !== meter.durationMs || canonical(trial.candidate.changedPaths) !== canonical(changedPaths) ||
      normalizeSha(String(artifacts?.candidateDigest ?? "")) !== trial.candidate.artifact.sha256) {
    throw new Error("delegated_pr_trial_execution_binding_mismatch");
  }
  if (run.created_at !== trial.startedAt || meter.createdAt !== trial.startedAt ||
      run.finished_at !== trial.candidate.createdAt || meter.candidateReadyAt !== trial.candidate.createdAt) {
    throw new Error("delegated_pr_trial_execution_timeline_mismatch");
  }

  const delivery = delivered.delivery;
  const cycle = ci[0]!.cycle;
  if (trial.source.repositoryId !== delivery.repositoryId || trial.source.snapshotArtifact.artifactId !== delivery.snapshotId ||
      trial.source.baseBranch !== delivery.baseBranch || trial.source.revision !== delivery.expectedBaseRevision ||
      trial.source.remoteRepositoryId !== cycle.remoteRepositoryId || trial.source.installationId !== cycle.installationId ||
      trial.candidate.commitSha !== delivery.commitSha || trial.delivery.repositoryId !== delivery.repositoryId ||
      trial.delivery.baseBranch !== delivery.baseBranch || trial.delivery.headBranch !== delivery.branchName ||
      trial.delivery.pullRequestNumber !== delivery.draftPrNumber || trial.delivery.candidateDigest !== normalizeSha(approval.candidate.digest) ||
      trial.delivery.installationId !== cycle.installationId || trial.delivery.remoteRepositoryId !== cycle.remoteRepositoryId ||
      trial.approval.auditEventId !== approval.auditEvents[0]!.id || trial.approval.requestId !== approval.requestIds[0] ||
      trial.approval.membershipEvidenceId !== approval.membershipEvidenceId ||
      trial.approval.principalId !== approval.reviewerPrincipalId ||
      trial.approval.trustPrincipalId !== approval.trustPrincipalId || trial.approval.authMethod !== approval.authMethod ||
      trial.approval.approvedAt !== approval.reviewedAt ||
      trial.approval.candidateDigest !== normalizeSha(approval.candidate.digest) ||
      trial.approval.sealArtifact.artifactId !== approval.seal.path ||
      trial.approval.sealArtifact.sha256 !== normalizeSha(approval.seal.sha256)) {
    throw new Error("delegated_pr_trial_review_delivery_mismatch");
  }
  if (trial.source.owner !== contract.repository.owner || trial.source.name !== contract.repository.name ||
      trial.delivery.owner !== contract.repository.owner || trial.delivery.name !== contract.repository.name ||
      !exactGitHubPullUrl(delivery.draftPrUrl, trial.delivery.owner, trial.delivery.name,
        trial.delivery.pullRequestNumber) || !delivery.deliveredAt || !timestamp(delivery.deliveredAt) ||
      Date.parse(delivery.deliveredAt) > Date.parse(trial.delivery.observedAt)) {
    throw new Error("delegated_pr_trial_delivery_identity_mismatch");
  }
  const cleanupEvidence = cleanup.cleanup;
  if (trial.cleanup.pullRequestState !== cleanupEvidence.pullRequestState ||
      trial.cleanup.branchState !== cleanupEvidence.branchState ||
      trial.cleanup.headRevision !== cleanupEvidence.headSha || trial.cleanup.baseRevision !== cleanupEvidence.baseSha ||
      trial.cleanup.openTrialPullRequests !== cleanupEvidence.openPullRequestsForHead ||
      trial.cleanup.observedAt !== cleanup.observedAt || !artifactEqual(trial.cleanup.rollbackArtifact, cleanup.artifact) ||
      canonical(trial.cleanup.evidenceRefs) !== canonical(cleanupEvidence.evidenceRefs) ||
      cleanupEvidence.pullRequestNumber !== trial.delivery.pullRequestNumber ||
      !exactGitHubPullUrl(cleanupEvidence.pullRequestUrl, trial.delivery.owner, trial.delivery.name,
        trial.delivery.pullRequestNumber)) {
    throw new Error("delegated_pr_trial_cleanup_binding_mismatch");
  }
  assertCleanupScope(trial, inventory, contract);
  assertDeliveryObservation(db, trial, inventory);
  assertVerificationAuthority(db, trial, contract);
}

function validateBundle(
  row: ArtifactManifestRow,
  ref: Readonly<{ tenantId: string; runId: string; correlationId: string; trial: number }>,
): DelegatedPrTrialBundleV1 {
  if (!row.content_text || row.kind !== DELEGATED_PR_TRIAL_BUNDLE_KIND || row.schema_version !== 1 ||
      row.media_type !== DELEGATED_PR_TRIAL_BUNDLE_MEDIA_TYPE || row.size_bytes > MAX_BYTES ||
      row.size_bytes !== Buffer.byteLength(row.content_text, "utf8") || row.sha256 !== contentDigest(row.content_text)) {
    throw new Error("delegated_pr_trial_bundle_corrupt");
  }
  const value = parseObject(row.content_text, "delegated_pr_trial_bundle_corrupt");
  exactKeys(value, ["schemaVersion", "kind", "bundleId", "trialDigest", "assembledAt", "trial"],
    "delegated_pr_trial_bundle_corrupt");
  const trial = snapshotPlain(value.trial, "delegated_pr_trial_bundle_corrupt") as DelegatedPrTrialEvidence;
  const trialDigest = digest(trial);
  const expectedId = delegatedPrTrialBundleId({ ...ref, trialDigest });
  if (value.schemaVersion !== 1 || value.kind !== DELEGATED_PR_TRIAL_BUNDLE_KIND || value.bundleId !== expectedId ||
      value.trialDigest !== trialDigest || row.id !== expectedId || !timestamp(value.assembledAt) ||
      trial.trial !== ref.trial || trial.tenantId !== ref.tenantId || trial.runId !== ref.runId ||
      trial.correlationId !== ref.correlationId) {
    throw new Error("delegated_pr_trial_bundle_mismatch");
  }
  return deepFreeze(value as unknown as DelegatedPrTrialBundleV1);
}

function assertProducer(db: AppDb, row: ArtifactManifestRow, producerPrincipalId: string): void {
  const principal = db.raw.prepare(
    `SELECT * FROM principals WHERE tenant_id = ? AND id = ? AND kind = 'service'`,
  ).get(row.tenant_id, producerPrincipalId) as PrincipalRow | undefined;
  if (!principal || row.producer_principal_id !== producerPrincipalId ||
      principal.created_at > row.created_at || principal.revoked_at && principal.revoked_at <= row.created_at ||
      principal.expires_at && principal.expires_at <= row.created_at) {
    throw new Error("delegated_pr_trial_producer_invalid");
  }
}

function loadEvidence(
  db: AppDb,
  ref: Readonly<{ tenantId: string; runId: string; trial: number }>,
): EvidenceRecordRow | undefined {
  const rows = db.raw.prepare(
    `SELECT * FROM evidence_records WHERE tenant_id = ? AND subject_type = 'delegated_pr_trial'
       AND subject_id = ? ORDER BY created_at, id`,
  ).all(ref.tenantId, trialSubject(ref.runId, ref.trial)) as EvidenceRecordRow[];
  if (rows.length > 1) throw new Error("delegated_pr_trial_evidence_ambiguous");
  return rows[0];
}

function assertEvent(
  db: AppDb,
  bundle: DelegatedPrTrialBundleV1,
  row: ArtifactManifestRow,
  evidence: EvidenceRecordRow,
  producerPrincipalId: string,
): void {
  const integrity = verifyDomainEventIntegrity(db, bundle.trial.tenantId);
  if (!integrity.ok) throw new Error("delegated_pr_trial_event_integrity_invalid");
  const events = db.raw.prepare(
    `SELECT * FROM domain_events WHERE tenant_id = ? AND aggregate_type = 'delegated_pr_trial'
       AND aggregate_id = ? AND event_type = 'delegated_pr_trial.assembled'`,
  ).all(bundle.trial.tenantId, bundle.bundleId) as DomainEventRow[];
  if (events.length !== 1) throw new Error("delegated_pr_trial_event_ambiguous");
  const event = events[0]!;
  const payload = parseObject(event.payload_json, "delegated_pr_trial_event_corrupt");
  exactKeys(payload, ["bundleId", "artifactId", "evidenceId", "trialDigest", "tenantId", "runId",
    "correlationId", "jobId", "trial", "cleanupArtifactId", "assembledAt"],
  "delegated_pr_trial_event_corrupt");
  if (event.actor_principal_id !== producerPrincipalId || event.correlation_id !== bundle.trial.correlationId ||
      event.idempotency_key !== `delegated-pr-trial:${bundle.bundleId}` ||
      event.schema_version !== 1 || payload.bundleId !== bundle.bundleId || payload.artifactId !== row.id ||
      payload.evidenceId !== evidence.id || payload.trialDigest !== bundle.trialDigest ||
      payload.tenantId !== bundle.trial.tenantId || payload.runId !== bundle.trial.runId ||
      payload.correlationId !== bundle.trial.correlationId || payload.jobId !== bundle.trial.jobId ||
      payload.trial !== bundle.trial.trial || payload.cleanupArtifactId !== evidence.input_artifact_id ||
      payload.assembledAt !== bundle.assembledAt || event.created_at !== bundle.assembledAt) {
    throw new Error("delegated_pr_trial_event_corrupt");
  }
}

export function createStoredDelegatedPrTrialAuthority(
  db: AppDb,
  rawConfig: StoredDelegatedPrTrialAuthorityConfig,
): DelegatedPrAcceptanceAuthority {
  const config = snapshotPlain({
    contract: rawConfig.contract,
    producerPrincipalId: rawConfig.producerPrincipalId,
    producerService: rawConfig.producerService,
    producerVersion: rawConfig.producerVersion,
    verifiedAt: rawConfig.verifiedAt,
    maximumCleanupAgeMs: rawConfig.maximumCleanupAgeMs,
  }, "delegated_pr_trial_authority_config_invalid");
  assertDelegatedPrAcceptanceContract(config.contract);
  if (!ID.test(config.producerPrincipalId) || !ID.test(config.producerService) ||
      !ID.test(config.producerVersion) || !timestamp(config.verifiedAt) ||
      config.producerPrincipalId !== config.contract.attestationProducer.principalId ||
      config.producerService !== config.contract.attestationProducer.service ||
      config.producerVersion !== config.contract.mendpointRevision ||
      config.maximumCleanupAgeMs !== undefined &&
        (!Number.isSafeInteger(config.maximumCleanupAgeMs) || config.maximumCleanupAgeMs < 1)) {
    throw new Error("delegated_pr_trial_authority_config_invalid");
  }
  const cleanupTrustPolicy = captureTrustPolicy(rawConfig.cleanupTrustPolicy);
  const trialTrustPolicy = captureTrustPolicy(rawConfig.trialTrustPolicy);
  return Object.freeze({
    async loadTrial(ref) {
      const requested = snapshotPlain(ref, "delegated_pr_trial_reference_invalid");
      if (requested.tenantId !== config.contract.tenantId || !ID.test(requested.runId) ||
          !ID.test(requested.correlationId) || !Number.isSafeInteger(requested.trial) || requested.trial < 1) {
        return null;
      }
      const evidence = loadEvidence(db, requested);
      if (!evidence) return null;
      if (evidence.verdict !== "passed" || evidence.tool !== DELEGATED_PR_TRIAL_ASSEMBLER ||
          evidence.tool_version !== config.producerVersion || evidence.producer_principal_id !== config.producerPrincipalId ||
          evidence.commit_sha !== config.contract.mendpointRevision || !evidence.input_artifact_id) {
        throw new Error("delegated_pr_trial_evidence_invalid");
      }
      const row = loadManifest(db, requested.tenantId, evidence.artifact_id);
      if (!row) throw new Error("delegated_pr_trial_bundle_missing");
      assertProducer(db, row, config.producerPrincipalId);
      const bundle = validateBundle(row, requested);
      if (bundle.assembledAt !== evidence.created_at || row.created_at !== bundle.assembledAt ||
          !timestamp(bundle.trial.finalizedAt) || Date.parse(bundle.assembledAt) < Date.parse(bundle.trial.finalizedAt) ||
          Date.parse(bundle.assembledAt) > Date.parse(config.verifiedAt)) {
        throw new Error("delegated_pr_trial_evidence_invalid");
      }
      const inventory = await getVerifiedFettlerDelegationEvidence(db, {
        tenantId: requested.tenantId,
        runId: requested.runId,
        correlationId: requested.correlationId,
        verifiedAt: config.verifiedAt,
        maximumAgeMs: config.maximumCleanupAgeMs,
        trustPolicy: cleanupTrustPolicy,
      });
      const cleanup = observed(inventory.cleanup, "delegated_pr_trial_cleanup_not_observed");
      if (evidence.input_artifact_id !== cleanup.artifact.artifactId) {
        throw new Error("delegated_pr_trial_cleanup_binding_mismatch");
      }
      assertEvent(db, bundle, row, evidence, config.producerPrincipalId);
      assertDurableBindings(db, bundle.trial, inventory, config.contract);
      assertClaimArtifacts(db, bundle.trial, config.producerPrincipalId);
      const verified = await verifySoftwareAttestation({
        envelope: bundle.trial.attestation,
        trustPolicy: trialTrustPolicy,
        expectedScope: delegatedPrAttestationScope(config.contract, bundle.trial),
        verifiedAt: config.verifiedAt,
      });
      if (verified.statement.predicate.outcome !== "passed" ||
          verified.statement.predicate.producer.principalId !== config.producerPrincipalId ||
          verified.statement.predicate.producer.service !== config.producerService ||
          verified.statement.predicate.producer.version !== config.producerVersion ||
          verified.statement.predicate.issuedAt !== bundle.trial.finalizedAt ||
          verified.keys.some((key) => key.principalId !== config.producerPrincipalId ||
            key.service !== config.producerService ||
            !config.contract.attestationProducer.trustedKeyIds.includes(key.keyId))) {
        throw new Error("delegated_pr_trial_attestation_invalid");
      }
      return deepFreeze(bundle.trial);
    },
    async manifest() {
      const row = requireManifest(
        db,
        config.contract.tenantId,
        config.contract.authorityManifest,
        config.producerPrincipalId,
      );
      if (row.kind !== "delegated_pr_acceptance_authority" || row.schema_version !== 1) {
        throw new Error("delegated_pr_trial_authority_manifest_invalid");
      }
      return deepFreeze({ artifactId: row.id, sha256: row.sha256 });
    },
    async now() {
      return config.verifiedAt;
    },
  });
}
