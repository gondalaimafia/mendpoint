/**
 * Fail-closed Policy Envelope enforcement on the live ReGauge pilot-lane path
 * (spec §6.7). Launch already pins a versioned envelope. This seam evaluates
 * that inherited envelope before the worker takes a unit lease.
 *
 * Unbound campaigns (no Mission) are not evaluated here — that enrollment gap
 * stays visible. A bound Mission with a missing envelope, invalid envelope, or
 * explicit deny fails closed and does not claim. Those blockers are also raised
 * as Mission exceptions (category `policy_exception`) so the same deny is not
 * rediscovered on the next claim (ME-MSN-002).
 */
import {
  evaluateMissionExceptions,
  listRepositorySnapshots,
  raiseMissionException,
  resolveMissionForRegaugeCampaign,
  type AppDb,
  type Mission,
  type SnapshotIdentity,
} from "@mendpoint/db";
import { isTrainingTierModel } from "@mendpoint/agent";
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "@mendpoint/pipeline";

export type RegaugePilotPolicyInput = Readonly<{
  tenantId: string;
  campaignId: string;
  repositoryId: string;
  externalProcessing: boolean;
  /** The exact paths this attempt would rewrite, enforced against forbidden zones. */
  changedPaths: readonly string[];
  /**
   * The model id the adaptive external call would use for this attempt, or
   * undefined for the internal deterministic lane (no external model call). Used
   * to derive whether the attempt routes to a training-capturing tier.
   */
  adaptiveModelId?: string;
  observedAt?: string;
}>;

function regaugePilotPolicyTask(input: RegaugePilotPolicyInput) {
  return Object.freeze({
    repositoryId: input.repositoryId,
    // The runnable campaign summary does not carry a git branch. Empty keeps
    // unrestricted envelopes (empty branchScope) allowed, and fail-closes a
    // tenant that has scoped branches until this seam learns the real name.
    branch: "",
    targetPaths: Object.freeze([...input.changedPaths]),
    tool: "edit",
    modelClass: input.externalProcessing ? "llm" : "deterministic",
    externalProcessing: input.externalProcessing,
    risk: "medium" as const,
    isDeployment: false,
    // Derived from the adaptive adapter's model actually in use for this attempt:
    // true only when the external call would route to a training-capturing tier,
    // so an envelope that forbids training capture can deny it. The internal
    // deterministic lane makes no external call and never captures.
    wantsTrainingCapture:
      input.adaptiveModelId !== undefined && isTrainingTierModel(input.adaptiveModelId),
    residency: "default",
  });
}

/** Bind to the Mission's snapshot when one exists. Missing snapshot id is context-independent; a dangling snapshot id fails closed. */
function missionObservedAgainst(db: AppDb, mission: Mission): SnapshotIdentity | undefined {
  if (!mission.snapshotId) return undefined;
  if (!mission.repositoryId) throw new Error("mission_exception_snapshot_not_found");
  const row = listRepositorySnapshots(db, mission.tenantId, mission.repositoryId)
    .find((item) => item.id === mission.snapshotId);
  if (!row) throw new Error("mission_exception_snapshot_not_found");
  return { snapshotId: row.id, resolvedSha: row.resolved_sha };
}

function recordPolicyException(
  db: AppDb,
  mission: Mission,
  reason: string,
  createdAt: string,
): void {
  const observedAgainst = missionObservedAgainst(db, mission);
  const already = evaluateMissionExceptions(
    db,
    mission.tenantId,
    mission.id,
    observedAgainst,
  ).blocking.some((item) => item.category === "policy_exception" && item.reason === reason);
  if (already) return;
  raiseMissionException(db, {
    tenantId: mission.tenantId,
    missionId: mission.id,
    reason,
    impact: "ReGauge pilot claim denied by the inherited Policy Envelope",
    ownerPrincipalId: mission.ownerPrincipalId,
    resolutionPath: "adjust_task_or_rebind_policy_envelope",
    blocking: true,
    ...(observedAgainst ? { observedAgainst } : {}),
    correlationId: `regauge-pilot-policy:${mission.id}`,
    createdAt,
    category: "policy_exception",
  });
}

/**
 * Evaluate the campaign's bound Mission envelope. No-op when unbound.
 */
export function assertRegaugePilotMissionPolicy(db: AppDb, input: RegaugePilotPolicyInput): void {
  const mission = resolveMissionForRegaugeCampaign(db, input.tenantId, input.campaignId);
  if (!mission) return;
  const observedAt = input.observedAt ?? new Date().toISOString();
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: regaugePilotPolicyTask(input),
  });
  if (enforcement.status === "no_envelope") {
    recordPolicyException(db, mission, "mission_policy_envelope_missing", observedAt);
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    recordPolicyException(db, mission, reasons.join(";"), observedAt);
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
