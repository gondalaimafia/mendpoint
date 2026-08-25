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
import {
  evaluateMissionTaskPolicy,
  missionPolicyDenialReasons,
} from "@mendpoint/pipeline";

export type RegaugePilotPolicyInput = Readonly<{
  tenantId: string;
  campaignId: string;
  repositoryId: string;
  externalProcessing: boolean;
}>;

function regaugePilotPolicyTask(input: RegaugePilotPolicyInput) {
  return Object.freeze({
    repositoryId: input.repositoryId,
    // The runnable campaign summary does not carry a git branch. Empty keeps
    // unrestricted envelopes (empty branchScope) allowed, and fail-closes a
    // tenant that has scoped branches until this seam learns the real name.
    branch: "",
    targetPaths: Object.freeze([] as const),
    tool: "edit",
    modelClass: input.externalProcessing ? "llm" : "deterministic",
    externalProcessing: input.externalProcessing,
    risk: "medium" as const,
    isDeployment: false,
    wantsTrainingCapture: false,
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
