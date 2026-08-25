import {
  completeJob,
  getConnectedRepository,
  getPrincipalBySubject,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  readVerifierAdvisoryJobInput,
  reconcileVerifierAdvisoryPolicyAuthority,
  VERIFIER_ADVISORY_JOB_TYPE,
} from "@mendpoint/pipeline";
import {
  resolveVerifierRuntimeConfig,
  type VerifierHttpTransport,
} from "@mendpoint/verifier";
import {
  observeProductCompletionInAdvisory,
  RETRYABLE_VERIFIER_FAILURE_CODES,
  resolveVerifierGovernance,
} from "./verifier-product-shadow.js";

const BOOTSTRAP_PRINCIPAL_SUBJECT = "service:regauge-production-bootstrap";

export type RunVerifierAdvisoryJobResult = Readonly<{
  status: "verified" | "already_verified";
  jobId: string;
  telemetryDigest: string | null;
}>;

export async function runVerifierAdvisoryJob(input: Readonly<{
  db: AppDb;
  job: JobRow;
  env?: Readonly<Record<string, string | undefined>>;
  transport?: VerifierHttpTransport;
  now?: () => string;
}>): Promise<RunVerifierAdvisoryJobResult> {
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date().toISOString());
  const authorityAt = now();
  if (input.job.type !== VERIFIER_ADVISORY_JOB_TYPE || input.job.status !== "running" ||
      !input.job.lease_owner || input.job.lease_generation < 1) {
    throw new Error("verifier_advisory_job_invalid");
  }
  const config = resolveVerifierRuntimeConfig(env);
  if (!config.enabled || config.rolloutMode !== "advisory") {
    throw new Error("verifier_advisory_runtime_required");
  }
  const completion = readVerifierAdvisoryJobInput(input.db, input.job);
  if (completion.product !== "regauge") throw new Error("verifier_advisory_product_invalid");
  const principal = getPrincipalBySubject(
    input.db,
    completion.tenantId,
    "service",
    BOOTSTRAP_PRINCIPAL_SUBJECT,
  );
  if (!principal || principal.created_at > authorityAt ||
      principal.revoked_at && principal.revoked_at <= authorityAt ||
      principal.expires_at && principal.expires_at <= authorityAt) {
    throw new Error("verifier_advisory_principal_invalid");
  }
  const repository = getConnectedRepository(input.db, completion.repositoryId, completion.tenantId);
  if (!repository) throw new Error("verifier_advisory_repository_invalid");
  const governance = resolveVerifierGovernance(env, completion.tenantId, completion.product);
  const policyEnvelopeJson = env.MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON?.trim();
  if (!policyEnvelopeJson) throw new Error("verifier_advisory_policy_required");
  const authority = reconcileVerifierAdvisoryPolicyAuthority(input.db, {
    completion,
    policyEnvelopeJson,
    actorPrincipalId: principal.id,
    branch: repository.selected_branch,
    processingRegion: governance.processingRegion,
    createdAt: authorityAt,
  });
  const result = await observeProductCompletionInAdvisory({
    db: input.db,
    env: Object.freeze({ ...env, MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: principal.id }),
    completion,
    authorityAt,
    ...(input.transport ? { transport: input.transport } : {}),
  });
  if (result?.failureCode && RETRYABLE_VERIFIER_FAILURE_CODES.has(
    result.failureCode as "api_failure" | "logprob_failure",
  )) {
    throw new Error(`verifier_advisory_provider_retryable:${result.failureCode}`);
  }
  const outcome = Object.freeze({
    status: result ? "verified" as const : "already_verified" as const,
    jobId: input.job.id,
    telemetryDigest: result?.telemetry.telemetryDigest ?? null,
    policyEnvelopeId: authority.policyEnvelopeId,
    policyEnvelopeVersion: authority.policyEnvelopeVersion,
    policyEnvelopeSha256: authority.policyEnvelopeSha256,
    advisoryOnly: true,
    behaviorChanged: false,
  });
  if (!completeJob(input.db, input.job.id, outcome, now(), {
    workerId: input.job.lease_owner,
    leaseGeneration: input.job.lease_generation,
  })) {
    throw new Error("verifier_advisory_lease_lost");
  }
  return Object.freeze({
    status: outcome.status,
    jobId: outcome.jobId,
    telemetryDigest: outcome.telemetryDigest,
  });
}
