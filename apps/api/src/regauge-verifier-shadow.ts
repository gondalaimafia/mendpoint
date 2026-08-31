import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getConnectedRepository,
  getPrincipalBySubject,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import {
  applyRecipe,
  type ExactSourceSnapshot,
  type TransformerAttemptCheckpointCompletionResult,
  type TransformerPilotExecutionStore,
  type TransformerVerifierAdvisoryDispatch,
} from "@mendpoint/transformer";
import {
  assertRegaugeDeepSeekApprovedScope,
  enqueueVerifierAdvisoryJob,
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
  reconcileVerifierAdvisoryPolicyAuthority,
  REGAUGE_BOOTSTRAP_PRINCIPAL_SUBJECT,
  type EnqueueVerifierAdvisoryResult,
  type ProductCompletionAdvisoryInput,
  type VerifierAdvisorySubstantiveEvidence,
} from "@mendpoint/pipeline";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function buildDedicatedRegaugeCompletionInput(
  result: TransformerAttemptCheckpointCompletionResult,
  missionId: string,
): ProductCompletionAdvisoryInput {
  const { campaign, receipt } = result;
  const units = campaign.units.filter((candidate) => candidate.id === receipt.unitId);
  const unit = units[0];
  if (campaign.tenantId !== receipt.tenantId || campaign.campaignId !== receipt.campaignId ||
      campaign.revision < receipt.campaignRevision || units.length !== 1 || !unit ||
      !["executed", "draft", "accepted", "merged"].includes(unit.state) ||
      unit.verificationPassed !== true || unit.executedAt !== receipt.observedAt ||
      Date.parse(campaign.updatedAt) < Date.parse(receipt.observedAt) ||
      !ID.test(campaign.tenantId) || !ID.test(campaign.campaignId) || !ID.test(unit.id) ||
      !ID.test(unit.snapshot.repositoryId) || !DIGEST.test(unit.snapshot.digest) ||
      !DIGEST.test(unit.candidateDigest) || !DIGEST.test(receipt.completionDigest) ||
      unit.changedPaths.length === 0 || unit.executionEvidenceRefs.length === 0) {
    throw new Error("regauge_verifier_advisory_completion_invalid");
  }
  const taskId = `${campaign.campaignId}:${unit.id}`;
  const candidateId = `regauge_${createHash("sha256")
    .update([campaign.tenantId, campaign.campaignId, unit.id, String(unit.attemptNumber),
      unit.candidateDigest, receipt.completionDigest].join("\0"), "utf8")
    .digest("hex").slice(0, 32)}`;
  return Object.freeze({
    tenantId: campaign.tenantId,
    missionId,
    taskId,
    product: "regauge",
    repositoryId: unit.snapshot.repositoryId,
    snapshotId: unit.snapshot.snapshotId,
    snapshotDigest: unit.snapshot.digest,
    objective: `Execute the bound ${unit.recipe.id} migration for unit ${unit.id}.`,
    risk: "high",
    allowedChangedPaths: Object.freeze([...unit.changedPaths]),
    candidateId,
    candidateDigest: unit.candidateDigest,
    changedPaths: Object.freeze([...unit.changedPaths]),
    observableSummary: `The exact checkpoint completion passed deterministic verification for ${unit.changedPaths.length} changed ${unit.changedPaths.length === 1 ? "path" : "paths"}.`,
    deterministicEvidenceDigest: receipt.completionDigest,
    deterministicEvidenceRefs: Object.freeze([...unit.executionEvidenceRefs]),
    observedAt: receipt.observedAt,
  });
}

export type RegaugeVerifierAdvisoryDispatchOutcome = Readonly<{
  dispatchId: string;
  status: "enqueued" | "failed";
  jobId?: string;
  errorCode?: string;
}>;

