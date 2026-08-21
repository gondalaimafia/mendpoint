import { createHash } from "node:crypto";
import {
  completeJob,
  enqueueJob,
  failJob,
  getJob,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  promoteDelegatedPrCandidate,
  deriveDelegatedPrVerificationAuthority,
  readDelegatedPrVerificationTerminal,
  runDelegatedPrVerification,
  type DelegatedPrCandidateOperationDependencies,
  type DelegatedPrVerificationAuthority,
  type DelegatedPrVerificationDependencies,
  type PromotedDelegatedPrCandidate,
} from "@mendpoint/pipeline";

export const DELEGATED_PR_VERIFICATION_JOB_TYPE = "warden.candidate.verify";

type PromoteCandidate = typeof promoteDelegatedPrCandidate;
type VerifyCandidate = typeof runDelegatedPrVerification;

export type DelegatedPrVerificationJobDependencies = Readonly<{
  job: JobRow;
  candidateDependencies: DelegatedPrCandidateOperationDependencies;
  verificationDependencies: DelegatedPrVerificationDependencies;
  promoteCandidate?: PromoteCandidate;
  verifyCandidate?: VerifyCandidate;
  now?: () => string;
}>;

type Payload = Readonly<{ runId: string; correlationId: string }>;

const ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function payload(job: JobRow): Payload {
  let parsed: unknown;
  try { parsed = JSON.parse(job.payload_json); }
  catch { throw new Error("delegated_pr_verification_job_payload_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      canonical(Object.keys(parsed).sort()) !== canonical(["correlationId", "runId"]) ||
      !ID.test(String((parsed as Record<string, unknown>).runId ?? "")) ||
      !ID.test(String((parsed as Record<string, unknown>).correlationId ?? ""))) {
    throw new Error("delegated_pr_verification_job_payload_invalid");
  }
  return Object.freeze({
    runId: String((parsed as Record<string, unknown>).runId),
    correlationId: String((parsed as Record<string, unknown>).correlationId),
  });
}

function jobId(input: Readonly<{ tenantId: string; runId: string; correlationId: string }>): string {
  const digest = createHash("sha256")
    .update(canonical({ schemaVersion: 1, tenantId: input.tenantId,
      runId: input.runId, correlationId: input.correlationId }), "utf8")
    .digest("hex");
  return `warden_verify_${digest.slice(0, 40)}`;
}

export type DelegatedPrVerificationApprovalAuthority =
  | Readonly<{ required: false }>
  | Readonly<{
      required: true;
      verificationJobId: string;
      candidateArtifactId: string;
      failToPassArtifactId: string;
      passToPassArtifactId: string;
      completedAt: string;
      candidateProducerPrincipalId: string;
      candidateProducerVersion: string;
    }>;

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return canonical(Object.keys(value).sort()) === canonical([...keys].sort());
}

function authoritySnapshot(unsafe: DelegatedPrVerificationAuthority): DelegatedPrVerificationAuthority {
  const authority = Object.freeze({
    candidateProducerPrincipalId: unsafe.candidateProducerPrincipalId,
    candidateProducerVersion: unsafe.candidateProducerVersion,
    authorityId: unsafe.authorityId,
    authorityDigest: unsafe.authorityDigest,
    executionAuthorityId: unsafe.executionAuthorityId,
    mendpointRevision: unsafe.mendpointRevision,
    policy: Object.freeze({
      failToPassCommandDigest: unsafe.policy?.failToPassCommandDigest,
      passToPassCommandDigest: unsafe.policy?.passToPassCommandDigest,
      sandboxBackend: unsafe.policy?.sandboxBackend,
    }),
  });
  if ([authority.candidateProducerPrincipalId, authority.authorityId, authority.executionAuthorityId,
    authority.policy.sandboxBackend].some((value) => !ID.test(String(value ?? ""))) ||
      !REVISION.test(authority.candidateProducerVersion) || !REVISION.test(authority.mendpointRevision) ||
      !DIGEST.test(authority.authorityDigest) || !DIGEST.test(authority.policy.failToPassCommandDigest) ||
      !DIGEST.test(authority.policy.passToPassCommandDigest) ||
      authority.authorityId === authority.candidateProducerPrincipalId ||
      authority.authorityId === authority.executionAuthorityId) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  return authority;
}

