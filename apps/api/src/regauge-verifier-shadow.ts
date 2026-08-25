import { createHash } from "node:crypto";
import {
  getConnectedRepository,
  getPrincipalBySubject,
  resolveMissionForRegaugeCampaign,
  type AppDb,
} from "@mendpoint/db";
import type { TransformerAttemptCheckpointCompletionResult } from "@mendpoint/transformer";
import {
  assertRegaugeDeepSeekApprovedScope,
  enqueueVerifierAdvisoryJob,
  REGAUGE_DEEPSEEK_APPROVED_SCOPE,
  reconcileVerifierAdvisoryPolicyAuthority,
  type EnqueueVerifierAdvisoryResult,
  type ProductCompletionAdvisoryInput,
} from "@mendpoint/pipeline";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BOOTSTRAP_PRINCIPAL_SUBJECT = "service:regauge-production-bootstrap";

export function buildDedicatedRegaugeCompletionInput(
  result: TransformerAttemptCheckpointCompletionResult,
  missionId: string,
): ProductCompletionAdvisoryInput {
  const { campaign, receipt } = result;
  const units = campaign.units.filter((candidate) => candidate.id === receipt.unitId);
  const unit = units[0];
  if (campaign.tenantId !== receipt.tenantId || campaign.campaignId !== receipt.campaignId ||
      campaign.revision !== receipt.campaignRevision || units.length !== 1 || !unit ||
      unit.state !== "executed" || unit.verificationPassed !== true ||
      unit.executedAt !== receipt.observedAt || campaign.updatedAt !== receipt.observedAt ||
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

export function enqueueDedicatedRegaugeCompletionForAdvisory(input: Readonly<{
  db: AppDb;
  env?: Readonly<Record<string, string | undefined>>;
  completion: TransformerAttemptCheckpointCompletionResult;
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
    BOOTSTRAP_PRINCIPAL_SUBJECT,
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
  return enqueueVerifierAdvisoryJob(input.db, {
    completion,
    producerPrincipalId: principal.id,
    createdAt: completion.observedAt,
  });
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
