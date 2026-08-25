import { createHash } from "node:crypto";
import {
  getAgentRun,
  getPrincipal,
  getWardenCandidateDelivery,
  getWardenCiCycle,
  listWardenCiObservations,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  EXACT_DRAFT_OBSERVATION_EVIDENCE_VERSION,
  exactDraftCleanupOperationId,
  type ExactDraftCleanupInput,
} from "@mendpoint/github";
import { assertDelegatedPrVerificationApprovalAuthority } from "./delegated-pr-verification-job.js";
import { WARDEN_CANDIDATE_CLEANUP_JOB_TYPE } from "./warden-candidate-observation.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const REPOSITORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export type DelegatedPrCleanupAuthority = Readonly<{
  tenantId: string;
  runId: string;
  correlationId: string;
  actorPrincipalId: string;
  repositoryId: string;
  deliveryRecordId: string;
  cycleId: string;
  observationId: string;
  observationArtifactId: string;
  candidateArtifactId: string;
  verificationArtifactIds: readonly [string, string];
  snapshotId: string;
  resolvedAt: string;
  cleanup: ExactDraftCleanupInput;
}>;

export type ResolveDelegatedPrCleanupAuthorityInput = Readonly<{
  job: JobRow;
  actorPrincipalId: string;
  resolveRepository(input: Readonly<{
    tenantId: string;
    repositoryId: string;
    installationId: number;
    remoteRepositoryId: number;
  }>): Readonly<{ owner: string; repo: string }> | Promise<Readonly<{ owner: string; repo: string }>>;
  now?: () => string;
}>;