export function assertDelegatedPrVerificationApprovalAuthority(
  db: AppDb,
  input: Readonly<{ tenantId: string; runId: string; sourceJobId: string; candidateDigest: string }>,
): DelegatedPrVerificationApprovalAuthority {
  if (![input.tenantId, input.runId, input.sourceJobId].every((value) => ID.test(value))) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  const sourceJob = getJob(db, input.sourceJobId, input.tenantId);
  let sourceResult: Record<string, unknown> | null = null;
  try { sourceResult = object(JSON.parse(sourceJob?.result_json ?? "")); } catch { /* compatibility fallback below */ }
  const requestMarker = object(sourceResult?.delegatedVerification);
  const markerPresent = sourceResult?.delegatedVerification !== undefined;
  const requestedJobId = typeof requestMarker?.jobId === "string" ? requestMarker.jobId : null;
  const storedAuthority = object(requestMarker?.authority);
  const jobs = requestedJobId
    ? [getJob(db, requestedJobId, input.tenantId)].filter((job): job is JobRow => Boolean(job))
    : db.raw.prepare(
      `SELECT * FROM jobs WHERE tenant_id = ? AND type = ?
         AND json_extract(payload_json, '$.runId') = ?`,
    ).all(input.tenantId, DELEGATED_PR_VERIFICATION_JOB_TYPE, input.runId) as JobRow[];
  if (requestedJobId && jobs.length !== 1) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  if (jobs.length === 0) {
    if (markerPresent) throw new Error("delegated_pr_verification_authority_invalid");
    return Object.freeze({ required: false });
  }
  if (jobs.length !== 1 || !DIGEST.test(input.candidateDigest) || markerPresent &&
      (!requestedJobId || !storedAuthority || !exactKeys(requestMarker!, ["schemaVersion", "jobId", "authority"]) ||
        requestMarker!.schemaVersion !== 1)) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  const job = jobs[0]!;
  const verificationJobId = job.id;
  if (requestedJobId && verificationJobId !== requestedJobId) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  let payload: Record<string, unknown> | null = null;
  try { payload = object(JSON.parse(job.payload_json)); } catch { /* invalid below */ }
  if (job.type !== DELEGATED_PR_VERIFICATION_JOB_TYPE || !payload ||
      !exactKeys(payload, ["runId", "correlationId"]) || payload.runId !== input.runId ||
      payload.correlationId !== input.sourceJobId) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  if (job.status === "pending" || job.status === "running") {
    throw new Error("delegated_pr_verification_pending");
  }
  if (job.status !== "done") throw new Error("delegated_pr_verification_failed");
  let result: Record<string, unknown> | null = null;
  try { result = object(JSON.parse(job.result_json ?? "")); } catch { /* invalid below */ }
  if (!result || !exactKeys(result, ["status", "runId", "candidateArtifactId", "candidateDigest",
    "failToPassArtifactId", "passToPassArtifactId", "completedAt"]) ||
      result.status !== "verified" || result.runId !== input.runId ||
      typeof result.candidateArtifactId !== "string" || !ID.test(result.candidateArtifactId) ||
      result.candidateDigest !== input.candidateDigest ||
      typeof result.failToPassArtifactId !== "string" || !ID.test(result.failToPassArtifactId) ||
      typeof result.passToPassArtifactId !== "string" || !ID.test(result.passToPassArtifactId) ||
      !timestamp(result.completedAt) || result.completedAt !== job.finished_at) {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  let terminal;
  let verifiedAuthority: DelegatedPrVerificationAuthority;
  try {
    verifiedAuthority = storedAuthority
      ? storedAuthority as DelegatedPrVerificationAuthority
      : deriveDelegatedPrVerificationAuthority(db, {
        tenantId: input.tenantId,
        runId: input.runId,
        candidateArtifactId: result.candidateArtifactId,
        failToPassArtifactId: result.failToPassArtifactId,
        passToPassArtifactId: result.passToPassArtifactId,
      });
    terminal = readDelegatedPrVerificationTerminal(db, {
      tenantId: input.tenantId,
      runId: input.runId,
      correlationId: input.sourceJobId,
      candidateArtifactId: result.candidateArtifactId,
      idempotencyKey: `${verificationJobId}:verification`,
      completedAt: result.completedAt,
    }, verifiedAuthority);
  } catch {
    throw new Error("delegated_pr_verification_authority_invalid");
  }
  if (!terminal || terminal.status !== "completed" || terminal.candidateDigest !== result.candidateDigest ||
      terminal.failToPass.artifact.artifactId !== result.failToPassArtifactId ||
      terminal.passToPass.artifact.artifactId !== result.passToPassArtifactId ||
      terminal.completedAt !== result.completedAt) throw new Error("delegated_pr_verification_authority_invalid");
  return Object.freeze({
    required: true,
    verificationJobId,
    candidateArtifactId: result.candidateArtifactId,
    failToPassArtifactId: result.failToPassArtifactId,
    passToPassArtifactId: result.passToPassArtifactId,
    completedAt: result.completedAt,
    candidateProducerPrincipalId: verifiedAuthority.candidateProducerPrincipalId,
    candidateProducerVersion: verifiedAuthority.candidateProducerVersion,
  });
}

export function enqueueDelegatedPrVerificationJob(
  db: AppDb,
  input: Readonly<{ tenantId: string; runId: string; correlationId: string; createdAt: string }>,
): string {
  if (!ID.test(input.tenantId) || !ID.test(input.runId) || !ID.test(input.correlationId) ||
      !Number.isFinite(Date.parse(input.createdAt)) || new Date(input.createdAt).toISOString() !== input.createdAt) {
    throw new Error("delegated_pr_verification_job_input_invalid");
  }
  const id = jobId(input);
  const expectedPayload = canonical({ runId: input.runId, correlationId: input.correlationId });
  const existing = db.raw.prepare("SELECT tenant_id, type, payload_json FROM jobs WHERE id = ?")
    .get(id) as { tenant_id: string; type: string; payload_json: string } | undefined;
  if (existing) {
    let existingPayload: unknown;
    try { existingPayload = JSON.parse(existing.payload_json); }
    catch { throw new Error("delegated_pr_verification_job_conflict"); }
    if (existing.tenant_id !== input.tenantId || existing.type !== DELEGATED_PR_VERIFICATION_JOB_TYPE ||
        canonical(existingPayload) !== expectedPayload) {
      throw new Error("delegated_pr_verification_job_conflict");
    }
    return id;
  }
  enqueueJob(db, {
    id,
    tenantId: input.tenantId,
    type: DELEGATED_PR_VERIFICATION_JOB_TYPE,
    payload: { runId: input.runId, correlationId: input.correlationId },
    maxAttempts: 3,
    createdAt: input.createdAt,
  });
  return id;
}

export function requestDelegatedPrVerificationJob(
  db: AppDb,
  input: Readonly<{ tenantId: string; runId: string; correlationId: string; createdAt: string;
    authority: DelegatedPrVerificationAuthority }>,
): string {
  if (!db.raw.isTransaction) throw new Error("delegated_pr_verification_request_transaction_required");
  const sourceJob = getJob(db, input.correlationId, input.tenantId);
  let sourceResult: Record<string, unknown> | null = null;
  try { sourceResult = object(JSON.parse(sourceJob?.result_json ?? "")); } catch { /* invalid below */ }
  if (!sourceJob || sourceJob.type !== "agent.run" || sourceJob.status !== "done" || !sourceResult ||
      sourceResult.status !== "candidate_ready" || sourceResult.sessionId !== input.runId) {
    throw new Error("delegated_pr_verification_request_source_invalid");
  }
  const id = enqueueDelegatedPrVerificationJob(db, {
    tenantId: input.tenantId,
    runId: input.runId,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
  });
  const marker = Object.freeze({ schemaVersion: 1, jobId: id, authority: authoritySnapshot(input.authority) });
  const existingMarker = sourceResult.delegatedVerification;
  if (existingMarker !== undefined && canonical(existingMarker) !== canonical(marker)) {
    throw new Error("delegated_pr_verification_request_conflict");
  }
  const updated = db.raw.prepare(
    `UPDATE jobs SET result_json = json_set(result_json, '$.delegatedVerification', json(?))
       WHERE id = ? AND tenant_id = ? AND type = 'agent.run' AND status = 'done'`,
  ).run(canonical(marker), input.correlationId, input.tenantId);
  if (Number(updated.changes) !== 1) throw new Error("delegated_pr_verification_request_conflict");
  return id;
}

function retryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown } | null)?.code;
  const status = (error as { status?: unknown } | null)?.status;
  return message === "delegated_pr_verification_outcome_unknown" ||
    message === "delegated_pr_verification_lease_held" ||
    message === "delegated_pr_verification_timeout" ||
    message === "delegated_pr_verification_checkpoint_conflict" ||
    typeof code === "string" && ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"].includes(code.toUpperCase()) ||
    status === 429 || typeof status === "number" && status >= 500 && status <= 599;
}

