import { createHash } from "node:crypto";
import { getPrincipalBySubject, type AppDb } from "@mendpoint/db";
import type { TransformerAttemptCheckpointCompletionResult } from "@mendpoint/transformer";
import {
  observeProductCompletionInShadow,
  type ProductCompletionShadowInput,
} from "@mendpoint/worker/verifier-product-shadow";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const BOOTSTRAP_PRINCIPAL_SUBJECT = "service:regauge-production-bootstrap";

export function buildDedicatedRegaugeCompletionInput(
  result: TransformerAttemptCheckpointCompletionResult,
): ProductCompletionShadowInput {
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
    throw new Error("regauge_verifier_shadow_completion_invalid");
  }
  const taskId = `${campaign.campaignId}:${unit.id}`;
  const candidateId = `regauge_${createHash("sha256")
    .update([campaign.tenantId, campaign.campaignId, unit.id, String(unit.attemptNumber),
      unit.candidateDigest, receipt.completionDigest].join("\0"), "utf8")
    .digest("hex").slice(0, 32)}`;
  return Object.freeze({
    tenantId: campaign.tenantId,
    missionId: campaign.campaignId,
    taskId,
    product: "regauge",
    repositoryId: unit.snapshot.repositoryId,
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

export async function observeDedicatedRegaugeCompletionInShadow(input: Readonly<{
  db: AppDb;
  env?: Readonly<Record<string, string | undefined>>;
  completion: TransformerAttemptCheckpointCompletionResult;
  transport?: Parameters<typeof observeProductCompletionInShadow>[0]["transport"];
  observer?: typeof observeProductCompletionInShadow;
}>): ReturnType<typeof observeProductCompletionInShadow> {
  const completion = buildDedicatedRegaugeCompletionInput(input.completion);
  const principal = getPrincipalBySubject(
    input.db,
    completion.tenantId,
    "service",
    BOOTSTRAP_PRINCIPAL_SUBJECT,
  );
  if (!principal || principal.revoked_at && principal.revoked_at <= completion.observedAt ||
      principal.expires_at && principal.expires_at <= completion.observedAt ||
      principal.created_at > completion.observedAt) {
    throw new Error("regauge_verifier_shadow_principal_invalid");
  }
  const observer = input.observer ?? observeProductCompletionInShadow;
  return await observer({
    db: input.db,
    env: Object.freeze({
      ...(input.env ?? process.env),
      MENDPOINT_AGENT_VERIFIER_PRINCIPAL_ID: principal.id,
    }),
    completion,
    ...(input.transport ? { transport: input.transport } : {}),
  });
}