type CleanupPayload = Readonly<{
  schemaVersion: 1;
  cycleId: string;
  deliveryId: string;
  observationId: string;
  headSha: string;
  observationDigest: string;
}>;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parsePayload(job: JobRow): CleanupPayload {
  if (job.type !== WARDEN_CANDIDATE_CLEANUP_JOB_TYPE || job.status !== "running" ||
      !job.lease_owner || job.lease_generation < 1) {
    throw new Error("delegated_pr_cleanup_authority_job_invalid");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(job.payload_json); }
  catch { throw new Error("delegated_pr_cleanup_authority_payload_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("delegated_pr_cleanup_authority_payload_invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (!exactKeys(value, ["schemaVersion", "cycleId", "deliveryId", "observationId",
    "headSha", "observationDigest"]) || value.schemaVersion !== 1 ||
      ![value.cycleId, value.deliveryId, value.observationId].every((item) =>
        typeof item === "string" && ID.test(item)) ||
      typeof value.headSha !== "string" || !REVISION.test(value.headSha) ||
      typeof value.observationDigest !== "string" || !DIGEST.test(value.observationDigest)) {
    throw new Error("delegated_pr_cleanup_authority_payload_invalid");
  }
  return Object.freeze(value as CleanupPayload);
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function assertObservationArtifact(
  db: AppDb,
  input: Readonly<{
    tenantId: string;
    observationId: string;
    artifactId: string;
    digest: string;
    candidateArtifactId: string;
    producerPrincipalId: string;
    producerVersion: string;
    deliveryId: string;
    cycleId: string;
    repositoryId: string;
    remoteRepositoryId: number;
    installationId: number;
    pullRequestNumber: number;
    baseBranch: string;
    branchName: string;
    baseRevision: string;
    headRevision: string;
    observedAt: string;
  }>,
): void {
  const artifact = db.raw.prepare(
    `SELECT sha256, size_bytes, content_text, producer_principal_id FROM artifact_manifests
       WHERE tenant_id = ? AND id = ? AND kind = 'delegated_pr_github_observation'
       AND schema_version = 1 AND media_type = 'application/vnd.mendpoint.github-exact-draft-observation+json'`,
  ).get(input.tenantId, input.artifactId) as Readonly<{
    sha256: string; size_bytes: number; content_text: string | null; producer_principal_id: string;
  }> | undefined;
  const expectedSha = input.digest.slice("sha256:".length);
  if (!artifact?.content_text || artifact.sha256 !== expectedSha ||
      createHash("sha256").update(artifact.content_text, "utf8").digest("hex") !== expectedSha ||
      Buffer.byteLength(artifact.content_text, "utf8") !== artifact.size_bytes ||
      artifact.producer_principal_id !== input.producerPrincipalId) {
    throw new Error("delegated_pr_cleanup_authority_observation_invalid");
  }
  let document: Record<string, unknown>;
  try { document = object(JSON.parse(artifact.content_text), "delegated_pr_cleanup_authority_observation_invalid"); }
  catch { throw new Error("delegated_pr_cleanup_authority_observation_invalid"); }
  const remote = object(document.observation, "delegated_pr_cleanup_authority_observation_invalid");
  if (document.schemaVersion !== EXACT_DRAFT_OBSERVATION_EVIDENCE_VERSION ||
      document.tenantId !== input.tenantId || document.cycleId !== input.cycleId ||
      document.deliveryId !== input.deliveryId || document.repositoryId !== input.repositoryId ||
      document.remoteRepositoryId !== input.remoteRepositoryId ||
      document.installationId !== input.installationId ||
      document.pullRequestNumber !== input.pullRequestNumber || document.baseBranch !== input.baseBranch ||
      document.branchName !== input.branchName || document.baseRevision !== input.baseRevision ||
      document.headRevision !== input.headRevision || document.verdict !== "success" ||
      document.trigger !== "checks_passed" || document.observedAt !== input.observedAt ||
      remote.state !== "draft" || remote.baseRevision !== input.baseRevision ||
      remote.headRevision !== input.headRevision || remote.checks !== "success" ||
      remote.checkRevision !== input.headRevision || remote.repositoryId !== input.remoteRepositoryId ||
      remote.installationId !== input.installationId || remote.matchingOpenDrafts !== 1) {
    throw new Error("delegated_pr_cleanup_authority_observation_invalid");
  }
  const evidence = db.raw.prepare(
    `SELECT input_artifact_id, producer_principal_id, tool, tool_version, commit_sha, verdict FROM evidence_records
       WHERE tenant_id = ? AND subject_type = 'delegated_pr_github_observation' AND subject_id = ?
       AND artifact_id = ? ORDER BY id`,
  ).all(input.tenantId, input.observationId, input.artifactId) as Array<{
    input_artifact_id: string | null; producer_principal_id: string;
    tool: string; tool_version: string; commit_sha: string | null; verdict: string;
  }>;
  if (evidence.length !== 1 || evidence[0]!.input_artifact_id !== input.candidateArtifactId ||
      evidence[0]!.producer_principal_id !== input.producerPrincipalId ||
      evidence[0]!.tool !== "mendpoint-exact-github-observer" ||
      evidence[0]!.tool_version !== input.producerVersion ||
      evidence[0]!.commit_sha !== input.producerVersion || evidence[0]!.verdict !== "passed") {
    throw new Error("delegated_pr_cleanup_authority_observation_invalid");
  }
}

export async function resolveDelegatedPrCleanupAuthority(
  db: AppDb,
  input: ResolveDelegatedPrCleanupAuthorityInput,
): Promise<DelegatedPrCleanupAuthority> {
  const payload = parsePayload(input.job);
  const now = input.now ?? (() => new Date().toISOString());
  const resolvedAt = now();
  if (!timestamp(resolvedAt) || !ID.test(input.actorPrincipalId) ||
      typeof input.resolveRepository !== "function") {
    throw new Error("delegated_pr_cleanup_authority_input_invalid");
  }
  const principal = getPrincipal(db, input.job.tenant_id, input.actorPrincipalId);
  if (!principal || principal.kind !== "service" || principal.created_at > resolvedAt ||
      principal.revoked_at && principal.revoked_at <= resolvedAt ||
      principal.expires_at && principal.expires_at <= resolvedAt) {
    throw new Error("delegated_pr_cleanup_authority_principal_invalid");
  }
  const delivery = getWardenCandidateDelivery(db, input.job.tenant_id, payload.deliveryId);
  const cycle = getWardenCiCycle(db, input.job.tenant_id, payload.cycleId);
  const observations = cycle ? listWardenCiObservations(db, input.job.tenant_id, cycle.id)
    .filter((candidate) => candidate.id === payload.observationId) : [];
  if (!delivery || !cycle || observations.length !== 1 || delivery.status !== "delivered" ||
      delivery.draftPr !== true || !delivery.branchName || !delivery.baseRevision || !delivery.commitSha ||
      !delivery.draftPrNumber || !delivery.draftPrUrl || cycle.deliveryId !== delivery.id ||
      cycle.status !== "awaiting_review" || cycle.repositoryId !== delivery.repositoryId ||
      cycle.baseBranch !== delivery.baseBranch || cycle.baseRevision !== delivery.baseRevision ||
      cycle.branchName !== delivery.branchName || cycle.currentHeadSha !== delivery.commitSha ||
      cycle.pullRequestNumber !== delivery.draftPrNumber || cycle.currentHeadSha !== payload.headSha ||
      cycle.currentObservationDigest !== payload.observationDigest) {
    throw new Error("delegated_pr_cleanup_authority_scope_invalid");
  }
  const observation = observations[0]!;
  if (observation.verdict !== "success" || observation.headSha !== payload.headSha ||
      observation.observationDigest !== payload.observationDigest ||
      observation.evidenceDigest !== payload.observationDigest ||
      !ID.test(observation.evidenceArtifactId)) {
    throw new Error("delegated_pr_cleanup_authority_observation_invalid");
  }
  const run = getAgentRun(db, delivery.runId, input.job.tenant_id);
  let result: Record<string, unknown> | null = null;
  try { result = run?.result_json ? object(JSON.parse(run.result_json), "delegated_pr_cleanup_authority_run_invalid") : null; }
  catch { throw new Error("delegated_pr_cleanup_authority_run_invalid"); }
  const artifacts = result?.artifacts && typeof result.artifacts === "object" && !Array.isArray(result.artifacts)
    ? result.artifacts as Record<string, unknown> : null;
  const candidateDigest = typeof artifacts?.candidateDigest === "string" ? artifacts.candidateDigest : "";
  if (!run?.job_id || !result || !DIGEST.test(candidateDigest)) {
    throw new Error("delegated_pr_cleanup_authority_run_invalid");
  }
  const verification = assertDelegatedPrVerificationApprovalAuthority(db, {
    tenantId: input.job.tenant_id,
    runId: run.id,
    sourceJobId: run.job_id,
    candidateDigest,
  });
  if (!verification.required) throw new Error("delegated_pr_cleanup_authority_verification_missing");
  assertObservationArtifact(db, {
    tenantId: input.job.tenant_id,
    observationId: observation.id,
    artifactId: observation.evidenceArtifactId,
    digest: observation.observationDigest,
    candidateArtifactId: verification.candidateArtifactId,
    producerPrincipalId: verification.candidateProducerPrincipalId,
    producerVersion: verification.candidateProducerVersion,
    deliveryId: delivery.id,
    cycleId: cycle.id,
    repositoryId: cycle.repositoryId,
    remoteRepositoryId: cycle.remoteRepositoryId,
    installationId: cycle.installationId,
    pullRequestNumber: cycle.pullRequestNumber,
    baseBranch: cycle.baseBranch,
    branchName: cycle.branchName,
    baseRevision: cycle.baseRevision,
    headRevision: cycle.currentHeadSha,
    observedAt: observation.observedAt,
  });
  const repository = await input.resolveRepository({ tenantId: input.job.tenant_id,
    repositoryId: cycle.repositoryId, installationId: cycle.installationId,
    remoteRepositoryId: cycle.remoteRepositoryId });
  if (!repository || !REPOSITORY_NAME.test(repository.owner) || !REPOSITORY_NAME.test(repository.repo)) {
    throw new Error("delegated_pr_cleanup_authority_repository_invalid");
  }
  const scope = Object.freeze({ owner: repository.owner, repo: repository.repo,
    installationId: cycle.installationId, expectedRepositoryId: cycle.remoteRepositoryId,
    pullRequestNumber: cycle.pullRequestNumber, baseBranch: cycle.baseBranch,
    expectedBaseSha: cycle.baseRevision, headBranch: cycle.branchName,
    expectedHeadSha: cycle.currentHeadSha, headDisposition: "retain_exact" as const });
  return Object.freeze({ tenantId: input.job.tenant_id, runId: run.id, correlationId: run.job_id,
    repositoryId: cycle.repositoryId,
    actorPrincipalId: input.actorPrincipalId, deliveryRecordId: delivery.id, cycleId: cycle.id,
    observationId: observation.id, observationArtifactId: observation.evidenceArtifactId,
    candidateArtifactId: verification.candidateArtifactId,
    verificationArtifactIds: Object.freeze([
      verification.failToPassArtifactId, verification.passToPassArtifactId,
    ]) as readonly [string, string],
    snapshotId: delivery.snapshotId, resolvedAt,
    cleanup: Object.freeze({ ...scope, operationId: exactDraftCleanupOperationId(scope) }) });
}