export async function drainDedicatedRegaugeAdvisoryOutbox(input: Readonly<{
  db: AppDb;
  store: TransformerPilotExecutionStore;
  env?: Readonly<Record<string, string | undefined>>;
  tenantId: string;
  limit?: number;
  now?: () => string;
  loadExactSource(
    completion: TransformerAttemptCheckpointCompletionResult,
    dispatch: TransformerVerifierAdvisoryDispatch,
  ): ExactSourceSnapshot | Promise<ExactSourceSnapshot>;
}>): Promise<readonly RegaugeVerifierAdvisoryDispatchOutcome[]> {
  if (input.tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId) {
    throw new Error("verifier_advisory_scope_invalid");
  }
  const now = input.now ?? (() => new Date().toISOString());
  input.store.backfillVerifierAdvisoryDispatches({
    tenantId: input.tenantId,
    campaignId: REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId,
  });
  const limit = input.limit ?? 25;
  const claimantId = `regauge-advisory-drainer-${randomUUID()}`;
  const outcomes: RegaugeVerifierAdvisoryDispatchOutcome[] = [];
  for (let index = 0; index < limit; index += 1) {
    const leaseToken = randomBytes(32).toString("base64url");
    const claim = input.store.claimNextVerifierAdvisoryDispatch({
      tenantId: input.tenantId,
      claimantId,
      claimId: `regauge-advisory-claim-${randomUUID()}`,
      leaseToken,
      leaseDurationMs: 60_000,
      observedAt: now(),
    });
    if (!claim) break;
    const { dispatch } = claim;
    if (dispatch.campaignId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId) {
      input.store.recordVerifierAdvisoryDispatchClaimResult({
        tenantId: claim.tenantId,
        dispatchId: claim.dispatchId,
        claimId: claim.claimId,
        leaseGeneration: claim.leaseGeneration,
        leaseToken,
        status: "failed",
        errorCode: "verifier_advisory_scope_invalid",
        observedAt: now(),
      });
      outcomes.push(Object.freeze({
        dispatchId: dispatch.dispatchId,
        status: "failed",
        errorCode: "verifier_advisory_scope_invalid",
      }));
      continue;
    }
    try {
      const completion = input.store.readVerifierAdvisoryCompletion(dispatch);
      const exactSource = await input.loadExactSource(completion, dispatch);
      const queued = enqueueDedicatedRegaugeCompletionForAdvisory({
        db: input.db,
        env: input.env,
        completion,
        exactSource,
      });
      input.store.recordVerifierAdvisoryDispatchClaimResult({
        tenantId: claim.tenantId,
        dispatchId: claim.dispatchId,
        claimId: claim.claimId,
        leaseGeneration: claim.leaseGeneration,
        leaseToken,
        status: "enqueued",
        jobId: queued.jobId,
        observedAt: now(),
      });
      outcomes.push(Object.freeze({
        dispatchId: dispatch.dispatchId,
        status: "enqueued",
        jobId: queued.jobId,
      }));
    } catch (error) {
      const errorCode = error instanceof Error && ID.test(error.message)
        ? error.message
        : "verifier_advisory_dispatch_failed";
      input.store.recordVerifierAdvisoryDispatchClaimResult({
        tenantId: claim.tenantId,
        dispatchId: claim.dispatchId,
        claimId: claim.claimId,
        leaseGeneration: claim.leaseGeneration,
        leaseToken,
        status: "failed",
        errorCode,
        observedAt: now(),
      });
      outcomes.push(Object.freeze({ dispatchId: dispatch.dispatchId, status: "failed", errorCode }));
    }
  }
  return Object.freeze(outcomes);
}

