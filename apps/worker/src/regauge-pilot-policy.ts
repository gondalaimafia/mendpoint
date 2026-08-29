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
 *
 * The deny is observed in the context of the exact immutable snapshot this unit
 * would execute against, so the exception is bound to THAT snapshot
 * (`observedAgainst`), threaded from the caller (the runnable campaign unit's
 * taskSnapshotId/expectedBaseRevision). It is NOT derived from
 * `mission.snapshotId`: the unit snapshot advances per wave and is the precise
 * context this claim was denied against, whereas the mission's launch snapshot
 * is a single immutable pin that never moves. The exception counts as blocking
 * only while the mission is on that snapshot; once a later claim runs against a
 * newer unit snapshot the prior deny is STALE, surfaced for re-affirmation
 * rather than blocking forever (apps/api/src/warden-candidate-review.ts).
 */
import {
  evaluateMissionExceptions,
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
  /**
   * The immutable snapshot this unit would execute against. A raised policy
   * exception is bound to it so it goes stale when the mission moves past it,
   * instead of blocking the mission forever.
   */
  observedAgainst: SnapshotIdentity;
  /**
   * Observation timestamp, taken from the lane's injected clock. Required so
   * tests and replays agree — the seam never reads the wall clock itself.
   */
  observedAt: string;
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

function recordPolicyException(
  db: AppDb,
  mission: Mission,
  reason: string,
  createdAt: string,
  observedAgainst: SnapshotIdentity,
): void {
  // Dedup against the CURRENT snapshot: a still-blocking policy_exception with
  // the same reason on this snapshot means the deny was already recorded. A
  // matching exception bound to a superseded snapshot is stale here, so a fresh
  // deny on the new snapshot is recorded (and re-affirmed) rather than skipped.
  const already = evaluateMissionExceptions(db, mission.tenantId, mission.id, observedAgainst).blocking
    .some((item) => item.category === "policy_exception" && item.reason === reason);
  if (already) return;
  raiseMissionException(db, {
    tenantId: mission.tenantId,
    missionId: mission.id,
    reason,
    impact: "ReGauge pilot claim denied by the inherited Policy Envelope",
    ownerPrincipalId: mission.ownerPrincipalId,
    resolutionPath: "adjust_task_or_rebind_policy_envelope",
    blocking: true,
    observedAgainst,
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
  const enforcement = evaluateMissionTaskPolicy(db, {
    tenantId: input.tenantId,
    missionId: mission.id,
    task: regaugePilotPolicyTask(input),
  });
  if (enforcement.status === "no_envelope") {
    recordPolicyException(db, mission, "mission_policy_envelope_missing", input.observedAt, input.observedAgainst);
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    recordPolicyException(db, mission, reasons.join(";"), input.observedAt, input.observedAgainst);
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