function jobFence(job: JobRow) {
  if (job.type !== DELEGATED_PR_VERIFICATION_JOB_TYPE || job.status !== "running" ||
      !job.lease_owner || job.lease_generation < 1) {
    throw new Error("delegated_pr_verification_job_invalid");
  }
  return Object.freeze({ workerId: job.lease_owner, leaseGeneration: job.lease_generation });
}

export async function runDelegatedPrVerificationJob(
  db: AppDb,
  dependencies: DelegatedPrVerificationJobDependencies,
) {
  const fence = jobFence(dependencies.job);
  const boundPayload = payload(dependencies.job);
  const now = dependencies.now ?? (() => new Date().toISOString());
  const observedAt = now();
  const promote = dependencies.promoteCandidate ?? promoteDelegatedPrCandidate;
  const verify = dependencies.verifyCandidate ?? runDelegatedPrVerification;
  let candidate: PromotedDelegatedPrCandidate | null = null;
  try {
    candidate = await promote(db, {
      tenantId: dependencies.job.tenant_id,
      runId: boundPayload.runId,
      correlationId: boundPayload.correlationId,
      idempotencyKey: `${dependencies.job.id}:candidate`,
      observedAt,
    }, dependencies.candidateDependencies);
    const verification = await verify(db, {
      tenantId: dependencies.job.tenant_id,
      runId: boundPayload.runId,
      correlationId: boundPayload.correlationId,
      candidateArtifactId: candidate.artifact.artifactId,
      idempotencyKey: `${dependencies.job.id}:verification`,
      requestedAt: observedAt,
    }, dependencies.verificationDependencies);
    if (verification.status === "failed") {
      const failed = failJob(db, dependencies.job.id, verification.code, verification.completedAt, {
        ...fence,
        retryable: false,
        errorCode: "delegated_pr_verification_failed",
      });
      if (!failed.applied) throw new Error("delegated_pr_verification_job_lease_lost");
      return Object.freeze({ status: "failed" as const, runId: boundPayload.runId,
        candidateArtifactId: candidate.artifact.artifactId, code: verification.code });
    }
    const completed = {
      status: "verified" as const,
      runId: boundPayload.runId,
      candidateArtifactId: candidate.artifact.artifactId,
      candidateDigest: verification.candidateDigest,
      failToPassArtifactId: verification.failToPass.artifact.artifactId,
      passToPassArtifactId: verification.passToPass.artifact.artifactId,
      completedAt: verification.completedAt,
    };
    if (!completeJob(db, dependencies.job.id, completed, verification.completedAt, fence)) {
      throw new Error("delegated_pr_verification_job_lease_lost");
    }
    return Object.freeze(completed);
  } catch (error) {
    if (error instanceof Error && error.message === "delegated_pr_verification_job_lease_lost") throw error;
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    const failedAt = now();
    const failed = failJob(db, dependencies.job.id, message, failedAt, {
      ...fence,
      retryable: retryable(error),
      errorCode: retryable(error)
        ? "delegated_pr_verification_retryable"
        : "delegated_pr_verification_terminal",
    });
    if (!failed.applied) throw new Error("delegated_pr_verification_job_lease_lost");
    return Object.freeze({
      status: failed.status === "dead_letter" ? "failed" as const : "retry_scheduled" as const,
      runId: boundPayload.runId,
      candidateArtifactId: candidate?.artifact.artifactId ?? null,
      code: message,
    });
  }
}
