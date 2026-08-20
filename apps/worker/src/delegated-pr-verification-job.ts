import { createHash } from "node:crypto";
import {
  completeJob,
  enqueueJob,
  failJob,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  promoteDelegatedPrCandidate,
  runDelegatedPrVerification,
  type DelegatedPrCandidateOperationDependencies,
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
    .update(canonical({ schemaVersion: 1, ...input }), "utf8")
    .digest("hex");
  return `warden_verify_${digest.slice(0, 40)}`;
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
