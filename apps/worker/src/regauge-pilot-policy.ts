/**
 * Fail-closed Policy Envelope enforcement on the live ReGauge pilot-lane path
 * (spec §6.7). Launch already pins a versioned envelope. This seam evaluates
 * that inherited envelope before the worker takes a unit lease.
 *
 * Unbound campaigns (no Mission) are not evaluated here — that enrollment gap
 * stays visible. A bound Mission with a missing envelope, invalid envelope, or
 * explicit deny fails closed and does not claim.
 */
import { resolveMissionForRegaugeCampaign, type AppDb } from "@mendpoint/db";
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
    throw new Error("mission_policy_envelope_missing");
  }
  const reasons = missionPolicyDenialReasons(enforcement);
  if (reasons) {
    throw new Error(`mission_policy_denied:${reasons.join(";")}`);
  }
}
