import {
  completeJob,
  getConnectedRepository,
  getJob,
  getPrincipalBySubject,
  type AppDb,
  type JobRow,
} from "@mendpoint/db";
import {
  assertRegaugeDeepSeekApprovedScope,
  readVerifierAdvisoryJobInput,
  readVerifierAdvisoryJobSubstantiveEvidence,
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
  VerifierProviderNoResponseError,
} from "./verifier-product-shadow.js";
import { handoffCompletedJobToMissionReview } from "./mission-task-job-bridge.js";

const BOOTSTRAP_PRINCIPAL_SUBJECT = "service:regauge-production-bootstrap";

export { VerifierProviderNoResponseError };

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
  operationHooks?: Readonly<{
    afterProviderReturn?: () => void;
    afterProviderReceipt?: () => void;
    afterMissionHandoffBeforeCommit?: () => void;
  }>;
  refreshProviderLease?: () => boolean;
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
  const campaignId = completion.taskId.slice(0, completion.taskId.lastIndexOf(":"));
  assertRegaugeDeepSeekApprovedScope({
    tenantId: completion.tenantId,
    campaignId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryBranch: repository.selected_branch,
  });
  const governance = resolveVerifierGovernance(env, completion.tenantId, completion.product);
  const policyEnvelopeJson = env.MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON?.trim();
  if (!policyEnvelopeJson) throw new Error("verifier_advisory_policy_required");
  const authority = reconcileVerifierAdvisoryPolicyAuthority(input.db, {
    completion,
    policyEnvelopeJson,
    actorPrincipalId: principal.id,
    branch: repository.selected_branch,
    repositoryScope: `${repository.owner}/${repository.name}`,
    processingRegion: governance.processingRegion,
    createdAt: authorityAt,
  });
  // Repository content is rehydrated only after the exact job, tenant,
  // repository, campaign, principal, and inherited Policy Envelope have all
  // been revalidated. The following observation path performs the separate
  // durable consent check before any provider request.
  const substantiveEvidence = readVerifierAdvisoryJobSubstantiveEvidence(input.db, input.job, completion);
  const result = await observeProductCompletionInAdvisory({
    db: input.db,
    env: Object.freeze({ ...env, MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: principal.id }),
    completion,
    substantiveSources: substantiveEvidence.sources,
    authorityAt,
    now,
    beforeProviderRequest: (requestedAt) => {
      if (input.refreshProviderLease && !input.refreshProviderLease()) {
        throw new Error("verifier_advisory_lease_lost_before_provider_request");
      }
      const current = getJob(input.db, input.job.id, input.job.tenant_id);
      if (!current || current.status !== "running" || current.lease_owner !== input.job.lease_owner ||
          current.lease_generation !== input.job.lease_generation || !current.lease_expires_at ||
          current.lease_expires_at <= requestedAt) {
        throw new Error("verifier_advisory_lease_lost_before_provider_request");
      }
    },
    operationHooks: input.operationHooks,
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
  const settledAt = now();
  const ownsTransaction = !input.db.raw.isTransaction;
  if (ownsTransaction) input.db.raw.exec("BEGIN IMMEDIATE");
  try {
    if (!completeJob(input.db, input.job.id, outcome, settledAt, {
      workerId: input.job.lease_owner,
      leaseGeneration: input.job.lease_generation,
    })) {
      throw new Error("verifier_advisory_lease_lost");
    }
    handoffCompletedJobToMissionReview(input.db, input.job, settledAt);
    input.operationHooks?.afterMissionHandoffBeforeCommit?.();
    if (ownsTransaction) input.db.raw.exec("COMMIT");
  } catch (error) {
    if (ownsTransaction && input.db.raw.isTransaction) input.db.raw.exec("ROLLBACK");
    throw error;
  }
  return Object.freeze({
    status: outcome.status,
    jobId: outcome.jobId,
    telemetryDigest: outcome.telemetryDigest,
  });
}