export function enqueueDedicatedRegaugeCompletionForAdvisory(input: Readonly<{
  db: AppDb;
  env?: Readonly<Record<string, string | undefined>>;
  completion: TransformerAttemptCheckpointCompletionResult;
  exactSource: ExactSourceSnapshot;
}>): EnqueueVerifierAdvisoryResult {
  const env = input.env ?? process.env;
  const campaign = input.completion.campaign;
  if (campaign.tenantId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.tenantId ||
      campaign.campaignId !== REGAUGE_DEEPSEEK_APPROVED_SCOPE.campaignId) {
    throw new Error("verifier_advisory_scope_invalid");
  }
  const mission = resolveMissionForRegaugeCampaign(input.db, campaign.tenantId, campaign.campaignId);
  if (!mission) throw new Error("regauge_verifier_advisory_mission_missing");
  const completion = buildDedicatedRegaugeCompletionInput(input.completion, mission.id);
  const principal = getPrincipalBySubject(
    input.db,
    completion.tenantId,
    "service",
    REGAUGE_BOOTSTRAP_PRINCIPAL_SUBJECT,
  );
  if (!principal || principal.revoked_at && principal.revoked_at <= completion.observedAt ||
      principal.expires_at && principal.expires_at <= completion.observedAt ||
      principal.created_at > completion.observedAt) {
    throw new Error("regauge_verifier_advisory_principal_invalid");
  }
  const repository = getConnectedRepository(input.db, completion.repositoryId, completion.tenantId);
  if (!repository || repository.id !== mission.repositoryId || completion.snapshotId !== mission.snapshotId) {
    throw new Error("regauge_verifier_advisory_mission_scope_invalid");
  }
  assertRegaugeDeepSeekApprovedScope({
    tenantId: completion.tenantId,
    campaignId: campaign.campaignId,
    repositoryOwner: repository.owner,
    repositoryName: repository.name,
    repositoryBranch: repository.selected_branch,
  });
  const processingRegion = resolveProcessingRegion(env, completion.tenantId);
  const policyEnvelopeJson = env.MENDPOINT_REGAUGE_VERIFIER_POLICY_ENVELOPE_JSON?.trim();
  if (!policyEnvelopeJson) throw new Error("regauge_verifier_advisory_policy_required");
  reconcileVerifierAdvisoryPolicyAuthority(input.db, {
    completion,
    policyEnvelopeJson,
    actorPrincipalId: principal.id,
    branch: repository.selected_branch,
    repositoryScope: `${repository.owner}/${repository.name}`,
    processingRegion,
    createdAt: completion.observedAt,
  });
  const substantiveEvidence = createSubstantiveEvidence(input.completion, completion, input.exactSource);
  return enqueueVerifierAdvisoryJob(input.db, {
    completion,
    substantiveEvidence,
    producerPrincipalId: principal.id,
    createdAt: completion.observedAt,
  });
}

function createSubstantiveEvidence(
  result: TransformerAttemptCheckpointCompletionResult,
  completion: ProductCompletionAdvisoryInput,
  source: ExactSourceSnapshot,
): VerifierAdvisorySubstantiveEvidence {
  const unit = result.campaign.units.find((candidate) => candidate.id === result.receipt.unitId);
  if (!unit || source.repositoryId !== completion.repositoryId ||
      source.revision !== unit.snapshot.revision || source.digest !== completion.snapshotDigest) {
    throw new Error("regauge_verifier_advisory_source_binding_invalid");
  }
  const application = applyRecipe(unit.recipe, source.files);
  const paths = application.operations.map((operation) => operation.path);
  if (application.inputDigest !== completion.snapshotDigest ||
      application.outputDigest !== completion.candidateDigest ||
      JSON.stringify(paths) !== JSON.stringify(completion.changedPaths)) {
    throw new Error("regauge_verifier_advisory_candidate_binding_invalid");
  }
  const sources = application.operations.map((operation, index) => {
    const content = canonical({ path: operation.path, before: operation.before, after: operation.after });
    return Object.freeze({
      id: `candidate_diff_${index + 1}`,
      kind: "repository_excerpt" as const,
      digest: `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
      locator: `${completion.snapshotId}:${operation.path}`,
      content,
    });
  });
  return Object.freeze({
    schemaVersion: 1,
    tenantId: completion.tenantId,
    repositoryId: completion.repositoryId,
    snapshotId: completion.snapshotId,
    snapshotDigest: completion.snapshotDigest,
    candidateId: completion.candidateId,
    candidateDigest: completion.candidateDigest,
    changedPaths: Object.freeze([...completion.changedPaths]),
    sources: Object.freeze(sources),
  });
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function resolveProcessingRegion(
  env: Readonly<Record<string, string | undefined>>,
  tenantId: string,
): string {
  let value: unknown;
  try { value = JSON.parse(env.MENDPOINT_AGENT_VERIFIER_GOVERNANCE_JSON?.trim() ?? ""); }
  catch { throw new Error("regauge_verifier_advisory_governance_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("regauge_verifier_advisory_governance_invalid");
  }
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) throw new Error("regauge_verifier_advisory_governance_invalid");
  const matches = entries.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) &&
    (entry as Record<string, unknown>).tenantId === tenantId &&
    Array.isArray((entry as Record<string, unknown>).products) &&
    ((entry as Record<string, unknown>).products as unknown[]).includes("regauge"));
  const region = matches.length === 1 ? (matches[0] as Record<string, unknown>).processingRegion : null;
  if (typeof region !== "string" || !region.trim()) {
    throw new Error("regauge_verifier_advisory_governance_invalid");
  }
  return region;
}
